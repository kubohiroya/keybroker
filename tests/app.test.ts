import { describe, expect, it, vi } from "vitest";
import { PairingManager } from "../src/core/pairing.js";
import { CapabilityRegistry } from "../src/core/registry.js";
import type { CapabilityProvider } from "../src/core/types.js";
import {
  CANDYHOUSE_COMMAND,
  CANDYHOUSE_STATUS,
} from "../src/providers/candyhouse/provider.js";
import { createRelayApp } from "../src/server-node/app.js";

function fixture(capabilities: readonly string[] = [CANDYHOUSE_STATUS]) {
  const execute = vi.fn(async () => ({ locked: true }));
  const provider: CapabilityProvider = {
    id: "candyhouse",
    capabilities: new Set([CANDYHOUSE_STATUS, CANDYHOUSE_COMMAND]),
    execute,
  };
  const pairing = new PairingManager({
    capabilities,
    randomCode: () => "12345678",
    randomToken: () => "a-valid-session-token-that-is-long-enough",
  });
  return {
    app: createRelayApp({
      pairing,
      registry: new CapabilityRegistry([provider]),
    }),
    execute,
  };
}

async function pair(app: ReturnType<typeof createRelayApp>): Promise<string> {
  const response = await app.request("http://127.0.0.1/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null" },
    body: JSON.stringify({ code: "12345678" }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

describe("relay app", () => {
  it("exposes health without authentication and rejects DNS rebinding hosts", async () => {
    const { app } = fixture();
    const health = await app.request("http://127.0.0.1/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      service: "capability-proxy",
    });

    const denied = await app.request("http://attacker.example/health");
    expect(denied.status).toBe(403);
  });

  it("pairs once and requires the resulting bearer token", async () => {
    const { app, execute } = fixture();
    const missing = await app.request(
      "http://127.0.0.1/v1/candyhouse/devices/front-door/status",
    );
    expect(missing.status).toBe(401);

    const token = await pair(app);
    const response = await app.request(
      "http://127.0.0.1/v1/candyhouse/devices/front-door/status",
      { headers: { authorization: `Bearer ${token}`, origin: "null" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { locked: true } });
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects an oversized unauthenticated pairing body", async () => {
    const { app } = fixture();
    const response = await app.request("http://127.0.0.1/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ code: "1".repeat(4096) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "request_too_large",
        message: "Request body is too large.",
      },
    });
  });

  it("denies command capability when commands are disabled", async () => {
    const { app, execute } = fixture();
    const token = await pair(app);
    const response = await app.request(
      "http://127.0.0.1/v1/candyhouse/devices/front-door/commands/unlock",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "null" },
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unapproved browser origins", async () => {
    const { app } = fixture();
    const response = await app.request("http://127.0.0.1/health", {
      headers: { origin: "https://attacker.example" },
    });
    expect(response.status).toBe(403);
  });

  it("answers the Relay authorization preflight for the TurboWarp sandbox", async () => {
    const { app } = fixture();
    const response = await app.request(
      "http://127.0.0.1/v1/candyhouse/devices/front-door/status",
      {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });
});
