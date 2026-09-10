#!/usr/bin/env node
/** Launch the existing league CLI/MCP with this franchise's own saved credential. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [id, mode = "help", ...args] = process.argv.slice(2);
const registry = JSON.parse(
  readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
);
if (!Object.hasOwn(registry.franchises, id ?? "")) {
  console.error(
    "Usage: native-league.mjs FRANCHISE_ID [me|state|agent|mcp|observations|help|...]",
  );
  process.exit(2);
}
const credentials = join(root, ".local/native-league", id + ".json");
if (!existsSync(credentials)) {
  console.error(
    `${id}: league API credential has not been provisioned. Ask the league operator to connect your owner account.`,
  );
  process.exit(3);
}
const config = JSON.parse(readFileSync(credentials, "utf8"));
const env = {
  ...process.env,
  FOOTBALL_API_TOKEN: config.token,
  FOOTBALL_API_URL: config.baseUrl,
  FOOTBALL_LEAGUE_ID: config.leagueId,
  FOOTBALL_AGENT_ID: id,
  FOOTBALL_TEAM_ID: config.teamId,
};
const entry =
  mode === "mcp"
    ? "src/mcp.ts"
    : mode === "observations"
      ? "scripts/harness-mcp.ts"
      : "src/cli.ts";
const cliArgs =
  mode === "mcp" || mode === "observations"
    ? []
    : [
        mode,
        ...(mode === "state" && !args.length
          ? [config.leagueId]
          : mode === "agent" && !args.length
            ? [id]
            : args),
      ];
const child = spawn(
  join(root, "node_modules/.bin/tsx"),
  [join(root, entry), ...cliArgs],
  { env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
