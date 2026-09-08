import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export function argumentsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !/^--[a-z][a-z0-9-]*$/.test(argv[i]) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error("Arguments must be --name value pairs");
    if (args[argv[i].slice(2)] !== undefined)
      throw new Error("Duplicate argument");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}
export function composeCommand(project, command) {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(project ?? ""))
    throw new Error("An explicit valid --project is required");
  return [
    "compose",
    "-p",
    project,
    "-f",
    path.join(root, "compose.live.yml"),
    "exec",
    "-T",
    "postgres",
    ...command,
  ];
}
export function child(command, args, options = {}) {
  const process = spawn(command, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  // Never relay database/client stderr: a malformed connection can contain secrets.
  let stderrBytes = 0;
  process.stderr?.on("data", (bytes) => {
    stderrBytes += bytes.length;
  });
  const completed = new Promise((resolve, reject) => {
    process.once("error", () =>
      reject(new Error(`${command} could not start`)),
    );
    process.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} failed (${code ?? signal}; ${stderrBytes} diagnostic bytes suppressed)`,
            ),
          ),
    );
  });
  completed.catch(() => {});
  return { process, completed };
}
export async function capture(command, args) {
  const c = child(command, args);
  const chunks = [];
  c.process.stdout.on("data", (value) => chunks.push(value));
  c.process.stdin.end();
  await c.completed;
  return Buffer.concat(chunks).toString("utf8").trim();
}
export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
