import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const config = process.argv[2];
if (!config) throw Error("A fixed franchise configuration path is required.");
const databaseFile =
  process.env.FOOTBALL_DATABASE_URL_FILE ??
  resolve(root, ".local/deploy/database-url.host");
const env = {
  ...process.env,
  B4_LEAGUE_DATABASE_URL: (await readFile(databaseFile, "utf8")).trim(),
};
const child = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/tsx/dist/cli.mjs"),
    resolve(root, "scripts/buzz-acp-bridge.ts"),
    "--config",
    resolve(config),
  ],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("League bridge could not start.");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
