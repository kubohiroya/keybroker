import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const cliPath = fileURLToPath(
    new URL("../dist/server-node/cli.js", import.meta.url),
  );
  await chmod(cliPath, 0o755);
}
