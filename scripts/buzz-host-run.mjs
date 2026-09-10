import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.argv[2];
const commands = {
  listener: "buzz-managed-listener.ts",
  outbound: "buzz-outbound.ts",
};
if (!Object.hasOwn(commands, command))
  throw Error("Select listener or outbound");
const path = resolve(root, ".local/deploy/database-url.host"),
  info = await lstat(path);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
  throw Error("Private database URL file required");
const env = {
  ...process.env,
  DATABASE_URL: (await readFile(path, "utf8")).trim(),
  B4_LEAGUE_BUZZ_EXECUTABLE: "/Users/joey/.local/bin/buzz",
};
const child = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/tsx/dist/cli.mjs"),
    resolve(root, "scripts", commands[command]),
    ...process.argv.slice(3),
  ],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("Scoped Buzz process could not start");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
