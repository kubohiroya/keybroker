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

export function startRelay(config: RelayConfig): RunningRelay {
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
  return { pairingCode: pairing.pairingCode, server };
}
