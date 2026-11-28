import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GitAuthEnv,
  GitSession,
} from "../../src/providers/github/GitSession.js";
import worker from "../../src/cloudflare/worker.js";

const bff = "https://bff.example.test";
const editor = "tw-editor://.";
const proxy = "https://git.example.test";

type Repo = { id: number; owner: string; name: string; admin: boolean };

function fixture({
  features = "pulls-read,repository-rename",
  admin = true,
  patch,
}: {
  features?: string;
  admin?: boolean;
  patch?: (name: string) => Response | Promise<Response>;
} = {}) {
  const records = new Map<string, unknown>();
  const instances = new Map<string, GitSession>();
  const repos: Repo[] = [
    { id: 42, owner: "owner", name: "project", admin },
    { id: 43, owner: "owner", name: "taken", admin: true },
  ];
  const env = {
    GIT_ALLOWED_ORIGINS: editor,
    GIT_PROXY_ORIGIN: proxy,
    GIT_GITHUB_API: features,
    GIT_GITHUB_CLIENT_ID: "app",
    GIT_GITHUB_CLIENT_SECRET: "fixture",
    GIT_GITHUB_REDIRECT_URI: bff + "/v1/git-auth/callback",
    GIT_SESSION_KEY: "a".repeat(64),
  } as GitAuthEnv & { GIT_GITHUB_API: string };
  env.GIT_SESSIONS = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      let object = instances.get(name);
      if (!object) {
        const storage = {
          get: async (key: string) => structuredClone(records.get(name + key)),
          put: async (key: string, value: unknown) => {
            records.set(name + key, structuredClone(value));
          },
          delete: async (keys: string[]) => {
            for (const key of keys) records.delete(name + key);
          },
          setAlarm: async () => {},
          transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
            callback(storage),
        };
        object = new GitSession(
          { storage } as unknown as DurableObjectState,
          env,
        );
        instances.set(name, object);
      }
      const instance = object;
      return {
        fetch: (url: string, init: RequestInit) =>
          instance.fetch(new Request(url, init)),
      };
    },
  } as unknown as DurableObjectNamespace;
  const find = (owner: string, name: string) =>
    repos.find(
      (repo) =>
        repo.owner.toLowerCase() === owner.toLowerCase() &&
        repo.name.toLowerCase() === name.toLowerCase(),
    );
  const send = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "ghu_private",
        refresh_token: "ghr_private",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      });
    if (input === "https://api.github.com/user")
      return Response.json({ id: 1, login: "fixture-user" });
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/u.exec(
      input,
    );
    if (!match) return new Response(null, { status: 404 });
    const repo = find(match[1]!, match[2]!);
    if (init?.method === "PATCH") {
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(String(init.body)) as { name: string };
      expect(Object.keys(body)).toEqual(["name"]);
      if (patch) return patch(body.name);
      if (!repo) return new Response(null, { status: 404 });
      if (find(repo.owner, body.name) && find(repo.owner, body.name) !== repo)
        return Response.json(
          { message: "name already exists" },
          { status: 422 },
        );
      repo.name = body.name;
      return Response.json({
        id: repo.id,
        full_name: repo.owner + "/" + repo.name,
      });
    }
    if (!repo) {
      // GitHub redirects a renamed repository's old name.
      return new Response(null, { status: 301 });
    }
    return Response.json({
      id: repo.id,
      full_name: repo.owner + "/" + repo.name,
      permissions: { pull: true, push: true, admin: repo.admin },
    });
  });
  vi.stubGlobal("fetch", send);
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(bff + "/v1/git-auth" + path, {
        ...init,
        headers: { Origin: editor, ...init.headers },
      }),
      env as never,
    );
  const login = async (write = true) => {
    const started = (await (
      await call("/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remote: "https://github.com/owner/project.git",
          write,
        }),
      })
    ).json()) as { authorizationUrl: string; ticket: string };
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await call("/callback?code=fixture-code&state=" + state);
    const session = (await (
      await call("/session", {
        headers: { Authorization: "Bearer " + started.ticket },
      })
    ).json()) as { bearer: string };
    return session.bearer;
  };
  const rename = (bearer: string, repo: string, body: unknown) => {
    const text = JSON.stringify(body);
    return worker.fetch(
      new Request(proxy + "/v1/github/owner/" + repo + "/name", {
        method: "POST",
        headers: {
          Origin: editor,
          Authorization: "Bearer " + bearer,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(text).byteLength),
        },
        body: text,
      }),
      env as never,
    );
  };
  const authorize = (bearer: string, repo: string) => {
    const [state, credential] = bearer.split(".");
    return env
      .GIT_SESSIONS!.get(env.GIT_SESSIONS!.idFromName(state!))
      .fetch("https://git-session.internal/authorize", {
        method: "POST",
        body: JSON.stringify({
          credential,
          origin: editor,
          owner: "owner",
          repo,
          write: false,
        }),
      });
  };
  const patches = () =>
    send.mock.calls.filter(([, init]) => init?.method === "PATCH");
  return { send, login, rename, authorize, patches, repos };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("repository rename route", () => {
  it("renames the session repository and binds the session to the new name", async () => {
    const { login, rename, authorize, patches } = fixture();
    const bearer = await login();
    const response = await rename(bearer, "project", { name: "my-urashima" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: "owner",
      repo: "my-urashima",
      repositoryId: 42,
    });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]![0]).toBe("https://api.github.com/repos/owner/project");
    // The same login now serves the new name and no longer the old one.
    expect((await authorize(bearer, "my-urashima")).status).toBe(200);
    expect((await authorize(bearer, "project")).status).toBe(403);
  });

  it("completes a retry after an unknown outcome without renaming again", async () => {
    const { login, rename, repos, patches } = fixture();
    const bearer = await login();
    // GitHub applied the rename but the response was lost.
    repos[0]!.name = "my-urashima";
    const response = await rename(bearer, "project", { name: "my-urashima" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repo: "my-urashima" });
    expect(patches()).toHaveLength(0);
  });

  it("reports a taken name, a missing admin role and a missing App permission", async () => {
    let state = fixture();
    let bearer = await state.login();
    let response = await state.rename(bearer, "project", { name: "taken" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "REPOSITORY_NAME_UNAVAILABLE",
    });

    state = fixture({ admin: false });
    bearer = await state.login();
    response = await state.rename(bearer, "project", { name: "renamed" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(state.patches()).toHaveLength(0);

    state = fixture({
      patch: () =>
        Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        ),
    });
    bearer = await state.login();
    response = await state.rename(bearer, "project", { name: "renamed" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "ADMINISTRATION_PERMISSION_REQUIRED",
    });
    // The session stays bound to the old name.
    expect((await state.authorize(bearer, "project")).status).toBe(200);
  });

  it("requires a write login for the session repository", async () => {
    const state = fixture();
    const readOnly = await state.login(false);
    let response = await state.rename(readOnly, "project", { name: "renamed" });
    expect(response.status).toBe(403);
    const bearer = await state.login();
    response = await state.rename(bearer, "taken", { name: "renamed" });
    expect(response.status).toBe(403);
    expect(state.patches()).toHaveLength(0);
  });

  it("rejects invalid names and extra keys before contacting GitHub", async () => {
    const state = fixture();
    const bearer = await state.login();
    const calls = state.send.mock.calls.length;
    for (const body of [
      { name: "" },
      { name: "." },
      { name: ".." },
      { name: "a.git" },
      { name: "浦島太郎" },
      { name: "a b" },
      { name: "a".repeat(101) },
      { name: "ok", private: true },
      { name: 1 },
    ]) {
      const response = await state.rename(bearer, "project", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.send.mock.calls.length).toBe(calls);
  });

  it("is unavailable unless repository-rename is enabled", async () => {
    const state = fixture({ features: "pulls-read" });
    const bearer = await state.login();
    const response = await state.rename(bearer, "project", { name: "renamed" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "GITHUB_API_UNAVAILABLE",
    });
  });
});
