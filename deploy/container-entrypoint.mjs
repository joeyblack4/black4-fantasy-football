import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const mode = process.argv[2] ?? "api";
const modes = {
  api: ["src/server.ts"],
  clock: ["scripts/league-clock.ts"],
  worker: ["scripts/live-worker.ts", "--live"],
  synthetic: ["scripts/worker.ts", "--synthetic"],
};
if (!Object.hasOwn(modes, mode)) throw new Error("Unknown container mode");
const env = { ...process.env };
if (!env.DATABASE_URL_FILE)
  throw new Error("DATABASE_URL_FILE must name a mounted secret");
env.DATABASE_URL = (await readFile(env.DATABASE_URL_FILE, "utf8")).trim();
if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL))
  throw new Error("Invalid database secret");
if (mode === "worker") {
  const keyName = env.FOOTBALL_KEY_NAME;
  if (
    !keyName ||
    !/^B4_LEAGUE_[A-Z0-9_]+$/.test(keyName) ||
    !env.FOOTBALL_KEY_FILE
  )
    throw new Error("A dedicated B4_LEAGUE_ key secret mount is required");
  env[keyName] = (await readFile(env.FOOTBALL_KEY_FILE, "utf8")).trim();
  if (!env[keyName]) throw new Error("Dedicated inference secret is empty");
}
const child = spawn(process.execPath, ["--import", "tsx", ...modes[mode]], {
  stdio: "inherit",
  env,
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopping = true;
    child.kill(signal);
  });
child.once("error", () => {
  console.error("Container child failed to start");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (stopping ? 0 : 1);
  if (signal && !stopping) console.error("Container child exited by signal");
});
