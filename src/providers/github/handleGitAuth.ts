import { generateCodeChallenge, generateCodeVerifier } from "./pkce.js";
import {
  type GitAuthEnv,
  getGitAuthSettings,
  hashGitTicket,
  parseGitRemote,
  publicationApprovalPathPattern,
} from "./GitSession.js";

const prefix = "/v1/git-auth";
const callbackPath = prefix + "/callback";
const startPath = prefix + "/start";
const sessionPath = prefix + "/session";

export function isGitAuthPath(path: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export async function handleGitAuth(
  request: Request,
  env: GitAuthEnv,
): Promise<Response> {
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
  const url = new URL(request.url);
  const callback = url.pathname === callbackPath && request.method === "GET";
  const origin = request.headers.get("Origin");
  if (!callback) {
    const origins = env.GIT_ALLOWED_ORIGINS?.split(",").map((value) =>
      value.trim(),
    );
    if (
      !origin ||
      origin === "*" ||
      origin === "null" ||
      !origins?.includes(origin)
    )
      return fail(403, "FORBIDDEN");
    headers.set("Access-Control-Allow-Origin", origin);
  }

  const settings = getGitAuthSettings(env);
  const namespace = env.GIT_SESSIONS;
  if (!settings || !namespace) return fail(404, "GIT_AUTH_UNAVAILABLE");
  if (url.origin !== new URL(settings.redirectUri).origin)
    return fail(403, "FORBIDDEN");
  const call = (state: string, path: string, body: object) =>
    namespace
      .get(namespace.idFromName(state))
      .fetch("https://git-session.internal" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

  if (request.method === "OPTIONS") {
    const method = request.headers.get("Access-Control-Request-Method");
    const allowed =
      url.pathname === startPath && method === "POST"
        ? ["content-type"]
        : url.pathname === sessionPath &&
            (method === "GET" || method === "DELETE")
          ? ["authorization"]
          : null;
    if (!allowed || !method || url.search) return fail(400, "BAD_REQUEST");
    headers.set(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    const requested =
      request.headers
        .get("Access-Control-Request-Headers")
        ?.split(",")
        .map((header) => header.trim().toLowerCase()) ?? [];
    if (requested.some((header) => !allowed.includes(header)))
      return fail(403, "FORBIDDEN");
    headers.set("Access-Control-Allow-Methods", method);
    headers.set("Access-Control-Allow-Headers", allowed.join(", "));
    return new Response(null, { status: 204, headers });
  }

  try {
    if (callback) {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (
        !state ||
        !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
        !code ||
        !/^[A-Za-z0-9_-]+$/u.test(code) ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length !== 1
      ) {
        return fail(400, "INVALID_OAUTH_STATE");
      }
      const proofCookie = "__Host-tw-publish-proof-" + state + "=";
      const proofs = (request.headers.get("Cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(proofCookie));
      const proof =
        proofs.length === 1 ? proofs[0]?.slice(proofCookie.length) : undefined;
      const result = await call(state, "/callback", {
        state,
        code,
        ...(proof && { proof }),
      });
      if (proof)
        headers.set(
          "Set-Cookie",
          proofCookie + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
      if (result.status === 204) {
        const location = result.headers.get("Location");
        if (location && publicationApprovalPathPattern.test(location)) {
          headers.set("Location", location);
          return new Response(null, { status: 303, headers });
        }
        headers.set("Content-Type", "text/plain; charset=utf-8");
        return new Response(
          "GitHub authorization complete. Return to the Editor.",
          { headers },
        );
      }
      const error = await result.json<{ code: string }>();
      return fail(result.status, error.code);
    }
    if (url.search) return fail(400, "BAD_REQUEST");
    if (url.pathname === startPath && request.method === "POST") {
      if (request.headers.get("Content-Type") !== "application/json")
        return fail(400, "BAD_REQUEST");
      const input = await request
        .json<{
          remote: unknown;
          write: unknown;
          review?: unknown;
          repositoryId?: unknown;
        }>()
        .catch(() => null);
      const remote = parseGitRemote(input?.remote);
      if (
        !remote ||
        typeof input?.write !== "boolean" ||
        (input.review !== undefined && typeof input.review !== "boolean") ||
        (input.repositoryId !== undefined &&
          (typeof input.repositoryId !== "number" ||
            !Number.isSafeInteger(input.repositoryId) ||
            input.repositoryId < 1))
      )
        return fail(400, "BAD_REQUEST");
      const state = generateCodeVerifier();
      const ticket = generateCodeVerifier();
      const verifier = generateCodeVerifier();
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri,
        state,
        code_challenge: await generateCodeChallenge(verifier),
        code_challenge_method: "S256",
        scope: "offline_access",
      }).toString();
      const result = await call(state, "/start", {
        phase: "pending",
        state,
        verifier,
        ticketHash: await hashGitTicket(ticket),
        origin,
        remote,
        write: input.write,
        // Review submission is a separate grant from push. Omitting it requests no review grant.
        review: input.review ?? false,
        ...(input.repositoryId !== undefined && {
          repositoryId: input.repositoryId,
        }),
        deadline: Date.now() + 10 * 60_000,
      });
      if (result.status !== 204) return fail(502, "UPSTREAM_FAILURE");
      return Response.json(
        { authorizationUrl: url.href, ticket: state + "." + ticket },
        { headers },
      );
    }
    if (
      url.pathname === sessionPath &&
      (request.method === "GET" || request.method === "DELETE")
    ) {
      const ticket = /^Bearer ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
        request.headers.get("Authorization") ?? "",
      );
      if (!ticket?.[1] || !ticket[2]) return fail(401, "SESSION_REQUIRED");
      const result = await call(
        ticket[1],
        request.method === "GET" ? "/session" : "/revoke",
        {
          origin,
          state: ticket[1],
          credential: ticket[2],
        },
      );
      if (result.status === 202 || result.status === 204)
        return new Response(null, { status: result.status, headers });
      if (result.status !== 200) {
        const error = await result.json<{ code: string }>();
        return fail(result.status, error.code);
      }
      headers.set("Content-Type", "application/json");
      return new Response(result.body, { headers });
    }
    return fail(400, "BAD_REQUEST");
  } catch {
    return fail(502, "UPSTREAM_FAILURE");
  }
}
