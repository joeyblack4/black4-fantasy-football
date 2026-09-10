#!/usr/bin/env node
/** Preserve native workspaces while exposing them in Finder. Defaults to read-only. */
import {
  readFileSync,
  lstatSync,
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  realpathSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const linksOnly = process.argv.includes("--links-only");
const apply = process.argv.includes("--apply") || linksOnly;
const verify = process.argv.includes("--verify");
if (apply && !linksOnly && !process.argv.includes("--writers-stopped"))
  throw new Error(
    "Stop franchise runtimes first, then supply --writers-stopped.",
  );
const registry = JSON.parse(
  readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
);
const stat = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const entries = Object.keys(registry.franchises).map((id) => ({
  id,
  company: id.replace(/^b4-/, ""),
  old: join(root, ".local/franchise-runtimes/native-live", id, "workspace"),
  destination: join(root, "franchises", id.replace(/^b4-/, ""), "workspace"),
}));
// Validate every destination before changing any workspace; never merge or overwrite work.
for (const row of entries) {
  const oldStat = stat(row.old),
    destinationStat = stat(row.destination);
  if (linksOnly && !oldStat?.isSymbolicLink())
    throw new Error(`${row.id}: links-only cannot migrate an active workspace`);
  if (oldStat?.isSymbolicLink()) {
    if (
      !destinationStat?.isDirectory() ||
      realpathSync(row.old) !== row.destination
    )
      throw new Error(`${row.id}: unexpected compatibility link`);
  } else {
    if (!oldStat?.isDirectory())
      throw new Error(`${row.id}: original workspace missing`);
    if (destinationStat)
      throw new Error(
        `${row.id}: destination already exists alongside original`,
      );
  }
}
function linkCanonical(workspace, name, target, id) {
  const path = join(workspace, name),
    current = stat(path);
  if (
    current?.isSymbolicLink() &&
    resolve(workspace, readlinkSync(path)) === target
  )
    return;
  if (current) {
    const backupRoot = join(root, ".local/workspace-migration-backups", id);
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    let backup = join(backupRoot, name),
      suffix = 0;
    while (stat(backup)) backup = join(backupRoot, `${name}.${++suffix}`);
    renameSync(path, backup);
  }
  symlinkSync(relative(workspace, target), path);
}
if (apply) {
  for (const row of entries) {
    if (!stat(row.old).isSymbolicLink()) {
      mkdirSync(dirname(row.destination), { recursive: true });
      renameSync(row.old, row.destination);
      symlinkSync(relative(dirname(row.old), row.destination), row.old);
    }
    linkCanonical(
      row.destination,
      "START_HERE.md",
      join(root, "docs/FRANCHISE_START.md"),
      row.id,
    );
    linkCanonical(
      row.destination,
      "RULEBOOK.md",
      join(root, "docs/SEASON_RULES.md"),
      row.id,
    );
    linkCanonical(
      row.destination,
      "OWNER_CHARTER.md",
      join(root, "docs/OWNER_CHARTER.md"),
      row.id,
    );
    linkCanonical(
      row.destination,
      "SEASON_OPERATIONS.md",
      join(root, "docs/SEASON_OPERATIONS.md"),
      row.id,
    );
    linkCanonical(
      row.destination,
      "NATIVE_SCHEDULING.md",
      join(root, "docs/NATIVE_SCHEDULING.md"),
      row.id,
    );
  }
}
const result = entries.map((row) => {
  const moved =
    stat(row.old)?.isSymbolicLink() &&
    existsSync(row.destination) &&
    realpathSync(row.old) === row.destination;
  const canonical = (name, target) => {
    const path = join(row.destination, name);
    return (
      !!moved &&
      stat(path)?.isSymbolicLink() === true &&
      existsSync(path) &&
      realpathSync(path) === join(root, target)
    );
  };
  return {
    franchise: row.id,
    workspace: relative(root, row.destination),
    migrated: !!moved,
    files: readdirSync(moved ? row.destination : row.old).length,
    commonBrief: canonical("START_HERE.md", "docs/FRANCHISE_START.md"),
    rulebook: canonical("RULEBOOK.md", "docs/SEASON_RULES.md"),
    ownerCharter: canonical("OWNER_CHARTER.md", "docs/OWNER_CHARTER.md"),
    seasonOperations: canonical(
      "SEASON_OPERATIONS.md",
      "docs/SEASON_OPERATIONS.md",
    ),
    nativeScheduling: canonical(
      "NATIVE_SCHEDULING.md",
      "docs/NATIVE_SCHEDULING.md",
    ),
  };
});
console.log(
  JSON.stringify(
    {
      mode: apply ? "applied" : verify ? "verification" : "preview",
      workspaces: result,
    },
    null,
    2,
  ),
);
if (
  verify &&
  result.some(
    (row) =>
      !row.migrated ||
      !row.commonBrief ||
      !row.rulebook ||
      !row.ownerCharter ||
      !row.seasonOperations ||
      !row.nativeScheduling,
  )
)
  process.exitCode = 1;
