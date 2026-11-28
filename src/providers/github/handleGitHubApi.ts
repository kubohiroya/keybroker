import {
  type GitHubReviewOperation,
  githubReviewDocuments,
  isGitHubReviewOperation,
  pullRequestPublicationStatusDocument,
} from "./githubReviewDocuments.js";

const namespace = "/v1/github";
const restOrigin = "https://api.github.com";
const graphqlUrl = "https://api.github.com/graphql";
const userAgent = "HierarchiDB-Git";
const maxRequestBytes = 256 * 1024;
const upstreamTimeout = 30_000;
const kib = 1024;
const mib = 1024 * kib;
const maxBodyLength = 65_536;
const maxPathBytes = 1024;
const maxRepositoryNameLength = 100;
const maxPullRequestNumber = 2_147_483_647;
const submitIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nodeIdPattern = /^[A-Za-z0-9_=-]{1,200}$/u;
const commitOidPattern = /^[0-9a-f]{40}$/u;
const attemptPattern = /^[A-Za-z0-9_-]{43}$/u;
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const repoPattern = /^[A-Za-z0-9_.-]+$/u;
const pathPattern =
  /^\/v1\/github\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/(?:(pulls)|pulls\/([1-9][0-9]{0,9})|pulls\/([1-9][0-9]{0,9})\/(reviews|publication-status)|graphql\/([A-Za-z]+)|(name))$/u;
const features = [
  "pulls-read",
  "review-threads",
  "reviews-body",
  "checks-read",
  "repository-rename",
] as const;
const events = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
const pullStates = ["OPEN", "CLOSED", "MERGED"] as const;
const checkStates = [
  "SUCCESS",
  "FAILURE",
  "PENDING",
  "ERROR",
  "EXPECTED",
] as const;
const reviewDecisions = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
] as const;
const mergeStates = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const;
const mergeability = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;

type Feature = (typeof features)[number];
type ReviewEvent = (typeof events)[number];
type Json = { [key: string]: unknown };
type GitHubEnv = {
  GIT_PROXY_ORIGIN?: string;
  GIT_ALLOWED_ORIGINS?: string;
  GIT_GITHUB_API?: string;
  GIT_SESSIONS?: DurableObjectNamespace;
};
type PathMatch = {
  owner: string;
  repo: string;
  feature: Feature;
  target:
    | { kind: "pulls" }
    | { kind: "pull"; number: number }
    | { kind: "publication-status"; number: number }
    | { kind: "reviews"; number: number }
    | { kind: "graphql"; operation: string }
    | { kind: "name" };
};
type Route =
  | { kind: "pulls"; page: number }
  | { kind: "pull"; number: number }
  | { kind: "publication-status"; number: number }
  | { kind: "reviews"; number: number; page: number }
  | { kind: "create-review"; number: number }
  | { kind: "graphql"; operation: GitHubReviewOperation }
  | { kind: "rename" };
type SubmitStep = "start" | "thread" | "submit" | "delete" | "context";
const submitStates = [
  "starting",
  "threading",
  "submitting",
  "deleting",
  "pending",
  "start-unknown",
  "submit-unknown",
  "broken",
  "submitted",
  "closed",
] as const;
type SubmitState = (typeof submitStates)[number];
type SubmitGrant = {
  id: string;
  state: SubmitState;
  number: number;
  commitOid: string;
  threads: number;
  attempt: string;
  pullRequestNodeId: string | null;
  reviewNodeId: string | null;
};
type Grant = {
  owner: string;
  repo: string;
  accessToken: string;
  repositoryId: number;
  reviewId?: string;
  submit?: SubmitGrant;
};
type ReviewVariables = {
  number: number;
  commitOid?: string;
  threadIndex?: number;
  path?: string;
  body?: string;
  threadCount?: number;
  event?: ReviewEvent;
};
type GraphqlOutcome =
  | { kind: "ok"; data: Json }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "forbidden" }
  | { kind: "not-found"; data: Json | null }
  | { kind: "rejected" }
  | { kind: "redirect" }
  | { kind: "not-sent" }
  | { kind: "unknown"; timeout: boolean };
type ReviewContext = {
  viewer: string;
  pullRequestNodeId: string;
  headRefOid: string;
  pending: {
    id: string;
    // GitHub's `viewerDidAuthor`.
    ours: boolean;
    createdAt: string;
    body: string;
    commitOid: string | null;
    comments: number;
  }[];
  recent: {
    id: string;
    ours: boolean;
    state: string;
    submittedAt: string | null;
    commitOid: string | null;
  }[];
};

const stepOf: { [operation in GitHubReviewOperation]: SubmitStep } = {
  pullRequestReviewContext: "context",
  addPullRequestReview: "start",
  addPullRequestReviewThread: "thread",
  submitPullRequestReview: "submit",
  deletePullRequestReview: "delete",
};
const variableKeys: { [operation in GitHubReviewOperation]: string } = {
  pullRequestReviewContext: "number",
  addPullRequestReview: "commitOid,number",
  addPullRequestReviewThread: "body,number,path,threadIndex",
  submitPullRequestReview: "body,event,number,threadCount",
  deletePullRequestReview: "number",
};

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

/** The upstream response did not have the contracted shape or size. */
class ShapeError extends Error {}

export function isGitHubApiPath(path: string): boolean {
  return path === namespace || path.startsWith(namespace + "/");
}

/**
 * Parses `GIT_GITHUB_API`. An absent or empty value disables every route. An unknown or
 * repeated value is a configuration error and fails every route instead of being ignored.
 */
function parseFeatures(
  value: string | undefined,
): Set<Feature> | null | "invalid" {
  if (value === undefined || value.trim() === "") return null;
  const names = value.split(",").map((name) => name.trim());
  const valid = (name: string): name is Feature =>
    (features as readonly string[]).includes(name);
  if (!names.every(valid) || new Set(names).size !== names.length)
    return "invalid";
  return new Set(names);
}

function matchPath(path: string): PathMatch | null {
  const match = pathPattern.exec(path);
  if (!match || match[0] !== path) return null;
  const [, owner, repo, pulls, pull, suffixNumber, suffix, operation, name] =
    match;
  // The GitHub API names a repository without the `.git` suffix of the Git routes.
  if (
    !owner ||
    !repo ||
    [".", ".."].includes(repo) ||
    repo.toLowerCase().endsWith(".git")
  )
    return null;
  if (pulls)
    return { owner, repo, feature: "pulls-read", target: { kind: "pulls" } };
  if (pull) {
    const number = Number(pull);
    if (number > maxPullRequestNumber) return null;
    return {
      owner,
      repo,
      feature: "pulls-read",
      target: { kind: "pull", number },
    };
  }
  if (suffixNumber) {
    const number = Number(suffixNumber);
    if (number > maxPullRequestNumber) return null;
    return suffix === "publication-status"
      ? {
          owner,
          repo,
          feature: "checks-read",
          target: { kind: "publication-status", number },
        }
      : {
          owner,
          repo,
          feature: "reviews-body",
          target: { kind: "reviews", number },
        };
  }
  if (operation)
    return {
      owner,
      repo,
      feature: "review-threads",
      target: { kind: "graphql", operation },
    };
  if (name)
    return {
      owner,
      repo,
      feature: "repository-rename",
      target: { kind: "name" },
    };
  return null;
}

function parsePage(search: string, max: number): number | null {
  if (search === "") return 1;
  const match = /^\?page=([1-9][0-9]?)$/u.exec(search);
  if (!match?.[1]) return null;
  const page = Number(match[1]);
  return page <= max ? page : null;
}

function resolveRoute(
  path: PathMatch,
  method: string,
  search: string,
): Route | null {
  const { target } = path;
  if (target.kind === "pulls") {
    const page = method === "GET" ? parsePage(search, 50) : null;
    return page === null ? null : { kind: "pulls", page };
  }
  if (target.kind === "pull" || target.kind === "publication-status")
    return method === "GET" && search === "" ? target : null;
  if (target.kind === "name")
    return method === "POST" && search === "" ? { kind: "rename" } : null;
  if (target.kind === "reviews") {
    if (method === "POST")
      return search === ""
        ? { kind: "create-review", number: target.number }
        : null;
    const page = method === "GET" ? parsePage(search, 10) : null;
    return page === null
      ? null
      : { kind: "reviews", number: target.number, page };
  }
  return method === "POST" &&
    search === "" &&
    isGitHubReviewOperation(target.operation)
    ? { kind: "graphql", operation: target.operation }
    : null;
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isBody(value: unknown, minLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxBodyLength
  );
}

function isEvent(value: unknown): value is ReviewEvent {
  return (
    typeof value === "string" && (events as readonly string[]).includes(value)
  );
}

/** A relative path whose last element is exactly `project.source.json`. */
function isProjectSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxPathBytes
  )
    return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected.
  // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
  if (/[\u0000-\u001f\u007f\\]/u.test(value)) return false;
  const parts = value.split("/");
  return (
    parts.at(-1) === "project.source.json" &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validateVariables(
  operation: GitHubReviewOperation,
  input: Json,
): ReviewVariables | null {
  if (Object.keys(input).sort().join(",") !== variableKeys[operation])
    return null;
  const { number, commitOid, threadIndex, path, body, threadCount, event } =
    input;
  if (!isInteger(number, 1, maxPullRequestNumber)) return null;
  switch (operation) {
    case "pullRequestReviewContext":
    case "deletePullRequestReview":
      return { number };
    case "addPullRequestReview":
      return typeof commitOid === "string" && commitOidPattern.test(commitOid)
        ? { number, commitOid }
        : null;
    case "addPullRequestReviewThread":
      return isInteger(threadIndex, 0, 49) &&
        isProjectSourcePath(path) &&
        isBody(body, 1)
        ? { number, threadIndex, path, body }
        : null;
    case "submitPullRequestReview":
      if (!isInteger(threadCount, 0, 50) || !isEvent(event) || !isBody(body, 0))
        return null;
      if (event === "REQUEST_CHANGES" && body.length === 0) return null;
      if (event === "COMMENT" && body.length === 0 && threadCount === 0)
        return null;
      return { number, threadCount, event, body };
  }
}

function validateReview(
  input: Json,
): { commit_id: string; event: ReviewEvent; body?: string } | null {
  const keys = Object.keys(input);
  if (keys.some((key) => !["commit_id", "event", "body"].includes(key)))
    return null;
  const { commit_id, event, body } = input;
  if (
    typeof commit_id !== "string" ||
    !commitOidPattern.test(commit_id) ||
    !isEvent(event)
  )
    return null;
  if (body === undefined)
    return event === "APPROVE" ? { commit_id, event } : null;
  return isBody(body, event === "APPROVE" ? 0 : 1)
    ? { commit_id, event, body }
    : null;
}

/** Seconds until GitHub accepts requests again, from `retry-after` or `x-ratelimit-reset`. */
function retryAfterSeconds(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^[0-9]+$/u.test(retryAfter))
    return Number(retryAfter);
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^[0-9]+$/u.test(reset))
    return Math.max(0, Math.ceil(Number(reset) - Date.now() / 1000));
  return 60;
}

function restRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  );
}

/** Reads a JSON response body up to `limit` bytes. */
async function readJson(response: Response, limit: number): Promise<unknown> {
  const type = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(;|$)/u.test(type) || !response.body) {
    await response.body?.cancel();
    throw new ShapeError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ShapeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new ShapeError();
  }
}

// Shape readers. Each throws ShapeError when the upstream value does not have the contracted type.
function object(value: unknown): Json {
  if (!isJson(value)) throw new ShapeError();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new ShapeError();
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new ShapeError();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ShapeError();
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError();
  return value;
}
function nodeId(value: unknown): string {
  const id = string(value);
  if (!nodeIdPattern.test(id)) throw new ShapeError();
  return id;
}
function login(value: unknown): { login: string } | null {
  return value === null ? null : { login: string(object(value).login) };
}
function commitOid(value: unknown): string | null {
  return value === null ? null : string(object(value).oid);
}

function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  const match = choices.find((choice) => choice === value);
  if (match === undefined) throw new ShapeError();
  return match;
}

function branchRef(value: unknown): string {
  const ref = string(value);
  if (
    ref.length === 0 ||
    new TextEncoder().encode(ref).byteLength > maxPathBytes
  )
    throw new ShapeError();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected.
  // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
  if (/[\u0000-\u0020\u007f]/u.test(ref)) throw new ShapeError();
  return ref;
}

function shapePullSummary(value: unknown) {
  const pull = object(value);
  const head = object(pull.head);
  const base = object(pull.base);
  return {
    number: integer(pull.number),
    title: string(pull.title),
    state: string(pull.state),
    draft: boolean(pull.draft),
    merged_at: nullableString(pull.merged_at),
    updated_at: string(pull.updated_at),
    user: login(pull.user),
    head: { sha: string(head.sha), ref: string(head.ref) },
    base: { sha: string(base.sha), ref: string(base.ref) },
  };
}

function shapeRevision(value: unknown) {
  const revision = object(value);
  return {
    sha: string(revision.sha),
    ref: string(revision.ref),
    repo:
      revision.repo === null
        ? null
        : { full_name: string(object(revision.repo).full_name) },
  };
}

function shapePull(value: unknown) {
  const pull = object(value);
  return {
    number: integer(pull.number),
    title: string(pull.title),
    state: string(pull.state),
    draft: boolean(pull.draft),
    merged_at: nullableString(pull.merged_at),
    user: login(pull.user),
    // The text media type returns `body_text`; `body` is included when GitHub sends it.
    ...(pull.body !== undefined && { body: nullableString(pull.body) }),
    body_text: nullableString(pull.body_text),
    changed_files: integer(pull.changed_files),
    head: shapeRevision(pull.head),
    base: shapeRevision(pull.base),
  };
}

function shapeReview(value: unknown) {
  const review = object(value);
  return {
    id: integer(review.id),
    user: login(review.user),
    commit_id: nullableString(review.commit_id),
    state: string(review.state),
    submitted_at:
      review.submitted_at === undefined
        ? null
        : nullableString(review.submitted_at),
    body: string(review.body),
  };
}

function shapeCreatedReview(value: unknown) {
  const review = object(value);
  return {
    id: integer(review.id),
    state: string(review.state),
    commit_id: nullableString(review.commit_id),
    submitted_at:
      review.submitted_at === undefined
        ? null
        : nullableString(review.submitted_at),
    html_url: string(review.html_url),
  };
}

function boundPull(data: Json, repositoryId: number): Json {
  if (data.repository === null) throw new ProxyError(403, "FORBIDDEN");
  const repository = object(data.repository);
  if (integer(repository.databaseId) !== repositoryId)
    throw new ProxyError(403, "FORBIDDEN");
  if (repository.pullRequest === null)
    throw new ProxyError(404, "PULL_REQUEST_NOT_FOUND");
  return object(repository.pullRequest);
}

function shapePublicationStatus(
  data: Json,
  repositoryId: number,
  number: number,
) {
  const pull = boundPull(data, repositoryId);
  const headSha = string(pull.headRefOid);
  const baseSha = string(pull.baseRefOid);
  const state = enumValue(pull.state, pullStates);
  const mergedAt = nullableString(pull.mergedAt);
  if (
    pull.number !== number ||
    !commitOidPattern.test(headSha) ||
    !commitOidPattern.test(baseSha) ||
    (state === "MERGED") !== (mergedAt !== null) ||
    (mergedAt !== null && !Number.isFinite(Date.parse(mergedAt)))
  )
    throw new ShapeError();

  const headRepositoryId =
    pull.headRepository === null
      ? null
      : object(pull.headRepository).databaseId;
  if (
    headRepositoryId !== null &&
    !isInteger(headRepositoryId, 1, Number.MAX_SAFE_INTEGER)
  )
    throw new ShapeError();

  let checks: {
    state: (typeof checkStates)[number] | null;
    totalCount: number;
  } = {
    state: null,
    totalCount: 0,
  };
  if (pull.statusCheckRollup !== null) {
    const rollup = object(pull.statusCheckRollup);
    const totalCount = object(rollup.contexts).totalCount;
    // GitHub can update the pull request during the query. A stale rollup cannot prove CI.
    if (
      commitOid(rollup.commit) !== headSha ||
      !isInteger(totalCount, 0, Number.MAX_SAFE_INTEGER)
    )
      throw new ShapeError();
    const checkState = enumValue(rollup.state, checkStates);
    checks = { state: totalCount === 0 ? null : checkState, totalCount };
  }

  return {
    repositoryId,
    number,
    state,
    mergedAt,
    draft: boolean(pull.isDraft),
    head: {
      ref: branchRef(pull.headRefName),
      sha: headSha,
      repositoryId: headRepositoryId,
    },
    base: { ref: branchRef(pull.baseRefName), sha: baseSha },
    checks,
    reviewDecision:
      pull.reviewDecision === null
        ? null
        : enumValue(pull.reviewDecision, reviewDecisions),
    mergeStateStatus: enumValue(pull.mergeStateStatus, mergeStates),
    mergeable: enumValue(pull.mergeable, mergeability),
  };
}

function shapeContext(data: Json, repositoryId: number): ReviewContext {
  const viewer = string(object(data.viewer).login);
  const pull = boundPull(data, repositoryId);
  return {
    viewer,
    pullRequestNodeId: nodeId(pull.id),
    headRefOid: string(pull.headRefOid),
    pending: array(object(pull.pending).nodes).map((value) => {
      const node = object(value);
      const id = nodeId(node.id);
      return {
        id,
        ours: boolean(node.viewerDidAuthor),
        createdAt: string(node.createdAt),
        body: string(node.body),
        commitOid: commitOid(node.commit),
        comments: integer(object(node.comments).totalCount),
      };
    }),
    recent: array(object(pull.recent).nodes).map((value) => {
      const node = object(value);
      return {
        id: nodeId(node.id),
        ours: boolean(node.viewerDidAuthor),
        state: string(node.state),
        submittedAt: nullableString(node.submittedAt),
        commitOid: commitOid(node.commit),
      };
    }),
  };
}

function contextResponse(
  context: ReviewContext,
  reviewNodeId: string | null,
  submit?: { state: SubmitState; threads: number },
) {
  const pending = context.pending.find((review) => review.ours);
  return {
    headRefOid: context.headRefOid,
    viewer: context.viewer,
    pendingReview: pending
      ? {
          ours: reviewNodeId !== null && pending.id === reviewNodeId,
          commitOid: pending.commitOid,
          createdAt: pending.createdAt,
        }
      : null,
    reviews: context.recent
      .filter((review) => review.ours)
      .reverse()
      .map((review) => ({
        state: review.state,
        commitOid: review.commitOid,
        submittedAt: review.submittedAt,
        ours: reviewNodeId !== null && review.id === reviewNodeId,
      })),
    ...(submit && { submit }),
  };
}

function isGrant(
  value: unknown,
  reviewId: string | undefined,
  submit?: { id: string; number: number },
): value is Grant {
  if (!isJson(value)) return false;
  const { owner, repo, accessToken, repositoryId } = value;
  if (
    typeof owner !== "string" ||
    !ownerPattern.test(owner) ||
    typeof repo !== "string" ||
    !repoPattern.test(repo) ||
    [".", "..", ".git"].includes(repo.toLowerCase()) ||
    typeof accessToken !== "string" ||
    !/^[A-Za-z0-9_]+$/u.test(accessToken) ||
    !isInteger(repositoryId, 1, Number.MAX_SAFE_INTEGER) ||
    value.reviewId !== reviewId
  )
    return false;
  if (!submit) return value.submit === undefined;
  const grant = value.submit;
  const nullableNode = (id: unknown) =>
    id === null || (typeof id === "string" && nodeIdPattern.test(id));
  return (
    isJson(grant) &&
    grant.id === submit.id &&
    grant.number === submit.number &&
    typeof grant.state === "string" &&
    submitStates.includes(grant.state as SubmitState) &&
    typeof grant.commitOid === "string" &&
    commitOidPattern.test(grant.commitOid) &&
    isInteger(grant.threads, 0, 50) &&
    typeof grant.attempt === "string" &&
    attemptPattern.test(grant.attempt) &&
    nullableNode(grant.pullRequestNodeId) &&
    nullableNode(grant.reviewNodeId)
  );
}

async function authorize(
  stub: DurableObjectStub,
  body: {
    credential: string;
    origin: string;
    owner: string;
    repo: string;
    operation: "read" | "review";
    reviewId?: string;
    submit?: {
      id: string;
      step: SubmitStep;
      number: number;
      commitOid?: string;
      threadIndex?: number;
      threadCount?: number;
    };
  },
): Promise<Grant> {
  const response = await stub.fetch("https://git-session.internal/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json<unknown>();
  if (response.status === 200) {
    if (!isGrant(value, body.reviewId, body.submit))
      throw new ProxyError(502, "UPSTREAM_FAILURE");
    return value;
  }
  const code = isJson(value) ? value.code : undefined;
  const allowed: { [status: number]: string[] } = {
    400: ["BAD_REQUEST"],
    401: ["SESSION_REQUIRED", "SESSION_EXPIRED", "REAUTH_REQUIRED"],
    403: ["FORBIDDEN"],
    409: ["REVIEW_DUPLICATE", "REVIEW_STEP_CONFLICT"],
    429: ["RATE_LIMITED"],
  };
  if (typeof code === "string" && allowed[response.status]?.includes(code)) {
    const retryAfter = isJson(value) ? value.retryAfter : undefined;
    throw new ProxyError(
      response.status,
      code,
      isInteger(retryAfter, 0, Number.MAX_SAFE_INTEGER)
        ? retryAfter
        : undefined,
    );
  }
  throw new ProxyError(
    response.status === 504 ? 504 : 502,
    response.status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE",
  );
}

/**
 * Records the outcome of the reserved step and returns the record's next state. A failure to
 * record leaves the step in flight, so the client is told the outcome is unknown.
 */
async function reportResult(
  stub: DurableObjectStub,
  submit: SubmitGrant,
  outcome:
    "ok" | "failed" | "unknown" | "gone" | "pending" | "submitted" | "closed",
  ids: { pullRequestNodeId?: string; reviewNodeId?: string } = {},
): Promise<{ state: SubmitState; threads: number }> {
  const response = await stub.fetch(
    "https://git-session.internal/review-result",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submitId: submit.id,
        attempt: submit.attempt,
        outcome,
        ...ids,
      }),
    },
  );
  const value = await response.json<unknown>();
  if (
    response.status !== 200 ||
    !isJson(value) ||
    typeof value.state !== "string" ||
    !submitStates.includes(value.state as SubmitState) ||
    !isInteger(value.threads, 0, 50)
  )
    throw new ProxyError(502, "UPSTREAM_FAILURE");
  return { state: value.state as SubmitState, threads: value.threads };
}

/**
 * Validates the body of a rename request: exactly one `name` that GitHub accepts as a
 * repository name (letters, digits, `-`, `_` and `.`, up to 100 characters, not `.` or `..`
 * and without the `.git` suffix).
 */
function validateRepositoryName(input: Json): string | null {
  const { name } = input;
  if (Object.keys(input).join(",") !== "name" || typeof name !== "string")
    return null;
  return isRepositoryName(name) ? name : null;
}

export function isRepositoryName(name: string): boolean {
  return (
    name.length <= maxRepositoryNameLength &&
    repoPattern.test(name) &&
    ![".", ".."].includes(name) &&
    !name.toLowerCase().endsWith(".git")
  );
}

/**
 * Asks the session to rename its repository. The session checks the repository ID, renames it
 * with the fixed `PATCH /repos/{owner}/{repo}` request that sends only `name`, and binds itself
 * to the new name, so the client keeps the same login after rewriting its `origin`.
 */
async function rename(
  stub: DurableObjectStub,
  body: {
    credential: string;
    origin: string;
    owner: string;
    repo: string;
    name: string;
  },
): Promise<{ owner: string; repo: string; repositoryId: number }> {
  const response = await stub.fetch("https://git-session.internal/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json<unknown>();
  if (response.status === 200) {
    if (
      !isJson(value) ||
      Object.keys(value).sort().join(",") !== "owner,repo,repositoryId" ||
      typeof value.owner !== "string" ||
      !ownerPattern.test(value.owner) ||
      typeof value.repo !== "string" ||
      !isRepositoryName(value.repo) ||
      !isInteger(value.repositoryId, 1, Number.MAX_SAFE_INTEGER)
    )
      throw new ProxyError(502, "UPSTREAM_FAILURE");
    return {
      owner: value.owner,
      repo: value.repo,
      repositoryId: value.repositoryId,
    };
  }
  const code = isJson(value) ? value.code : undefined;
  const allowed: { [status: number]: string[] } = {
    400: ["BAD_REQUEST"],
    401: ["SESSION_REQUIRED", "SESSION_EXPIRED", "REAUTH_REQUIRED"],
    403: ["FORBIDDEN", "ADMINISTRATION_PERMISSION_REQUIRED"],
    409: ["REPOSITORY_NAME_UNAVAILABLE", "REDIRECT_REJECTED"],
    429: ["RATE_LIMITED"],
    504: ["UPSTREAM_TIMEOUT"],
  };
  if (typeof code === "string" && allowed[response.status]?.includes(code)) {
    const retryAfter = isJson(value) ? value.retryAfter : undefined;
    throw new ProxyError(
      response.status,
      code,
      isInteger(retryAfter, 0, Number.MAX_SAFE_INTEGER)
        ? retryAfter
        : undefined,
    );
  }
  throw new ProxyError(502, "UPSTREAM_FAILURE");
}

export async function handleGitHubApi(
  request: Request,
  env: GitHubEnv,
  send: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  const fail = (status: number, code: string, retryAfter?: number) =>
    Response.json(
      {
        code,
        requestId: crypto.randomUUID(),
        ...(retryAfter !== undefined && { retryAfter }),
      },
      { status, headers },
    );
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = env.GIT_ALLOWED_ORIGINS?.split(",").map((value) =>
    value.trim(),
  );
  if (
    !origin ||
    origin === "null" ||
    origin === "*" ||
    !allowed?.includes(origin)
  )
    return fail(403, "FORBIDDEN");
  headers.set("Access-Control-Allow-Origin", origin);
  const enabled = parseFeatures(env.GIT_GITHUB_API);
  if (enabled === "invalid") return fail(500, "GITHUB_API_MISCONFIGURED");
  if (!enabled || !env.GIT_SESSIONS || !env.GIT_PROXY_ORIGIN)
    return fail(404, "GITHUB_API_UNAVAILABLE");
  if (url.protocol !== "https:" || url.origin !== env.GIT_PROXY_ORIGIN)
    return fail(403, "FORBIDDEN");

  const path = matchPath(url.pathname);
  if (!path) return fail(400, "BAD_REQUEST");
  if (!enabled.has(path.feature)) return fail(404, "GITHUB_API_UNAVAILABLE");
  const preflight = request.method === "OPTIONS";
  const method = preflight
    ? request.headers.get("Access-Control-Request-Method")
    : request.method;
  const route = method ? resolveRoute(path, method, url.search) : null;
  if (!method || !route) return fail(400, "BAD_REQUEST");
  const post = method === "POST";
  if (preflight) {
    headers.set(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    const allowedHeaders = post
      ? ["authorization", "content-type", "review-submit-id"]
      : ["authorization"];
    const requested =
      request.headers
        .get("Access-Control-Request-Headers")
        ?.split(",")
        .map((header) => header.trim().toLowerCase()) ?? [];
    if (requested.some((header) => !allowedHeaders.includes(header)))
      return fail(403, "FORBIDDEN");
    headers.set("Access-Control-Allow-Methods", method);
    headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    return new Response(null, { status: 204, headers });
  }

  const bearer = /^Bearer ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
    request.headers.get("Authorization") ?? "",
  );
  if (!bearer?.[1] || !bearer[2]) return fail(401, "SESSION_REQUIRED");
  const submitId = request.headers.get("Review-Submit-Id");
  const length = request.headers.get("Content-Length");
  let input: Json | null = null;
  if (post) {
    if (request.headers.get("Content-Type") !== "application/json")
      return fail(400, "BAD_REQUEST");
    if (
      !length ||
      !/^[0-9]+$/u.test(length) ||
      request.headers.has("Transfer-Encoding")
    )
      return fail(411, "LENGTH_REQUIRED");
    if (Number(length) > maxRequestBytes) return fail(413, "PAYLOAD_TOO_LARGE");
    if (!request.body || Number(length) === 0) return fail(400, "BAD_REQUEST");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== Number(length)) return fail(400, "BAD_REQUEST");
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
      if (isJson(parsed)) input = parsed;
    } catch {
      return fail(400, "BAD_REQUEST");
    }
    if (!input) return fail(400, "BAD_REQUEST");
  } else if (request.body || (length !== null && length !== "0")) {
    return fail(400, "BAD_REQUEST");
  }
  const submitRequired =
    route.kind === "create-review" ||
    (route.kind === "graphql" &&
      route.operation !== "pullRequestReviewContext");
  const submitAllowed = submitRequired || route.kind === "graphql";
  if (
    submitId !== null
      ? !submitAllowed || !submitIdPattern.test(submitId)
      : submitRequired
  )
    return fail(400, "BAD_REQUEST");

  const review =
    route.kind === "create-review" && input ? validateReview(input) : null;
  if (route.kind === "create-review" && !review)
    return fail(400, "BAD_REQUEST");
  const variables =
    route.kind === "graphql" && input
      ? validateVariables(route.operation, input)
      : null;
  if (route.kind === "graphql" && !variables) return fail(400, "BAD_REQUEST");
  const newName =
    route.kind === "rename" && input ? validateRepositoryName(input) : null;
  if (route.kind === "rename" && !newName) return fail(400, "BAD_REQUEST");

  const timeout = AbortSignal.timeout(upstreamTimeout);
  const stub = env.GIT_SESSIONS.get(env.GIT_SESSIONS.idFromName(bearer[1]));
  const session = {
    credential: bearer[2],
    origin,
    owner: path.owner,
    repo: path.repo,
  };
  const respond = (value: unknown) => {
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(value), { status: 200, headers });
  };

  const rest = (
    grant: Grant,
    suffix: string,
    accept: string,
    body?: string,
  ): Promise<Response> => {
    // Workerd supports no-store before the pinned workers-types declares it.
    const init: RequestInit & { cache: "no-store" } = {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + grant.accessToken,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body }),
      redirect: "manual",
      cache: "no-store",
      signal: timeout,
    };
    return send(
      restOrigin + "/repos/" + grant.owner + "/" + grant.repo + suffix,
      init,
    );
  };

  const restFailure = async (
    response: Response,
    notFound: ProxyError,
    rejected?: ProxyError,
  ) => {
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400)
      return new ProxyError(409, "REDIRECT_REJECTED");
    if (restRateLimited(response))
      return new ProxyError(
        429,
        "RATE_LIMITED",
        retryAfterSeconds(response.headers),
      );
    if (response.status === 401 || response.status === 403)
      return new ProxyError(403, "FORBIDDEN");
    if (response.status === 404) return notFound;
    if (response.status === 422 && rejected) return rejected;
    if (response.status === 504) return new ProxyError(504, "UPSTREAM_TIMEOUT");
    return new ProxyError(502, "UPSTREAM_FAILURE");
  };

  const graphql = async (
    grant: Grant,
    operation: GitHubReviewOperation | "pullRequestPublicationStatus",
    graphqlVariables: Json,
  ): Promise<GraphqlOutcome> => {
    let response: Response;
    try {
      // Workerd supports no-store before the pinned workers-types declares it.
      const init: RequestInit & { cache: "no-store" } = {
        method: "POST",
        headers: {
          Authorization: "Bearer " + grant.accessToken,
          Accept: "application/vnd.github+json",
          "User-Agent": userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            operation === "pullRequestPublicationStatus"
              ? pullRequestPublicationStatusDocument
              : githubReviewDocuments[operation],
          variables: graphqlVariables,
        }),
        redirect: "manual",
        cache: "no-store",
        signal: timeout,
      };
      response = await send(graphqlUrl, init);
    } catch {
      // The request may have reached GitHub before the connection failed.
      return { kind: "unknown", timeout: timeout.aborted };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { kind: "redirect" };
    }
    if (
      response.status === 429 ||
      (response.status === 403 && restRateLimited(response))
    ) {
      await response.body?.cancel();
      return {
        kind: "rate-limited",
        retryAfter: retryAfterSeconds(response.headers),
      };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { kind: "forbidden" };
    }
    if (response.status === 502 || response.status === 504) {
      await response.body?.cancel();
      return { kind: "unknown", timeout: response.status === 504 };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { kind: "not-sent" };
    }
    const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
    const retryAfter = retryAfterSeconds(response.headers);
    let body: unknown;
    try {
      body = await readJson(
        response,
        operation === "pullRequestReviewContext" ? 256 * kib : 64 * kib,
      );
    } catch {
      return { kind: "unknown", timeout: timeout.aborted };
    }
    if (!isJson(body)) return { kind: "unknown", timeout: false };
    const data = isJson(body.data) ? body.data : null;
    if (body.errors === undefined) {
      if (data) return { kind: "ok", data };
      return exhausted
        ? { kind: "rate-limited", retryAfter }
        : { kind: "unknown", timeout: false };
    }
    if (!Array.isArray(body.errors) || body.errors.length === 0)
      return { kind: "unknown", timeout: false };
    const types = body.errors.map((error) =>
      isJson(error) ? error.type : undefined,
    );
    if (exhausted || types.includes("RATE_LIMITED"))
      return { kind: "rate-limited", retryAfter };
    if (types.includes("FORBIDDEN")) return { kind: "forbidden" };
    if (types.includes("NOT_FOUND")) return { kind: "not-found", data };
    if (body.data === null || body.data === undefined)
      return { kind: "rejected" };
    return { kind: "unknown", timeout: false };
  };

  /** The client error for an outcome in which GitHub did not apply the request. */
  const unsent = (
    outcome: Exclude<GraphqlOutcome, { kind: "ok" } | { kind: "unknown" }>,
    rejected: ProxyError,
    notFound: ProxyError,
  ): ProxyError => {
    switch (outcome.kind) {
      case "rate-limited":
        return new ProxyError(429, "RATE_LIMITED", outcome.retryAfter);
      case "forbidden":
        return new ProxyError(403, "FORBIDDEN");
      case "not-found":
        return notFound;
      case "rejected":
        return rejected;
      case "redirect":
        return new ProxyError(409, "REDIRECT_REJECTED");
      case "not-sent":
        return new ProxyError(502, "UPSTREAM_FAILURE");
    }
  };
  const unknownError = (outcome: { timeout: boolean }) =>
    outcome.timeout
      ? new ProxyError(504, "UPSTREAM_TIMEOUT")
      : new ProxyError(502, "UPSTREAM_FAILURE");
  const upstreamFailure = new ProxyError(502, "UPSTREAM_FAILURE");
  const pullNotFound = new ProxyError(404, "PULL_REQUEST_NOT_FOUND");

  /** Reads a fixed query about the pull request in the verified repository. */
  const readPull = async <T>(
    grant: Grant,
    number: number,
    query: "pullRequestReviewContext" | "pullRequestPublicationStatus",
    shape: (data: Json, repositoryId: number, number: number) => T,
  ): Promise<T> => {
    const outcome = await graphql(grant, query, {
      owner: grant.owner,
      name: grant.repo,
      number,
    });
    if (outcome.kind === "unknown") throw unknownError(outcome);
    if (outcome.kind === "not-found") {
      // A missing pull request in the verified repository is reported as such; anything else
      // (such as a renamed repository that `followRenames: false` does not follow) is forbidden.
      const repository = outcome.data?.repository;
      if (
        isJson(repository) &&
        repository.databaseId === grant.repositoryId &&
        repository.pullRequest === null
      )
        throw pullNotFound;
      throw new ProxyError(403, "FORBIDDEN");
    }
    if (outcome.kind !== "ok")
      throw unsent(outcome, upstreamFailure, pullNotFound);
    try {
      return shape(outcome.data, grant.repositoryId, number);
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      throw upstreamFailure;
    }
  };
  const readContext = (grant: Grant, number: number) =>
    readPull(grant, number, "pullRequestReviewContext", shapeContext);

  try {
    if (route.kind === "rename") {
      if (!newName) return fail(400, "BAD_REQUEST");
      return respond(await rename(stub, { ...session, name: newName }));
    }
    if (route.kind === "publication-status") {
      const grant = await authorize(stub, { ...session, operation: "read" });
      return respond(
        await readPull(
          grant,
          route.number,
          "pullRequestPublicationStatus",
          shapePublicationStatus,
        ),
      );
    }

    if (
      route.kind === "pulls" ||
      route.kind === "pull" ||
      route.kind === "reviews"
    ) {
      const grant = await authorize(stub, { ...session, operation: "read" });
      const { suffix, accept, limit, shape } =
        route.kind === "pulls"
          ? {
              suffix:
                "/pulls?state=all&sort=updated&direction=desc&per_page=20&page=" +
                route.page,
              accept: "application/vnd.github+json",
              limit: mib,
              shape: (value: unknown): unknown =>
                array(value).map(shapePullSummary),
            }
          : route.kind === "pull"
            ? {
                suffix: "/pulls/" + route.number,
                accept: "application/vnd.github.text+json",
                limit: mib,
                shape: shapePull,
              }
            : {
                suffix:
                  "/pulls/" +
                  route.number +
                  "/reviews?per_page=30&page=" +
                  route.page,
                accept: "application/vnd.github+json",
                limit: 4 * mib,
                shape: (value: unknown): unknown =>
                  array(value).map(shapeReview),
              };
      const response = await rest(grant, suffix, accept);
      if (response.status !== 200)
        throw await restFailure(
          response,
          route.kind === "pulls"
            ? new ProxyError(403, "FORBIDDEN")
            : pullNotFound,
        );
      try {
        return respond(shape(await readJson(response, limit)));
      } catch {
        throw upstreamFailure;
      }
    }

    if (route.kind === "create-review") {
      if (!review || submitId === null) return fail(400, "BAD_REQUEST");
      const grant = await authorize(stub, {
        ...session,
        operation: "review",
        reviewId: submitId,
      });
      let response: Response;
      try {
        response = await rest(
          grant,
          "/pulls/" + route.number + "/reviews",
          "application/vnd.github+json",
          JSON.stringify(review),
        );
      } catch {
        throw unknownError({ timeout: timeout.aborted });
      }
      if (response.status !== 200)
        throw await restFailure(
          response,
          pullNotFound,
          new ProxyError(422, "REVIEW_REJECTED"),
        );
      try {
        return respond(shapeCreatedReview(await readJson(response, mib)));
      } catch {
        throw unknownError({ timeout: timeout.aborted });
      }
    }

    if (!variables) return fail(400, "BAD_REQUEST");
    const operation = route.operation;
    const step = stepOf[operation];
    if (step === "context" && submitId === null) {
      const grant = await authorize(stub, { ...session, operation: "read" });
      return respond(
        contextResponse(await readContext(grant, variables.number), null),
      );
    }
    if (submitId === null) return fail(400, "BAD_REQUEST");
    const grant = await authorize(stub, {
      ...session,
      operation: step === "context" ? "read" : "review",
      submit: {
        id: submitId,
        step,
        number: variables.number,
        ...(step === "start" && { commitOid: variables.commitOid }),
        ...(step === "thread" && { threadIndex: variables.threadIndex }),
        ...(step === "submit" && { threadCount: variables.threadCount }),
      },
    });
    const submit = grant.submit;
    if (!submit) throw upstreamFailure;

    if (step === "context") {
      const context = await readContext(grant, variables.number);
      let resolved: { state: SubmitState; threads: number } = {
        state: submit.state,
        threads: submit.threads,
      };
      let reviewNodeId = submit.reviewNodeId;
      if (submit.state === "start-unknown") {
        // The review the start step creates is the viewer's pending review on the recorded
        // commit with an empty body and no comments.
        const created = context.pending.find(
          (candidate) =>
            candidate.ours &&
            candidate.commitOid === submit.commitOid &&
            candidate.body === "" &&
            candidate.comments === 0,
        );
        resolved = created
          ? await reportResult(stub, submit, "pending", {
              pullRequestNodeId: context.pullRequestNodeId,
              reviewNodeId: created.id,
            })
          : await reportResult(stub, submit, "closed");
        if (created) reviewNodeId = created.id;
      } else if (submit.state === "submit-unknown") {
        const id = submit.reviewNodeId;
        const pending = context.pending.some(
          (candidate) => candidate.id === id,
        );
        const recent = context.recent.find((candidate) => candidate.id === id);
        resolved = await reportResult(
          stub,
          submit,
          pending || recent?.state === "PENDING"
            ? "pending"
            : recent
              ? "submitted"
              : "closed",
        );
      }
      return respond(contextResponse(context, reviewNodeId, resolved));
    }

    if (step === "start") {
      if (submit.state !== "starting" || !variables.commitOid)
        throw upstreamFailure;
      let context: ReviewContext;
      try {
        context = await readContext(grant, variables.number);
      } catch (error) {
        // The context query creates nothing, so the start step did not happen.
        await reportResult(stub, submit, "failed");
        throw error;
      }
      if (context.pending.some((candidate) => candidate.ours)) {
        await reportResult(stub, submit, "failed");
        throw new ProxyError(409, "PENDING_REVIEW_EXISTS");
      }
      const outcome = await graphql(grant, "addPullRequestReview", {
        pullRequestId: context.pullRequestNodeId,
        commitOid: variables.commitOid,
      });
      if (outcome.kind === "unknown") {
        await reportResult(stub, submit, "unknown");
        throw unknownError(outcome);
      }
      if (outcome.kind !== "ok") {
        await reportResult(stub, submit, "failed");
        throw unsent(
          outcome,
          new ProxyError(422, "REVIEW_REJECTED"),
          pullNotFound,
        );
      }
      let reviewNodeId: string;
      try {
        const created = object(
          object(outcome.data.addPullRequestReview).pullRequestReview,
        );
        reviewNodeId = nodeId(created.id);
        if (
          created.state !== "PENDING" ||
          commitOid(created.commit) !== variables.commitOid ||
          nodeId(object(created.pullRequest).id) !== context.pullRequestNodeId
        )
          throw new ShapeError();
      } catch {
        await reportResult(stub, submit, "unknown");
        throw upstreamFailure;
      }
      await reportResult(stub, submit, "ok", {
        pullRequestNodeId: context.pullRequestNodeId,
        reviewNodeId,
      });
      return respond({ state: "PENDING", commitOid: variables.commitOid });
    }

    const reviewNodeId = submit.reviewNodeId;
    const inFlight = {
      thread: "threading",
      submit: "submitting",
      delete: "deleting",
    }[step];
    if (submit.state !== inFlight || !reviewNodeId) throw upstreamFailure;

    if (step === "thread") {
      const outcome = await graphql(grant, "addPullRequestReviewThread", {
        reviewId: reviewNodeId,
        path: variables.path,
        body: variables.body,
      });
      if (outcome.kind === "unknown") {
        await reportResult(stub, submit, "unknown");
        throw unknownError(outcome);
      }
      if (outcome.kind === "not-found") {
        await reportResult(stub, submit, "gone");
        throw new ProxyError(409, "REVIEW_STEP_CONFLICT");
      }
      if (outcome.kind !== "ok") {
        await reportResult(stub, submit, "failed");
        throw unsent(
          outcome,
          new ProxyError(422, "REVIEW_THREAD_REJECTED"),
          pullNotFound,
        );
      }
      try {
        const thread = object(
          object(outcome.data.addPullRequestReviewThread).thread,
        );
        nodeId(thread.id);
        if (thread.subjectType !== "FILE" || thread.path !== variables.path)
          throw new ShapeError();
      } catch {
        await reportResult(stub, submit, "unknown");
        throw upstreamFailure;
      }
      const result = await reportResult(stub, submit, "ok");
      return respond({ threads: result.threads });
    }

    if (step === "submit") {
      const outcome = await graphql(grant, "submitPullRequestReview", {
        reviewId: reviewNodeId,
        event: variables.event,
        body: variables.body,
      });
      if (outcome.kind === "unknown") {
        await reportResult(stub, submit, "unknown");
        throw unknownError(outcome);
      }
      if (outcome.kind === "not-found") {
        await reportResult(stub, submit, "gone");
        throw new ProxyError(409, "REVIEW_STEP_CONFLICT");
      }
      if (outcome.kind !== "ok") {
        await reportResult(stub, submit, "failed");
        throw unsent(
          outcome,
          new ProxyError(422, "REVIEW_REJECTED"),
          pullNotFound,
        );
      }
      let published;
      try {
        const value = object(
          object(outcome.data.submitPullRequestReview).pullRequestReview,
        );
        const state = string(value.state);
        if (nodeId(value.id) !== reviewNodeId || state === "PENDING")
          throw new ShapeError();
        published = {
          state,
          commitOid: string(commitOid(value.commit)),
          submittedAt: string(value.submittedAt),
          url: string(value.url),
        };
      } catch {
        await reportResult(stub, submit, "unknown");
        throw upstreamFailure;
      }
      await reportResult(stub, submit, "ok");
      return respond(published);
    }

    const outcome = await graphql(grant, "deletePullRequestReview", {
      reviewId: reviewNodeId,
    });
    if (outcome.kind === "unknown") {
      await reportResult(stub, submit, "unknown");
      throw unknownError(outcome);
    }
    if (outcome.kind === "not-found") {
      await reportResult(stub, submit, "gone");
      return respond({ deleted: true });
    }
    if (outcome.kind !== "ok") {
      await reportResult(stub, submit, "failed");
      throw unsent(
        outcome,
        new ProxyError(422, "REVIEW_REJECTED"),
        pullNotFound,
      );
    }
    try {
      const deleted = object(
        object(outcome.data.deletePullRequestReview).pullRequestReview,
      );
      if (nodeId(deleted.id) !== reviewNodeId) throw new ShapeError();
    } catch {
      await reportResult(stub, submit, "unknown");
      throw upstreamFailure;
    }
    await reportResult(stub, submit, "ok");
    return respond({ deleted: true });
  } catch (error) {
    if (error instanceof ProxyError)
      return fail(error.status, error.code, error.retryAfter);
    return timeout.aborted
      ? fail(504, "UPSTREAM_TIMEOUT")
      : fail(502, "UPSTREAM_FAILURE");
  }
}
