import { afterEach, describe, expect, it, vi } from "vitest";
import { GitRepositoryCreation } from "../../src/providers/github/GitRepositoryCreation.js";
import type { GitRepositoryCreationEnv } from "../../src/providers/github/gitRepositoryCreationProtocol.js";
import worker from "../../src/cloudflare/worker.js";
import { generateCodeChallenge } from "../../src/providers/github/pkce.js";

// The keybroker Worker serves the routes the hierarchidb BFF served.
const app = {
  request: (url: string, init: RequestInit, env: never) =>
    worker.fetch(new Request(url, init), env),
};

const bff = "https://bff.example.test";
const editor = "https://editor.example.test";
const prefix = "/v1/github-create";
const intent = {
  operationId: "create-1",
  owner: "alice",
  name: "game",
  description: "Game",
  visibility: "private",
  seedDigest: "a".repeat(64),
  topics: ["scratch", "blocks"],
};
const repoPath = "https://api.github.com/repos/alice/game";
const createUrl = "https://api.github.com/user/repos";
const json = { "Content-Type": "application/json" };

function fixture() {
  const records = new Map<string, Map<string, unknown>>();
  const instances = new Map<string, GitRepositoryCreation>();
  const locks = new Map<string, Promise<unknown>>();
  const env: GitRepositoryCreationEnv = {
    GIT_ALLOWED_ORIGINS: editor + ",https://other.example.test",
    GIT_CREATE_CLIENT_ID: "creation-app",
    GIT_CREATE_CLIENT_SECRET: "fixture-secret",
    GIT_CREATE_REDIRECT_URI: bff + prefix + "/callback",
    GIT_CREATE_SESSION_KEY: "a".repeat(64),
  };
  env.GIT_REPOSITORY_CREATION = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      let instance = instances.get(name);
      if (!instance) {
        let entries = records.get(name);
        if (!entries) {
          entries = new Map();
          records.set(name, entries);
        }
        const local = entries;
        const storage = {
          get: async (key: string) => structuredClone(local.get(key)),
          put: async (key: string, value: unknown) => {
            local.set(key, structuredClone(value));
          },
          delete: async (key: string) => local.delete(key),
          setAlarm: async () => {},
          transaction: (callback: (tx: unknown) => Promise<unknown>) => {
            const result = (locks.get(name) ?? Promise.resolve()).then(() =>
              callback(storage),
            );
            locks.set(
              name,
              result.catch(() => {}),
            );
            return result;
          },
        };
        instance = new GitRepositoryCreation(
          { storage } as unknown as DurableObjectState,
          env,
        );
        instances.set(name, instance);
      }
      const object = instance;
      return {
        fetch: (url: string, init: RequestInit) =>
          object.fetch(new Request(url, init)),
      };
    },
  } as unknown as DurableObjectNamespace;

  const repository = {
    id: 42,
    name: "game",
    owner: { login: "alice" },
    private: true,
    size: 0,
    created_at: new Date().toISOString(),
    secretFixtureField: "filtered",
  };
  let actor = { login: "alice", id: 1 };
  const send = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    if (url === "https://github.com/login/oauth/access_token") {
      expect((init?.body as URLSearchParams).get("client_secret")).toBe(
        "fixture-secret",
      );
      return Response.json({ access_token: "ghu_fixture", expires_in: 28_800 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer ghu_fixture",
    );
    if (url === "https://api.github.com/user") return Response.json(actor);
    if (url === createUrl) return Response.json(repository, { status: 201 });
    if (url === repoPath) return Response.json(repository);
    if (url === repoPath + "/topics")
      return Response.json({ names: intent.topics });
    if (
      url === repoPath + "/branches?per_page=1" ||
      url === repoPath + "/tags?per_page=1"
    )
      return Response.json([]);
    throw new Error("Unexpected upstream request");
  });
  vi.stubGlobal("fetch", send);
  const call = (path: string, init: RequestInit = {}, origin = editor) =>
    app.request(
      bff + prefix + path,
      { ...init, headers: { Origin: origin, ...init.headers } },
      env as never,
    );
  async function login() {
    const start = await call("/start", {
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(start.status).toBe(200);
    const { authorizationUrl, ticket } = await start.json<{
      authorizationUrl: string;
      ticket: string;
    }>();
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get("state");
    expect(ticket).toMatch(/^login\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("redirect_uri")).toBe(
      bff + prefix + "/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = "/callback?code=fixture-code&state=" + state;
    const ticketHeaders = { Authorization: "Bearer " + ticket };
    expect((await call("/session", { headers: ticketHeaders })).status).toBe(
      202,
    );
    expect((await call(callback)).status).toBe(200);
    const exchange = send.mock.calls.findLast(([target]) =>
      target.includes("/oauth/access_token"),
    );
    const verifier = (exchange?.[1]?.body as URLSearchParams).get(
      "code_verifier",
    );
    expect(typeof verifier).toBe("string");
    expect(url.searchParams.get("code_challenge")).toBe(
      await generateCodeChallenge(verifier ?? ""),
    );
    expect((await call(callback)).status).toBe(400);
    const session = await call("/session", { headers: ticketHeaders });
    expect(session.status).toBe(200);
    const result = await session.json<{ bearer: string; expiresAt: number }>();
    expect(result).toMatchObject({
      scope: "repository-creation",
      connection: { mode: "cloudflare", proxyOrigin: bff },
      account: { login: actor.login },
      bearer: expect.stringMatching(
        /^create\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u,
      ),
    });
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(JSON.stringify(result)).not.toContain("ghu_fixture");
    const headers = { ...json, Authorization: "Bearer " + result.bearer };
    const create = (input: object = intent) =>
      call("/repos", { method: "POST", headers, body: JSON.stringify(input) });
    return { ticketHeaders, headers, create, expiresAt: result.expiresAt };
  }
  return {
    env,
    call,
    send,
    records,
    instances,
    login,
    repository,
    setActor: (value: typeof actor) => {
      actor = value;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub repository creation on the BFF", () => {
  it("separates the login and creation credentials, encrypts provider tokens and enforces origin and revocation", async () => {
    const { call, login, records, send } = fixture();
    const { ticketHeaders, headers } = await login();
    expect(
      JSON.stringify(
        [...records.values()].flatMap((record) => [...record.values()]),
      ),
    ).not.toContain("ghu_fixture");
    expect((await call("/owners", { headers: ticketHeaders })).status).toBe(
      401,
    );
    expect((await call("/session", { headers })).status).toBe(401);
    expect(
      (await call("/owners", { headers }, "https://other.example.test")).status,
    ).toBe(401);
    expect(
      (await call("/owners", { headers }, "https://denied.example.test"))
        .status,
    ).toBe(403);
    expect(
      (
        await call("/owners", {
          headers: {
            Authorization: "Bearer " + "a".repeat(43) + "." + "b".repeat(43),
          },
        })
      ).status,
    ).toBe(401);
    expect(await (await call("/owners", { headers })).json()).toEqual({
      owners: [
        {
          login: "alice",
          type: "User",
          canCreate: { private: true, public: true },
        },
      ],
    });
    expect(
      (await call("/session", { method: "DELETE", headers: ticketHeaders }))
        .status,
    ).toBe(204);
    expect((await call("/owners", { headers })).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a creation binding and validates the exact preflight and request fields", async () => {
    const { env, call, login, send } = fixture();
    const namespace = env.GIT_REPOSITORY_CREATION;
    delete env.GIT_REPOSITORY_CREATION;
    expect(
      (await call("/start", { method: "POST", headers: json, body: "{}" }))
        .status,
    ).toBe(404);
    env.GIT_REPOSITORY_CREATION = namespace;
    expect(
      (
        await call("/start", {
          method: "POST",
          headers: json,
          body: '{ "owner": "alice" }',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/start", {
          method: "POST",
          headers: json,
          body: " ".repeat(4097),
        })
      ).status,
    ).toBe(413);
    const options = {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    };
    const preflight = await call("/repos", options);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(editor);
    expect((await call("/repos?owner=alice", options)).status).toBe(400);
    expect(
      (
        await call("/repos", {
          ...options,
          headers: {
            ...options.headers,
            "Access-Control-Request-Headers": "Cookie",
          },
        })
      ).status,
    ).toBe(403);
    const { create } = await login();
    expect((await create({ ...intent, owner: "other" })).status).toBe(403);
    expect((await create({ ...intent, name: "a.git" })).status).toBe(400);
    expect(
      (await create({ ...intent, path: "https://github.com/user/repos" }))
        .status,
    ).toBe(400);
    expect((await create({ ...intent, topics: ["../unsafe"] })).status).toBe(
      400,
    );
    expect(send.mock.calls.filter(([url]) => url === createUrl)).toHaveLength(
      0,
    );
  });

  it("expires the creation grant and keeps previously journaled receipts for reauthorization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { call, login, send } = fixture();
    const first = await login();
    expect((await first.create()).status).toBe(201);
    vi.setSystemTime(first.expiresAt);
    expect((await call("/owners", { headers: first.headers })).status).toBe(
      401,
    );
    expect(
      (await call("/session", { headers: first.ticketHeaders })).status,
    ).toBe(401);
    expect((await first.create()).status).toBe(401);
    expect((await (await login()).create()).status).toBe(201);
    expect(send.mock.calls.filter(([url]) => url === createUrl)).toHaveLength(
      1,
    );
  });

  it("records a verified receipt across a restart and different sign-in without a second GitHub mutation", async () => {
    const { call, login, instances, send, setActor } = fixture();
    const first = await login();
    const result = await first.create();
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({
      id: 42,
      name: "game",
      owner: "alice",
      visibility: "private",
      remote: "https://github.com/alice/game.git",
    });
    instances.clear();
    const second = await login();
    expect((await second.create()).status).toBe(201);
    expect(
      (await second.create({ ...intent, seedDigest: "b".repeat(64) })).status,
    ).toBe(409);
    const writes = send.mock.calls.filter(([url]) => url === createUrl);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.[1]?.body as string)).toEqual({
      name: "game",
      description: "Game",
      private: true,
      auto_init: false,
    });
    setActor({ login: "other-user", id: 2 });
    const { headers } = await login();
    // The response for the other account must come from its own journal, not Alice's.
    expect((await call("/operations/create-1", { headers })).status).toBe(404);
  });

  it("reconciles an unknown operation only after receiving the inspected repository ID", async () => {
    const { call, login, repository, send } = fixture();
    const { create, headers } = await login();
    send.mockImplementationOnce(async () => {
      throw new Error("Upstream response was lost");
    });
    const first = await create();
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ code: "unknown" });
    expect((await create()).status).toBe(502);
    const operation = "/operations/create-1";
    const reconcile = (repositoryId: number) =>
      call(operation + "/reconcile", {
        method: "POST",
        headers,
        body: JSON.stringify({ repositoryId }),
      });
    const inspect = await call(operation, { headers });
    expect(await inspect.json()).toMatchObject({
      status: "unknown",
      candidate: { id: 42 },
    });
    expect((await reconcile(41)).status).toBe(409);
    repository.size = 4;
    expect(await (await call(operation, { headers })).json()).toEqual({
      status: "unknown",
      candidate: null,
    });
    expect((await reconcile(42)).status).toBe(409);
    repository.size = 0;
    expect((await reconcile(42)).status).toBe(201);
    expect((await reconcile(41)).status).toBe(409);
    expect((await create()).status).toBe(201);
    expect(send.mock.calls.filter(([url]) => url === createUrl)).toHaveLength(
      1,
    );
  });

  it("applies topics only to the matching receipt and verifies the repository ID again on GitHub", async () => {
    const { call, login, repository, send } = fixture();
    const { create, headers } = await login();
    expect((await create()).status).toBe(201);
    const topics = (id: number, operationId = intent.operationId) =>
      call("/repos/" + id + "/topics", {
        method: "PUT",
        headers,
        body: JSON.stringify({ operationId }),
      });
    expect((await topics(43)).status).toBe(403);
    expect((await topics(42, "missing")).status).toBe(403);
    repository.id = 43;
    expect((await topics(42)).status).toBe(403);
    expect(
      send.mock.calls.filter(([url]) => url.endsWith("/topics")),
    ).toHaveLength(0);
    repository.id = 42;
    expect((await topics(42)).status).toBe(204);
    expect((await topics(42)).status).toBe(204);
    const writes = send.mock.calls.filter(([url]) => url.endsWith("/topics"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.[1]?.body as string)).toEqual({
      names: intent.topics,
    });
  });
});
