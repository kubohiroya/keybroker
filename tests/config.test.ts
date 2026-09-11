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
});
