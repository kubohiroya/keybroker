const github = "https://github.com";
const maxRequestBytes = 32 * 1024 * 1024;
const namespace = "/v1/git";
const pushIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const pathPattern =
  /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\.git(\/info\/refs\?service=(git-upload-pack|git-receive-pack)|\/(git-upload-pack|git-receive-pack))$/u;

export function isGitProxyPath(path: string): boolean {
  return path === namespace || path.startsWith(namespace + "/");
}

function parseRoute(path: string, method: string) {
  const match = pathPattern.exec(path);
  if (!match || match[0] !== path) return null;
  const [, owner, repo, suffix, discovery, rpc] = match;
  if (
    !owner ||
    !repo ||
    !suffix ||
    [".", "..", ".git"].includes(repo.toLowerCase())
  )
    return null;
  if (method !== (discovery ? "GET" : "POST")) return null;
  const service = discovery || rpc;
  return {
    owner,
    repo,
    suffix,
    service,
    write: service === "git-receive-pack",
  };
}

type Route = NonNullable<ReturnType<typeof parseRoute>>;
type Grant = {
  owner: string;
  repo: string;
  accessToken: string;
  pushId?: string;
};
type GitEnv = {
  GIT_PROXY_ORIGIN?: string;
  GIT_ALLOWED_ORIGINS?: string;
  GIT_SESSIONS?: DurableObjectNamespace;
};

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function upstreamFailure(status: number) {
  if (status === 401) return new ProxyError(401, "REAUTH_REQUIRED");
  if (status === 403 || status === 404) return new ProxyError(403, "FORBIDDEN");
  if (status === 429) return new ProxyError(429, "RATE_LIMITED");
  if (status === 504) return new ProxyError(504, "UPSTREAM_TIMEOUT");
  return new ProxyError(502, "UPSTREAM_FAILURE");
}

async function authorize(
  stub: DurableObjectStub,
  credential: string,
  origin: string,
  route: Route,
  { candidate, pushId }: { candidate?: Route; pushId?: string } = {},
) {
  const response = await stub.fetch("https://git-session.internal/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credential,
      origin,
      owner: route.owner,
      repo: route.repo,
      write: route.write,
      ...(route.write &&
        route.suffix.startsWith("/info/") && { writeDiscovery: true }),
      ...(candidate && {
        candidate: { owner: candidate.owner, repo: candidate.repo },
      }),
      ...(pushId && { pushId }),
    }),
  });
  if (response.status !== 200) {
    const value = await response.json<{ code?: string }>();
    if (
      response.status === 401 &&
      (value.code === "SESSION_REQUIRED" ||
        value.code === "SESSION_EXPIRED" ||
        value.code === "REAUTH_REQUIRED")
    )
      throw new ProxyError(401, value.code);
    if (response.status === 403 && value.code === "FORBIDDEN")
      throw new ProxyError(403, value.code);
    if (response.status === 400 && value.code === "BAD_REQUEST")
      throw new ProxyError(400, value.code);
    if (
      response.status === 409 &&
      (value.code === "REDIRECT_REJECTED" || value.code === "PUSH_DUPLICATE")
    )
      throw new ProxyError(409, value.code);
    throw upstreamFailure(response.status);
  }
  const grant = await response.json<Grant>();
  const canonical = parseRoute(
    "/" + grant.owner + "/" + grant.repo + ".git" + route.suffix,
    route.suffix.startsWith("/info/") ? "GET" : "POST",
  );
  if (
    !canonical ||
    grant.pushId !== pushId ||
    typeof grant.accessToken !== "string" ||
    !/^[A-Za-z0-9_]+$/u.test(grant.accessToken)
  ) {
    throw new ProxyError(502, "UPSTREAM_FAILURE");
  }
  return grant;
}

export async function handleGitProxy(
  request: Request,
  env: GitEnv,
  send: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  const fail = (status: number, code: string) =>
    Response.json(
      { code, requestId: crypto.randomUUID() },
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
  if (!env.GIT_SESSIONS || !env.GIT_PROXY_ORIGIN)
    return fail(404, "GIT_PROXY_UNAVAILABLE");
  if (url.protocol !== "https:" || url.origin !== env.GIT_PROXY_ORIGIN)
    return fail(403, "FORBIDDEN");

  const preflight = request.method === "OPTIONS";
  const method = preflight
    ? request.headers.get("Access-Control-Request-Method")
    : request.method;
  const route =
    method &&
    parseRoute(url.pathname.slice(namespace.length) + url.search, method);
  if (!route) return fail(400, "BAD_REQUEST");
  const post = method === "POST";
  const push = post && route.write;
  if (preflight) {
    headers.set(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    const allowedHeaders = post
      ? ["authorization", "content-type"]
      : ["authorization"];
    if (push) allowedHeaders.push("git-push-id");
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
  const length = request.headers.get("Content-Length");
  const contentType = "application/x-" + route.service + "-request";
  if (post) {
    if (request.headers.get("Content-Type") !== contentType)
      return fail(400, "BAD_REQUEST");
    if (
      !length ||
      !/^[0-9]+$/u.test(length) ||
      request.headers.has("Transfer-Encoding")
    ) {
      return fail(411, "LENGTH_REQUIRED");
    }
    if (Number(length) > maxRequestBytes) return fail(413, "PAYLOAD_TOO_LARGE");
    if (!request.body || Number(length) === 0) return fail(400, "BAD_REQUEST");
  } else if (request.body || (length !== null && length !== "0")) {
    return fail(400, "BAD_REQUEST");
  }
  const pushId = request.headers.get("Git-Push-Id");
  if (push ? !pushIdPattern.test(pushId ?? "") : pushId !== null)
    return fail(400, "BAD_REQUEST");

  const timeout = AbortSignal.timeout(120_000);
  try {
    const stub = env.GIT_SESSIONS.get(env.GIT_SESSIONS.idFromName(bearer[1]));
    const grant = await authorize(stub, bearer[2], origin, route, {
      pushId: pushId ?? undefined,
    });
    const responseType =
      "application/x-" + route.service + (post ? "-result" : "-advertisement");
    const signal = AbortSignal.any([request.signal, timeout]);
    let body: ReadableStream | undefined;
    if (post && request.body) {
      const stream = new FixedLengthStream(Number(length));
      void request.body.pipeTo(stream.writable, { signal }).catch(() => {});
      body = stream.readable;
    }
    const upstream = (approved: Grant) => {
      // Workerd supports no-store before the pinned workers-types declares it.
      const init: RequestInit & { cache: "no-store" } = {
        method,
        headers: {
          Authorization:
            "Basic " + btoa("x-access-token:" + approved.accessToken),
          Accept: responseType,
          ...(post && { "Content-Type": contentType }),
        },
        ...(body && { body }),
        redirect: "manual",
        cache: "no-store",
        signal,
      };
      return send(
        github +
          "/" +
          approved.owner +
          "/" +
          approved.repo +
          ".git" +
          route.suffix,
        init,
      );
    };
    let response = await upstream(grant);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      const path = location?.startsWith(github + "/")
        ? location.slice(github.length)
        : location;
      const candidate =
        !post && path?.startsWith("/") && parseRoute(path, "GET");
      if (!candidate || candidate.service !== route.service)
        return fail(409, "REDIRECT_REJECTED");
      const redirected = await authorize(stub, bearer[2], origin, route, {
        candidate,
      });
      if (redirected.owner === grant.owner && redirected.repo === grant.repo)
        return fail(409, "REDIRECT_REJECTED");
      response = await upstream(redirected);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return fail(409, "REDIRECT_REJECTED");
      }
    }
    if (
      response.status !== 200 ||
      !response.body ||
      response.headers.get("Content-Type") !== responseType
    ) {
      await response.body?.cancel();
      throw upstreamFailure(response.status);
    }
    headers.set("Content-Type", responseType);
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof ProxyError) return fail(error.status, error.code);
    return timeout.aborted
      ? fail(504, "UPSTREAM_TIMEOUT")
      : fail(502, "UPSTREAM_FAILURE");
  }
}
