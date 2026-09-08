import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  ProvisionSchema,
  provisionFranchiseKey,
} from "../src/providers/provision.js";
const path = process.argv[process.argv.indexOf("--config") + 1];
if (!process.argv.includes("--config") || !path)
  throw Error("--config is required.");
const spec = ProvisionSchema.parse(JSON.parse(await readFile(path, "utf8")));
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        mode: "plan",
        spec,
        spendLimit: "Initial key limit only; no purchase or inference.",
        requiredSecret: "B4_LEAGUE_OPENROUTER_MANAGEMENT",
        negativeTests: "required before activation",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const dir = resolve(
  process.env.FOOTBALL_SECRET_DIRECTORY ?? ".local/live/secrets",
);
await mkdir(dir, { recursive: true, mode: 0o700 });
if (((await stat(dir)).mode & 0o077) !== 0)
  throw Error("Secret directory must be mode0700.");
const journal = await open(
  resolve(dir, spec.name + ".provision.jsonl"),
  "wx",
  0o600,
);
try {
  const receipt = await provisionFranchiseKey(spec, {
    managementKey: process.env.B4_LEAGUE_OPENROUTER_MANAGEMENT ?? "",
    journal: async (r) => {
      await journal.write(JSON.stringify(r) + "\n");
      await journal.sync();
    },
    saveSecret: async (ref, key) => {
      await writeFile(resolve(dir, ref + ".key"), key + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    },
  });
  console.log(JSON.stringify(receipt));
} catch {
  console.error(
    "Provisioning stopped. Inspect the private journal; do not retry a dispatched mutation without reconciliation. No secret has been printed.",
  );
  process.exitCode = 1;
} finally {
  await journal.close();
}
