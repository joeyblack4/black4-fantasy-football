/** Local synthetic durability soak. No provider API, Buzz account, or external messages. */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { testDb } from "../../tests/helpers.js";
import { RuntimeStore } from "./index.js";
import { runOne, TestDriver } from "./worker.js";
const durationMs = Number(process.env.RUNTIME_SOAK_MS ?? 1800000);
if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 3600000)
  throw new Error("Invalid soak duration");
const reportName = process.env.RUNTIME_SOAK_REPORT ?? "runtime-soak";
if (!/^[a-z0-9-]{1,80}$/.test(reportName))
  throw new Error("Invalid report filename");
const codeFiles = [
  "index.ts",
  "worker.ts",
  "football-schema.ts",
  "football-outbox.ts",
];
const hasher = createHash("sha256");
for (const name of codeFiles)
  hasher.update(await readFile(new URL("./" + name, import.meta.url)));
const codeHash = hasher.digest("hex");
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});
const fixture = await testDb();
const store = new RuntimeStore(fixture.db);
const started = Date.now();
const counters = {
  loops: 0,
  completed: 0,
  staleFenced: 0,
  leaseRecoveries: 0,
  messages: 0,
  errors: [] as string[],
};
const report = async (final: boolean) => {
  const snapshot = await store.snapshot();
  counters.messages = snapshot.messages.length;
  const data = {
    synthetic: true,
    codeHash,
    codeFiles,
    isolatedSchema: fixture.schema,
    completedDuration: Date.now() - started >= durationMs,
    stoppedBySignal: stopping,
    driver: "DETERMINISTIC_TEST_DRIVER",
    startedAt: new Date(started).toISOString(),
    sampledAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    durationMs,
    final,
    ...counters,
    jobs: snapshot.jobs.length,
    receipts: snapshot.receipts.length,
    scope:
      "Local PostgreSQL scheduler, messaging and wallet reliability only; no evidence of LLM initiative or Buzz delivery.",
  };
  await mkdir("evidence", { recursive: true });
  await writeFile(
    "evidence/" + reportName + ".json",
    JSON.stringify(data, null, 2) + "\n",
  );
  console.log(JSON.stringify(data));
};
try {
  for (const id of ["soak-a", "soak-b"])
    await store.createAgent({
      id,
      model: "synthetic/soak",
      budgetMicros: 100000,
    });
  await store.ingestEvent({
    agentId: "soak-a",
    causalId: "start",
    payload: { synthetic: true },
  });
  const driver = new TestDriver("synthetic/soak", (job) => ({
    costMicros: 0,
    summary: "Synthetic timer and message loop. No model called.",
    actions:
      job.agentId === "soak-a"
        ? [
            {
              type: "schedule",
              causalId: "next:" + job.id,
              dueAt: new Date(Date.now() + 400).toISOString(),
              payload: { synthetic: true },
            },
            {
              type: "message",
              recipientId: "soak-b",
              causalId: "send:" + job.id,
              body: "SYNTHETIC event receipt probe; no reply requested.",
            },
          ]
        : [],
  }));
  let nextReport = started;
  let nextCrash = started + 10000;
  while (!stopping && Date.now() - started < durationMs) {
    counters.loops++;
    if (Date.now() >= nextCrash) {
      const claim = await store.claim(
        "simulated-disconnect",
        30,
        "synthetic/soak",
      );
      if (claim) {
        await new Promise((r) => setTimeout(r, 45));
        try {
          await store.heartbeat(claim);
        } catch {
          counters.staleFenced++;
        }
        counters.leaseRecoveries++;
      }
      nextCrash = Date.now() + 10000;
    }
    const outcomes = await Promise.all([
      runOne(store, driver, "worker-1"),
      runOne(store, driver, "worker-2"),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "completed") counters.completed++;
      if (outcome.status === "failed" || outcome.status === "stale")
        counters.errors.push(JSON.stringify(outcome));
    }
    if (Date.now() >= nextReport) {
      await report(false);
      nextReport = Date.now() + 60000;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await report(true);
} finally {
  await fixture.close();
}
