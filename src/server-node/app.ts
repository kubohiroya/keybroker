import { Hono } from "hono";
import { CapabilityError, toPublicError } from "../core/errors.js";
import type { PairingManager } from "../core/pairing.js";
import type { CapabilityRegistry } from "../core/registry.js";
import type { CapabilityPrincipal, RelayServerOptions } from "../core/types.js";
import {
  CANDYHOUSE_COMMAND,
  CANDYHOUSE_HISTORY,
  CANDYHOUSE_STATUS,
} from "../providers/candyhouse/provider.js";

export interface RelayAppOptions extends RelayServerOptions {
  registry: CapabilityRegistry;
  pairing: PairingManager;
}

const DEFAULT_ALLOWED_ORIGINS = ["null", "https://turbowarp.org"];
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const MAX_JSON_BODY_BYTES = 4096;

export function createRelayApp(options: RelayAppOptions): Hono {
  const app = new Hono();
  const allowedOrigins = new Set(
    options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
  );
  const allowedHosts = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);

  app.use("*", async (context, next) => {
    if (
      !isAllowedHost(
        context.req.header("host"),
        context.req.raw.url,
        allowedHosts,
      )
    ) {
      return context.json(
        { error: { code: "invalid_host", message: "Invalid Host header." } },
        403,
      );
    }

    const origin = context.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return context.json(
        { error: { code: "origin_denied", message: "Origin is not allowed." } },
        403,
      );
    }

    if (origin !== undefined) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
    }
    if (context.req.method === "OPTIONS") {
      context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      context.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      context.header("Access-Control-Max-Age", "600");
      return context.body(null, 204);
    }
    await next();
  });

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "capability-proxy" }),
  );

  app.post("/v1/pair", async (context) => {
    const body = await readJsonObject(context.req.raw);
    if (typeof body.code !== "string") {
      throw new CapabilityError(400, "invalid_input", "code must be a string.");
    }
    return context.json(options.pairing.pair(body.code));
  });

  app.get("/v1/candyhouse/devices/:alias/status", async (context) => {
    const principal = authenticate(
      context.req.header("authorization"),
      options.pairing,
    );
    const data = await options.registry.execute(
      "candyhouse",
      {
        capability: CANDYHOUSE_STATUS,
        resource: context.req.param("alias"),
      },
      principal,
    );
    return context.json({ data });
  });

  app.get("/v1/candyhouse/devices/:alias/history", async (context) => {
    const principal = authenticate(
      context.req.header("authorization"),
      options.pairing,
    );
    const data = await options.registry.execute(
      "candyhouse",
      {
        capability: CANDYHOUSE_HISTORY,
        resource: context.req.param("alias"),
        input: {
          page: context.req.query("page"),
          length: context.req.query("length"),
        },
      },
      principal,
    );
    return context.json({ data });
  });

  app.post(
    "/v1/candyhouse/devices/:alias/commands/:command",
    async (context) => {
      const principal = authenticate(
        context.req.header("authorization"),
        options.pairing,
      );
      const body = await readOptionalJsonObject(context.req.raw);
      const data = await options.registry.execute(
        "candyhouse",
        {
          capability: CANDYHOUSE_COMMAND,
          resource: context.req.param("alias"),
          input: {
            command: context.req.param("command"),
            history: body.history,
          },
        },
        principal,
      );
      return context.json({ data });
    },
  );

  app.notFound((context) =>
    context.json(
      { error: { code: "not_found", message: "Route not found." } },
      404,
    ),
  );

  app.onError((error, context) => {
    const publicError = toPublicError(error);
    const headers = new Headers({ "content-type": "application/json" });
    const origin = context.req.header("origin");
    if (origin !== undefined && allowedOrigins.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
    }
    return new Response(JSON.stringify(publicError.body), {
      status: publicError.status,
      headers,
    });
  });

  return app;
}

function authenticate(
  authorization: string | undefined,
  pairing: PairingManager,
): CapabilityPrincipal {
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/u.exec(authorization ?? "");
  if (!match?.[1]) {
    throw new CapabilityError(
      401,
      "missing_token",
      "A relay Bearer token is required.",
    );
  }
  return pairing.authenticate(match[1]);
}

function isAllowedHost(
  host: string | undefined,
  requestUrl: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  try {
    const hostname = host
      ? new URL(`http://${host}`).hostname
      : new URL(requestUrl).hostname;
    return allowedHosts.has(hostname);
  } catch {
    return false;
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await readLimitedText(request);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CapabilityError(
      400,
      "invalid_json",
      "Expected a JSON request body.",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CapabilityError(400, "invalid_input", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await readLimitedText(request);
  if (text.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CapabilityError(
      400,
      "invalid_json",
      "Expected a JSON request body.",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CapabilityError(400, "invalid_input", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function readLimitedText(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new CapabilityError(
      413,
      "request_too_large",
      "Request body is too large.",
    );
  }

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new CapabilityError(
        413,
        "request_too_large",
        "Request body is too large.",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
