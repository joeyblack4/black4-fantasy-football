#!/usr/bin/env node
/** Install only shared access links; never start/restart a native harness. */
import { lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function preparePlatformControlWorkspace(workspace, install = true) {
  const links = {
    "platform-control": join(root, "scripts/platform-control.mjs"),
    "PLATFORM_CONTROL.md": join(root, "docs/PLATFORM_CONTROL.md"),
  };
  const entries = Object.entries(links).map(([name, target]) => {
    const path = join(workspace, name);
    let current;
    try {
      current = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const ready =
      current?.isSymbolicLink() &&
      resolve(workspace, readlinkSync(path)) === target;
    if (current && !ready)
      throw Error(`Platform Control link collision: ${name}`);
    return { name, path, target, ready: Boolean(ready) };
  });
  if (install)
    for (const entry of entries) {
      if (!entry.ready)
        symlinkSync(relative(workspace, entry.target), entry.path);
      entry.ready = true;
    }
  return entries.every((entry) => entry.ready);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv.includes("--install") && !process.argv.includes("--check"))
    throw Error("Pass --install or --check");
  const registry = JSON.parse(
    readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
  );
  const results = Object.entries(registry.franchises).map(([id, spec]) => ({
    id,
    harness: spec.harness,
    ready: preparePlatformControlWorkspace(
      join(root, "franchises", id.replace(/^b4-/, ""), "workspace"),
      process.argv.includes("--install"),
    ),
  }));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((row) => !row.ready)) process.exitCode = 1;
}
