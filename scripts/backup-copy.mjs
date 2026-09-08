// Explicit operator-configured remote only; never uploads age private identities.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { argumentsOf, capture, sha256 } from "./backup-lib.mjs";
const args = argumentsOf(process.argv.slice(2));
if (
  Object.keys(args).some(
    (key) => !["archive", "host", "directory"].includes(key),
  )
)
  throw new Error("Unsupported argument");
if (
  !args.archive ||
  !/^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9][a-z0-9.-]*$/i.test(args.host ?? "") ||
  !/^\/[a-zA-Z0-9_./-]+$/.test(args.directory ?? "") ||
  args.directory.split("/").includes("..")
)
  throw new Error(
    "Provide archive, SSH host and safe absolute remote directory",
  );
const archive = path.resolve(args.archive);
const name = path.basename(archive);
if (!/^black4-[a-zA-Z0-9.-]+\.dump\.age$/.test(name))
  throw new Error("Unexpected encrypted archive filename");
const receipt = JSON.parse(await readFile(archive + ".receipt.json", "utf8"));
const digest = await sha256(archive);
if (
  receipt.sha256 !== digest ||
  receipt.archive !== name ||
  receipt.encryption !== "age"
)
  throw new Error("Local archive receipt verification failed");
const remote = path.posix.join(args.directory, name);
const options = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
await capture("scp", [...options, archive, `${args.host}:${remote}`]);
await capture("scp", [
  ...options,
  archive + ".receipt.json",
  `${args.host}:${remote}.receipt.json`,
]);
const remoteDigest = (
  await capture("ssh", [...options, args.host, "sha256sum", "--", remote])
).split(/\s+/)[0];
if (remoteDigest !== digest)
  throw new Error("Remote checksum did not match; transfer is not verified");
const result = {
  status: "verified-copy",
  verifiedAt: new Date().toISOString(),
  sha256: digest,
  host: args.host,
  path: remote,
  privateIdentityTransferred: false,
  remoteRestoreTest: "not performed",
};
await writeFile(
  archive + ".offdevice.json",
  JSON.stringify(result, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify(result));
