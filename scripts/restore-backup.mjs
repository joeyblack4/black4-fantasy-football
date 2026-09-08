import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import {
  argumentsOf,
  capture,
  child,
  composeCommand,
  sha256,
} from "./backup-lib.mjs";
const args = argumentsOf(process.argv.slice(2));
if (
  Object.keys(args).some(
    (key) =>
      !["project", "archive", "identity", "sha256", "target"].includes(key),
  )
)
  throw new Error("Unsupported argument");
if (!/^black4_football_restore_[a-z0-9_]{1,40}$/.test(args.target ?? ""))
  throw new Error(
    "Restore target must be a separately created black4_football_restore_* database",
  );
if (
  !args.archive ||
  !args.identity ||
  !/^[a-f0-9]{64}$/.test(args.sha256 ?? "")
)
  throw new Error("Provide --archive, --identity and trusted --sha256");
if ((await sha256(args.archive)) !== args.sha256)
  throw new Error("Archive SHA-256 does not match trusted receipt");
const identity = await stat(args.identity);
if (!identity.isFile() || (identity.mode & 0o077) !== 0)
  throw new Error("Identity must be a private file (mode 0600 or stricter)");
const scratch = await mkdtemp(path.join(os.tmpdir(), "black4-restore-"));
await chmod(scratch, 0o700);
let decrypt, restore;
try {
  const dump = path.join(scratch, "authenticated.dump");
  decrypt = child("age", [
    "--decrypt",
    "--identity",
    path.resolve(args.identity),
    "--output",
    dump,
    path.resolve(args.archive),
  ]);
  decrypt.process.stdin.end();
  decrypt.process.stdout.resume();
  await decrypt.completed;
  await chmod(dump, 0o600);
  // Decryption/authentication completes before any database write. Existing nonempty databases are rejected.
  const objects = await capture(
    "docker",
    composeCommand(args.project, [
      "psql",
      "-X",
      "-U",
      "black4",
      "-d",
      args.target,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "WITH user_schemas AS (SELECT oid,nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%') SELECT (SELECT count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM user_schemas)) + (SELECT count(*) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM user_schemas)) + (SELECT count(*) FROM pg_type WHERE typnamespace IN (SELECT oid FROM user_schemas)) + (SELECT count(*) FROM user_schemas WHERE nspname <> 'public') + (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql')",
    ]),
  );
  if (objects !== "0")
    throw new Error("Restore target is not empty; no overwrite permitted");
  restore = child(
    "docker",
    composeCommand(args.project, [
      "pg_restore",
      "-U",
      "black4",
      "-d",
      args.target,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
    ]),
  );
  restore.process.stdout.resume();
  await Promise.all([
    pipeline(createReadStream(dump), restore.process.stdin),
    restore.completed,
  ]);
  console.log(
    JSON.stringify({
      restored: true,
      target: args.target,
      sha256: args.sha256,
      source: path.basename(args.archive),
      publication: false,
    }),
  );
} finally {
  decrypt?.process.kill("SIGTERM");
  restore?.process.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
