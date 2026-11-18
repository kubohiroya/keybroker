import { decrypt, encrypt } from "./encryption.js";
import { generateCodeVerifier } from "./pkce.js";

export type GitAuthEnv = {
  GIT_SESSIONS?: DurableObjectNamespace;
  GIT_PUBLICATION_JOBS?: DurableObjectNamespace;
  GIT_ALLOWED_ORIGINS?: string;
  GIT_PROXY_ORIGIN?: string;
  GIT_GITHUB_CLIENT_ID?: string;
  GIT_GITHUB_CLIENT_SECRET?: string;
  GIT_GITHUB_REDIRECT_URI?: string;
  GIT_SESSION_KEY?: string;
};

type Settings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  proxyOrigin: string;
  key: string;
};
type Repository = { owner: string; repo: string };
type Pending = {
  phase: "pending" | "exchanging" | "failed";
  state: string;
  verifier: string;
  ticketHash: string;
  origin: string;
  remote: Repository;
  repositoryId?: number;
  write: boolean;
  review: boolean;
  deadline: number;
  publication?: {
    objectId: string;
    jobId: string;
    proofHash: string;
    accountId: number;
    repositoryId: number;
    returnPath: string;
  };
};
type Active = {
  phase: "active";
  origin: string;
  remote: Repository;
  write: boolean;
  review: boolean;
  ticketHash: string;
  canonical: Repository & { id: number };
  repositoryId?: number;
  account: { login: string };
  deadline: number;
  expiresAt: number;
  credentials: string;
};
type Record = Pending | Active;
type Credentials = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  proxySecret: string;
};

const keyPattern = /^[A-Za-z0-9_-]{43}$/u;
export const publicationApprovalPathPattern =
  /^\/v1\/github-publication\/approval\/([0-9a-f]{64})\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/([A-Za-z0-9_-]{43})$/u;
const tokenPattern = /^[A-Za-z0-9_]+$/u;
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const repoPattern = /^[A-Za-z0-9_.-]+$/u;
const recordKey = "session";
const pushIdsKey = "push-ids";
const reviewIdsKey = "review-ids";
const reviewSubmitsKey = "review-submits";
const sessionKeys = [recordKey, pushIdsKey, reviewIdsKey, reviewSubmitsKey];
const maxPushIds = 256;
const maxReviewRecords = 256;
const shortSession = 5 * 60_000;
// An in-flight step older than this is treated as an unknown outcome. The Git Worker's upstream
// timeout is 30 seconds, so the step can no longer complete through the Worker.
const reviewStepTimeout = 60_000;
const submitIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nodeIdPattern = /^[A-Za-z0-9_=-]{1,200}$/u;
const commitOidPattern = /^[0-9a-f]{40}$/u;
const maxPullRequestNumber = 2_147_483_647;

type ReviewStep = "start" | "thread" | "submit" | "delete" | "context";
type SubmitRequest = {
  id: string;
  step: ReviewStep;
  number: number;
  commitOid?: string;
  threadIndex?: number;
  threadCount?: number;
};
type GitHubAuthorization = Repository & {
  credential: string;
  origin: string;
  operation: "read" | "review" | "publication";
  reviewId?: string;
  submit?: SubmitRequest;
};
type SubmitState =
  | "starting"
  | "threading"
  | "submitting"
  | "deleting"
  | "pending"
  | "start-unknown"
  | "submit-unknown"
  | "broken"
  | "submitted"
  | "closed";
type ReviewSubmit = {
  repositoryId: number;
  number: number;
  commitOid: string;
  pullRequestNodeId: string | null;
  reviewNodeId: string | null;
  threads: number;
  state: SubmitState;
  // The state a failed or unknown delete returns to.
  resume: "pending" | "broken" | null;
  // The thread index of the last thread step, to recognize a resent request.
  threadIndex: number | null;
  since: number;
  // Nonce of the current state. A result must name it, so a late result of an expired step
  // cannot overwrite a newer state.
  attempt: string;
};
type ReviewSubmits = { [submitId: string]: ReviewSubmit };
type ReviewOutcome =
  "ok" | "failed" | "unknown" | "gone" | "pending" | "submitted" | "closed";
type ReviewResult = {
  submitId: string;
  attempt: string;
  outcome: ReviewOutcome;
  pullRequestNodeId?: string;
  reviewNodeId?: string;
};

export class GitAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function finished(state: SubmitState): boolean {
  return state === "submitted" || state === "closed";
}

/**
 * Applies the outcome of the current step to a review submit record. Returns null when the
 * outcome does not apply to the record's state.
 */
function transition(
  record: ReviewSubmit,
  outcome: ReviewOutcome,
  ids: { pullRequestNodeId?: string; reviewNodeId?: string },
  now: number,
): ReviewSubmit | null {
  const next = (patch: Partial<ReviewSubmit>): ReviewSubmit => ({
    ...record,
    ...patch,
    since: now,
    attempt: generateCodeVerifier(),
  });
  switch (record.state) {
    case "starting":
      if (outcome === "ok") {
        if (!ids.pullRequestNodeId || !ids.reviewNodeId) return null;
        return next({
          state: "pending",
          threads: 0,
          pullRequestNodeId: ids.pullRequestNodeId,
          reviewNodeId: ids.reviewNodeId,
        });
      }
      if (outcome === "failed") return next({ state: "closed" });
      if (outcome === "unknown") return next({ state: "start-unknown" });
      return null;
    case "threading":
      if (outcome === "ok")
        return next({
          state: "pending",
          threads: record.threads + 1,
          threadIndex: null,
        });
      if (outcome === "failed" || outcome === "unknown")
        return next({ state: "broken" });
      if (outcome === "gone") return next({ state: "closed" });
      return null;
    case "submitting":
      if (outcome === "ok") return next({ state: "submitted" });
      if (outcome === "failed") return next({ state: "pending" });
      if (outcome === "unknown") return next({ state: "submit-unknown" });
      if (outcome === "gone") return next({ state: "closed" });
      return null;
    case "deleting":
      if (!record.resume) return null;
      if (outcome === "ok" || outcome === "gone")
        return next({ state: "closed", resume: null });
      if (outcome === "failed" || outcome === "unknown")
        return next({ state: record.resume, resume: null });
      return null;
    case "start-unknown":
      if (outcome === "pending") {
        if (!ids.pullRequestNodeId || !ids.reviewNodeId) return null;
        return next({
          state: "pending",
          threads: 0,
          pullRequestNodeId: ids.pullRequestNodeId,
          reviewNodeId: ids.reviewNodeId,
        });
      }
      if (outcome === "closed") return next({ state: "closed" });
      return null;
    case "submit-unknown":
      if (
        outcome === "pending" ||
        outcome === "submitted" ||
        outcome === "closed"
      )
        return next({ state: outcome });
      return null;
    default:
      return null;
  }
}

/** Treats an in-flight step that outlived the Worker timeout as an unknown outcome. */
function settle(record: ReviewSubmit, now: number): ReviewSubmit {
  if (
    !["starting", "threading", "submitting", "deleting"].includes(
      record.state,
    ) ||
    now - record.since < reviewStepTimeout
  )
    return record;
  const settled = transition(record, "unknown", {}, now);
  if (!settled)
    throw new Error("An in-flight review submit record cannot settle");
  return settled;
}

function validSubmitRequest(
  operation: "read" | "review",
  submit: SubmitRequest,
): boolean {
  const keys = Object.keys(submit).sort().join(",");
  if (
    !submitIdPattern.test(submit.id) ||
    !isInteger(submit.number, 1, maxPullRequestNumber)
  )
    return false;
  switch (submit.step) {
    case "context":
      return operation === "read" && keys === "id,number,step";
    case "start":
      return (
        operation === "review" &&
        keys === "commitOid,id,number,step" &&
        typeof submit.commitOid === "string" &&
        commitOidPattern.test(submit.commitOid)
      );
    case "thread":
      return (
        operation === "review" &&
        keys === "id,number,step,threadIndex" &&
        isInteger(submit.threadIndex, 0, 49)
      );
    case "submit":
      return (
        operation === "review" &&
        keys === "id,number,step,threadCount" &&
        isInteger(submit.threadCount, 0, 50)
      );
    case "delete":
      return operation === "review" && keys === "id,number,step";
    default:
      return false;
  }
}

/**
 * Checks a GraphQL review step against the submit records and marks the step as in flight.
 * Returns the record the Worker continues with.
 */
function reserveStep(
  submits: ReviewSubmits,
  reviewIds: string[],
  submit: SubmitRequest,
  repositoryId: number,
  now: number,
): ReviewSubmit {
  const existing = submits[submit.id];
  if (submit.step === "start") {
    if (existing || reviewIds.includes(submit.id))
      return gitError(409, "REVIEW_DUPLICATE");
    for (const [id, value] of Object.entries(submits)) {
      const record = settle(value, now);
      submits[id] = record;
      if (
        record.repositoryId === repositoryId &&
        record.number === submit.number &&
        !finished(record.state)
      )
        return gitError(409, "REVIEW_STEP_CONFLICT");
    }
    if (reviewIds.length + Object.keys(submits).length >= maxReviewRecords)
      return gitError(429, "RATE_LIMITED");
    if (!submit.commitOid) return gitError(400, "BAD_REQUEST");
    const record: ReviewSubmit = {
      repositoryId,
      number: submit.number,
      commitOid: submit.commitOid,
      pullRequestNodeId: null,
      reviewNodeId: null,
      threads: 0,
      state: "starting",
      resume: null,
      threadIndex: null,
      since: now,
      attempt: generateCodeVerifier(),
    };
    submits[submit.id] = record;
    return record;
  }
  if (
    !existing ||
    existing.repositoryId !== repositoryId ||
    existing.number !== submit.number
  )
    return gitError(409, "REVIEW_STEP_CONFLICT");
  const record = settle(existing, now);
  submits[submit.id] = record;
  const begin = (patch: Partial<ReviewSubmit>): ReviewSubmit => {
    const value = {
      ...record,
      ...patch,
      since: now,
      attempt: generateCodeVerifier(),
    };
    submits[submit.id] = value;
    return value;
  };
  switch (submit.step) {
    case "context":
      return record;
    case "thread": {
      const index = submit.threadIndex;
      if (index === undefined) return gitError(400, "BAD_REQUEST");
      if (record.state === "pending" && index === record.threads)
        return begin({ state: "threading", threadIndex: index });
      if (
        index < record.threads ||
        ((record.state === "threading" || record.state === "broken") &&
          index === record.threadIndex)
      )
        return gitError(409, "REVIEW_DUPLICATE");
      return gitError(409, "REVIEW_STEP_CONFLICT");
    }
    case "submit":
      if (record.state === "pending" && submit.threadCount === record.threads)
        return begin({ state: "submitting" });
      if (["submitting", "submit-unknown", "submitted"].includes(record.state))
        return gitError(409, "REVIEW_DUPLICATE");
      return gitError(409, "REVIEW_STEP_CONFLICT");
    case "delete":
      if (record.state === "pending" || record.state === "broken")
        return begin({ state: "deleting", resume: record.state });
      if (record.state === "deleting" || record.state === "closed")
        return gitError(409, "REVIEW_DUPLICATE");
      return gitError(409, "REVIEW_STEP_CONFLICT");
    default:
      return gitError(400, "BAD_REQUEST");
  }
}

export function getGitAuthSettings(env: GitAuthEnv): Settings | null {
  const {
    GIT_GITHUB_CLIENT_ID: clientId,
    GIT_GITHUB_CLIENT_SECRET: clientSecret,
    GIT_GITHUB_REDIRECT_URI: redirectUri,
    GIT_PROXY_ORIGIN: proxyOrigin,
    GIT_SESSION_KEY: key,
  } = env;
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !proxyOrigin ||
    !key ||
    !/^[a-f0-9]{64}$/iu.test(key)
  )
    return null;
  try {
    const callback = new URL(redirectUri);
    const proxy = new URL(proxyOrigin);
    if (
      callback.protocol !== "https:" ||
      callback.pathname !== "/v1/git-auth/callback" ||
      redirectUri !== callback.origin + callback.pathname ||
      proxy.protocol !== "https:" ||
      proxy.origin !== proxyOrigin
    )
      return null;
  } catch {
    return null;
  }
  return { clientId, clientSecret, redirectUri, proxyOrigin, key };
}

function validRepository(owner: unknown, repo: unknown): owner is string {
  return (
    typeof owner === "string" &&
    ownerPattern.test(owner) &&
    typeof repo === "string" &&
    repoPattern.test(repo) &&
    ![".", "..", ".git"].includes(repo.toLowerCase())
  );
}

export function parseGitRemote(value: unknown): Repository | null {
  if (typeof value !== "string") return null;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      value,
    );
  return match &&
    match[0] === value &&
    match[1] &&
    match[2] &&
    validRepository(match[1], match[2])
    ? { owner: match[1], repo: match[2] }
    : null;
}

export async function hashGitTicket(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}

function sameRepository(a: Repository, b: Repository): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function gitError(status: number, code: string): never {
  throw new GitAuthError(status, code);
}

/** Seconds until GitHub accepts requests again, from `retry-after` or `x-ratelimit-reset`. */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^[0-9]+$/u.test(retryAfter))
    return Number(retryAfter);
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^[0-9]+$/u.test(reset))
    return Math.max(0, Math.ceil(Number(reset) - now / 1000));
  return 60;
}

export class GitSession {
  private key: Promise<CryptoKey> | undefined;
  private refreshing: Promise<Credentials> | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: GitAuthEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const config = getGitAuthSettings(this.env);
    if (!config || request.method !== "POST")
      return Response.json({ code: "GIT_AUTH_UNAVAILABLE" }, { status: 404 });
    try {
      const path = new URL(request.url).pathname;
      if (path === "/start") {
        const pending = await request.json<Pending>();
        await this.state.storage.setAlarm(pending.deadline);
        await this.state.storage.put(recordKey, pending);
        return new Response(null, { status: 204 });
      }
      if (path === "/callback") {
        const { code, state, proof } = await request.json<{
          code: string;
          state: string;
          proof?: string;
        }>();
        const publication = await this.complete(state, code, config, proof);
        return new Response(null, {
          status: 204,
          ...(publication && { headers: { Location: publication } }),
        });
      }
      if (path === "/session" || path === "/revoke") {
        const { credential, origin, state } = await request.json<{
          credential: string;
          origin: string;
          state: string;
        }>();
        const record = await this.state.storage.get<Record>(recordKey);
        if (
          !record ||
          record.origin !== origin ||
          record.ticketHash !== (await hashGitTicket(credential))
        ) {
          return gitError(401, "SESSION_REQUIRED");
        }
        if (path === "/revoke") {
          await this.state.storage.delete(sessionKeys);
          return new Response(null, { status: 204 });
        }
        if (record.deadline <= Date.now())
          return gitError(401, "SESSION_EXPIRED");
        if (record.phase === "failed") return gitError(401, "REAUTH_REQUIRED");
        if (record.phase !== "active")
          return new Response(null, { status: 202 });
        const { credentials, expiresAt } = await this.lease(record, config);
        return Response.json({
          connection: { mode: "cloudflare", proxyOrigin: config.proxyOrigin },
          account: record.account,
          bearer: state + "." + credentials.proxySecret,
          ...(record.repositoryId !== undefined && {
            repositoryId: record.canonical.id,
          }),
          expiresAt,
        });
      }
      if (path === "/authorize") {
        const value = await request.json<
          | (Repository & {
              credential: string;
              origin: string;
              write: boolean;
              candidate?: Repository;
              pushId?: string;
              writeDiscovery?: boolean;
            })
          | GitHubAuthorization
        >();
        // GitHub API requests name an operation; Git Smart HTTP requests name `write`.
        if ("operation" in value)
          return Response.json(await this.authorizeGitHub(value, config));
        return Response.json(await this.authorize(value, config));
      }
      if (path === "/review-result") {
        return Response.json(
          await this.reviewResult(await request.json<ReviewResult>()),
        );
      }
      return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
    } catch (error) {
      return error instanceof GitAuthError
        ? Response.json(
            {
              code: error.code,
              ...(error.retryAfter !== undefined && {
                retryAfter: error.retryAfter,
              }),
            },
            { status: error.status },
          )
        : Response.json({ code: "UPSTREAM_FAILURE" }, { status: 502 });
    }
  }

  async alarm(): Promise<void> {
    const record = await this.state.storage.get<Record>(recordKey);
    if (!record || record.deadline <= Date.now())
      await this.state.storage.delete(sessionKeys);
  }

  private async complete(
    state: string,
    code: string,
    config: Settings,
    proof?: string,
  ): Promise<string | undefined> {
    const pending = await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<Record>(recordKey);
      if (
        !current ||
        current.phase !== "pending" ||
        current.state !== state ||
        current.deadline <= Date.now()
      ) {
        return gitError(400, "INVALID_OAUTH_STATE");
      }
      if (
        current.publication &&
        (!proof ||
          !keyPattern.test(proof) ||
          current.publication.proofHash !== (await hashGitTicket(proof)))
      )
        return gitError(400, "INVALID_OAUTH_STATE");
      await tx.put(recordKey, { ...current, phase: "exchanging" });
      return current;
    });
    try {
      const expectedRepositoryId =
        pending.publication?.repositoryId ?? pending.repositoryId;
      const tokens = await this.exchange(
        {
          code,
          redirect_uri: config.redirectUri,
          code_verifier: pending.verifier,
          ...(expectedRepositoryId !== undefined && {
            repository_id: String(expectedRepositoryId),
          }),
        },
        config,
      );
      const user = await this.github("/user", tokens.accessToken);
      if (typeof user.login !== "string" || !user.login)
        return gitError(401, "REAUTH_REQUIRED");
      const login = user.login;
      const canonical = await this.lookup(
        pending.remote,
        pending.write,
        tokens.accessToken,
      );
      if (
        expectedRepositoryId !== undefined &&
        canonical.id !== expectedRepositoryId
      )
        return gitError(403, "FORBIDDEN");
      if (pending.publication) {
        const {
          objectId,
          jobId,
          accountId,
          repositoryId,
          proofHash,
          returnPath,
        } = pending.publication;
        const namespace = this.env.GIT_PUBLICATION_JOBS;
        if (!namespace || user.id !== accountId)
          return gitError(403, "FORBIDDEN");
        if (!publicationApprovalPathPattern.test(returnPath))
          return gitError(403, "FORBIDDEN");
        const response = await namespace
          .get(namespace.idFromString(objectId))
          .fetch("https://github-publication.internal/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: jobId,
              state,
              accountId,
              repositoryId,
              proofHash,
            }),
          });
        if (!response.ok) return gitError(403, "PUBLICATION_APPROVAL_REJECTED");
        await this.state.storage.delete(sessionKeys);
        return returnPath;
      }
      const deadline = Math.min(
        tokens.refreshExpiresAt,
        Date.now() + 8 * 60 * 60_000,
      );
      const expiresAt = Math.min(deadline, Date.now() + shortSession);
      const credentials = await encrypt(
        JSON.stringify({ ...tokens, proxySecret: generateCodeVerifier() }),
        await this.encryptionKey(config),
      );
      await this.state.storage.transaction(async (tx) => {
        const current = await tx.get<Record>(recordKey);
        if (current?.phase !== "exchanging")
          return gitError(401, "SESSION_REQUIRED");
        await tx.setAlarm(deadline);
        await tx.put<Active>(recordKey, {
          phase: "active",
          origin: pending.origin,
          remote: pending.remote,
          ticketHash: pending.ticketHash,
          write: pending.write,
          review: pending.review,
          canonical,
          ...(pending.repositoryId !== undefined && {
            repositoryId: pending.repositoryId,
          }),
          account: { login },
          deadline,
          expiresAt,
          credentials,
        });
      });
    } catch (error) {
      await this.state.storage.transaction(async (tx) => {
        const current = await tx.get<Record>(recordKey);
        if (current?.phase === "exchanging")
          await tx.put(recordKey, { ...current, phase: "failed" });
      });
      throw error;
    }
  }

  private async lease(
    record: Active,
    config: Settings,
  ): Promise<{ credentials: Credentials; expiresAt: number }> {
    const current = await this.readCredentials(record, config);
    if (record.expiresAt > Date.now())
      return { credentials: current, expiresAt: record.expiresAt };
    return this.state.storage.transaction(async (tx) => {
      const latest = await tx.get<Record>(recordKey);
      if (latest?.phase !== "active" || latest.deadline <= Date.now())
        return gitError(401, "SESSION_EXPIRED");
      const credentials = await this.readCredentials(latest, config);
      if (latest.expiresAt > Date.now())
        return { credentials, expiresAt: latest.expiresAt };
      credentials.proxySecret = generateCodeVerifier();
      const expiresAt = Math.min(latest.deadline, Date.now() + shortSession);
      await tx.put(recordKey, {
        ...latest,
        expiresAt,
        credentials: await encrypt(
          JSON.stringify(credentials),
          await this.encryptionKey(config),
        ),
      });
      return { credentials, expiresAt };
    });
  }

  private async authorize(
    value: Repository & {
      credential: string;
      origin: string;
      write: boolean;
      candidate?: Repository;
      pushId?: string;
      writeDiscovery?: boolean;
    },
    config: Settings,
  ) {
    const record = await this.state.storage.get<Record>(recordKey);
    if (
      !record ||
      record.phase !== "active" ||
      record.origin !== value.origin ||
      !keyPattern.test(value.credential)
    )
      return gitError(401, "SESSION_REQUIRED");
    const credentials = await this.readCredentials(record, config);
    if (credentials.proxySecret !== value.credential)
      return gitError(401, "SESSION_REQUIRED");
    if (record.expiresAt <= Date.now()) return gitError(401, "SESSION_EXPIRED");
    if (!sameRepository(value, record.remote) || (value.write && !record.write))
      return gitError(403, "FORBIDDEN");
    if (
      (value.write && !value.pushId && value.writeDiscovery !== true) ||
      (value.pushId !== undefined &&
        (!value.write || value.candidate || value.writeDiscovery))
    )
      return gitError(400, "BAD_REQUEST");

    const usable =
      credentials.accessExpiresAt > Date.now()
        ? credentials
        : await this.refresh(credentials, config);
    let target;
    try {
      target = await this.lookup(
        value.candidate ?? record.canonical,
        value.write,
        usable.accessToken,
      );
    } catch (error) {
      if (
        value.candidate &&
        error instanceof GitAuthError &&
        error.status === 403
      )
        return gitError(409, "REDIRECT_REJECTED");
      throw error;
    }
    if (target.id !== record.canonical.id)
      return gitError(
        value.candidate ? 409 : 403,
        value.candidate ? "REDIRECT_REJECTED" : "FORBIDDEN",
      );
    await this.state.storage.transaction(async (tx) => {
      const latest = await tx.get<Record>(recordKey);
      if (latest?.phase !== "active") return gitError(401, "SESSION_REQUIRED");
      if (latest.expiresAt <= Date.now())
        return gitError(401, "SESSION_EXPIRED");
      if (
        (await this.readCredentials(latest, config)).proxySecret !==
        value.credential
      )
        return gitError(401, "SESSION_REQUIRED");
      if (value.pushId) {
        const pushIds = (await tx.get<string[]>(pushIdsKey)) ?? [];
        if (pushIds.includes(value.pushId))
          return gitError(409, "PUSH_DUPLICATE");
        if (pushIds.length >= maxPushIds) return gitError(429, "RATE_LIMITED");
        await tx.put(pushIdsKey, [...pushIds, value.pushId]);
      }
      if (value.candidate)
        await tx.put(recordKey, { ...latest, canonical: target });
    });
    return {
      owner: target.owner,
      repo: target.repo,
      accessToken: usable.accessToken,
      ...(value.pushId && { pushId: value.pushId }),
    };
  }

  /**
   * Authorizes a GitHub API request of the Git Worker. The repository ID is checked on every
   * request, review submits are reserved atomically before the Worker contacts GitHub, and the
   * grant carries only node IDs that this session recorded.
   */
  private async authorizeGitHub(value: GitHubAuthorization, config: Settings) {
    const { operation, reviewId, submit } = value;
    if (
      (operation !== "read" &&
        operation !== "review" &&
        operation !== "publication") ||
      (reviewId !== undefined &&
        (operation !== "review" ||
          submit !== undefined ||
          !submitIdPattern.test(reviewId))) ||
      (submit !== undefined &&
        (operation === "publication" ||
          typeof submit !== "object" ||
          submit === null ||
          !validSubmitRequest(operation, submit)))
    )
      return gitError(400, "BAD_REQUEST");
    if (
      operation === "review" &&
      reviewId === undefined &&
      submit === undefined
    )
      return gitError(400, "BAD_REQUEST");
    const record = await this.state.storage.get<Record>(recordKey);
    if (
      !record ||
      record.phase !== "active" ||
      record.origin !== value.origin ||
      !keyPattern.test(value.credential)
    )
      return gitError(401, "SESSION_REQUIRED");
    const credentials = await this.readCredentials(record, config);
    if (credentials.proxySecret !== value.credential)
      return gitError(401, "SESSION_REQUIRED");
    if (record.expiresAt <= Date.now()) return gitError(401, "SESSION_EXPIRED");
    if (
      !sameRepository(value, record.remote) ||
      (operation === "review" && record.review !== true) ||
      (operation === "publication" && record.write !== true)
    )
      return gitError(403, "FORBIDDEN");

    const usable =
      credentials.accessExpiresAt > Date.now()
        ? credentials
        : await this.refresh(credentials, config);
    const target = await this.lookup(
      record.canonical,
      operation === "publication",
      usable.accessToken,
      true,
    );
    if (target.id !== record.canonical.id) return gitError(403, "FORBIDDEN");
    const actor =
      operation === "publication"
        ? await this.github("/user", usable.accessToken, true)
        : undefined;
    if (
      actor &&
      (!isInteger(actor.id, 1, Number.MAX_SAFE_INTEGER) ||
        typeof actor.login !== "string" ||
        actor.login.toLowerCase() !== record.account.login.toLowerCase())
    )
      return gitError(403, "FORBIDDEN");
    const reserved = await this.state.storage.transaction(async (tx) => {
      const latest = await tx.get<Record>(recordKey);
      if (latest?.phase !== "active") return gitError(401, "SESSION_REQUIRED");
      if (latest.expiresAt <= Date.now())
        return gitError(401, "SESSION_EXPIRED");
      if (
        (await this.readCredentials(latest, config)).proxySecret !==
        value.credential
      )
        return gitError(401, "SESSION_REQUIRED");
      if (!reviewId && !submit) return null;
      const reviewIds = (await tx.get<string[]>(reviewIdsKey)) ?? [];
      const submits = (await tx.get<ReviewSubmits>(reviewSubmitsKey)) ?? {};
      if (reviewId) {
        if (reviewIds.includes(reviewId) || submits[reviewId])
          return gitError(409, "REVIEW_DUPLICATE");
        if (reviewIds.length + Object.keys(submits).length >= maxReviewRecords)
          return gitError(429, "RATE_LIMITED");
        await tx.put(reviewIdsKey, [...reviewIds, reviewId]);
        return null;
      }
      if (!submit) return null;
      const current = reserveStep(
        submits,
        reviewIds,
        submit,
        target.id,
        Date.now(),
      );
      await tx.put(reviewSubmitsKey, submits);
      return current;
    });
    return {
      owner: target.owner,
      repo: target.repo,
      accessToken: usable.accessToken,
      repositoryId: target.id,
      ...(actor && { account: { id: actor.id, login: actor.login } }),
      ...(reviewId && { reviewId }),
      ...(submit &&
        reserved && {
          submit: {
            id: submit.id,
            state: reserved.state,
            number: reserved.number,
            commitOid: reserved.commitOid,
            threads: reserved.threads,
            attempt: reserved.attempt,
            pullRequestNodeId: reserved.pullRequestNodeId,
            reviewNodeId: reserved.reviewNodeId,
          },
        }),
    };
  }

  /** Records the upstream outcome of the step that the Worker reserved with `/authorize`. */
  private async reviewResult(
    value: ReviewResult,
  ): Promise<{ state: SubmitState; threads: number }> {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.submitId !== "string" ||
      !submitIdPattern.test(value.submitId) ||
      typeof value.attempt !== "string" ||
      !keyPattern.test(value.attempt) ||
      ![
        "ok",
        "failed",
        "unknown",
        "gone",
        "pending",
        "submitted",
        "closed",
      ].includes(value.outcome) ||
      (value.pullRequestNodeId !== undefined &&
        !nodeIdPattern.test(value.pullRequestNodeId)) ||
      (value.reviewNodeId !== undefined &&
        !nodeIdPattern.test(value.reviewNodeId))
    )
      return gitError(400, "BAD_REQUEST");
    return this.state.storage.transaction(async (tx) => {
      const latest = await tx.get<Record>(recordKey);
      if (latest?.phase !== "active") return gitError(401, "SESSION_REQUIRED");
      const submits = (await tx.get<ReviewSubmits>(reviewSubmitsKey)) ?? {};
      const record = submits[value.submitId];
      if (!record || record.attempt !== value.attempt)
        return gitError(409, "REVIEW_STEP_CONFLICT");
      const updated = transition(
        record,
        value.outcome,
        {
          pullRequestNodeId: value.pullRequestNodeId,
          reviewNodeId: value.reviewNodeId,
        },
        Date.now(),
      );
      if (!updated) return gitError(409, "REVIEW_STEP_CONFLICT");
      submits[value.submitId] = updated;
      await tx.put(reviewSubmitsKey, submits);
      return { state: updated.state, threads: updated.threads };
    });
  }

  private refresh(
    credentials: Credentials,
    config: Settings,
  ): Promise<Credentials> {
    if (!this.refreshing) {
      this.refreshing = this.rotate(credentials, config).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async rotate(
    credentials: Credentials,
    config: Settings,
  ): Promise<Credentials> {
    const record = await this.state.storage.get<Record>(recordKey);
    if (record?.phase !== "active") return gitError(401, "SESSION_REQUIRED");
    const latestCredentials = await this.readCredentials(record, config);
    if (
      latestCredentials.refreshToken !== credentials.refreshToken ||
      latestCredentials.accessExpiresAt > Date.now()
    ) {
      return latestCredentials;
    }
    if (latestCredentials.refreshExpiresAt <= Date.now()) {
      await this.state.storage.delete(sessionKeys);
      return gitError(401, "REAUTH_REQUIRED");
    }
    const tokens = await this.exchange(
      {
        grant_type: "refresh_token",
        refresh_token: latestCredentials.refreshToken,
      },
      config,
    ).catch(async (error) => {
      if (error instanceof GitAuthError && error.status === 401)
        await this.state.storage.delete(sessionKeys);
      throw error;
    });
    return this.state.storage.transaction(async (tx) => {
      const latest = await tx.get<Record>(recordKey);
      if (latest?.phase !== "active") return gitError(401, "SESSION_REQUIRED");
      const current = await this.readCredentials(latest, config);
      const updated = { ...tokens, proxySecret: current.proxySecret };
      await tx.put(recordKey, {
        ...latest,
        credentials: await encrypt(
          JSON.stringify(updated),
          await this.encryptionKey(config),
        ),
      });
      return updated;
    });
  }

  private encryptionKey(config: Settings): Promise<CryptoKey> {
    this.key ??= crypto.subtle.importKey(
      "raw",
      Uint8Array.from(config.key.match(/../gu) ?? [], (part) =>
        Number.parseInt(part, 16),
      ),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return this.key;
  }

  private async readCredentials(
    record: Active,
    config: Settings,
  ): Promise<Credentials> {
    return JSON.parse(
      await decrypt(record.credentials, await this.encryptionKey(config)),
    ) as Credentials;
  }

  private async exchange(
    parameters: RecordOfStrings,
    config: Settings,
  ): Promise<Omit<Credentials, "proxySecret">> {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...parameters,
        }),
      },
    );
    if (response.status === 429) return gitError(429, "RATE_LIMITED");
    if (
      (response.status >= 300 && response.status < 400) ||
      response.status >= 500
    ) {
      await response.body?.cancel();
      return gitError(502, "UPSTREAM_FAILURE");
    }
    const token = await response.json<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
    }>();
    const validSeconds = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      Number.isSafeInteger(Date.now() + value * 1000);
    if (
      !response.ok ||
      !token.access_token ||
      !tokenPattern.test(token.access_token) ||
      !token.refresh_token ||
      !tokenPattern.test(token.refresh_token) ||
      !validSeconds(token.expires_in) ||
      !validSeconds(token.refresh_token_expires_in)
    )
      return gitError(401, "REAUTH_REQUIRED");
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
      refreshExpiresAt: Date.now() + token.refresh_token_expires_in * 1000,
    };
  }

  private async github(
    path: string,
    accessToken: string,
    rateLimit = false,
  ): Promise<{
    login?: string;
    id?: number;
    full_name?: string;
    permissions?: { pull?: boolean; push?: boolean };
  }> {
    const response = await fetch("https://api.github.com" + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + accessToken,
        "User-Agent": "HierarchiDB-Git",
      },
    });
    if (response.status === 401) return gitError(401, "REAUTH_REQUIRED");
    // GitHub API routes separate a rate limit from missing permission; Git routes keep FORBIDDEN.
    if (
      rateLimit &&
      (response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after"))))
    ) {
      await response.body?.cancel();
      throw new GitAuthError(
        429,
        "RATE_LIMITED",
        retryAfterSeconds(response.headers),
      );
    }
    if (response.status === 403 || response.status === 404)
      return gitError(403, "FORBIDDEN");
    if (response.status === 429) return gitError(429, "RATE_LIMITED");
    if (!response.ok) return gitError(502, "UPSTREAM_FAILURE");
    return response.json();
  }

  private async lookup(
    remote: Repository,
    write: boolean,
    accessToken: string,
    rateLimit = false,
  ): Promise<Repository & { id: number }> {
    if (!validRepository(remote.owner, remote.repo))
      return gitError(403, "FORBIDDEN");
    const result = await this.github(
      "/repos/" + remote.owner + "/" + remote.repo,
      accessToken,
      rateLimit,
    );
    const name =
      result.full_name &&
      parseGitRemote("https://github.com/" + result.full_name);
    if (
      !name ||
      !sameRepository(name, remote) ||
      typeof result.id !== "number" ||
      !Number.isSafeInteger(result.id) ||
      result.id <= 0 ||
      (write ? result.permissions?.push : result.permissions?.pull) !== true
    )
      return gitError(403, "FORBIDDEN");
    return { ...name, id: result.id };
  }
}

type RecordOfStrings = { [name: string]: string };
