import { afterEach, describe, expect, it, vi } from "vitest";
import { githubReviewDocuments } from "../../src/providers/github/githubReviewDocuments.js";
import { handleGitHubApi } from "../../src/providers/github/handleGitHubApi.js";
import {
  type GitAuthEnv,
  GitSession,
} from "../../src/providers/github/GitSession.js";
import worker from "../../src/cloudflare/worker.js";

// The keybroker Worker serves the routes the hierarchidb BFF served.
const app = {
  request: (url: string, init: RequestInit, env: never) =>
    worker.fetch(new Request(url, init), env),
};

const bff = "https://bff.example.test";
const editor = "tw-editor://.";
const remote = "https://github.com/owner/project.git";
const proxy = "https://git.example.test";
const sha = "a".repeat(40);
const pullRequestNodeId = "PR_kwDOnode7";

type Operation = keyof typeof githubReviewDocuments;
type Fault =
  | "apply-then-502"
  | "apply-then-504"
  | "apply-then-drop"
  | "fail-502"
  | "unprocessable";
type FakeReview = {
  id: string;
  state: string;
  body: string;
  commit: string;
  comments: number;
  viewerDidAuthor: boolean;
  createdAt: string;
  submittedAt: string | null;
};

const ids = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

/**
 * A stateful GitHub stub (REST and GraphQL), the BFF's GitSession Durable Object with
 * serialized transactions and persistent storage, and the Git Worker's GitHub API handler.
 */
function fixture() {
  const records = new Map<string, unknown>();
  const instances = new Map<string, GitSession>();
  let queue: Promise<unknown> = Promise.resolve();
  const env = {
    GIT_ALLOWED_ORIGINS: editor,
    GIT_PROXY_ORIGIN: proxy,
    GIT_GITHUB_CLIENT_ID: "app",
    GIT_GITHUB_CLIENT_SECRET: "fixture",
    GIT_GITHUB_REDIRECT_URI: bff + "/v1/git-auth/callback",
    GIT_SESSION_KEY: "a".repeat(64),
  } as GitAuthEnv;
  const instance = (name: string) => {
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
        // Durable Object transactions on one object do not interleave.
        transaction: (callback: (tx: unknown) => Promise<unknown>) => {
          const run = queue.then(() => callback(storage));
          queue = run.catch(() => {});
          return run;
        },
      };
      object = new GitSession(
        { storage } as unknown as DurableObjectState,
        env,
      );
      instances.set(name, object);
    }
    return object;
  };
  env.GIT_SESSIONS = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (url: string, init: RequestInit) =>
        instance(name).fetch(new Request(url, init)),
    }),
  } as unknown as DurableObjectNamespace;

  const hub = {
    repositoryId: 42,
    graphqlRepositoryId: 42,
    lookupFault: null as Response | null,
    reviews: [] as FakeReview[],
    faults: new Map<Operation, Fault>(),
    hold: null as Promise<void> | null,
    nextId: 1,
  };
  const graphqlCalls: {
    operation: Operation;
    variables: { [key: string]: unknown };
  }[] = [];
  const mutations = (operation: Operation) =>
    graphqlCalls.filter((call) => call.operation === operation).length;
  const reviewNode = (review: FakeReview) => ({
    id: review.id,
    viewerDidAuthor: review.viewerDidAuthor,
    state: review.state,
    submittedAt: review.submittedAt,
    createdAt: review.createdAt,
    body: review.body,
    commit: { oid: review.commit },
    comments: { totalCount: review.comments },
  });
  const graphql = async (
    query: string,
    variables: { [key: string]: unknown },
  ) => {
    const operation = (Object.keys(githubReviewDocuments) as Operation[]).find(
      (name) => githubReviewDocuments[name] === query,
    );
    if (!operation) throw new Error("unexpected GraphQL document");
    graphqlCalls.push({ operation, variables });
    if (operation === "pullRequestReviewContext") {
      expect(variables).toEqual({
        owner: "owner",
        name: "project",
        number: variables.number,
      });
      const repository =
        variables.number === 7
          ? {
              databaseId: hub.graphqlRepositoryId,
              pullRequest: {
                id: pullRequestNodeId,
                headRefOid: sha,
                pending: {
                  nodes: hub.reviews
                    .filter((r) => r.state === "PENDING")
                    .map(reviewNode),
                },
                recent: { nodes: hub.reviews.slice(-30).map(reviewNode) },
              },
            }
          : { databaseId: hub.graphqlRepositoryId, pullRequest: null };
      return Response.json({
        data: { viewer: { login: "fixture-user" }, repository },
        ...(variables.number !== 7 && {
          errors: [{ type: "NOT_FOUND", message: "detail" }],
        }),
      });
    }
    if (hub.hold) await hub.hold;
    const fault = hub.faults.get(operation);
    hub.faults.delete(operation);
    if (fault === "fail-502") return new Response(null, { status: 502 });
    if (fault === "unprocessable")
      return Response.json({
        data: null,
        errors: [{ type: "UNPROCESSABLE", message: "detail" }],
      });
    let data: unknown;
    const review = hub.reviews.find(
      (candidate) => candidate.id === variables.reviewId,
    );
    if (operation === "addPullRequestReview") {
      expect(variables).toEqual({
        pullRequestId: pullRequestNodeId,
        commitOid: sha,
      });
      const created: FakeReview = {
        id: "PRR_node" + hub.nextId++,
        state: "PENDING",
        body: "",
        commit: String(variables.commitOid),
        comments: 0,
        viewerDidAuthor: true,
        createdAt: "2026-11-11T00:00:00Z",
        submittedAt: null,
      };
      hub.reviews.push(created);
      data = {
        addPullRequestReview: {
          pullRequestReview: {
            id: created.id,
            state: "PENDING",
            commit: { oid: created.commit },
            pullRequest: { id: pullRequestNodeId },
          },
        },
      };
    } else if (!review || review.state !== "PENDING") {
      return Response.json({
        data: null,
        errors: [{ type: "NOT_FOUND", message: "detail" }],
      });
    } else if (operation === "addPullRequestReviewThread") {
      review.comments += 1;
      data = {
        addPullRequestReviewThread: {
          thread: {
            id: "PRRT_" + review.comments,
            path: variables.path,
            subjectType: "FILE",
          },
        },
      };
    } else if (operation === "submitPullRequestReview") {
      review.state = {
        COMMENT: "COMMENTED",
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      }[String(variables.event)] as string;
      review.body = String(variables.body);
      review.submittedAt = "2026-11-11T00:01:00Z";
      data = {
        submitPullRequestReview: {
          pullRequestReview: {
            id: review.id,
            state: review.state,
            submittedAt: review.submittedAt,
            url: "https://github.com/owner/project/pull/7#pullrequestreview-1",
            commit: { oid: review.commit },
          },
        },
      };
    } else {
      hub.reviews = hub.reviews.filter((candidate) => candidate !== review);
      data = {
        deletePullRequestReview: { pullRequestReview: { id: review.id } },
      };
    }
    if (fault === "apply-then-502") return new Response(null, { status: 502 });
    if (fault === "apply-then-504") return new Response(null, { status: 504 });
    if (fault === "apply-then-drop") throw new TypeError("connection reset");
    return Response.json({ data });
  };
  const restPosts: string[] = [];
  const send = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "ghu_private",
        refresh_token: "ghr_private",
        expires_in: 60,
        refresh_token_expires_in: 7200,
      });
    if (input === "https://api.github.com/user")
      return Response.json({ login: "fixture-user" });
    if (input === "https://api.github.com/graphql") {
      const body = JSON.parse(String(init?.body));
      return graphql(body.query, body.variables);
    }
    if (input === "https://api.github.com/repos/owner/project") {
      if (hub.lookupFault) return hub.lookupFault;
      return Response.json({
        id: hub.repositoryId,
        full_name: "owner/project",
        permissions: { pull: true, push: false },
      });
    }
    if (input.startsWith("https://api.github.com/repos/owner/project/pulls")) {
      if (init?.method === "POST") {
        restPosts.push(String(init.body));
        if (hub.hold) await hub.hold;
        return Response.json({
          id: 11,
          state: "COMMENTED",
          commit_id: sha,
          submitted_at: "2026-11-11T00:00:00Z",
          html_url:
            "https://github.com/owner/project/pull/7#pullrequestreview-11",
        });
      }
      return Response.json([]);
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", send);

  const auth = (path: string, init: RequestInit = {}) =>
    app.request(
      bff + "/v1/git-auth" + path,
      { ...init, headers: { Origin: editor, ...init.headers } },
      env as never,
    );
  const login = async (review?: unknown) => {
    const start = await auth("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote,
        write: false,
        ...(review !== undefined && { review }),
      }),
    });
    if (start.status !== 200)
      return { status: start.status, state: "", ticket: "", bearer: "" };
    const { authorizationUrl, ticket } = await start.json();
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    expect(
      (await auth("/callback?code=fixture-code&state=" + state)).status,
    ).toBe(200);
    const session = await (
      await auth("/session", { headers: { Authorization: "Bearer " + ticket } })
    ).json();
    return { status: 200, state, ticket, bearer: session.bearer as string };
  };
  const workerEnv = {
    GIT_ALLOWED_ORIGINS: editor,
    GIT_PROXY_ORIGIN: proxy,
    GIT_GITHUB_API: "pulls-read,review-threads,reviews-body",
    GIT_SESSIONS: env.GIT_SESSIONS,
  };
  const api = (
    bearer: string,
    path: string,
    value?: unknown,
    submitId?: string,
  ): Promise<Response> => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    return handleGitHubApi(
      new Request(proxy + "/v1/github/owner/project" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: editor,
          Authorization: "Bearer " + bearer,
          ...(body !== undefined && {
            "Content-Type": "application/json",
            "Content-Length": String(new TextEncoder().encode(body).byteLength),
          }),
          ...(submitId && { "Review-Submit-Id": submitId }),
        },
        body,
      }),
      workerEnv,
      send as typeof fetch,
    );
  };
  const step = {
    context: (bearer: string, submitId?: string, number = 7) =>
      api(bearer, "/graphql/pullRequestReviewContext", { number }, submitId),
    start: (bearer: string, submitId: string, number = 7) =>
      api(
        bearer,
        "/graphql/addPullRequestReview",
        { number, commitOid: sha },
        submitId,
      ),
    thread: (
      bearer: string,
      submitId: string,
      threadIndex: number,
      number = 7,
    ) =>
      api(
        bearer,
        "/graphql/addPullRequestReviewThread",
        {
          number,
          threadIndex,
          path: "projects/a/project.source.json",
          body: "Stage: comment " + threadIndex,
        },
        submitId,
      ),
    submit: (
      bearer: string,
      submitId: string,
      threadCount: number,
      event = "COMMENT",
    ) =>
      api(
        bearer,
        "/graphql/submitPullRequestReview",
        { number: 7, threadCount, event, body: "Overall" },
        submitId,
      ),
    remove: (bearer: string, submitId: string) =>
      api(bearer, "/graphql/deletePullRequestReview", { number: 7 }, submitId),
  };
  const lookups = () =>
    send.mock.calls.filter(
      ([url]) => url === "https://api.github.com/repos/owner/project",
    ).length;
  const restart = () => instances.clear();
  return {
    env,
    records,
    hub,
    graphqlCalls,
    mutations,
    restPosts,
    send,
    auth,
    login,
    api,
    step,
    lookups,
    restart,
    instance,
  };
}

const codeOf = async (response: Response) => [
  response.status,
  (await response.json()).code,
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub API review submits through the BFF session", () => {
  it("requires the separate review grant for review submits", async () => {
    const { login, step, api, mutations, restPosts } = fixture();
    expect((await login("yes")).status).toBe(400);
    const { bearer } = await login();
    expect((await step.context(bearer)).status).toBe(200);
    expect((await api(bearer, "/pulls")).status).toBe(200);
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    expect(
      await codeOf(
        await api(
          bearer,
          "/pulls/7/reviews",
          { commit_id: sha, event: "COMMENT", body: "x" },
          ids(2),
        ),
      ),
    ).toEqual([403, "FORBIDDEN"]);
    expect(mutations("addPullRequestReview")).toBe(0);
    expect(restPosts).toHaveLength(0);
  });

  it("checks the repository ID on every request and resolves node IDs only in the proxy", async () => {
    const { login, step, api, hub, mutations, graphqlCalls, lookups } =
      fixture();
    const { bearer } = await login(true);
    const before = lookups();
    const started = await step.start(bearer, ids(1));
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ state: "PENDING", commitOid: sha });
    const responses = [
      await step.thread(bearer, ids(1), 0),
      await step.thread(bearer, ids(1), 1),
      await step.submit(bearer, ids(1), 2),
      await step.context(bearer, ids(1)),
    ];
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(bodies[0]).toEqual({ threads: 1 });
    expect(bodies[1]).toEqual({ threads: 2 });
    expect(bodies[2]).toMatchObject({ state: "COMMENTED", commitOid: sha });
    expect(bodies[3]).toMatchObject({
      pendingReview: null,
      reviews: [{ state: "COMMENTED", commitOid: sha, ours: true }],
      submit: { state: "submitted", threads: 2 },
    });
    expect(JSON.stringify(bodies)).not.toMatch(/PRR?_/u);
    expect(lookups() - before).toBe(5);
    expect(
      [
        "addPullRequestReview",
        "addPullRequestReviewThread",
        "submitPullRequestReview",
      ].map((op) => mutations(op as never)),
    ).toEqual([1, 2, 1]);
    const reviewIds = new Set(
      graphqlCalls
        .filter((call) => "reviewId" in call.variables)
        .map((call) => call.variables.reviewId),
    );
    expect([...reviewIds]).toEqual(["PRR_node1"]);

    hub.repositoryId = 43;
    expect(await codeOf(await api(bearer, "/pulls"))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    expect(await codeOf(await step.start(bearer, ids(2)))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    hub.repositoryId = 42;
    hub.graphqlRepositoryId = 43;
    expect(await codeOf(await step.start(bearer, ids(3)))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    expect(mutations("addPullRequestReview")).toBe(1);
    hub.graphqlRepositoryId = 42;
    expect(await codeOf(await step.context(bearer, undefined, 99))).toEqual([
      404,
      "PULL_REQUEST_NOT_FOUND",
    ]);
    hub.lookupFault = new Response(null, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "42" },
    });
    const limited = await api(bearer, "/pulls/7");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 42,
    });
  });

  it("sends each step at most once when the same submit ID arrives concurrently", async () => {
    const { login, step, hub, mutations } = fixture();
    const { bearer } = await login(true);
    const race = async (send: () => Promise<Response>) => {
      let release = () => {};
      hub.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const watch = (promise: Promise<Response>) =>
        promise.then((response) => {
          if (response.status === 409) release();
          return response;
        });
      const results = await Promise.all([watch(send()), watch(send())]);
      hub.hold = null;
      return Promise.all(results.map(codeOf));
    };
    const sorted = (values: unknown[][]) =>
      values.sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(sorted(await race(() => step.start(bearer, ids(1))))).toEqual([
      [200, undefined],
      [409, "REVIEW_DUPLICATE"],
    ]);
    expect(sorted(await race(() => step.thread(bearer, ids(1), 0)))).toEqual([
      [200, undefined],
      [409, "REVIEW_DUPLICATE"],
    ]);
    expect(sorted(await race(() => step.submit(bearer, ids(1), 1)))).toEqual([
      [200, undefined],
      [409, "REVIEW_DUPLICATE"],
    ]);
    expect(mutations("addPullRequestReview")).toBe(1);
    expect(mutations("addPullRequestReviewThread")).toBe(1);
    expect(mutations("submitPullRequestReview")).toBe(1);
  });

  it("refuses resends after a disconnect and resolves the unknown outcome by reading GitHub", async () => {
    const { login, step, hub, mutations } = fixture();
    const { bearer } = await login(true);

    // Start: GitHub created the pending review, but the response was lost.
    hub.faults.set("addPullRequestReview", "apply-then-504");
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      504,
      "UPSTREAM_TIMEOUT",
    ]);
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect(await codeOf(await step.remove(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    const found = await (await step.context(bearer, ids(1))).json();
    expect(found).toMatchObject({
      pendingReview: { ours: true, commitOid: sha },
      submit: { state: "pending", threads: 0 },
    });

    // Thread: GitHub added the thread, but the connection dropped.
    hub.faults.set("addPullRequestReviewThread", "apply-then-drop");
    expect(await codeOf(await step.thread(bearer, ids(1), 0))).toEqual([
      502,
      "UPSTREAM_FAILURE",
    ]);
    expect(await codeOf(await step.thread(bearer, ids(1), 0))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect(await codeOf(await step.submit(bearer, ids(1), 0))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(await (await step.remove(bearer, ids(1))).json()).toEqual({
      deleted: true,
    });
    expect(await codeOf(await step.remove(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect(hub.reviews).toHaveLength(0);

    // Submit: GitHub published the review, but answered 502.
    expect((await step.start(bearer, ids(2))).status).toBe(200);
    hub.faults.set("submitPullRequestReview", "apply-then-502");
    expect(await codeOf(await step.submit(bearer, ids(2), 0))).toEqual([
      502,
      "UPSTREAM_FAILURE",
    ]);
    expect(await codeOf(await step.submit(bearer, ids(2), 0))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    const published = await (await step.context(bearer, ids(2))).json();
    expect(published).toMatchObject({
      pendingReview: null,
      submit: { state: "submitted" },
    });
    expect(published.reviews.at(0)).toMatchObject({
      state: "COMMENTED",
      ours: true,
    });
    expect(await codeOf(await step.submit(bearer, ids(2), 0))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);

    // Submit: GitHub did not publish before the 502; the check reports the review as pending.
    expect((await step.start(bearer, ids(3))).status).toBe(200);
    hub.faults.set("submitPullRequestReview", "fail-502");
    expect(await codeOf(await step.submit(bearer, ids(3), 0))).toEqual([
      502,
      "UPSTREAM_FAILURE",
    ]);
    expect(await (await step.context(bearer, ids(3))).json()).toMatchObject({
      pendingReview: { ours: true },
      submit: { state: "pending" },
    });
    expect((await step.submit(bearer, ids(3), 0)).status).toBe(200);

    // Submit: unknown, and the user discarded the pending review on GitHub meanwhile.
    expect((await step.start(bearer, ids(4))).status).toBe(200);
    hub.faults.set("submitPullRequestReview", "fail-502");
    expect((await step.submit(bearer, ids(4), 0)).status).toBe(502);
    hub.reviews = hub.reviews.filter((review) => review.state !== "PENDING");
    expect(await (await step.context(bearer, ids(4))).json()).toMatchObject({
      pendingReview: null,
      submit: { state: "closed" },
    });

    // Start: GitHub created nothing before the 502.
    hub.faults.set("addPullRequestReview", "fail-502");
    expect((await step.start(bearer, ids(5))).status).toBe(502);
    expect(await (await step.context(bearer, ids(5))).json()).toMatchObject({
      pendingReview: null,
      submit: { state: "closed" },
    });
    expect(mutations("addPullRequestReview")).toBe(5);
    expect(mutations("submitPullRequestReview")).toBe(4);
  });

  it("keeps records across a Worker restart and settles a step left in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    const { login, step, restart, env, mutations, hub } = fixture();
    const { bearer, state } = await login(true);
    expect((await step.start(bearer, ids(1))).status).toBe(200);
    expect((await step.thread(bearer, ids(1), 0)).status).toBe(200);
    restart();
    expect(await codeOf(await step.thread(bearer, ids(1), 0))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);

    // The Worker reserved the submit step and stopped before it reached GitHub.
    if (!env.GIT_SESSIONS) throw new Error("missing fixture binding");
    const stub = env.GIT_SESSIONS.get(env.GIT_SESSIONS.idFromName(state));
    const reserved = await stub.fetch(
      "https://git-session.internal/authorize",
      {
        method: "POST",
        body: JSON.stringify({
          credential: bearer.split(".")[1],
          origin: editor,
          owner: "owner",
          repo: "project",
          operation: "review",
          submit: { id: ids(1), step: "submit", number: 7, threadCount: 1 },
        }),
      },
    );
    expect(await reserved.json()).toMatchObject({
      submit: { state: "submitting" },
    });
    restart();
    expect(await codeOf(await step.submit(bearer, ids(1), 1))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect(await (await step.context(bearer, ids(1))).json()).toMatchObject({
      submit: { state: "submitting" },
    });
    vi.setSystemTime(new Date("2026-11-11T00:01:01Z"));
    expect(await (await step.context(bearer, ids(1))).json()).toMatchObject({
      pendingReview: { ours: true },
      submit: { state: "pending", threads: 1 },
    });
    const result = await step.submit(bearer, ids(1), 1);
    expect(result.status).toBe(200);
    expect(mutations("submitPullRequestReview")).toBe(1);
    expect(hub.reviews[0]?.state).toBe("COMMENTED");
  });

  it("rejects out-of-order steps, count mismatches and another pull request", async () => {
    const { login, step, api, hub, mutations, records } = fixture();
    const { bearer } = await login(true);
    expect(await codeOf(await step.thread(bearer, ids(1), 0))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(await codeOf(await step.context(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect((await step.start(bearer, ids(1))).status).toBe(200);
    expect(await codeOf(await step.thread(bearer, ids(1), 1))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(await codeOf(await step.submit(bearer, ids(1), 1))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(await codeOf(await step.thread(bearer, ids(1), 0, 8))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(await codeOf(await step.start(bearer, ids(2)))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect(
      await codeOf(
        await api(
          bearer,
          "/pulls/7/reviews",
          { commit_id: sha, event: "COMMENT", body: "x" },
          ids(1),
        ),
      ),
    ).toEqual([409, "REVIEW_DUPLICATE"]);
    hub.faults.set("addPullRequestReviewThread", "unprocessable");
    expect(await codeOf(await step.thread(bearer, ids(1), 0))).toEqual([
      422,
      "REVIEW_THREAD_REJECTED",
    ]);
    expect(await codeOf(await step.submit(bearer, ids(1), 0))).toEqual([
      409,
      "REVIEW_STEP_CONFLICT",
    ]);
    expect((await step.remove(bearer, ids(1))).status).toBe(200);
    hub.faults.set("submitPullRequestReview", "unprocessable");
    expect((await step.start(bearer, ids(3))).status).toBe(200);
    expect(
      await codeOf(await step.submit(bearer, ids(3), 0, "APPROVE")),
    ).toEqual([422, "REVIEW_REJECTED"]);
    expect((await step.submit(bearer, ids(3), 0)).status).toBe(200);
    expect(mutations("addPullRequestReviewThread")).toBe(1);
    expect(mutations("submitPullRequestReview")).toBe(2);
    expect(records.size).toBeGreaterThan(0);
  });

  it("does not add to an existing pending review of the viewer", async () => {
    const { login, step, hub, mutations } = fixture();
    const { bearer } = await login(true);
    hub.reviews.push({
      id: "PRR_manual",
      state: "PENDING",
      body: "",
      commit: sha,
      comments: 1,
      viewerDidAuthor: true,
      createdAt: "2026-11-10T00:00:00Z",
      submittedAt: null,
    });
    const context = await (await step.context(bearer)).json();
    expect(context.pendingReview).toEqual({
      ours: false,
      commitOid: sha,
      createdAt: "2026-11-10T00:00:00Z",
    });
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      409,
      "PENDING_REVIEW_EXISTS",
    ]);
    expect(mutations("addPullRequestReview")).toBe(0);
    expect(await (await step.context(bearer, ids(1))).json()).toMatchObject({
      submit: { state: "closed" },
    });
    expect(await codeOf(await step.start(bearer, ids(1)))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    hub.reviews = [];
    expect((await step.start(bearer, ids(2))).status).toBe(200);
    expect(mutations("addPullRequestReview")).toBe(1);
  });

  it("reserves REST review submit IDs once and caps the records of a login", async () => {
    const { login, api, hub, restPosts, records } = fixture();
    const { bearer, state } = await login(true);
    const create = () =>
      api(
        bearer,
        "/pulls/7/reviews",
        { commit_id: sha, event: "APPROVE" },
        ids(1),
      );
    let release = () => {};
    hub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results = await Promise.all(
      [create(), create()].map((promise) =>
        promise.then(async (response) => {
          if (response.status === 409) release();
          return codeOf(response);
        }),
      ),
    );
    hub.hold = null;
    expect(results.sort((a, b) => a[0] - b[0])).toEqual([
      [200, undefined],
      [409, "REVIEW_DUPLICATE"],
    ]);
    expect(restPosts).toEqual([
      JSON.stringify({ commit_id: sha, event: "APPROVE" }),
    ]);
    records.set(
      state + "review-ids",
      Array.from({ length: 256 }, (_, index) => ids(index + 1)),
    );
    expect(
      await codeOf(
        await api(
          bearer,
          "/pulls/7/reviews",
          { commit_id: sha, event: "APPROVE" },
          ids(999),
        ),
      ),
    ).toEqual([429, "RATE_LIMITED"]);
    expect(
      await codeOf(
        await api(
          bearer,
          "/graphql/addPullRequestReview",
          { number: 7, commitOid: sha },
          ids(998),
        ),
      ),
    ).toEqual([429, "RATE_LIMITED"]);
    expect(restPosts).toHaveLength(1);
  });

  it("keeps records through Bearer renewal and removes them on revoke and expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    const { login, step, auth, records, instance, hub } = fixture();
    const first = await login(true);
    expect((await step.start(first.bearer, ids(1))).status).toBe(200);
    expect([...records.keys()]).toContain(first.state + "review-submits");
    vi.setSystemTime(new Date("2026-11-11T00:05:01Z"));
    expect(await codeOf(await step.thread(first.bearer, ids(1), 0))).toEqual([
      401,
      "SESSION_EXPIRED",
    ]);
    const headers = { Authorization: "Bearer " + first.ticket };
    const renewed = (await (await auth("/session", { headers })).json())
      .bearer as string;
    expect(renewed).not.toBe(first.bearer);
    expect((await step.thread(renewed, ids(1), 0)).status).toBe(200);
    expect(await codeOf(await step.thread(renewed, ids(1), 0))).toEqual([
      409,
      "REVIEW_DUPLICATE",
    ]);
    expect((await auth("/session", { method: "DELETE", headers })).status).toBe(
      204,
    );
    expect(await codeOf(await step.submit(renewed, ids(1), 1))).toEqual([
      401,
      "SESSION_REQUIRED",
    ]);
    expect(
      [...records.keys()].filter((key) => key.startsWith(first.state)),
    ).toEqual([]);

    // The revoked login left its pending review on GitHub; the user discarded it there.
    hub.reviews = [];
    const second = await login(true);
    expect((await step.start(second.bearer, ids(1))).status).toBe(200);
    expect([...records.keys()]).toContain(second.state + "review-submits");
    vi.setSystemTime(new Date("2026-11-11T03:00:00Z"));
    await instance(second.state).alarm();
    expect(
      [...records.keys()].filter((key) => key.startsWith(second.state)),
    ).toEqual([]);
  });
});
