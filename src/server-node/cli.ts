#!/usr/bin/env node
import { resolve } from "node:path";
import { loadRelayConfig } from "./config.js";
import { startRelay } from "./server.js";

async function main(): Promise<void> {
  const help = process.argv.includes("--help") || process.argv.includes("-h");
  const configArgument = process.argv.indexOf("--config");
  const configPath =
    configArgument >= 0 ? process.argv[configArgument + 1] : undefined;
  if (help || !configPath || configPath.startsWith("-")) {
    process.stdout.write(
      "Usage: capability-proxy --config <config.json>\n\n" +
        "The config file contains provider secrets and must have mode 0600.\n",
    );
    process.exitCode = help ? 0 : 2;
    return;
  }

  const config = await loadRelayConfig(resolve(configPath));
  const running = startRelay(config);
  process.stdout.write(
    [
      `Capability Proxy listening on http://127.0.0.1:${config.server.port}`,
      `Pairing code: ${running.pairingCode}`,
      "The pairing code expires after five minutes and can be used once.",
      `Commands: ${config.server.commandsEnabled ? "enabled" : "disabled"}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown startup error.";
  process.stderr.write(`Capability Proxy failed to start: ${message}\n`);
  process.exitCode = 1;
});
