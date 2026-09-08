import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
const directory = resolve(process.argv[2] ?? ".local/deploy");
await mkdir(directory, { recursive: true, mode: 0o700 });
const hostPort = Number(process.env.FOOTBALL_POSTGRES_HOST_PORT ?? "55435");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)
  throw new Error("Invalid FOOTBALL_POSTGRES_HOST_PORT");
const files = [
  "postgres-password",
  "database-url.container",
  "database-url.host",
];
for (const name of files) {
  try {
    await access(join(directory, name));
    throw new Error("Deployment secret already exists; refusing overwrite");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const password = randomBytes(32).toString("base64url");
await writeFile(join(directory, "postgres-password"), password + "\n", {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  join(directory, "database-url.container"),
  "postgresql://black4:" + password + "@postgres:5432/black4_football\n",
  { mode: 0o600, flag: "wx" },
);

await writeFile(
  join(directory, "database-url.host"),
  "postgresql://black4:" +
    password +
    "@127.0.0.1:" +
    hostPort +
    "/black4_football\n",
  { mode: 0o600, flag: "wx" },
);

console.log(
  "Created dedicated database secret files in " +
    directory +
    ". No provider key, live worker or account was created.",
);
