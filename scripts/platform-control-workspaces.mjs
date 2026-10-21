#!/usr/bin/env node
/**
 * Owner workspaces link the Black 4 guide (PLATFORM_CONTROL.md). The courier
 * link (`platform-control`) is retired: owners reach Black 4 only through the
 * Black 4 MCP in their own harness (scripts/black4-mcp.mjs). Never starts or
 * restarts a native harness.
 */
import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guide = join(root, "docs/PLATFORM_CONTROL.md");
const retiredCourier = join(root, "scripts/platform-control.mjs");

function linkTarget(path, workspace) {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? resolve(workspace, readlinkSync(path)) : "not-a-link";
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Remove the courier link (only the exact retired one) and keep the guide link. */
export function retirePlatformControlLink(workspace, install = true) {
  const courier = join(workspace, "platform-control");
  const courierTarget = linkTarget(courier, workspace);
  if (courierTarget === retiredCourier && install) unlinkSync(courier);
  const doc = join(workspace, "PLATFORM_CONTROL.md");
  const docTarget = linkTarget(doc, workspace);
  if (docTarget !== null && docTarget !== guide)
    throw Error(`Black 4 guide link collision: ${doc}`);
  if (docTarget === null && install) symlinkSync(relative(workspace, guide), doc);
  return {
    courierRetired: linkTarget(courier, workspace) !== retiredCourier,
    guideLinked: linkTarget(doc, workspace) === guide,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--install") && !process.argv.includes("--check"))
    throw Error("Pass --install or --check");
  const registry = JSON.parse(readFileSync(join(root, "config/native-harnesses.json"), "utf8"));
  const results = Object.entries(registry.franchises).map(([id, spec]) => ({
    id,
    harness: spec.harness,
    ...retirePlatformControlLink(
      join(root, "franchises", id.replace(/^b4-/, ""), "workspace"),
      process.argv.includes("--install"),
    ),
  }));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((row) => !row.courierRetired || !row.guideLinked)) process.exitCode = 1;
}
