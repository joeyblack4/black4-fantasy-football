import { readFile } from "node:fs/promises";
import { createDb, migrate } from "../src/db.js";
import {
  ManifestRegistry,
  ManifestSchema,
} from "../src/providers/manifests.js";
const [command, pathOrId] = process.argv.slice(2);
if (!command || !pathOrId || !process.env.FOOTBALL_LEAGUE_ID)
  throw Error(
    "Usage: manifest.ts stage document.json | activate manifest-id; league binding required.",
  );
const db = createDb();
await migrate(db);
const registry = new ManifestRegistry(db),
  actor = {
    id: "joey-commissioner",
    role: "commissioner" as const,
    leagueId: process.env.FOOTBALL_LEAGUE_ID,
  };
try {
  if (command === "stage") {
    const doc = ManifestSchema.parse(
      JSON.parse(await readFile(pathOrId, "utf8")),
    );
    const key = process.env[doc.keyRef];
    if (!key) throw Error("Dedicated secret reference unavailable.");
    const m = await registry.stage(actor, doc, key);
    console.log(
      JSON.stringify({
        id: m.id,
        version: m.version,
        status: m.status,
        model: m.document.model,
        harness: m.document.harnessId,
      }),
    );
  } else if (command === "activate") {
    await registry.activate(actor, pathOrId);
    console.log(JSON.stringify({ activated: pathOrId }));
  } else throw Error("Unknown command");
} finally {
  await db.end();
}
