import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { ManifestRegistry } from "../src/providers/manifests.js";
import {
  GuardrailChecker,
  NegativeProbeSchema,
  NegativeAdjudicationSchema,
} from "../src/providers/guardrail-checks.js";
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan",
      readOnlyInspection:
        "--execute --manifest UUID --journal /absolute/private/provision.jsonl",
      optionalPaidProbe:
        "Add --probe /absolute/probe.json --allow-paid-negative-probe; one wrong_model or wrong_provider request per manifest/kind, wallet reserved first.",
      noNetworkAdjudication:
        "--execute --manifest UUID --adjudicate /absolute/private/review.json; reads captured evidence and commissioner token only, never provider keys or HTTP",
      secrets: [
        "B4_LEAGUE_COMMISSIONER_TOKEN",
        "B4_LEAGUE_OPENROUTER_MANAGEMENT",
        "manifest.keyRef",
      ],
      negativeProof:
        "Current documented generic errors remain unresolved; this command cannot make them green.",
      networkCalls: 0,
    }),
  );
  process.exit(0);
}
async function privateRead(path: string) {
  const file = resolve(path),
    s = await lstat(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (s.mode & 0o077) !== 0 ||
    s.uid !== process.getuid?.()
  )
    throw Error("Private input must be an owned nonsymlink mode0600 file.");
  if (s.size > 1024 * 1024) throw Error("Private input is too large.");
  return await readFile(file, "utf8");
}
const manifestId = arg("--manifest"),
  journalPath = arg("--journal"),
  adjudicationPath = arg("--adjudicate");
if (!manifestId || (!journalPath && !adjudicationPath))
  throw Error("--manifest and either --journal or --adjudicate required.");
if (adjudicationPath && (journalPath || arg("--probe")))
  throw Error("Adjudication cannot be combined with network inspection/probe.");
const db = createDb(
  process.env.DATABASE_URL ??
    (
      await privateRead(
        process.env.FOOTBALL_DATABASE_URL_FILE ??
          ".local/deploy/database-url.host",
      )
    ).trim(),
);
try {
  const actor = await authenticate(
    db,
    "Bearer " + (process.env.B4_LEAGUE_COMMISSIONER_TOKEN ?? ""),
  );
  if (adjudicationPath) {
    const checker = new GuardrailChecker(db, {
      synthetic: false,
      allowNetwork: true,
    });
    const review = NegativeAdjudicationSchema.parse(
      JSON.parse(await privateRead(adjudicationPath)),
    );
    console.log(
      JSON.stringify({
        manifestId,
        adjudication: await checker.adjudicate(actor, manifestId, review),
        networkCalls: 0,
      }),
    );
  } else {
    const manifest = await new ManifestRegistry(db).get(manifestId);
    const secret = process.env[manifest.document.keyRef] ?? "";
    const journal = (await privateRead(journalPath!))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const checker = new GuardrailChecker(db, {
      synthetic: false,
      allowNetwork: true,
    });
    const inspection = await checker.inspect(actor, manifestId, {
      apiKey: secret,
      managementKey: process.env.B4_LEAGUE_OPENROUTER_MANAGEMENT ?? "",
      provisioningJournal: journal,
    });
    console.log(JSON.stringify({ manifestId, inspection }));
    const probeFile = arg("--probe");
    if (probeFile) {
      if (!process.argv.includes("--allow-paid-negative-probe"))
        throw Error(
          "Negative probes require --allow-paid-negative-probe because a restriction failure can bill.",
        );
      const spec = NegativeProbeSchema.parse(
        JSON.parse(await privateRead(probeFile)),
      );
      console.log(
        JSON.stringify({
          manifestId,
          probe: await checker.probe(actor, manifestId, secret, spec),
        }),
      );
    }
  }
} catch {
  console.error(
    "Guardrail verification stopped. Inspect private check/provider/wallet receipts. No secret or raw provider response has been printed; do not retry uncertain inference.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
