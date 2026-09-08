import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { argumentsOf, child, composeCommand, sha256 } from "./backup-lib.mjs";
const args = argumentsOf(process.argv.slice(2));
if (
  Object.keys(args).some(
    (key) => !["project", "recipient", "out"].includes(key),
  )
)
  throw new Error("Unsupported argument");
if (!/^age1[0-9a-z]{50,100}$/.test(args.recipient ?? ""))
  throw new Error("Provide an age public --recipient");
if (!args.out) throw new Error("Provide private --out directory");
const out = path.resolve(args.out);
await mkdir(out, { recursive: true, mode: 0o700 });
const final = path.join(
  out,
  `black4-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.dump.age`,
);
const temp = final + ".partial";
let dump, encrypt;
try {
  dump = child(
    "docker",
    composeCommand(args.project, [
      "pg_dump",
      "-U",
      "black4",
      "-d",
      "black4_football",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ]),
  );
  encrypt = child("age", ["--encrypt", "--recipient", args.recipient]);
  dump.process.stdin.end();
  await Promise.all([
    pipeline(dump.process.stdout, encrypt.process.stdin),
    pipeline(
      encrypt.process.stdout,
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
    ),
    dump.completed,
    encrypt.completed,
  ]);
  await rename(temp, final);
  const receipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    project: args.project,
    database: "black4_football",
    archive: path.basename(final),
    sha256: await sha256(final),
    bytes: (await stat(final)).size,
    encryption: "age",
    recipient: args.recipient,
    offDevice: {
      status: "pending",
      reason: "No remote destination configured or transferred by this command",
    },
  };
  await writeFile(
    final + ".receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      archive: final,
      receipt: final + ".receipt.json",
      sha256: receipt.sha256,
      offDevice: "pending",
    }),
  );
} catch (error) {
  dump?.process.kill("SIGTERM");
  encrypt?.process.kill("SIGTERM");
  await rm(temp, { force: true });
  throw error;
}
