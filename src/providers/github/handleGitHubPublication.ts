import { generateCodeVerifier } from "./pkce.js";
import {
  getGitAuthSettings,
  hashGitTicket,
  publicationApprovalPathPattern,
} from "./GitSession.js";
import {
  approvalTtl,
  authorizePublication,
  canonicalRemote,
  denied,
  features,
  type Intent,
  invalid,
  type Job,
  jsonRecord,
  type PublicationEnv,
  PublicationError,
  positiveId,
  publicationPath,
  readPublicationJson,
  readText,
  remoteOf,
  rendererSession,
  requireKeys,
  target,
  tokenPattern,
  validateIntentShape,
} from "./gitHubPublicationProtocol.js";

const allowedPaths = [
  "/repository",
  "/stack-parent",
  "/jobs",
  "/jobs/status",
  "/jobs/advance",
] as const;
const cookieName = (id: string) => "__Host-tw-publication-" + id;
const browserCookie = (id: string) => "__Host-tw-publish-browser-" + id;

export function isGitHubPublicationPath(path: string) {
  return path === publicationPath || path.startsWith(publicationPath + "/");
}

function escapeHtml(value: string | number) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

function cookieValue(request: Request, name: string) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  const value =
    values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
  return value && tokenPattern.test(value) ? value : undefined;
}

function landingPage(path: string, csrf: string) {
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub publication</title>' +
    "<h1>GitHub publication</h1><p>Verify your GitHub account to see the publication request.</p>" +
    '<form method="post" action="' +
    escapeHtml(path) +
    '">' +
    '<input type="hidden" name="csrf" value="' +
    escapeHtml(csrf) +
    '">' +
    '<button type="submit" name="verify" value="yes">Continue to GitHub</button></form></html>'
  );
}

function approvalPage(
  path: string,
  csrf: string,
  intent: Intent,
  login: string,
  job?: Job,
) {
  const row = (label: string, value: string | number) =>
    "<dt>" +
    escapeHtml(label) +
    "</dt><dd><pre>" +
    escapeHtml(value) +
    "</pre></dd>";
  const issue = intent.issue;
  const parent = intent.stackParent;
  const fields = [
    row("GitHub account", login),
    row("Repository", intent.remote),
    row("Repository ID", intent.repositoryId),
    row("Base branch and commit", intent.base + "\n" + intent.baseOid),
    row("Head branch and commit", intent.head + "\n" + intent.commitOid),
    row(
      "Pull request",
      job?.pullNumber ? "#" + job.pullNumber : "Create a new pull request",
    ),
    row("Pull request title", intent.title),
    row("Pull request body", intent.body),
    ...(parent
      ? [
          row(
            "Parent pull request and stack",
            "#" +
              parent.number +
              (parent.stackNumber ? " in stack #" + parent.stackNumber : ""),
          ),
          row("Parent branch and commit", parent.head + "\n" + parent.headOid),
          row("Final target branch of the stack", parent.targetBase),
        ]
      : []),
    row(
      "Issue",
      !issue
        ? "None"
        : "number" in issue
          ? "Link #" + issue.number
          : "Create issue: " + issue.title + "\n" + issue.body,
    ),
    row(
      "Close issue after verified merge",
      issue?.closeAfterMerge ? "Yes" : "No",
    ),
    row(
      "Merge scope",
      intent.goal === "merge"
        ? "Squash merge after CI and GitHub rules permit it"
        : "Create the pull request",
    ),
    row(
      "Permit a merge with no visible checks",
      intent.allowNoChecks ? "Yes" : "No",
    ),
  ].join("");
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    "<title>Approve GitHub publication</title><h1>Approve GitHub publication</h1><dl>" +
    fields +
    '</dl><form method="post" action="' +
    escapeHtml(path) +
    '">' +
    '<input type="hidden" name="csrf" value="' +
    escapeHtml(csrf) +
    '">' +
    '<label><input type="checkbox" name="approve" value="yes" required> I approve this GitHub publication.</label> ' +
    '<button type="submit">Approve</button></form></html>'
  );
}

function responseFrom(value: unknown, headers: Headers, status = 200) {
  return Response.json(value, { status, headers });
}

function doRequest(stub: DurableObjectStub, path: string, value: object) {
  return stub.fetch("https://github-publication.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function passResult(response: Response, headers: Headers) {
  return responseFrom(await response.json<unknown>(), headers, response.status);
}

async function approval(
  request: Request,
  url: URL,
  match: RegExpExecArray,
  namespace: DurableObjectNamespace,
  headers: Headers,
) {
  const [, objectId, id, ticket] = match;
  if (!objectId || !id || !ticket) throw invalid();
  const stub = namespace.get(namespace.idFromString(objectId));
  const browser = cookieValue(request, browserCookie(id));
  const proofHash = browser ? await hashGitTicket(browser) : undefined;
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com/login/oauth/authorize",
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (request.method === "GET") {
    const response = await doRequest(stub, "/preview", {
      id,
      ticket,
      proofHash,
    });
    if (!response.ok) return passResult(response, headers);
    const value = await response.json<
      | { verified: false }
      | { verified: true; intent: Intent; login: string; job?: Job }
    >();
    const csrf = generateCodeVerifier();
    headers.set(
      "Set-Cookie",
      cookieName(id) +
        "=" +
        csrf +
        "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" +
        approvalTtl / 1000,
    );
    return new Response(
      value.verified
        ? approvalPage(url.pathname, csrf, value.intent, value.login, value.job)
        : landingPage(url.pathname, csrf),
      { headers },
    );
  }
  if (request.method !== "POST") throw invalid();
  if (
    request.headers.get("Origin") !== url.origin ||
    request.headers.get("Content-Type") !== "application/x-www-form-urlencoded"
  )
    throw denied();
  const form = new URLSearchParams(await readText(request, 512));
  const csrf = form.get("csrf");
  if (
    !csrf ||
    [...form.keys()].length !== 2 ||
    cookieValue(request, cookieName(id)) !== csrf
  )
    throw denied();
  if (form.get("approve") === "yes") {
    if (!proofHash) throw denied();
    const response = await doRequest(stub, "/approve", {
      id,
      ticket,
      proofHash,
    });
    if (!response.ok) return passResult(response, headers);
    headers.append(
      "Set-Cookie",
      cookieName(id) +
        "=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    headers.append(
      "Set-Cookie",
      browserCookie(id) +
        "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    return new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub publication approved</title>' +
        "<h1>GitHub publication approved</h1><p>Return to TurboWarp Plus Editor.</p></html>",
      { headers },
    );
  }
  if (form.get("verify") !== "yes") throw denied();
  const proof = generateCodeVerifier();
  const response = await doRequest(stub, "/begin-approval", {
    id,
    ticket,
    objectId,
    returnPath: url.pathname,
    proofHash: await hashGitTicket(proof),
  });
  if (!response.ok) return passResult(response, headers);
  const { state, authorizationUrl } = await response.json<{
    state: string;
    authorizationUrl: string;
  }>();
  const destination = new URL(authorizationUrl);
  if (
    !tokenPattern.test(state) ||
    destination.origin !== "https://github.com" ||
    destination.pathname !== "/login/oauth/authorize" ||
    destination.searchParams.get("state") !== state
  )
    throw invalid();
  headers.append(
    "Set-Cookie",
    cookieName(id) + "=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
  );
  headers.append(
    "Set-Cookie",
    "__Host-tw-publish-proof-" +
      state +
      "=" +
      proof +
      "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" +
      approvalTtl / 1000,
  );
  headers.append(
    "Set-Cookie",
    browserCookie(id) +
      "=" +
      proof +
      "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" +
      approvalTtl / 1000,
  );
  headers.set("Location", destination.href);
  return new Response(null, { status: 303, headers });
}

export async function handleGitHubPublication(
  request: Request,
  env: PublicationEnv,
): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });
  try {
    const url = new URL(request.url);
    const settings = getGitAuthSettings(env);
    const enabled = features(env.GIT_PUBLICATION);
    const namespace = env.GIT_PUBLICATION_JOBS;
    if (!settings || !enabled || !namespace || !env.GIT_SESSIONS)
      throw new PublicationError(404, "PUBLICATION_UNAVAILABLE");
    if (url.origin !== new URL(settings.redirectUri).origin || url.search)
      throw denied();
    const approvalPath = publicationApprovalPathPattern.exec(url.pathname);
    if (approvalPath)
      return await approval(request, url, approvalPath, namespace, headers);

    const origin = request.headers.get("Origin");
    const origins = env.GIT_ALLOWED_ORIGINS?.split(",").map((value) =>
      value.trim(),
    );
    if (
      !origin ||
      origin === "*" ||
      origin === "null" ||
      !origins?.includes(origin)
    )
      throw denied();
    headers.set("Access-Control-Allow-Origin", origin);
    const path = url.pathname.slice(publicationPath.length);
    if (!(allowedPaths as readonly string[]).includes(path)) throw invalid();
    if (request.method === "OPTIONS") {
      const asked =
        request.headers
          .get("Access-Control-Request-Headers")
          ?.split(",")
          .map((value) => value.trim().toLowerCase()) ?? [];
      if (
        request.headers.get("Access-Control-Request-Method") !== "POST" ||
        asked.some(
          (name) => name !== "authorization" && name !== "content-type",
        )
      )
        throw denied();
      headers.set(
        "Vary",
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      );
      headers.set("Access-Control-Allow-Methods", "POST");
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, content-type",
      );
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") throw invalid();

    const input = await readPublicationJson(request);
    if (!jsonRecord(input)) throw invalid();
    if (path === "/repository") {
      requireKeys(input, ["remote"]);
      const remote = canonicalRemote(input.remote);
      const authority = await authorizePublication(
        env,
        rendererSession(request, origin, remote),
      );
      return responseFrom(
        { repositoryId: authority.repositoryId, capabilities: enabled },
        headers,
      );
    }
    if (path === "/stack-parent") {
      requireKeys(input, ["remote", "repositoryId", "number"]);
      if (!enabled.includes("stacks")) throw denied();
      if (
        !positiveId(input.repositoryId) ||
        !positiveId(input.number) ||
        input.number > 2_147_483_647
      )
        throw invalid();
      const remote = canonicalRemote(input.remote);
      const session = rendererSession(request, origin, remote);
      const authority = await authorizePublication(env, session);
      if (authority.repositoryId !== input.repositoryId) throw denied();
      const objectId = namespace.idFromName(
        "publication/" + authority.account.id + "/" + authority.repositoryId,
      );
      const identity = {
        remote: remoteOf(authority),
        repositoryId: authority.repositoryId,
        account: authority.account,
        origin,
      };
      return passResult(
        await doRequest(namespace.get(objectId), "/stack-parent", {
          identity,
          session,
          number: input.number,
        }),
        headers,
      );
    }

    let selected;
    if (path === "/jobs") {
      requireKeys(input, ["intent"]);
      selected = validateIntentShape(input.intent);
    } else {
      requireKeys(
        input,
        path === "/jobs/advance"
          ? ["id", "remote", "repositoryId", "retryRejectedMerge"]
          : ["id", "remote", "repositoryId"],
      );
      if (
        input.retryRejectedMerge !== undefined &&
        typeof input.retryRejectedMerge !== "boolean"
      )
        throw invalid();
      selected = target(input);
    }
    const session = rendererSession(request, origin, selected.remote);
    const authority = await authorizePublication(env, session);
    if (authority.repositoryId !== selected.repositoryId) throw denied();
    const objectId = namespace.idFromName(
      "publication/" + authority.account.id + "/" + authority.repositoryId,
    );
    const stub = namespace.get(objectId);
    const identity = {
      id: selected.id,
      remote: remoteOf(authority),
      repositoryId: authority.repositoryId,
      account: authority.account,
      origin,
    };
    if (path === "/jobs") {
      const ticket = generateCodeVerifier();
      const response = await doRequest(stub, "/prepare", {
        identity,
        session,
        intent: input.intent,
        ticket,
      });
      if (!response.ok) return passResult(response, headers);
      const result = await response.json<{ job: Job | null }>();
      return responseFrom(
        {
          job: result.job,
          approvalUrl: result.job
            ? null
            : url.origin +
              publicationPath +
              "/approval/" +
              objectId.toString() +
              "/" +
              selected.id +
              "/" +
              ticket,
        },
        headers,
      );
    }
    if (path === "/jobs/status")
      return passResult(
        await doRequest(stub, "/status", { identity }),
        headers,
      );
    return passResult(
      await doRequest(stub, "/advance", {
        identity,
        session,
        retryRejectedMerge: input.retryRejectedMerge === true,
      }),
      headers,
    );
  } catch (error) {
    const failure =
      error instanceof PublicationError
        ? error
        : new PublicationError(502, "UPSTREAM_FAILURE");
    return responseFrom(
      { code: failure.code, requestId: crypto.randomUUID() },
      headers,
      failure.status,
    );
  }
}
