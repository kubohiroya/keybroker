import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../src/server-node/config.js";
import { startRelay } from "../src/server-node/server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("relay server startup", () => {
  it("rejects instead of reporting success when the port is occupied", async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address.");
    }

    await expect(startRelay(configForPort(address.port))).rejects.toMatchObject(
      {
        code: "EADDRINUSE",
      },
    );
  });
});

function configForPort(port: number): RelayConfig {
  return {
    server: {
      port,
      commandsEnabled: false,
      allowedOrigins: ["null", "https://turbowarp.org"],
      sessionTtlSeconds: 60,
    },
    providers: {
      candyhouse: {
        devices: {
          "front-door": {
            apiKey: "test-api-key",
            uuid: "00000000-0000-0000-0000-000000000000",
            secretKey: "00000000000000000000000000000000",
          },
        },
      },
    },
  };
}
