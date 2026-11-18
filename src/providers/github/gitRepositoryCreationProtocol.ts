export type GitRepositoryCreationEnv = {
  GIT_REPOSITORY_CREATION?: DurableObjectNamespace;
  GIT_ALLOWED_ORIGINS?: string;
  GIT_CREATE_CLIENT_ID?: string;
  GIT_CREATE_CLIENT_SECRET?: string;
  GIT_CREATE_REDIRECT_URI?: string;
  GIT_CREATE_SESSION_KEY?: string;
};

export type CreationVisibility = "public" | "private";
export type CreationIntent = {
  owner: string;
  name: string;
  description: string;
  visibility: CreationVisibility;
  operationId: string;
  seedDigest: string;
  topics: string[];
};
export type CreatedRepository = {
  owner: string;
  name: string;
  id: number;
  visibility: CreationVisibility;
  remote: string;
};

export const creationPrefix = "/v1/github-create";
export const creationCallback = creationPrefix + "/callback";
const maxBody = 4096;

export class CreationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function creationError(status: number, code: string): never {
  throw new CreationError(status, code);
}

export function getCreationSettings(env: GitRepositoryCreationEnv) {
  const {
    GIT_CREATE_CLIENT_ID: clientId,
    GIT_CREATE_CLIENT_SECRET: clientSecret,
    GIT_CREATE_REDIRECT_URI: redirectUri,
    GIT_CREATE_SESSION_KEY: key,
  } = env;
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !key ||
    !/^[a-f0-9]{64}$/iu.test(key)
  )
    return null;
  try {
    const callback = new URL(redirectUri);
    if (
      callback.protocol !== "https:" ||
      redirectUri !== callback.origin + creationCallback
    )
      return null;
    return {
      clientId,
      clientSecret,
      redirectUri,
      key,
      origin: callback.origin,
    };
  } catch {
    return null;
  }
}

export type CreationSettings = NonNullable<
  ReturnType<typeof getCreationSettings>
>;
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export const loginName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(value);
export const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
export const validOperationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
export const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const providerToken = (value: unknown): value is string =>
  typeof value === "string" && /^ghu_[A-Za-z0-9_]{1,253}$/u.test(value);

export function parseCreationIntent(value: unknown): CreationIntent {
  if (
    !record(value) ||
    !exactKeys(value, [
      "owner",
      "name",
      "description",
      "visibility",
      "operationId",
      "seedDigest",
      "topics",
    ])
  ) {
    return creationError(400, "invalidRequest");
  }
  const {
    owner,
    name,
    description,
    visibility,
    operationId,
    seedDigest,
    topics,
  } = value;
  if (
    !loginName(owner) ||
    typeof name !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(name) ||
    name === "." ||
    name === ".." ||
    /\.git$/iu.test(name) ||
    typeof description !== "string" ||
    description.length > 350 ||
    // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
    /[\u0000-\u001f]/u.test(description) ||
    (visibility !== "private" && visibility !== "public") ||
    !validOperationId(operationId) ||
    typeof seedDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(seedDigest) ||
    !Array.isArray(topics) ||
    topics.length > 20 ||
    topics.some(
      (topic: unknown) =>
        typeof topic !== "string" || !/^[a-z0-9][a-z0-9-]{0,49}$/u.test(topic),
    )
  ) {
    return creationError(400, "invalidRequest");
  }
  return {
    owner,
    name,
    description,
    visibility,
    operationId,
    seedDigest,
    topics: [...new Set<string>(topics)],
  };
}

export function verifiedRepository(
  value: unknown,
  { owner, name, visibility }: CreationIntent,
): CreatedRepository | null {
  if (
    !record(value) ||
    !record(value.owner) ||
    !loginName(value.owner.login) ||
    !sameName(value.owner.login, owner) ||
    typeof value.name !== "string" ||
    !sameName(value.name, name) ||
    !positiveId(value.id) ||
    value.private !== (visibility === "private")
  )
    return null;
  return {
    owner: value.owner.login,
    name: value.name,
    visibility,
    id: value.id,
    remote:
      "https://github.com/" + value.owner.login + "/" + value.name + ".git",
  };
}

export function repositoryPath(
  repository: Pick<CreatedRepository, "owner" | "name">,
): string {
  return (
    "/repos/" +
    encodeURIComponent(repository.owner) +
    "/" +
    encodeURIComponent(repository.name)
  );
}

export async function boundedJson(
  message: Request | Response,
  limit = maxBody,
): Promise<unknown> {
  const stream = message.body;
  if (!stream) return creationError(400, "invalidRequest");
  const reader = stream.getReader();
  let bytes = 0;
  let body = "";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        return creationError(413, "payloadTooLarge");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof CreationError) throw error;
    return creationError(400, "invalidRequest");
  } finally {
    reader.releaseLock();
  }
}
