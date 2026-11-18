import { generateCodeChallenge, generateCodeVerifier } from "./pkce.js";
import { hashGitTicket } from "./GitSession.js";
import type { GitRepositoryCreationEnv } from "./gitRepositoryCreationProtocol.js";
import {
  boundedJson,
  CreationError,
  creationCallback,
  creationError,
  creationPrefix,
  exactKeys,
  getCreationSettings,
  loginName,
  parseCreationIntent,
  positiveId,
  providerToken,
  record,
  validOperationId,
} from "./gitRepositoryCreationProtocol.js";

const startPath = creationPrefix + "/start";
const sessionPath = creationPrefix + "/session";
const ownersPath = creationPrefix + "/owners";
const reposPath = creationPrefix + "/repos";
const topicRoute = /^\/v1\/github-create\/repos\/([1-9][0-9]{0,15})\/topics$/u;
const operationRoute =
  /^\/v1\/github-create\/operations\/([A-Za-z0-9_-]{1,100})(\/reconcile)?$/u;
const oauthState = /^[A-Za-z0-9_-]{43}$/u;

export function isGitRepositoryCreationPath(path: string): boolean {
  return path === creationPrefix || path.startsWith(creationPrefix + "/");
}

function routeMethod(path: string, method: string | null): boolean {
  if (path === startPath || path === reposPath) return method === "POST";
  if (path === sessionPath) return method === "GET" || method === "DELETE";
  if (path === ownersPath) return method === "GET";
  if (topicRoute.test(path)) return method === "PUT";
  const operation = operationRoute.exec(path);
  return Boolean(operation && method === (operation[2] ? "POST" : "GET"));
}

async function readBody(
  request: Request,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json")
    return creationError(400, "invalidRequest");
  const input = await boundedJson(request);
  if (!record(input) || !exactKeys(input, keys))
    return creationError(400, "invalidRequest");
  return input;
}

function parseCredential(request: Request, prefix: "login" | "create") {
  const match =
    /^Bearer (login|create)\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get("Authorization") ?? "",
    );
  if (match?.[1] !== prefix || !match[2] || !match[3])
    return creationError(401, "denied");
  return { state: match[2], credential: match[3] };
}

function parseCallback(url: URL) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (
    !state ||
    !oauthState.test(state) ||
    url.searchParams.getAll("state").length !== 1
  ) {
    return creationError(400, "invalidOAuthState");
  }
  if (
    error === "access_denied" &&
    code === null &&
    url.searchParams.getAll("error").length === 1
  ) {
    return { state, code: null };
  }
  if (
    !code ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(code) ||
    url.searchParams.getAll("code").length !== 1 ||
    error !== null
  )
    return creationError(400, "invalidOAuthState");
  return { state, code };
}

export async function handleGitRepositoryCreation(
  request: Request,
  env: GitRepositoryCreationEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const callback = path === creationCallback && request.method === "GET";
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Referrer-Policy": "no-referrer",
  });
  const fail = (status: number, code: string) =>
    Response.json(
      { code, requestId: crypto.randomUUID() },
      { status, headers },
    );
  if (!callback) {
    const origins = env.GIT_ALLOWED_ORIGINS?.split(",").map((item) =>
      item.trim(),
    );
    if (
      !origin ||
      origin === "null" ||
      origin === "*" ||
      !origins?.includes(origin)
    )
      return fail(403, "denied");
    headers.set("Access-Control-Allow-Origin", origin);
  }
  const settings = getCreationSettings(env);
  const namespace = env.GIT_REPOSITORY_CREATION;
  if (!settings || !namespace) return fail(404, "unavailable");
  if (settings.origin !== url.origin) return fail(403, "denied");

  const call = (name: string, path: string, data: object) =>
    namespace
      .get(namespace.idFromName(name))
      .fetch("https://git-repository-creation.internal" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
  const respond = async (result: Response) => {
    if (result.status === 202 || result.status === 204)
      return new Response(null, { status: result.status, headers });
    if (!result.ok) {
      const error = await result.json<{ code: string }>();
      return fail(result.status, error.code);
    }
    headers.set("Content-Type", "application/json");
    return new Response(result.body, { status: result.status, headers });
  };

  try {
    if (callback) {
      const params = parseCallback(url);
      const result = await call("login/" + params.state, "/callback", params);
      if (result.status !== 204) return await respond(result);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response(
        params.code === null
          ? "GitHub authorization was cancelled. Return to the Editor."
          : "GitHub authorization complete. Return to the Editor.",
        { headers },
      );
    }
    const method =
      request.method === "OPTIONS"
        ? request.headers.get("Access-Control-Request-Method")
        : request.method;
    if (url.search || !routeMethod(path, method) || !method)
      return fail(400, "invalidRequest");
    if (request.method === "OPTIONS") {
      const allowed =
        path === startPath
          ? ["content-type"]
          : method === "POST" || method === "PUT"
            ? ["authorization", "content-type"]
            : ["authorization"];
      const requested =
        request.headers
          .get("Access-Control-Request-Headers")
          ?.split(",")
          .map((header) => header.trim().toLowerCase()) ?? [];
      if (requested.some((header) => !allowed.includes(header)))
        return fail(403, "denied");
      headers.set("Access-Control-Allow-Methods", method);
      headers.set("Access-Control-Allow-Headers", allowed.join(", "));
      headers.set(
        "Vary",
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      );
      return new Response(null, { status: 204, headers });
    }
    if ((method === "GET" || method === "DELETE") && request.body)
      return fail(400, "invalidRequest");
    if (path === startPath) {
      await readBody(request, []);
      const state = generateCodeVerifier();
      const secret = generateCodeVerifier();
      const verifier = generateCodeVerifier();
      const authorizationUrl = new URL(
        "https://github.com/login/oauth/authorize",
      );
      authorizationUrl.search = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri,
        state,
        code_challenge: await generateCodeChallenge(verifier),
        code_challenge_method: "S256",
      }).toString();
      const result = await call("login/" + state, "/start", {
        phase: "pending",
        state,
        verifier,
        ticketHash: await hashGitTicket(secret),
        origin,
        deadline: Date.now() + 10 * 60_000,
      });
      if (result.status !== 204) return fail(502, "upstreamFailure");
      return Response.json(
        {
          authorizationUrl: authorizationUrl.href,
          ticket: "login." + state + "." + secret,
        },
        { headers },
      );
    }
    if (path === sessionPath) {
      const ticket = parseCredential(request, "login");
      return await respond(
        await call(
          "login/" + ticket.state,
          method === "DELETE" ? "/revoke" : "/session",
          {
            ...ticket,
            origin,
          },
        ),
      );
    }

    const ticket = parseCredential(request, "create");
    const grant = await call("login/" + ticket.state, "/authorize", {
      ...ticket,
      origin,
    });
    if (!grant.ok) return await respond(grant);
    const authority: unknown = await grant.json();
    if (
      !record(authority) ||
      !record(authority.account) ||
      !positiveId(authority.account.id) ||
      !loginName(authority.account.login) ||
      !providerToken(authority.accessToken) ||
      !positiveId(authority.expiresAt)
    )
      return fail(502, "upstreamFailure");
    if (authority.expiresAt <= Date.now()) return fail(401, "denied");
    if (path === ownersPath) {
      return Response.json(
        {
          owners: [
            {
              login: authority.account.login,
              type: "User",
              canCreate: { private: true, public: true },
            },
          ],
        },
        { headers },
      );
    }
    const account = "account/" + authority.account.id;
    if (path === reposPath) {
      const intent = parseCreationIntent(
        await readBody(request, [
          "owner",
          "name",
          "description",
          "visibility",
          "operationId",
          "seedDigest",
          "topics",
        ]),
      );
      return await respond(
        await call(account, "/create", { authority, intent }),
      );
    }
    const topics = topicRoute.exec(path);
    if (topics) {
      const { operationId } = await readBody(request, ["operationId"]);
      const repositoryId = Number(topics[1]);
      if (!validOperationId(operationId) || !positiveId(repositoryId))
        return fail(400, "invalidRequest");
      return await respond(
        await call(account, "/topics", {
          authority,
          operationId,
          repositoryId,
        }),
      );
    }
    const operation = operationRoute.exec(path);
    if (operation?.[1]) {
      const operationId = operation[1];
      if (!operation[2])
        return await respond(
          await call(account, "/inspect", { authority, operationId }),
        );
      const { repositoryId } = await readBody(request, ["repositoryId"]);
      if (!positiveId(repositoryId)) return fail(400, "invalidRequest");
      return await respond(
        await call(account, "/reconcile", {
          authority,
          operationId,
          repositoryId,
        }),
      );
    }
    return fail(400, "invalidRequest");
  } catch (error) {
    return error instanceof CreationError
      ? fail(error.status, error.code)
      : fail(502, "upstreamFailure");
  }
}
