import { serve, type ServerType } from "@hono/node-server";
import { PairingManager } from "../core/pairing.js";
import { CapabilityRegistry } from "../core/registry.js";
import {
  CANDYHOUSE_COMMAND,
  CANDYHOUSE_HISTORY,
  CANDYHOUSE_STATUS,
  CandyHouseProvider,
} from "../providers/candyhouse/provider.js";
import { createRelayApp } from "./app.js";
import type { RelayConfig } from "./config.js";

export interface RunningRelay {
  pairingCode: string;
  server: ServerType;
}

export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const capabilities = [CANDYHOUSE_STATUS, CANDYHOUSE_HISTORY];
  if (config.server.commandsEnabled) capabilities.push(CANDYHOUSE_COMMAND);

  const pairing = new PairingManager({
    capabilities,
    sessionTtlMilliseconds: config.server.sessionTtlSeconds * 1000,
  });
  const registry = new CapabilityRegistry([
    new CandyHouseProvider({ devices: config.providers.candyhouse.devices }),
  ]);
  const app = createRelayApp({
    pairing,
    registry,
    allowedOrigins: config.server.allowedOrigins,
  });
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: config.server.port,
  });
  await waitUntilListening(server);
  return { pairingCode: pairing.pairingCode, server };
}

async function waitUntilListening(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    server.once("listening", handleListening);
    server.once("error", handleError);
  });
}
