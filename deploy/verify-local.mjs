// Destructive cleanup is limited to this command's uniquely named fixture databases.
import { mkdtemp, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  argumentsOf,
  capture,
  composeCommand,
  root,
  sha256,
} from "../scripts/backup-lib.mjs";
const args = argumentsOf(process.argv.slice(2));
if (!/^black4-football-validation(?:-[a-z0-9]+)?$/.test(args.project ?? ""))
  throw new Error("Only a dedicated validation Compose project is permitted");
const api = new URL(args.api ?? "http://127.0.0.1:14313");
if (api.hostname !== "127.0.0.1" || api.protocol !== "http:")
  throw new Error("Validation API must be local loopback");
const sql = (database, query) =>
  capture(
    "docker",
    composeCommand(args.project, [
      "psql",
      "-X",
      "-U",
      "black4",
      "-d",
      database,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ]),
  );
const token = randomUUID().replaceAll("-", "");
const target = "black4_football_restore_" + token;
const emptyTarget = "black4_football_restore_" + token.slice(0, 30) + "_bad";
const table = "deployment_probe_" + token;
const temp = await mkdtemp(path.join(os.tmpdir(), "black4-deployment-"));
await chmod(temp, 0o700);
const evidence = {
  scope: "isolated synthetic deployment; no model requests or public sends",
  checkedAt: new Date().toISOString(),
  project: args.project,
  checks: {},
  offDeviceBackup:
    "pending: recipient custody and remote destination not configured",
};
let createdTarget = false,
  createdEmpty = false,
  createdProbe = false;
try {
  const health = await fetch(new URL("/health", api));
  if (!health.ok) throw new Error("API is unhealthy");
  evidence.checks.apiHealthy = true;
  const published = JSON.parse(
    await capture("docker", [
      "inspect",
      args.project + "-api-1",
      "--format",
      "{{json .HostConfig.PortBindings}}",
    ]),
  );
  if (published["4312/tcp"]?.[0]?.HostIp !== "127.0.0.1")
    throw new Error("API host binding is not loopback");
  evidence.checks.loopbackOnly = true;
  const postgresPorts = await capture("docker", [
    "inspect",
    args.project + "-postgres-1",
    "--format",
    "{{json .HostConfig.PortBindings}}",
  ]);
  if (!["{}", "null"].includes(postgresPorts))
    throw new Error("PostgreSQL has a host port");
  evidence.checks.noDatabaseHostPort = true;
  await sql(
    "black4_football",
    `CREATE TABLE ${table}(id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO ${table} VALUES (1,'synthetic backup proof');`,
  );
  createdProbe = true;
  await sql("black4_football", `CREATE DATABASE ${target}`);
  createdTarget = true;
  await sql("black4_football", `CREATE DATABASE ${emptyTarget}`);
  createdEmpty = true;
  const identity = path.join(temp, "identity.age");
  await capture("age-keygen", ["--output", identity]);
  await chmod(identity, 0o600);
  const recipient = await capture("age-keygen", ["--y", identity]);
  console.log("validation: encrypted backup");
  const result = JSON.parse(
    await capture(process.execPath, [
      path.join(root, "scripts/backup.mjs"),
      "--project",
      args.project,
      "--recipient",
      recipient,
      "--out",
      temp,
    ]),
  );
  const restoreArgs = [
    path.join(root, "scripts/restore-backup.mjs"),
    "--project",
    args.project,
    "--archive",
    result.archive,
    "--identity",
    identity,
    "--sha256",
    result.sha256,
    "--target",
    target,
  ];
  console.log("validation: restore");
  await capture(process.execPath, restoreArgs);
  if (
    (await sql(target, `SELECT marker FROM ${table} WHERE id=1`)) !==
    "synthetic backup proof"
  )
    throw new Error("Restored row mismatch");
  evidence.checks.encryptedRestoreExactRow = true;
  const expectReject = async (commandArgs) => {
    try {
      await capture(process.execPath, commandArgs);
    } catch {
      return;
    }
    throw new Error("Unsafe restore unexpectedly succeeded");
  };
  await expectReject(restoreArgs);
  evidence.checks.nonemptyRestoreRejected = true;
  const invalidHashArgs = [...restoreArgs];
  invalidHashArgs[invalidHashArgs.indexOf("--sha256") + 1] = "0".repeat(64);
  await expectReject(invalidHashArgs);
  evidence.checks.hashMismatchRejected = true;
  const bytes = await readFile(result.archive);
  bytes[bytes.length - 1] ^= 1;
  const tampered = path.join(temp, "tampered.age");
  await writeFile(tampered, bytes, { mode: 0o600 });
  const tamperArgs = [...restoreArgs];
  tamperArgs[tamperArgs.indexOf("--archive") + 1] = tampered;
  tamperArgs[tamperArgs.indexOf("--sha256") + 1] = await sha256(tampered);
  tamperArgs[tamperArgs.indexOf("--target") + 1] = emptyTarget;
  await expectReject(tamperArgs);
  if (
    (await sql(
      emptyTarget,
      "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
    )) !== "0"
  )
    throw new Error("Authentication failure mutated target");
  evidence.checks.tamperAuthenticationBeforeWrites = true;
  await sql(
    emptyTarget,
    "CREATE FUNCTION public.restore_guard() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
  );
  const functionTargetArgs = [...restoreArgs];
  functionTargetArgs[functionTargetArgs.indexOf("--target") + 1] = emptyTarget;
  await expectReject(functionTargetArgs);
  evidence.checks.functionOnlyTargetRejected = true;
  evidence.imageId = await capture("docker", [
    "inspect",
    args.project + "-api-1",
    "--format",
    "{{.Image}}",
  ]);
  evidence.postgresVersion = await sql(
    "black4_football",
    "SHOW server_version",
  );
  evidence.archiveBytes = (await readFile(result.archive)).length;
  evidence.archiveSha256 = result.sha256;
} finally {
  if (createdTarget) await sql("black4_football", `DROP DATABASE ${target}`);
  if (createdEmpty)
    await sql("black4_football", `DROP DATABASE ${emptyTarget}`);
  if (createdProbe) await sql("black4_football", `DROP TABLE ${table}`);
  await rm(temp, { recursive: true, force: true });
}
evidence.fixtureCleanup =
  "completed: unique probe, restore databases, temporary archive and test-only age key removed";
await writeFile(
  path.join(root, "evidence/deployment-validation.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
