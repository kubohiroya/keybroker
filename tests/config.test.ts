import { describe, expect, it } from "vitest";
import { parseRelayConfig } from "../src/server-node/config.js";

const device = {
  apiKey: "test-api-key",
  uuid: "00000000-0000-0000-0000-000000000000",
  secretKey: "00000000000000000000000000000000",
};

describe("parseRelayConfig", () => {
  it("keeps command execution disabled by default", () => {
    const config = parseRelayConfig({
      providers: { candyhouse: { devices: { front: device } } },
    });
    expect(config.server.commandsEnabled).toBe(false);
    expect(config.server.port).toBe(8787);
  });

  it("requires at least one configured device", () => {
    expect(() =>
      parseRelayConfig({ providers: { candyhouse: { devices: {} } } }),
    ).toThrow(/at least one/iu);
  });

  it("rejects wildcard browser origins", () => {
    expect(() =>
      parseRelayConfig({
        server: { allowedOrigins: ["*"] },
        providers: { candyhouse: { devices: { front: device } } },
      }),
    ).toThrow(/wildcard/iu);
  });

  it("requires at least one provider", () => {
    expect(() => parseRelayConfig({ providers: {} })).toThrow(
      /at least one provider/iu,
    );
  });
});

describe("parseRelayConfig providers.openai", () => {
  const environment = { OPENAI_API_KEY: "sk-from-environment" };

  it("accepts openai alone and applies defaults", () => {
    const config = parseRelayConfig(
      { providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } },
      environment,
    );
    expect(config.providers.candyhouse).toBeUndefined();
    expect(config.providers.openai).toEqual({
      apiKey: "sk-from-environment",
      model: "gpt-realtime-2.1",
      allowedModels: ["gpt-realtime-2.1"],
      clientSecretTtlSeconds: 60,
    });
  });

  it("accepts candyhouse and openai together", () => {
    const config = parseRelayConfig(
      {
        providers: {
          candyhouse: { devices: { front: device } },
          openai: {
            apiKey: "sk-inline",
            model: "gpt-realtime-custom",
            allowedVoices: ["marin", "cedar"],
            clientSecretTtlSeconds: 600,
          },
        },
      },
      {},
    );
    expect(config.providers.candyhouse?.devices.front).toEqual(device);
    expect(config.providers.openai).toEqual({
      apiKey: "sk-inline",
      model: "gpt-realtime-custom",
      allowedModels: ["gpt-realtime-custom"],
      allowedVoices: ["marin", "cedar"],
      clientSecretTtlSeconds: 600,
    });
  });

  it("requires exactly one of apiKeyEnv or apiKey", () => {
    expect(() =>
      parseRelayConfig({ providers: { openai: {} } }, environment),
    ).toThrow(/exactly one/iu);
    expect(() =>
      parseRelayConfig(
        {
          providers: {
            openai: { apiKeyEnv: "OPENAI_API_KEY", apiKey: "sk-inline" },
          },
        },
        environment,
      ),
    ).toThrow(/exactly one/iu);
  });

  it("rejects a missing environment variable without echoing secrets", () => {
    expect(() =>
      parseRelayConfig(
        { providers: { openai: { apiKeyEnv: "MISSING_OPENAI_KEY" } } },
        environment,
      ),
    ).toThrow(/MISSING_OPENAI_KEY.*not set/iu);
    expect(() =>
      parseRelayConfig(
        { providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } },
        { OPENAI_API_KEY: "   " },
      ),
    ).toThrow(/not set/iu);
    expect(() =>
      parseRelayConfig(
        { providers: { openai: { apiKeyEnv: "not a name" } } },
        environment,
      ),
    ).toThrow(/environment variable name/iu);
  });

  it("rejects empty or non-string keys", () => {
    expect(() =>
      parseRelayConfig({ providers: { openai: { apiKey: "" } } }, {}),
    ).toThrow(/apiKey/u);
    expect(() =>
      parseRelayConfig({ providers: { openai: { apiKey: 1 } } }, {}),
    ).toThrow(/apiKey/u);
  });

  it.each([9, 601, 60.5, "60"])(
    "rejects clientSecretTtlSeconds %s",
    (clientSecretTtlSeconds) => {
      expect(() =>
        parseRelayConfig(
          { providers: { openai: { apiKey: "sk", clientSecretTtlSeconds } } },
          {},
        ),
      ).toThrow(/10 through 600/u);
    },
  );

  it("accepts clientSecretTtlSeconds boundaries", () => {
    for (const clientSecretTtlSeconds of [10, 600]) {
      const config = parseRelayConfig(
        { providers: { openai: { apiKey: "sk", clientSecretTtlSeconds } } },
        {},
      );
      expect(config.providers.openai?.clientSecretTtlSeconds).toBe(
        clientSecretTtlSeconds,
      );
    }
  });

  it("validates model, allowedVoices, and unknown fields", () => {
    const parse = (openai: Record<string, unknown>) => () =>
      parseRelayConfig({ providers: { openai } }, {});
    expect(parse({ apiKey: "sk", model: "" })).toThrow(/model/u);
    expect(parse({ apiKey: "sk", model: "bad model" })).toThrow(/model/u);
    expect(parse({ apiKey: "sk", allowedVoices: "marin" })).toThrow(
      /allowedVoices/u,
    );
    expect(parse({ apiKey: "sk", allowedVoices: ["Marin"] })).toThrow(
      /allowedVoices/u,
    );
    expect(parse({ apiKey: "sk", apikey: "typo" })).toThrow(/unsupported/u);
  });

  it("accepts allowedModels that include the default model", () => {
    const config = parseRelayConfig(
      {
        providers: {
          openai: {
            apiKey: "sk",
            model: "gpt-realtime-2.1-mini",
            allowedModels: ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"],
          },
        },
      },
      {},
    );
    expect(config.providers.openai?.model).toBe("gpt-realtime-2.1-mini");
    expect(config.providers.openai?.allowedModels).toEqual([
      "gpt-realtime-2.1-mini",
      "gpt-realtime-2.1",
    ]);
  });

  it("defaults allowedModels to the default model when omitted", () => {
    const config = parseRelayConfig(
      {
        providers: { openai: { apiKey: "sk", model: "gpt-realtime-2.1-mini" } },
      },
      {},
    );
    expect(config.providers.openai?.allowedModels).toEqual([
      "gpt-realtime-2.1-mini",
    ]);
  });

  it("validates allowedModels", () => {
    const parse = (openai: Record<string, unknown>) => () =>
      parseRelayConfig({ providers: { openai } }, {});
    expect(
      parse({
        apiKey: "sk",
        model: "gpt-realtime-2.1",
        allowedModels: ["gpt-realtime-2.1-mini"],
      }),
    ).toThrow(/model \(gpt-realtime-2\.1\) must be listed in .*allowedModels/u);
    expect(
      parse({ apiKey: "sk", allowedModels: ["gpt-realtime-2.1-mini"] }),
    ).toThrow(/must be listed/u);
    expect(
      parse({
        apiKey: "sk",
        allowedModels: ["gpt-realtime-2.1", "gpt-realtime-2.1"],
      }),
    ).toThrow(/duplicates/u);
    expect(parse({ apiKey: "sk", allowedModels: [] })).toThrow(
      /allowedModels/u,
    );
    expect(parse({ apiKey: "sk", allowedModels: "gpt-realtime-2.1" })).toThrow(
      /allowedModels/u,
    );
    expect(
      parse({ apiKey: "sk", allowedModels: ["gpt-realtime-2.1", "bad model"] }),
    ).toThrow(/allowedModels/u);
    expect(
      parse({ apiKey: "sk", allowedModels: ["gpt-realtime-2.1", 1] }),
    ).toThrow(/allowedModels/u);
    expect(
      parse({
        apiKey: "sk",
        allowedModels: ["gpt-realtime-2.1", "a".repeat(129)],
      }),
    ).toThrow(/allowedModels/u);
  });

  it("never includes the API key in validation errors", () => {
    const secret = "sk-super-secret-value";
    const attempts = [
      { apiKey: secret, clientSecretTtlSeconds: 1 },
      { apiKey: secret, model: "bad model" },
      { apiKey: secret, apiKeyEnv: "OPENAI_API_KEY" },
    ];
    for (const openai of attempts) {
      try {
        parseRelayConfig({ providers: { openai } }, { OPENAI_API_KEY: secret });
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});
