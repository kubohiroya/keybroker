import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubPublication,
  type PublicationEngine,
} from "../../src/providers/github/GitHubPublication.js";
import { GitSession } from "../../src/providers/github/GitSession.js";
import type {
  Intent,
  PublicationEnv,
  StackParent,
} from "../../src/providers/github/gitHubPublicationProtocol.js";
import { handleGitAuth } from "../../src/providers/github/handleGitAuth.js";
import { handleGitHubPublication } from "../../src/providers/github/handleGitHubPublication.js";

const host = "https://bff.example.test";
const editor = "https://editor.example.test";
const endpoint = host + "/v1/github-publication";
const oauthPath = "/v1/git-auth/callback";
const remote = "https://github.com/owner/project.git";
const id = "00000000-0000-4000-8000-000000000001";
const baseOid = "a".repeat(40);
const commitOid = "b".repeat(40);
const head = "tw-plus/pr-" + id;
const input = { id, remote, repositoryId: 42 };
const intent: Intent = {
  ...input,
  head,
  base: "main",
  baseOid,
  commitOid,
  title: "<img src=bad>",
  body: "Expected PR body",
  goal: "merge",
  issue: { number: 7, closeAfterMerge: true },
};

function storage() {
  const entries = new Map<string, unknown>();
  const state = {
    async get(key: string) {
      return structuredClone(entries.get(key));
    },
    async put(key: string, value: unknown) {
      entries.set(key, structuredClone(value));
    },
    async delete(keys: string[]) {
      for (const key of keys) entries.delete(key);
    },
    async setAlarm() {},
    async transaction<T>(run: (tx: unknown) => Promise<T>) {
      return run(state);
    },
  };
  return {
    state: { storage: state } as unknown as DurableObjectState,
    entries,
  };
}

function namespace<T extends { fetch(request: Request): Promise<Response> }>(
  create: (name: string) => T,
) {
  const objects = new Map<string, T>();
  const identifiers = new Map<string, string>();
  const identify = (name: string) => {
    let value = identifiers.get(name);
    if (!value) {
      value = String(identifiers.size + 1).padStart(64, "0");
      identifiers.set(name, value);
    }
    return value;
  };
  return {
    idFromName: identify,
    idFromString: (value: string) => value,
    get(name: string) {
      const object = objects.get(name) ?? create(name);
      objects.set(name, object);
      return {
        fetch: (url: string, init?: RequestInit) =>
          object.fetch(new Request(url, init)),
      };
    },
  } as unknown as DurableObjectNamespace;
}

function fixture(
  previewEngine?: PublicationEngine,
  github?: (
    url: URL,
    init: RequestInit | undefined,
    refs: Map<string, string>,
  ) => Response,
) {
  const records: Map<string, unknown>[] = [];
  const refs = new Map([["main", baseOid]]);
  const parents = new Map<number, StackParent>();
  const write = vi.fn();
  const engine: PublicationEngine = {
    validateIntent: (value) => value as Intent,
    createHost: ({ grant, pushCommit }) => ({
      async branchOid(branch) {
        return refs.get(branch) ?? null;
      },
      async stackParent(number) {
        return parents.get(number) ?? null;
      },
      pushCommit,
      async createPullRequest(draft) {
        const authority = await grant("pulls-write");
        if (!authority) throw new Error("Unexpected missing capability");
        write(draft);
        return { number: 23 };
      },
    }),
    createQueue: ({ port, journal }) => ({
      advance: (jobId) =>
        journal.exclusive(jobId, async () => {
          const job = await journal.get(jobId);
          if (!job) throw new Error("Job missing");
          if (job.status !== "queued") return job;
          if ((await port.branchOid(job.intent.head)) === null) {
            try {
              await port.pushCommit(
                job.intent.commitOid,
                "refs/heads/" + job.intent.head,
              );
            } catch {
              const waiting = { ...job, pause: "requestFailed" };
              await journal.put(jobId, waiting);
              return waiting;
            }
          }
          const creating = { ...job, status: "creatingPull" as const };
          await journal.put(jobId, creating);
          await port.createPullRequest(job.intent);
          const created = {
            ...job,
            status: "waiting" as const,
            pullNumber: 23,
          };
          await journal.put(jobId, created);
          return created;
        }),
    }),
  };
  const env: PublicationEnv = {
    GIT_ALLOWED_ORIGINS: editor,
    GIT_GITHUB_CLIENT_ID: "fixture-client",
    GIT_GITHUB_CLIENT_SECRET: "fixture-secret",
    GIT_GITHUB_REDIRECT_URI: host + oauthPath,
    GIT_PROXY_ORIGIN: "https://git.example.test",
    GIT_SESSION_KEY: "f".repeat(64),
    GIT_PUBLICATION:
      "pulls-read,pulls-write,checks-read,issues-read,issues-write,merge",
    GIT_SESSIONS: namespace(() => new GitSession(storage().state, env)),
    GIT_PUBLICATION_JOBS: namespace(() => {
      const object = storage();
      records.push(object.entries);
      return new GitHubPublication(object.state, env, previewEngine ?? engine);
    }),
  };
  const actor = { id: 123, login: "alice" };
  const repo = {
    id: 42,
    full_name: "owner/project",
    permissions: { pull: true, push: true },
  };
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "ghu_fixture",
        refresh_token: "ghr_fixture",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
      });
    if (url === "https://api.github.com/user") return Response.json(actor);
    if (url === "https://api.github.com/repos/owner/project")
      return Response.json(repo);
    if (github) return github(new URL(url), init, refs);
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", upstream);
  const auth = (url: string, init?: RequestInit) =>
    handleGitAuth(new Request(host + "/v1/git-auth" + url, init), env);
  const callback = (state: string, cookie?: string) =>
    auth("/callback?code=mock&state=" + state, {
      headers: cookie ? { Cookie: cookie } : {},
    });
  async function login(write = true) {
    const started = await auth("/start", {
      method: "POST",
      headers: { Origin: editor, "Content-Type": "application/json" },
      body: JSON.stringify({ remote, write }),
    });
    expect(started.status).toBe(200);
    const { ticket, authorizationUrl } = await started.json<{
      ticket: string;
      authorizationUrl: string;
    }>();
    expect(
      (
        await callback(
          new URL(authorizationUrl).searchParams.get("state") ?? "",
        )
      ).status,
    ).toBe(200);
    const session = await auth("/session", {
      headers: { Origin: editor, Authorization: "Bearer " + ticket },
    });
    expect(session.status).toBe(200);
    return (await session.json<{ bearer: string }>()).bearer;
  }
  const call = (url: string, init?: RequestInit) =>
    handleGitHubPublication(new Request(url, init), env);
  const post = (path: string, bearer: string, body: object, origin = editor) =>
    call(endpoint + path, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + bearer,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  async function draft(bearer: string, value = intent) {
    const prepared = await post("/jobs", bearer, { intent: value });
    expect(prepared.status).toBe(200);
    const { approvalUrl, job } = await prepared.json<{
      approvalUrl: string;
      job: null;
    }>();
    expect(job).toBeNull();
    return approvalUrl;
  }
  async function preview(approvalUrl: string, browser?: string) {
    const response = await call(approvalUrl, {
      headers: browser ? { Cookie: browser } : {},
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(html)?.[1];
    const cookie = response.headers.get("Set-Cookie")?.split(";")[0];
    if (!csrf || !cookie) throw new Error("Approval challenge missing");
    return { response, html, csrf, cookie };
  }
  const consent = (
    approvalUrl: string,
    csrf: string,
    cookie: string,
    origin = host,
    action = "approve",
  ) =>
    call(approvalUrl, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, [action]: "yes" }),
    });
  async function consentState(approvalUrl: string) {
    const { csrf, cookie } = await preview(approvalUrl);
    const response = await consent(approvalUrl, csrf, cookie, host, "verify");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    const cookies = response.headers.get("Set-Cookie") ?? "";
    const proof =
      /(__Host-tw-publish-proof-[A-Za-z0-9_-]+=[A-Za-z0-9_-]+)/u.exec(
        cookies,
      )?.[1];
    const browser =
      /(__Host-tw-publish-browser-[A-Za-z0-9_-]+=[A-Za-z0-9_-]+)/u.exec(
        cookies,
      )?.[1];
    if (!proof || !browser) throw new Error("OAuth proof missing");
    return { state: location.searchParams.get("state") ?? "", proof, browser };
  }
  async function confirm(approvalUrl: string) {
    const { state, proof, browser } = await consentState(approvalUrl);
    expect((await callback(state, proof)).status).toBe(303);
    const { csrf, cookie } = await preview(approvalUrl, browser);
    expect(
      (await consent(approvalUrl, csrf, cookie + "; " + browser)).status,
    ).toBe(200);
  }
  return {
    env,
    actor,
    repo,
    refs,
    parents,
    records,
    write,
    upstream,
    login,
    post,
    call,
    draft,
    preview,
    consent,
    consentState,
    callback,
    confirm,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub publication approval and job BFF", () => {
  it("requires a write session bound to the canonical repository and caller origin", async () => {
    const { login, post, repo } = fixture();
    const read = await login(false);
    expect((await post("/repository", read, { remote })).status).toBe(403);
    const write = await login();
    expect(
      await (await post("/repository", write, { remote })).json(),
    ).toMatchObject({
      repositoryId: 42,
    });
    expect(
      (await post("/repository", write, { remote }, "https://other.test"))
        .status,
    ).toBe(403);
    expect(
      (await post("/jobs/status", write, { ...input, repositoryId: 43 }))
        .status,
    ).toBe(403);
    repo.id = 43;
    expect((await post("/repository", write, { remote })).status).toBe(403);
  });

  it("serves an escaped exact preview and requires same-origin consent and browser-bound GitHub callback", async () => {
    const {
      login,
      draft,
      preview,
      consent,
      consentState,
      callback,
      post,
      write,
      records,
    } = fixture();
    const bearer = await login();
    const approvalUrl = await draft(bearer);
    expect(
      await (await post("/jobs/status", bearer, input)).json(),
    ).toMatchObject({
      approval: "pending",
      job: null,
      intent,
    });
    expect((await post("/jobs/advance", bearer, input)).status).toBe(403);
    const landing = await preview(approvalUrl);
    expect(landing.html).not.toContain(intent.body);
    expect(landing.html).not.toContain(remote);
    expect(
      (
        await consent(
          approvalUrl,
          landing.csrf,
          landing.cookie,
          editor,
          "verify",
        )
      ).status,
    ).toBe(403);
    expect(
      (await consent(approvalUrl, landing.csrf, landing.cookie)).status,
    ).toBe(403);
    const { state, proof, browser } = await consentState(approvalUrl);
    expect((await callback(state)).status).toBe(400);
    expect((await post("/jobs/advance", bearer, input)).status).toBe(403);
    const verified = await callback(state, proof);
    expect(verified.status).toBe(303);
    expect(new URL(verified.headers.get("Location") ?? "", host).href).toBe(
      approvalUrl,
    );
    expect((await callback(state, proof)).status).toBe(400);
    expect((await preview(approvalUrl)).html).not.toContain(intent.body);
    expect((await post("/jobs/advance", bearer, input)).status).toBe(403);
    const { response, html, csrf, cookie } = await preview(
      approvalUrl,
      browser,
    );
    expect(html).toContain("&lt;img src=bad&gt;");
    expect(html).not.toContain("<img src=bad>");
    for (const expected of [
      remote,
      baseOid,
      commitOid,
      "Link #7",
      "Squash merge",
    ])
      expect(html).toContain(expected);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(
      (await consent(approvalUrl, csrf, cookie + "; " + browser, editor))
        .status,
    ).toBe(403);
    expect((await consent(approvalUrl, csrf, "")).status).toBe(403);
    expect(
      (await consent(approvalUrl, csrf, cookie + "; " + browser)).status,
    ).toBe(200);
    expect(
      (await consent(approvalUrl, csrf, cookie + "; " + browser)).status,
    ).toBe(410);
    expect(
      await (await post("/jobs/status", bearer, input)).json(),
    ).toMatchObject({
      approval: "approved",
      job: { intent, status: "queued" },
    });
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify([...(records[0]?.values() ?? [])])).not.toContain(
      "ghu_fixture",
    );
  });

  it("cannot approve from another GitHub account and can renew the exact pending draft", async () => {
    const { actor, login, draft, consentState, callback, post, call, confirm } =
      fixture();
    const bearer = await login();
    const first = await draft(bearer);
    const { state, proof } = await consentState(first);
    actor.id = 456;
    actor.login = "bob";
    expect((await callback(state, proof)).status).toBe(403);
    const other = await login();
    expect(await (await post("/jobs/status", other, input)).json()).toEqual({
      approval: "missing",
      job: null,
    });
    actor.id = 123;
    actor.login = "alice";
    expect(
      (
        await post("/jobs", bearer, {
          intent: { ...intent, commitOid: "f".repeat(40) },
        })
      ).status,
    ).toBe(409);
    const renewed = await draft(bearer);
    expect(renewed).not.toBe(first);
    expect((await call(first)).status).toBe(410);
    await confirm(renewed);
  });

  it("uses the durable approved job, waits for the local push and serializes concurrent advances", async () => {
    const { login, draft, confirm, post, refs, write } = fixture();
    const bearer = await login();
    await confirm(await draft(bearer));
    expect(
      await (await post("/jobs/advance", bearer, input)).json(),
    ).toMatchObject({
      status: "queued",
      awaitingPush: true,
    });
    expect(write).not.toHaveBeenCalled();
    refs.set(head, commitOid);
    const results = await Promise.all([
      post("/jobs/advance", bearer, input),
      post("/jobs/advance", bearer, input),
    ]);
    for (const result of results)
      expect(await result.json()).toMatchObject({
        status: "waiting",
        pullNumber: 23,
      });
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      await (await post("/jobs", bearer, { intent })).json(),
    ).toMatchObject({
      approvalUrl: null,
      job: { pullNumber: 23 },
    });
  });

  it("does not approve a target branch that has moved or a publication branch that already exists", async () => {
    const { login, post, refs, write } = fixture();
    const bearer = await login();
    refs.set("main", "d".repeat(40));
    expect((await post("/jobs", bearer, { intent })).status).toBe(409);
    refs.set("main", baseOid);
    refs.set(head, commitOid);
    expect((await post("/jobs", bearer, { intent })).status).toBe(409);
    expect(write).not.toHaveBeenCalled();
  });

  it("binds stack lookup and approval to the verified parent, commit and target branch", async () => {
    const {
      env,
      login,
      post,
      draft,
      consentState,
      callback,
      preview,
      parents,
      refs,
    } = fixture();
    const parent = {
      number: 18,
      head: "parent-feature",
      headOid: baseOid,
      targetBase: "main",
      stackNumber: 9,
    };
    const bearer = await login();
    expect(
      (
        await post("/stack-parent", bearer, {
          remote,
          repositoryId: 42,
          number: 18,
        })
      ).status,
    ).toBe(403);
    env.GIT_PUBLICATION += ",stacks";
    parents.set(parent.number, parent);
    refs.set(parent.head, parent.headOid);
    expect(
      await (
        await post("/stack-parent", bearer, {
          remote,
          repositoryId: 42,
          number: 18,
        })
      ).json(),
    ).toEqual({ parent });
    expect(
      (
        await post("/stack-parent", bearer, {
          remote,
          repositoryId: 43,
          number: 18,
        })
      ).status,
    ).toBe(403);
    const stacked = { ...intent, base: parent.head, stackParent: parent };
    expect(
      (
        await post("/jobs", bearer, {
          intent: { ...stacked, stackParent: { ...parent, stackNumber: 10 } },
        })
      ).status,
    ).toBe(409);
    const approvalUrl = await draft(bearer, stacked);
    const { state, proof, browser } = await consentState(approvalUrl);
    expect((await callback(state, proof)).status).toBe(303);
    const { html } = await preview(approvalUrl, browser);
    expect(html).toContain("#18 in stack #9");
    expect(html).toContain("parent-feature");
    expect(html).toContain("Final target branch of the stack");
  });
});

const previewDist = process.env.TW_PUBLICATION_ENGINE_PREVIEW_DIST;

it.skipIf(!previewDist)(
  "advances the actual shared queue and GitHub port through CI, merge and issue close",
  async () => {
    const load = (name: string) =>
      import(
        /* @vite-ignore */ pathToFileURL(resolve(previewDist ?? "", name)).href
      );
    const queue = await load("pull-request-queue.js");
    const hostModule = await load("github-publication-host.js");
    const mergeRequest = "00000000-0000-4000-8000-000000000002";
    const mergedOid = "c".repeat(40);
    const writes: string[] = [];
    let pullBody: string | undefined;
    let checks = "PENDING";
    let merged = false;
    let issue = "open";
    const { login, draft, confirm, post, refs } = fixture(
      {
        validateIntent: queue.validatePublicationIntent,
        createQueue: queue.createPullRequestQueue,
        createHost: hostModule.createGitHubPublicationHost,
      },
      (url, init, branches) => {
        const repository = "/repos/owner/project";
        const method = init?.method ?? "GET";
        expect(url.origin).toBe("https://api.github.com");
        const rawPull = () => ({
          number: 23,
          body: pullBody,
          state: merged ? "closed" : "open",
          merged,
          ...(merged && { merge_commit_sha: mergedOid }),
          changed_files: 1,
          head: { repo: { id: 42 }, ref: head, sha: commitOid },
          base: { repo: { id: 42 }, ref: "main", sha: baseOid },
        });
        if (url.pathname.startsWith(repository + "/git/ref/heads/")) {
          const name = url.pathname.slice(
            (repository + "/git/ref/heads/").length,
          );
          const sha = branches.get(name);
          return sha
            ? Response.json({
                ref: "refs/heads/" + name,
                object: { type: "commit", sha },
              })
            : new Response(null, { status: 404 });
        }
        if (url.pathname === repository + "/issues/7") {
          if (method === "PATCH") {
            expect(JSON.parse(String(init?.body))).toEqual({
              state: "closed",
              state_reason: "completed",
            });
            writes.push("close");
            issue = "closed";
          }
          return Response.json({ number: 7, state: issue });
        }
        if (url.pathname === repository + "/pulls") {
          if (method === "GET")
            return Response.json(pullBody ? [rawPull()] : []);
          const body = JSON.parse(String(init?.body)) as { body: string };
          expect(body).toMatchObject({
            head,
            base: "main",
            title: intent.title,
          });
          expect(body.body).toContain("Refs #7");
          pullBody = body.body;
          writes.push("pull");
          return Response.json(rawPull(), { status: 201 });
        }
        if (url.pathname === repository + "/pulls/23")
          return Response.json(rawPull());
        if (url.pathname === repository + "/pulls/23/files")
          return Response.json([
            {
              filename: "project/project.source.json",
              sha: commitOid,
              status: "modified",
              additions: 2,
              deletions: 1,
            },
          ]);
        if (url.pathname === "/graphql") {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            variables: { owner: "owner", name: "project", number: 23 },
          });
          return Response.json({
            data: {
              repository: {
                databaseId: 42,
                pullRequest: {
                  headRefOid: commitOid,
                  baseRefOid: baseOid,
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  mergeable: "MERGEABLE",
                  reviewDecision: "APPROVED",
                  closingIssuesReferences: { totalCount: 0 },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: commitOid,
                          statusCheckRollup: {
                            state: checks,
                            contexts: { totalCount: 1 },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        if (url.pathname === repository + "/pulls/23/merge-async") {
          expect(method).toBe("PUT");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            sha: commitOid,
            merge_method: "squash",
            bypass_rules: false,
          });
          writes.push("merge");
          return Response.json(
            { status: "pending", details: { uuid: mergeRequest } },
            { status: 202 },
          );
        }
        if (
          url.pathname ===
          repository + "/pulls/23/merge-async/" + mergeRequest
        ) {
          merged = true;
          return Response.json({ status: "merged" });
        }
        throw new Error("Unexpected GitHub request: " + url.pathname);
      },
    );
    const bearer = await login();
    await confirm(await draft(bearer));
    const advance = async () =>
      (await post("/jobs/advance", bearer, input)).json();
    expect(await advance()).toMatchObject({
      status: "queued",
      awaitingPush: true,
    });
    refs.set(head, commitOid);
    expect(await advance()).toMatchObject({ status: "pushed" });
    expect(await advance()).toMatchObject({
      status: "issueReady",
      issueNumber: 7,
    });
    expect(await advance()).toMatchObject({
      status: "waiting",
      pullNumber: 23,
    });
    expect(await advance()).toMatchObject({ status: "waiting" });
    expect(writes).toEqual(["pull"]);
    checks = "SUCCESS";
    expect(await advance()).toMatchObject({ status: "ready" });
    expect(await advance()).toMatchObject({
      status: "merging",
      mergeRequestId: mergeRequest,
    });
    expect(await advance()).toMatchObject({ status: "merging" });
    expect(await advance()).toMatchObject({
      status: "merged",
      mergeOid: mergedOid,
    });
    expect(await advance()).toMatchObject({ status: "done" });
    expect(writes).toEqual(["pull", "merge", "close"]);
  },
);
