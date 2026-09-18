import { describe, expect, it, vi } from "vitest";
import { CapabilityError } from "../src/core/errors.js";
import type { CapabilityPrincipal } from "../src/core/types.js";
import {
  OPENAI_REALTIME_CLIENT_SECRET,
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "../src/providers/openai/provider.js";

const API_KEY = "sk-test-secret-api-key-never-leak";
const principal: CapabilityPrincipal = {
  id: "test",
  capabilities: new Set([OPENAI_REALTIME_CLIENT_SECRET]),
};

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      value: "ek_abc123",
      expires_at: 1_756_310_470,
      session: { type: "realtime" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function setup(
  options: Partial<OpenAIProviderOptions> = {},
  respond: () => Promise<Response> = async () => okResponse(),
) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return respond();
    },
  );
  const provider = new OpenAIProvider({ apiKey: API_KEY, fetcher, ...options });
  const execute = (input: unknown) =>
    provider.execute({
      capability: OPENAI_REALTIME_CLIENT_SECRET,
      resource: "realtime",
      input,
      principal,
    });
  return { fetcher, execute };
}

function sentBody(fetcher: ReturnType<typeof setup>["fetcher"]): unknown {
  const [, init] = fetcher.mock.calls[0] ?? [];
  return JSON.parse(String(init?.body));
}

async function expectError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<CapabilityError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CapabilityError);
  expect(error).toMatchObject({ status, code });
  expect((error as Error).message).not.toContain(API_KEY);
  return error as CapabilityError;
}

describe("OpenAIProvider request shape", () => {
  it("sends the expected upstream request with defaults", async () => {
    const { fetcher, execute } = setup();
    await execute({});

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(sentBody(fetcher)).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "realtime", model: "gpt-realtime-2.1" },
    });
  });

  it("maps every session option and adds tool_choice only with tools", async () => {
    const { fetcher, execute } = setup({
      model: "gpt-realtime-custom",
      clientSecretTtlSeconds: 120,
    });
    const tool = {
      type: "function",
      name: "move_sprite",
      description: "Move the sprite.",
      parameters: {
        type: "object",
        properties: { steps: { type: "number" } },
        required: ["steps"],
      },
    };
    await execute({
      session: {
        instructions: "Be brief.",
        voice: "marin",
        outputModalities: ["audio"],
        tools: [tool],
      },
    });
    expect(sentBody(fetcher)).toEqual({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model: "gpt-realtime-custom",
        instructions: "Be brief.",
        output_modalities: ["audio"],
        audio: { output: { voice: "marin" } },
        tools: [tool],
        tool_choice: "auto",
      },
    });
  });

  it("omits tool_choice when tools are absent or empty", async () => {
    const first = setup();
    await first.execute({ session: { outputModalities: ["text"] } });
    expect(sentBody(first.fetcher)).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["text"],
      },
    });

    const second = setup();
    await second.execute({ session: { tools: [] } });
    const body = sentBody(second.fetcher) as {
      session: Record<string, unknown>;
    };
    expect(body.session).not.toHaveProperty("tools");
    expect(body.session).not.toHaveProperty("tool_choice");
  });

  it("maps the upstream response to epoch milliseconds", async () => {
    const { execute } = setup({ model: "gpt-realtime-custom" });
    await expect(execute({})).resolves.toEqual({
      value: "ek_abc123",
      expiresAt: 1_756_310_470_000,
      model: "gpt-realtime-custom",
    });
  });
});

describe("OpenAIProvider validation", () => {
  const invalidInputs: [string, unknown][] = [
    ["non-object body", []],
    ["unknown root key", { session: {}, model: "gpt-4o" }],
    ["non-object session", { session: "x" }],
    ["unknown session key", { session: { model: "other" } }],
    ["non-string instructions", { session: { instructions: 1 } }],
    [
      "too long instructions",
      { session: { instructions: "a".repeat(16_385) } },
    ],
    ["non-string voice", { session: { voice: 1 } }],
    ["uppercase voice", { session: { voice: "Alloy" } }],
    ["too long voice", { session: { voice: "a".repeat(33) } }],
    ["empty voice", { session: { voice: "" } }],
    ["string modalities", { session: { outputModalities: "audio" } }],
    ["both modalities", { session: { outputModalities: ["audio", "text"] } }],
    ["empty modalities", { session: { outputModalities: [] } }],
    ["unknown modality", { session: { outputModalities: ["video"] } }],
    ["non-array tools", { session: { tools: {} } }],
    [
      "too many tools",
      {
        session: {
          tools: Array.from({ length: 33 }, (_, index) => ({
            type: "function",
            name: `tool_${index}`,
          })),
        },
      },
    ],
    ["non-object tool", { session: { tools: ["x"] } }],
    ["wrong tool type", { session: { tools: [{ type: "mcp", name: "a" }] } }],
    [
      "unknown tool key",
      { session: { tools: [{ type: "function", name: "a", strict: true }] } },
    ],
    [
      "invalid tool name",
      { session: { tools: [{ type: "function", name: "a b" }] } },
    ],
    [
      "too long tool name",
      { session: { tools: [{ type: "function", name: "a".repeat(65) }] } },
    ],
    [
      "duplicate tool names",
      {
        session: {
          tools: [
            { type: "function", name: "a" },
            { type: "function", name: "a" },
          ],
        },
      },
    ],
    [
      "too long tool description",
      {
        session: {
          tools: [
            { type: "function", name: "a", description: "d".repeat(1025) },
          ],
        },
      },
    ],
    [
      "array tool parameters",
      { session: { tools: [{ type: "function", name: "a", parameters: [] }] } },
    ],
    [
      "non-object schema type",
      {
        session: {
          tools: [
            { type: "function", name: "a", parameters: { type: "string" } },
          ],
        },
      },
    ],
  ];

  it.each(invalidInputs)("rejects %s", async (_name, input) => {
    const { fetcher, execute } = setup();
    await expectError(execute(input), 400, "invalid_input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces allowedVoices when configured", async () => {
    const { fetcher, execute } = setup({ allowedVoices: ["marin"] });
    await expectError(
      execute({ session: { voice: "alloy" } }),
      400,
      "invalid_input",
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(execute({ session: { voice: "marin" } })).resolves.toEqual(
      expect.objectContaining({ value: "ek_abc123" }),
    );
  });

  it("accepts limits at their boundaries", async () => {
    const { fetcher, execute } = setup();
    await execute({
      session: {
        instructions: "a".repeat(16_384),
        voice: "a".repeat(32),
        tools: Array.from({ length: 32 }, (_, index) => ({
          type: "function",
          name: `${"n".repeat(60)}${String(index).padStart(4, "0")}`,
          description: "d".repeat(1024),
        })),
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("OpenAIProvider upstream errors", () => {
  const failures: [string, () => Promise<Response>][] = [
    [
      "a non-2xx response",
      async () =>
        new Response(
          JSON.stringify({ error: { message: `Incorrect key ${API_KEY}` } }),
          { status: 401 },
        ),
    ],
    ["a server error", async () => new Response("oops", { status: 500 })],
    ["non-JSON success", async () => new Response("<html>", { status: 200 })],
    [
      "a missing value",
      async () => new Response('{"expires_at":1}', { status: 200 }),
    ],
    [
      "a value without the ek_ prefix",
      async () =>
        new Response(`{"value":"${API_KEY}","expires_at":1}`, { status: 200 }),
    ],
    [
      "a non-integer expires_at",
      async () =>
        new Response('{"value":"ek_1","expires_at":"soon"}', { status: 200 }),
    ],
    [
      "a network error",
      async () => {
        throw new TypeError(`fetch failed for ${API_KEY}`);
      },
    ],
    [
      "a timeout",
      async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ];

  it.each(failures)("maps %s to 502 upstream_error", async (_name, respond) => {
    const { execute } = setup({}, respond);
    const error = await expectError(execute({}), 502, "upstream_error");
    expect(error.message).toBe("The OpenAI client secret request failed.");
  });

  it("aborts a hanging upstream request after the timeout", async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetcher,
      timeoutMilliseconds: 20,
    });
    await expectError(
      provider.execute({
        capability: OPENAI_REALTIME_CLIENT_SECRET,
        resource: "realtime",
        input: {},
        principal,
      }),
      502,
      "upstream_error",
    );
  });
});
