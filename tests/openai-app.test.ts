import { describe, expect, it, vi } from "vitest";
import { PairingManager } from "../src/core/pairing.js";
import { CapabilityRegistry } from "../src/core/registry.js";
import type { CapabilityProvider } from "../src/core/types.js";
import {
  CANDYHOUSE_STATUS,
  CandyHouseProvider,
} from "../src/providers/candyhouse/provider.js";
import {
  OPENAI_REALTIME_CLIENT_SECRET,
  OpenAIProvider,
} from "../src/providers/openai/provider.js";
import { createRelayApp } from "../src/server-node/app.js";

const API_KEY = "sk-test-secret-api-key-never-leak";
const ROUTE = "http://127.0.0.1/v1/openai/realtime/client-secrets";

function fixture(
  options: {
    withOpenAI?: boolean;
    capabilities?: readonly string[];
    respond?: () => Promise<Response>;
  } = {},
) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return (
        options.respond?.() ??
        new Response('{"value":"ek_test","expires_at":1756310470}', {
          status: 200,
        })
      );
    },
  );
  const providers: CapabilityProvider[] = [
    new CandyHouseProvider({
      devices: {
        "front-door": {
          apiKey: "test-api-key",
          uuid: "00000000-0000-0000-0000-000000000000",
          secretKey: "00000000000000000000000000000000",
        },
      },
    }),
  ];
  if (options.withOpenAI ?? true) {
    providers.push(new OpenAIProvider({ apiKey: API_KEY, fetcher }));
  }
  const pairing = new PairingManager({
    capabilities: options.capabilities ?? [
      CANDYHOUSE_STATUS,
      OPENAI_REALTIME_CLIENT_SECRET,
    ],
    randomCode: () => "12345678",
    randomToken: () => "a-valid-session-token-that-is-long-enough",
  });
  return {
    app: createRelayApp({
      pairing,
      registry: new CapabilityRegistry(providers),
    }),
    fetcher,
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

async function post(
  app: ReturnType<typeof createRelayApp>,
  body: string,
  token?: string,
  origin = "https://turbowarp.org",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin,
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.request(ROUTE, { method: "POST", headers, body });
}

describe("POST /v1/openai/realtime/client-secrets", () => {
  it("returns an ephemeral client secret to a paired client", async () => {
    const { app, fetcher } = fixture();
    const token = await pair(app);
    const response = await post(
      app,
      JSON.stringify({ session: { voice: "marin" } }),
      token,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://turbowarp.org",
    );
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      data: {
        value: "ek_test",
        expiresAt: 1_756_310_470_000,
        model: "gpt-realtime-2.1",
      },
    });
    expect(text).not.toContain(API_KEY);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires a relay bearer token", async () => {
    const { app, fetcher } = fixture();
    const missing = await post(app, "{}");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "missing_token" },
    });

    const invalid = await post(app, "{}", "not-the-token-but-long-enough-xx");
    expect(invalid.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("denies clients without the capability", async () => {
    const { app, fetcher } = fixture({ capabilities: [CANDYHOUSE_STATUS] });
    const token = await pair(app);
    const response = await post(app, "{}", token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "capability_denied" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("responds 404 provider_not_found when openai is not configured", async () => {
    const { app } = fixture({ withOpenAI: false });
    const token = await pair(app);
    const response = await post(app, "{}", token);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "provider_not_found", message: "Unknown provider." },
    });
  });

  it("rejects invalid JSON and invalid input with 400", async () => {
    const { app, fetcher } = fixture();
    const token = await pair(app);
    const malformed = await post(app, "{", token);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "invalid_json" },
    });

    const unknown = await post(
      app,
      JSON.stringify({ session: { model: "gpt-4o" } }),
      token,
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: "invalid_input" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows bodies up to 65536 bytes on this route only", async () => {
    const { app, fetcher } = fixture();
    const token = await pair(app);
    const tools = Array.from({ length: 20 }, (_, index) => ({
      type: "function",
      name: `tool_${index}`,
      description: "d".repeat(1000),
      parameters: { type: "object", properties: {} },
    }));
    const large = JSON.stringify({
      session: { instructions: "i".repeat(16_000), tools },
    });
    expect(large.length).toBeGreaterThan(4096);
    expect(large.length).toBeLessThanOrEqual(65_536);
    const accepted = await post(app, large, token);
    expect(accepted.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();

    const tooLarge = await post(
      app,
      JSON.stringify({ session: { instructions: "i".repeat(65_536) } }),
      token,
    );
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({
      error: {
        code: "request_too_large",
        message: "Request body is too large.",
      },
    });

    const pairTooLarge = await app.request("http://127.0.0.1/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "1".repeat(8192) }),
    });
    expect(pairTooLarge.status).toBe(413);
  });

  it("maps upstream failures to 502 without leaking the API key", async () => {
    const { app } = fixture({
      respond: async () =>
        new Response(
          JSON.stringify({ error: { message: `Bad key ${API_KEY}` } }),
          { status: 401 },
        ),
    });
    const token = await pair(app);
    const response = await post(app, "{}", token);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "upstream_error",
        message: "The OpenAI client secret request failed.",
      },
    });
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("Bad key");
  });

  it("still enforces Origin and Host checks", async () => {
    const { app, fetcher } = fixture();
    const token = await pair(app);
    const origin = await post(app, "{}", token, "https://attacker.example");
    expect(origin.status).toBe(403);

    const host = await app.request(
      "http://attacker.example/v1/openai/realtime/client-secrets",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      },
    );
    expect(host.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
