import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubReviewDocuments,
  pullRequestPublicationStatusDocument,
} from "../../src/providers/github/githubReviewDocuments.js";
import {
  handleGitHubApi,
  isGitHubApiPath,
} from "../../src/providers/github/handleGitHubApi.js";
import { isGitProxyPath } from "../../src/providers/github/handleGitProxy.js";

const origin = "tw-editor://.";
const host = "https://git.example.test";
const root = host + "/v1/github/owner/project";
const bearer = "Bearer " + "a".repeat(43) + "." + "b".repeat(43);
const submitId = "00000000-0000-4000-8000-000000000001";
const sha = "a".repeat(40);
const attempt = "c".repeat(43);
const publicationUrl = root + "/pulls/7/publication-status";

type Json = { [key: string]: unknown };

function pullSummary(number: number) {
  return {
    number,
    title: "Title " + number,
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-11-11T00:00:00Z",
    user: { login: "author", id: 1, node_id: "U_author" },
    head: {
      sha,
      ref: "feature",
      label: "owner:feature",
      repo: { full_name: "owner/project" },
    },
    base: {
      sha: "b".repeat(40),
      ref: "main",
      repo: { full_name: "owner/project" },
    },
    node_id: "PR_node",
    _links: { self: { href: "https://api.github.com/x" } },
  };
}

function publicationData(pull: Json = {}, repositoryId = 42) {
  return {
    repository: {
      databaseId: repositoryId,
      pullRequest: {
        number: 7,
        state: "OPEN",
        mergedAt: null,
        isDraft: false,
        headRefName: "feature",
        headRefOid: sha,
        headRepository: { databaseId: 42 },
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        statusCheckRollup: {
          commit: { oid: sha },
          state: "SUCCESS",
          contexts: { totalCount: 3 },
        },
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
        body: "must not be relayed",
        ...pull,
      },
    },
  };
}

function fixture({
  features = "pulls-read,review-threads,reviews-body",
  allowReview = true,
}: {
  features?: string | null;
  allowReview?: boolean;
} = {}) {
  const reserved = new Set<string>();
  const resolve = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Json;
    if (url.endsWith("/review-result"))
      return Response.json({ state: "pending", threads: 0 });
    if (body.credential !== "b".repeat(43))
      return Response.json({ code: "SESSION_REQUIRED" }, { status: 401 });
    if (body.operation === "review" && !allowReview)
      return Response.json({ code: "FORBIDDEN" }, { status: 403 });
    const reviewId = body.reviewId as string | undefined;
    if (reviewId) {
      if (reserved.has(reviewId))
        return Response.json({ code: "REVIEW_DUPLICATE" }, { status: 409 });
      reserved.add(reviewId);
    }
    const submit = body.submit as Json | undefined;
    return Response.json({
      owner: "owner",
      repo: "project",
      accessToken: "ghu_private",
      repositoryId: 42,
      ...(reviewId && { reviewId }),
      ...(submit && {
        submit: {
          id: submit.id,
          state: {
            start: "starting",
            thread: "threading",
            submit: "submitting",
            delete: "deleting",
            context: "pending",
          }[submit.step as string],
          number: submit.number,
          commitOid: sha,
          threads: 0,
          attempt,
          pullRequestNodeId: submit.step === "start" ? null : "PR_node",
          reviewNodeId: submit.step === "start" ? null : "PRR_node",
        },
      }),
    });
  });
  const env = {
    GIT_PROXY_ORIGIN: host,
    GIT_ALLOWED_ORIGINS: origin + ",https://editor.example.test",
    ...(features !== null && { GIT_GITHUB_API: features }),
    GIT_SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: resolve }),
    } as unknown as DurableObjectNamespace,
  };
  const graphql = vi.fn((_query: string, _variables: Json): Response =>
    Response.json({ data: { viewer: { login: "reviewer" } } }),
  );
  const send = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === "https://api.github.com/graphql") {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Json;
        };
        return graphql(body.query, body.variables);
      }
      const path = new URL(url).pathname;
      if (path === "/repos/owner/project/pulls")
        return Response.json([pullSummary(1), pullSummary(2)], {
          headers: {
            "Set-Cookie": "unsafe=1",
            "x-ratelimit-remaining": "4999",
            Link: "<x>",
          },
        });
      if (path === "/repos/owner/project/pulls/7")
        return Response.json({
          ...pullSummary(7),
          body_text: "plain",
          body: "markdown",
          changed_files: 3,
          head: { sha, ref: "feature", repo: null },
          base: {
            sha,
            ref: "main",
            repo: { full_name: "owner/project", private: true },
          },
          merge_commit_sha: "x",
        });
      if (
        path === "/repos/owner/project/pulls/7/reviews" &&
        init?.method === "POST"
      )
        return Response.json({
          id: 11,
          node_id: "PRR_rest",
          state: "COMMENTED",
          commit_id: sha,
          submitted_at: "2026-11-11T00:00:00Z",
          html_url:
            "https://github.com/owner/project/pull/7#pullrequestreview-11",
          body: "hidden",
          user: { login: "reviewer" },
        });
      if (path === "/repos/owner/project/pulls/7/reviews")
        return Response.json([
          {
            id: 10,
            node_id: "PRR_x",
            user: { login: "reviewer" },
            commit_id: sha,
            state: "APPROVED",
            submitted_at: "2026-11-11T00:00:00Z",
            body: "",
            html_url: "x",
          },
        ]);
      return new Response(null, { status: 404 });
    },
  );
  const call = (
    url: string,
    { headers, ...init }: RequestInit = {},
    allowedOrigin: string | null = origin,
  ) =>
    handleGitHubApi(
      new Request(url, {
        ...init,
        headers: {
          ...(allowedOrigin !== null && { Origin: allowedOrigin }),
          ...headers,
        },
      }),
      env,
      send as typeof fetch,
    );
  const post = (
    url: string,
    value: unknown,
    headers: Record<string, string> = {},
  ) => {
    const body = JSON.stringify(value);
    return call(url, {
      method: "POST",
      body,
      headers: {
        Authorization: bearer,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).byteLength),
        "Review-Submit-Id": submitId,
        ...headers,
      },
    });
  };
  return { env, call, post, resolve, send, graphql };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub API routes of the Git Worker", () => {
  it("reads a single fixed publication query for the session repository and PR", async () => {
    const { call, resolve, graphql, send } = fixture({
      features: "checks-read",
    });
    graphql.mockReturnValueOnce(
      Response.json(
        { data: publicationData() },
        { headers: { "Set-Cookie": "secret=1" } },
      ),
    );
    const response = await call(publicationUrl, {
      headers: { Authorization: bearer },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await response.json()).toEqual({
      repositoryId: 42,
      number: 7,
      state: "OPEN",
      mergedAt: null,
      draft: false,
      head: { ref: "feature", sha, repositoryId: 42 },
      base: { ref: "main", sha: "b".repeat(40) },
      checks: { state: "SUCCESS", totalCount: 3 },
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    });
    expect(resolve.mock.calls).toHaveLength(1);
    const authCall = resolve.mock.calls[0];
    expect(authCall?.[0]).toBe("https://git-session.internal/authorize");
    expect(JSON.parse(String(authCall?.[1].body))).toEqual({
      credential: "b".repeat(43),
      origin,
      owner: "owner",
      repo: "project",
      operation: "read",
    });
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0]?.[0]).toBe("https://api.github.com/graphql");
    expect(graphql).toHaveBeenCalledExactlyOnceWith(
      pullRequestPublicationStatusDocument,
      {
        owner: "owner",
        name: "project",
        number: 7,
      },
    );
    expect(pullRequestPublicationStatusDocument).toMatch(/^query /u);
    expect(pullRequestPublicationStatusDocument).toContain(
      "followRenames: false",
    );
  });

  it("keeps missing and empty check rollups distinct from successful CI", async () => {
    const { call, graphql } = fixture({ features: "checks-read" });
    for (const statusCheckRollup of [
      null,
      { commit: { oid: sha }, state: "SUCCESS", contexts: { totalCount: 0 } },
    ]) {
      graphql.mockReturnValueOnce(
        Response.json({
          data: publicationData({
            state: "MERGED",
            mergedAt: "2026-11-12T12:00:00Z",
            headRepository: null,
            reviewDecision: null,
            mergeStateStatus: "UNKNOWN",
            mergeable: "UNKNOWN",
            statusCheckRollup,
          }),
        }),
      );
      const response = await call(publicationUrl, {
        headers: { Authorization: bearer },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: "MERGED",
        mergedAt: "2026-11-12T12:00:00Z",
        head: { repositoryId: null },
        checks: { state: null, totalCount: 0 },
        reviewDecision: null,
        mergeable: "UNKNOWN",
      });
    }
  });

  it("rejects mismatched repository ID, pull number and check head", async () => {
    const { call, graphql } = fixture({ features: "checks-read" });
    for (const [data, status, code] of [
      [publicationData({}, 43), 403, "FORBIDDEN"],
      [publicationData({ number: 8 }), 502, "UPSTREAM_FAILURE"],
      [
        publicationData({
          statusCheckRollup: {
            commit: { oid: "c".repeat(40) },
            state: "SUCCESS",
            contexts: { totalCount: 3 },
          },
        }),
        502,
        "UPSTREAM_FAILURE",
      ],
      [
        { repository: { databaseId: 42, pullRequest: null } },
        404,
        "PULL_REQUEST_NOT_FOUND",
      ],
    ] as const) {
      graphql.mockReturnValueOnce(Response.json({ data }));
      const response = await call(publicationUrl, {
        headers: { Authorization: bearer },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  it("enables the publication read independently and rejects caller-supplied writes and queries", async () => {
    const off = fixture({ features: "pulls-read,review-threads" });
    const headers = { Authorization: bearer };
    expect((await off.call(publicationUrl, { headers })).status).toBe(404);
    expect(
      (
        await off.post(root + "/graphql/pullRequestPublicationStatus", {
          number: 7,
        })
      ).status,
    ).toBe(400);
    expect(off.resolve).not.toHaveBeenCalled();
    const { call, post, resolve, send } = fixture({ features: "checks-read" });
    for (const url of [
      publicationUrl + "?sha=" + sha,
      root + "/pulls/2147483648/publication-status",
      root + "/pulls/0/publication-status",
      root + "/pulls/7/merge",
    ])
      expect((await call(url, { headers })).status).toBe(400);
    expect(
      (await post(publicationUrl, { query: "mutation { x }" })).status,
    ).toBe(400);
    expect(
      (await call(publicationUrl, { method: "PUT", headers })).status,
    ).toBe(400);
    expect(
      (await call(publicationUrl, { method: "DELETE", headers })).status,
    ).toBe(400);
    expect(
      (
        await call(publicationUrl, {
          headers: { ...headers, "Review-Submit-Id": submitId },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(publicationUrl, { headers }, "https://other.example.test"))
        .status,
    ).toBe(403);
    expect((await call(publicationUrl)).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a status preflight and stops when the Git session rejects repository access", async () => {
    const { call, resolve, send } = fixture({ features: "checks-read" });
    const preflight = await call(publicationUrl, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe(
      "authorization",
    );
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockResolvedValueOnce(
      Response.json({ code: "FORBIDDEN" }, { status: 403 }),
    );
    expect(
      (await call(publicationUrl, { headers: { Authorization: bearer } }))
        .status,
    ).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("is unavailable without GIT_GITHUB_API and fails loudly on an unknown value", async () => {
    const off = fixture({ features: null });
    for (const url of [
      root + "/pulls",
      root + "/graphql/addPullRequestReview",
      root + "/x",
    ]) {
      const response = await off.call(url, {
        headers: { Authorization: bearer },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "GITHUB_API_UNAVAILABLE",
      });
    }
    const invalid = fixture({ features: "pulls-read,pulls-write" });
    expect(
      (
        await invalid.call(root + "/pulls", {
          headers: { Authorization: bearer },
        })
      ).status,
    ).toBe(500);
    expect(off.resolve).not.toHaveBeenCalled();
    expect(off.send).not.toHaveBeenCalled();
  });

  it("stops only the GraphQL routes when review-threads is removed", async () => {
    const { call, post, send } = fixture({
      features: "pulls-read,reviews-body",
    });
    const graphql = await post(root + "/graphql/addPullRequestReview", {
      number: 7,
      commitOid: sha,
    });
    expect(graphql.status).toBe(404);
    expect(await graphql.json()).toMatchObject({
      code: "GITHUB_API_UNAVAILABLE",
    });
    expect(
      (await call(root + "/pulls", { headers: { Authorization: bearer } }))
        .status,
    ).toBe(200);
    expect(
      (
        await post(root + "/pulls/7/reviews", {
          commit_id: sha,
          event: "COMMENT",
          body: "ok",
        })
      ).status,
    ).toBe(200);
    expect(send.mock.calls.some(([url]) => url.endsWith("/graphql"))).toBe(
      false,
    );
    const readOnly = fixture({ features: "pulls-read" });
    expect(
      (
        await readOnly.call(root + "/pulls/7/reviews", {
          headers: { Authorization: bearer },
        })
      ).status,
    ).toBe(404);
  });

  it("owns the /v1/github namespace separately from /v1/git/", () => {
    expect(isGitHubApiPath("/v1/github")).toBe(true);
    expect(isGitHubApiPath("/v1/github/owner/project/pulls")).toBe(true);
    for (const path of [
      "/v1/git/owner/project.git/git-upload-pack",
      "/v1/githubx",
      "/",
    ])
      expect(isGitHubApiPath(path)).toBe(false);
    expect(isGitProxyPath("/v1/github/owner/project/pulls")).toBe(false);
  });

  it("answers preflights with the route method and permitted headers only", async () => {
    const { call, resolve, send } = fixture();
    for (const [url, method, requested] of [
      [root + "/pulls?page=2", "GET", "authorization"],
      [root + "/pulls/7", "GET", "authorization"],
      [root + "/pulls/7/reviews", "GET", "authorization"],
      [
        root + "/pulls/7/reviews",
        "POST",
        "authorization, content-type, review-submit-id",
      ],
      [
        root + "/graphql/submitPullRequestReview",
        "POST",
        "authorization, content-type, review-submit-id",
      ],
    ] as const) {
      const response = await call(url, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": requested,
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(method);
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        method === "GET"
          ? "authorization"
          : "authorization, content-type, review-submit-id",
      );
    }
    const forbidden = await call(root + "/pulls", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, review-submit-id",
      },
    });
    expect(forbidden.status).toBe(403);
    const wrongMethod = await call(root + "/pulls/7", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "POST" },
    });
    expect(wrongMethod.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects other methods, paths, queries, operations, keys and types before egress", async () => {
    const { call, post, resolve, send } = fixture();
    const get = (url: string, init: RequestInit = {}) =>
      call(url, {
        ...init,
        headers: { Authorization: bearer, ...init.headers },
      });
    const badGets = [
      root + "/pulls?page=0",
      root + "/pulls?page=51",
      root + "/pulls?page=1&page=2",
      root + "/pulls?page=1&state=open",
      root + "/pulls?state=open",
      root + "/pulls?page=01",
      root + "/pulls/",
      root + "//pulls",
      root + "/pulls/0",
      root + "/pulls/2147483648",
      root + "/pulls/7?page=1",
      root + "/pulls/7/reviews?page=11",
      root + "/pulls/7/files",
      root + "/pulls/7/comments",
      host + "/v1/github/owner/project.git/pulls",
      host + "/v1/github/owner/../pulls",
      host + "/v1/github/-owner/project/pulls",
      host + "/v1/github/owner/pro%6aect/pulls",
      host + "/v1/github/owner/project",
      root + "/graphql",
      root + "/graphql/addPullRequestReview",
      root + "/graphql/anyQuery",
      host + "/v1/github",
    ];
    for (const url of badGets) {
      const response = await get(url);
      expect([url, response.status]).toEqual([url, 400]);
      expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      expect((await get(root + "/pulls/7", { method })).status).toBe(400);
    }
    expect(
      (
        await get(root + "/pulls", {
          headers: { "Review-Submit-Id": submitId },
        })
      ).status,
    ).toBe(400);
    const badPosts: [string, unknown, Record<string, string>?][] = [
      [root + "/graphql/unknownOperation", { number: 7 }],
      [root + "/graphql/pullRequestReviewContext?x=1", { number: 7 }],
      [
        root + "/graphql/pullRequestReviewContext",
        { number: 7, query: "{ viewer { login } }" },
      ],
      [root + "/graphql/pullRequestReviewContext", { number: "7" }],
      [root + "/graphql/pullRequestReviewContext", { number: 0 }],
      [root + "/graphql/pullRequestReviewContext", { number: 2_147_483_648 }],
      [root + "/graphql/pullRequestReviewContext", [7]],
      [
        root + "/graphql/addPullRequestReview",
        { number: 7, commitOid: sha, pullRequestId: "PR_x" },
      ],
      [
        root + "/graphql/addPullRequestReview",
        { number: 7, commitOid: sha.toUpperCase() },
      ],
      [root + "/graphql/addPullRequestReview", { number: 7 }],
      [
        root + "/graphql/addPullRequestReview",
        { number: 7, commitOid: sha },
        { "Review-Submit-Id": "" },
      ],
      [
        root + "/graphql/addPullRequestReview",
        { number: 7, commitOid: sha },
        { "Review-Submit-Id": "0000000A-0000-4000-8000-00000000000B" },
      ],
      [
        root + "/graphql/addPullRequestReview",
        { number: 7, commitOid: sha },
        { "Review-Submit-Id": submitId + ", " + submitId },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "project.source.json",
          body: "x",
          reviewId: "PRR_x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        { number: 7, threadIndex: 50, path: "project.source.json", body: "x" },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        { number: 7, threadIndex: 0.5, path: "project.source.json", body: "x" },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        { number: 7, threadIndex: 0, path: "a/project.source.json", body: "" },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        { number: 7, threadIndex: 0, path: "a/project.json", body: "x" },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "/a/project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "a//project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "../project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "a\\project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "a\nb/project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "x".repeat(1010) + "/project.source.json",
          body: "x",
        },
      ],
      [
        root + "/graphql/addPullRequestReviewThread",
        {
          number: 7,
          threadIndex: 0,
          path: "project.source.json",
          body: "x".repeat(65_537),
        },
      ],
      [
        root + "/graphql/submitPullRequestReview",
        { number: 7, threadCount: 0, event: "DISMISS", body: "x" },
      ],
      [
        root + "/graphql/submitPullRequestReview",
        { number: 7, threadCount: 0, event: "COMMENT", body: "" },
      ],
      [
        root + "/graphql/submitPullRequestReview",
        { number: 7, threadCount: 1, event: "REQUEST_CHANGES", body: "" },
      ],
      [
        root + "/graphql/submitPullRequestReview",
        { number: 7, threadCount: 51, event: "APPROVE", body: "" },
      ],
      [
        root + "/graphql/submitPullRequestReview",
        { number: 7, threadCount: 0, event: "APPROVE" },
      ],
      [
        root + "/graphql/deletePullRequestReview",
        { number: 7, reviewId: "PRR_x" },
      ],
      [
        root + "/pulls/7/reviews",
        { commit_id: sha, event: "COMMENT", body: "x", comments: [] },
      ],
      [root + "/pulls/7/reviews", { commit_id: sha, event: "", body: "x" }],
      [root + "/pulls/7/reviews", { commit_id: sha, body: "x" }],
      [root + "/pulls/7/reviews", { event: "COMMENT", body: "x" }],
      [root + "/pulls/7/reviews", { commit_id: sha, event: "COMMENT" }],
      [
        root + "/pulls/7/reviews",
        { commit_id: sha, event: "COMMENT", body: "x" },
        { "Review-Submit-Id": "x" },
      ],
      [root + "/pulls/7", { number: 7 }],
    ];
    for (const [url, value, headers] of badPosts) {
      const response = await post(url, value, headers);
      expect([url, value, response.status]).toEqual([url, value, 400]);
    }
    const withoutId = await call(root + "/graphql/deletePullRequestReview", {
      method: "POST",
      body: '{"number":7}',
      headers: {
        Authorization: bearer,
        "Content-Type": "application/json",
        "Content-Length": "12",
      },
    });
    expect(withoutId.status).toBe(400);
    expect(
      (
        await post(
          root + "/pulls/7/reviews",
          { commit_id: sha, event: "COMMENT", body: "x" },
          {
            "Content-Type": "text/plain",
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(root + "/pulls/7/reviews", {
          method: "POST",
          body: "{}",
          headers: {
            Authorization: bearer,
            "Content-Type": "application/json",
          },
        })
      ).status,
    ).toBe(411);
    expect(
      (
        await call(root + "/pulls/7/reviews", {
          method: "POST",
          body: "{}",
          headers: {
            Authorization: bearer,
            "Content-Type": "application/json",
            "Content-Length": String(256 * 1024 + 1),
          },
        })
      ).status,
    ).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects untrusted origins, a missing Bearer and a review-less session before egress", async () => {
    const { call, post, resolve, send } = fixture({ allowReview: false });
    for (const value of [
      null,
      "null",
      "*",
      "tw-editor://./",
      "https://evil.test",
    ]) {
      const response = await call(
        root + "/pulls",
        { headers: { Authorization: bearer } },
        value,
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
    expect(
      (await call((root + "/pulls").replace(host, "https://spoof.test")))
        .status,
    ).toBe(403);
    expect((await call(root + "/pulls")).status).toBe(401);
    expect(
      (
        await call(root + "/pulls", {
          headers: { Authorization: "Bearer " + "a".repeat(43) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(root + "/pulls", {
          headers: { Authorization: bearer.replace(/b+/u, "x".repeat(43)) },
        })
      ).status,
    ).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const denied = await post(root + "/graphql/addPullRequestReview", {
      number: 7,
      commitOid: sha,
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await post(root + "/pulls/7/reviews", {
          commit_id: sha,
          event: "APPROVE",
        })
      ).status,
    ).toBe(403);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });

  it("builds fixed upstream requests and returns only the contracted fields", async () => {
    const { call, post, send } = fixture();
    const headers = {
      Authorization: bearer,
      Cookie: "leak=1",
      Referer: "https://editor.example.test/",
    };
    const list = await call(root + "/pulls?page=3", { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(list.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    for (const name of ["Set-Cookie", "Link", "x-ratelimit-remaining"])
      expect(list.headers.has(name)).toBe(false);
    const pulls = await list.json();
    expect(pulls).toHaveLength(2);
    expect(pulls[0]).toEqual({
      number: 1,
      title: "Title 1",
      state: "open",
      draft: false,
      merged_at: null,
      updated_at: "2026-11-11T00:00:00Z",
      user: { login: "author" },
      head: { sha, ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
    });
    expect(await (await call(root + "/pulls/7", { headers })).json()).toEqual({
      number: 7,
      title: "Title 7",
      state: "open",
      draft: false,
      merged_at: null,
      user: { login: "author" },
      body: "markdown",
      body_text: "plain",
      changed_files: 3,
      head: { sha, ref: "feature", repo: null },
      base: { sha, ref: "main", repo: { full_name: "owner/project" } },
    });
    expect(
      await (await call(root + "/pulls/7/reviews?page=2", { headers })).json(),
    ).toEqual([
      {
        id: 10,
        user: { login: "reviewer" },
        commit_id: sha,
        state: "APPROVED",
        submitted_at: "2026-11-11T00:00:00Z",
        body: "",
      },
    ]);
    const created = await post(
      root + "/pulls/7/reviews",
      { commit_id: sha, event: "REQUEST_CHANGES", body: "fix" },
      headers,
    );
    expect(await created.json()).toEqual({
      id: 11,
      state: "COMMENTED",
      commit_id: sha,
      submitted_at: "2026-11-11T00:00:00Z",
      html_url: "https://github.com/owner/project/pull/7#pullrequestreview-11",
    });
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/owner/project/pulls?state=all&sort=updated&direction=desc&per_page=20&page=3",
      "https://api.github.com/repos/owner/project/pulls/7",
      "https://api.github.com/repos/owner/project/pulls/7/reviews?per_page=30&page=2",
      "https://api.github.com/repos/owner/project/pulls/7/reviews",
    ]);
    for (const [url, init] of send.mock.calls) {
      const sent = new Headers(init?.headers);
      const names = [...sent.keys()].sort();
      expect(names).toEqual(
        init?.method === "POST"
          ? [
              "accept",
              "authorization",
              "content-type",
              "user-agent",
              "x-github-api-version",
            ]
          : ["accept", "authorization", "user-agent", "x-github-api-version"],
      );
      expect(sent.get("Authorization")).toBe("Bearer ghu_private");
      expect(sent.get("Accept")).toBe(
        url.endsWith("/pulls/7")
          ? "application/vnd.github.text+json"
          : "application/vnd.github+json",
      );
      expect(sent.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      expect(init?.redirect).toBe("manual");
    }
    expect(JSON.parse(String(send.mock.calls[3]?.[1]?.body))).toEqual({
      commit_id: sha,
      event: "REQUEST_CHANGES",
      body: "fix",
    });
  });

  it("sends only the fixed GraphQL documents with node IDs from the session grant", async () => {
    const { post, send, graphql } = fixture();
    graphql.mockImplementation((query) => {
      if (query === githubReviewDocuments.addPullRequestReviewThread)
        return Response.json({
          data: {
            addPullRequestReviewThread: {
              thread: {
                id: "T_1",
                path: "a/project.source.json",
                subjectType: "FILE",
              },
            },
          },
        });
      return Response.json({
        data: {
          submitPullRequestReview: {
            pullRequestReview: {
              id: "PRR_node",
              state: "COMMENTED",
              submittedAt: "2026-11-11T00:00:00Z",
              url: "https://github.com/owner/project/pull/7#pullrequestreview-1",
              commit: { oid: sha },
            },
          },
        },
      });
    });
    const thread = await post(root + "/graphql/addPullRequestReviewThread", {
      number: 7,
      threadIndex: 0,
      path: "a/project.source.json",
      body: "Stage: when flag clicked",
    });
    expect(thread.status).toBe(200);
    expect(await thread.json()).toEqual({ threads: 0 });
    const submitted = await post(root + "/graphql/submitPullRequestReview", {
      number: 7,
      threadCount: 1,
      event: "COMMENT",
      body: "",
    });
    const published = await submitted.json();
    expect(published).toEqual({
      state: "COMMENTED",
      commitOid: sha,
      submittedAt: "2026-11-11T00:00:00Z",
      url: "https://github.com/owner/project/pull/7#pullrequestreview-1",
    });
    expect(JSON.stringify(published)).not.toContain("PRR_");
    const calls = graphql.mock.calls;
    expect(calls.map(([query]) => query)).toEqual([
      githubReviewDocuments.addPullRequestReviewThread,
      githubReviewDocuments.submitPullRequestReview,
    ]);
    expect(calls[0]?.[1]).toEqual({
      reviewId: "PRR_node",
      path: "a/project.source.json",
      body: "Stage: when flag clicked",
    });
    expect(calls[1]?.[1]).toEqual({
      reviewId: "PRR_node",
      event: "COMMENT",
      body: "",
    });
    for (const [, init] of send.mock.calls) {
      expect([...new Headers(init?.headers).keys()].sort()).toEqual([
        "accept",
        "authorization",
        "content-type",
        "user-agent",
      ]);
      expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
        "query",
        "variables",
      ]);
    }
  });

  it("rejects oversized, malformed and redirected upstream responses", async () => {
    const { call, post, send } = fixture();
    const headers = { Authorization: bearer };
    send.mockResolvedValueOnce(
      new Response("[" + '"x",'.repeat(300_000) + '"x"]', {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const large = await call(root + "/pulls", { headers });
    expect(large.status).toBe(502);
    expect(await large.json()).toMatchObject({ code: "UPSTREAM_FAILURE" });
    send.mockResolvedValueOnce(Response.json([{ number: "one" }]));
    expect((await call(root + "/pulls", { headers })).status).toBe(502);
    send.mockResolvedValueOnce(
      new Response("not json", { headers: { "Content-Type": "text/html" } }),
    );
    expect((await call(root + "/pulls/7", { headers })).status).toBe(502);
    send.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { Location: "https://api.github.com/repositories/1/pulls/7" },
      }),
    );
    const redirect = await call(root + "/pulls/7", { headers });
    expect(redirect.status).toBe(409);
    expect(await redirect.json()).toMatchObject({ code: "REDIRECT_REJECTED" });
    send.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(
      await (await call(root + "/pulls/8", { headers })).json(),
    ).toMatchObject({
      code: "PULL_REQUEST_NOT_FOUND",
    });
    send.mockResolvedValueOnce(new Response(null, { status: 422 }));
    const rejected = await post(root + "/pulls/7/reviews", {
      commit_id: sha,
      event: "APPROVE",
      body: "",
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: "REVIEW_REJECTED" });
  });

  it("separates GitHub rate limits from missing permission", async () => {
    const { call, post, send, graphql } = fixture();
    const headers = { Authorization: bearer };
    const now = Math.floor(Date.now() / 1000);
    const cases: [Response, number, string, number?][] = [
      [
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
        429,
        "RATE_LIMITED",
        30,
      ],
      [
        new Response(null, {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(now + 120),
          },
        }),
        429,
        "RATE_LIMITED",
      ],
      [
        new Response(null, { status: 403, headers: { "retry-after": "5" } }),
        429,
        "RATE_LIMITED",
        5,
      ],
      [new Response(null, { status: 403 }), 403, "FORBIDDEN"],
      [new Response(null, { status: 401 }), 403, "FORBIDDEN"],
      [new Response(null, { status: 504 }), 504, "UPSTREAM_TIMEOUT"],
      [new Response(null, { status: 500 }), 502, "UPSTREAM_FAILURE"],
    ];
    for (const [response, status, code, retryAfter] of cases) {
      send.mockResolvedValueOnce(response);
      const result = await call(root + "/pulls", { headers });
      const body = await result.json();
      expect([status, code]).toEqual([result.status, body.code]);
      if (status === 429) {
        expect(Number.isInteger(body.retryAfter)).toBe(true);
        if (retryAfter !== undefined) expect(body.retryAfter).toBe(retryAfter);
        else expect(body.retryAfter).toBeGreaterThan(100);
      } else expect(body).not.toHaveProperty("retryAfter");
    }
    const thread = () =>
      post(root + "/graphql/addPullRequestReviewThread", {
        number: 7,
        threadIndex: 0,
        path: "project.source.json",
        body: "x",
      });
    const graphqlCases: [Response, number, string][] = [
      [
        Response.json(
          {
            data: null,
            errors: [{ type: "RATE_LIMITED", message: "secret detail" }],
          },
          {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(now + 60),
            },
          },
        ),
        429,
        "RATE_LIMITED",
      ],
      [
        Response.json(
          { errors: [{ message: "API rate limit exceeded" }] },
          { headers: { "x-ratelimit-remaining": "0" } },
        ),
        429,
        "RATE_LIMITED",
      ],
      [
        Response.json({ data: null, errors: [{ type: "RATE_LIMITED" }] }),
        429,
        "RATE_LIMITED",
      ],
      [
        Response.json({
          data: null,
          errors: [{ type: "FORBIDDEN", message: "secret detail" }],
        }),
        403,
        "FORBIDDEN",
      ],
      [new Response(null, { status: 401 }), 403, "FORBIDDEN"],
      [
        new Response(null, { status: 403, headers: { "retry-after": "9" } }),
        429,
        "RATE_LIMITED",
      ],
      [
        Response.json({
          data: null,
          errors: [{ type: "UNPROCESSABLE", message: "secret detail" }],
        }),
        422,
        "REVIEW_THREAD_REJECTED",
      ],
      [
        Response.json({
          data: { addPullRequestReviewThread: null },
          errors: [{ type: "X" }],
        }),
        502,
        "UPSTREAM_FAILURE",
      ],
      [new Response(null, { status: 502 }), 502, "UPSTREAM_FAILURE"],
      [new Response(null, { status: 504 }), 504, "UPSTREAM_TIMEOUT"],
    ];
    for (const [response, status, code] of graphqlCases) {
      graphql.mockReturnValueOnce(response);
      const result = await thread();
      const body = await result.json();
      expect([result.status, body.code]).toEqual([status, code]);
      expect(JSON.stringify(body)).not.toContain("secret");
    }
  });
});
