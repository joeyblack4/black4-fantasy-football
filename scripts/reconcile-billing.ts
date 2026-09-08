import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";
import {
  ManifestRegistry,
  ManifestSchema,
} from "../src/providers/manifests.js";
import { BillingReconciler } from "../src/providers/reconcile.js";
// Explicit operator entry point. It reads metadata and updates local accounting, never generates inference.
if (!process.argv.includes("--apply-metadata-reconciliation"))
  throw Error(
    "Pass --apply-metadata-reconciliation to verify provider metadata and update receipts",
  );
const manifestId = process.env.FOOTBALL_MANIFEST_ID,
  leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!manifestId || !leagueId)
  throw Error("FOOTBALL_MANIFEST_ID and FOOTBALL_LEAGUE_ID are required");
if (process.env.DATABASE_URL_FILE)
  process.env.DATABASE_URL = (
    await readFile(process.env.DATABASE_URL_FILE, "utf8")
  ).trim();
const db = createDb();
try {
  const manifest = await new ManifestRegistry(db).get(manifestId);
  const document = ManifestSchema.parse(manifest.document);
  const secret = process.env[document.keyRef];
  if (!secret) throw Error("Dedicated manifest key is not available");
  const result = await new BillingReconciler(db).reconcile(
    { id: "local-billing-operator", role: "commissioner", leagueId },
    { manifestId, secret, limit: 100 },
  );
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error(
    "Billing reconciliation did not complete; inspect local receipts and configuration. Credentials and raw provider responses are not logged.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
