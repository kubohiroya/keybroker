import { type GitAuthEnv, parseGitRemote } from "./GitSession.js";

export const publicationPath = "/v1/github-publication";
export const approvalTtl = 10 * 60_000;
export const approvedTtl = 8 * 60 * 60_000;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
export const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
export const oidPattern = /^[0-9a-f]{40}$/u;
const enabledNames = [
  "pulls-read",
  "pulls-write",
  "issues-read",
  "issues-write",
  "checks-read",
  "merge",
  "stacks",
] as const;

export type PublicationCapability = (typeof enabledNames)[number];
export type PublicationEnv = GitAuthEnv & {
  GIT_PUBLICATION?: string;
};
type Json = Record<string, unknown>;
export type Target = { id: string; remote: string; repositoryId: number };
export type StackParent = {
  number: number;
  head: string;
  headOid: string;
  targetBase: string;
  stackNumber?: number;
};
export type Intent = Target & {
  head: string;
  base: string;
  baseOid: string;
  commitOid: string;
  title: string;
  body: string;
  goal: "pr" | "merge";
  allowNoChecks?: boolean;
  issue?:
    | { number: number; closeAfterMerge: boolean }
    | { title: string; body: string; closeAfterMerge: boolean };
  stackParent?: StackParent;
};
export type Job = {
  intent: Intent;
  status:
    | "queued"
    | "pushed"
    | "creatingIssue"
    | "issueReady"
    | "creatingPull"
    | "stacking"
    | "waitingForParent"
    | "waiting"
    | "ready"
    | "merging"
    | "merged"
    | "done";
  issueNumber?: number;
  pullNumber?: number;
  mergeOid?: string;
  pause?: string;
};
export type Authority = {
  owner: string;
  repo: string;
  repositoryId: number;
  account: { id: number; login: string };
  accessToken: string;
};
export type Session = {
  state: string;
  credential: string;
  origin: string;
  remote: string;
};

export class PublicationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const denied = () => new PublicationError(403, "FORBIDDEN");
export const invalid = () => new PublicationError(400, "BAD_REQUEST");
export const jsonRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const loginPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const namePattern = /^[A-Za-z0-9_.-]{1,100}$/u;

export function features(
  value: string | undefined,
): readonly PublicationCapability[] | null {
  if (!value?.trim()) return null;
  const names = value.split(",").map((name) => name.trim());
  const valid = (name: string): name is PublicationCapability =>
    (enabledNames as readonly string[]).includes(name);
  if (
    !names.every(valid) ||
    new Set(names).size !== names.length ||
    !names.includes("pulls-read") ||
    !names.includes("pulls-write") ||
    (names.includes("merge") && !names.includes("checks-read")) ||
    (names.includes("issues-write") && !names.includes("issues-read"))
  )
    throw new PublicationError(500, "PUBLICATION_MISCONFIGURED");
  return names;
}

export function canonicalRemote(value: unknown) {
  const parsed = parseGitRemote(value);
  if (
    !parsed ||
    !loginPattern.test(parsed.owner) ||
    !namePattern.test(parsed.repo)
  )
    throw invalid();
  return "https://github.com/" + parsed.owner + "/" + parsed.repo + ".git";
}

export const remoteOf = ({ owner, repo }: Authority) =>
  "https://github.com/" + owner + "/" + repo + ".git";
export const sameRemote = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

export function target(value: unknown): Target {
  if (
    !jsonRecord(value) ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    !positiveId(value.repositoryId)
  )
    throw invalid();
  return {
    id: value.id,
    remote: canonicalRemote(value.remote),
    repositoryId: value.repositoryId,
  };
}

export function requireKeys(
  value: unknown,
  allowed: readonly string[],
): asserts value is Json {
  if (
    !jsonRecord(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw invalid();
}

export function validateIntentShape(value: unknown): Target {
  requireKeys(value, [
    "id",
    "remote",
    "repositoryId",
    "head",
    "base",
    "baseOid",
    "commitOid",
    "title",
    "body",
    "goal",
    "allowNoChecks",
    "issue",
    "stackParent",
  ]);
  if (value.issue !== undefined) {
    if (!jsonRecord(value.issue)) throw invalid();
    requireKeys(
      value.issue,
      "number" in value.issue
        ? ["number", "closeAfterMerge"]
        : ["title", "body", "closeAfterMerge"],
    );
  }
  if (value.stackParent !== undefined)
    requireKeys(value.stackParent, [
      "number",
      "head",
      "headOid",
      "targetBase",
      "stackNumber",
    ]);
  return target(value);
}

export function canRun(
  intent: Intent,
  enabled: readonly PublicationCapability[],
) {
  if (
    intent.goal === "merge" &&
    (!enabled.includes("checks-read") || !enabled.includes("merge"))
  )
    throw denied();
  if (intent.stackParent && !enabled.includes("stacks")) throw denied();
  if (
    intent.issue &&
    (!enabled.includes("issues-read") ||
      ((!("number" in intent.issue) || intent.issue.closeAfterMerge) &&
        !enabled.includes("issues-write")) ||
      (intent.issue.closeAfterMerge && !enabled.includes("checks-read")))
  )
    throw denied();
}

export function rendererSession(
  request: Request,
  origin: string,
  remote: string,
): Session {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
    request.headers.get("Authorization") ?? "",
  );
  if (!bearer?.[1] || !bearer[2])
    throw new PublicationError(401, "SESSION_REQUIRED");
  return { state: bearer[1], credential: bearer[2], origin, remote };
}

export async function authorizePublication(
  env: PublicationEnv,
  session: Session,
): Promise<Authority> {
  const namespace = env.GIT_SESSIONS;
  const remote = parseGitRemote(session.remote);
  if (!namespace || !remote) throw denied();
  const response = await namespace
    .get(namespace.idFromName(session.state))
    .fetch("https://git-session.internal/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...remote,
        origin: session.origin,
        credential: session.credential,
        operation: "publication",
      }),
    });
  if (response.status === 401)
    throw new PublicationError(401, "SESSION_REQUIRED");
  if (response.status === 403) throw denied();
  if (response.status === 429) throw new PublicationError(429, "RATE_LIMITED");
  if (response.status !== 200)
    throw new PublicationError(502, "UPSTREAM_FAILURE");
  const value = await response.json<unknown>();
  if (
    !jsonRecord(value) ||
    typeof value.owner !== "string" ||
    !loginPattern.test(value.owner) ||
    typeof value.repo !== "string" ||
    !namePattern.test(value.repo) ||
    typeof value.accessToken !== "string" ||
    !/^[A-Za-z0-9_]{1,2048}$/u.test(value.accessToken) ||
    !positiveId(value.repositoryId) ||
    !jsonRecord(value.account) ||
    !positiveId(value.account.id) ||
    typeof value.account.login !== "string" ||
    !loginPattern.test(value.account.login)
  )
    throw denied();
  const authority = value as Authority;
  if (!sameRemote(remoteOf(authority), session.remote)) throw denied();
  return authority;
}

export async function readText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let length = 0;
  let result = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      length += value.byteLength;
      if (length > maxBytes)
        throw new PublicationError(413, "PAYLOAD_TOO_LARGE");
      result += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw invalid();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readPublicationJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type") !== "application/json")
    throw invalid();
  const text = await readText(request, 256 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw invalid();
  }
}
