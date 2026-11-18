import type { CreationSettings } from "./gitRepositoryCreationProtocol.js";
import {
  boundedJson,
  creationError,
  positiveId,
  providerToken,
  record,
} from "./gitRepositoryCreationProtocol.js";

export async function exchangeCreationCode(
  config: CreationSettings,
  code: string,
  verifier: string,
) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (response.status === 429) return creationError(429, "rateLimited");
  if (!response.ok) return creationError(401, "denied");
  const value = await readGitHubJson(response);
  if (
    !record(value) ||
    !providerToken(value.access_token) ||
    !positiveId(value.expires_in) ||
    !Number.isSafeInteger(Date.now() + value.expires_in * 1000)
  )
    return creationError(401, "denied");
  return {
    accessToken: value.access_token,
    expiresAt: Date.now() + value.expires_in * 1000,
  };
}

export async function sendCreationRequest(
  path: string,
  accessToken: string,
  method = "GET",
  body?: object,
) {
  return fetch("https://api.github.com" + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + accessToken,
      "User-Agent": "HierarchiDB-Git",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function readGitHubJson(response: Response): Promise<unknown> {
  try {
    return await boundedJson(response, 256 * 1024);
  } catch {
    return creationError(502, "upstreamFailure");
  }
}

export function githubRefusal(response: Response): CreationErrorResult | null {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  ) {
    return { status: 429, code: "rateLimited" };
  }
  if (response.status === 401) return { status: 401, code: "denied" };
  if (response.status === 403 || response.status === 404)
    return { status: 403, code: "insufficientPermission" };
  return null;
}

type CreationErrorResult = { status: number; code: string };
