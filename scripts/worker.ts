import { setTimeout as pause } from "node:timers/promises";
import { createDb, migrate } from "../src/db.js";
import { RuntimeStore, type DriverResult } from "../src/runtime/index.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
if (!process.argv.includes("--synthetic"))
  throw new Error(
    "This rehearsal worker requires --synthetic. Live driver activation is a separate canary gate.",
  );
const db = createDb();
await migrate(db);
const store = new RuntimeStore(db),
  outbox = new FootballOutbox(db, store);
let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
const driver = new TestDriver("synthetic/test", (job) => {
  const result: DriverResult = {
    actions: [],
    costMicros: 0,
    summary:
      "Synthetic transport and scheduling rehearsal; no model inference.",
  };
  if (job.payload.scenario === "opening-review")
    result.actions = [
      {
        type: "message",
        recipientId: String(job.payload.peer),
        causalId: "synthetic-trade-inquiry",
        body: "[SYNTHETIC TEST] I have a roster gap. Can we discuss a trade? This text was written by a test fixture.",
      },
      {
        type: "schedule",
        causalId: "synthetic-follow-up",
        dueAt: new Date(Date.now() + 15000).toISOString(),
        payload: { scenario: "follow-up" },
      },
      {
        type: "remember",
        key: "rehearsal",
        content:
          "Synthetic inquiry sent; a follow-up appointment was recorded. No football decision made.",
      },
    ];
  else if (job.kind === "message" && job.payload.senderId === "demo-team-01")
    result.actions = [
      {
        type: "message",
        recipientId: "demo-team-01",
        causalId: "synthetic-trade-reply",
        body: "[SYNTHETIC TEST] Message received through the durable inbox. This is a fixture response, not model collaboration.",
        replyTo: String(job.payload.messageId),
        conversationId: String(job.payload.conversationId),
      },
    ];
  else if (job.payload.scenario === "follow-up")
    result.actions = [
      {
        type: "remember",
        key: "rehearsal-result",
        content:
          "The persisted appointment woke this fixture without another human prompt.",
      },
    ];
  return result;
});
console.log("Synthetic worker listening; no paid inference or Buzz sends.");
try {
  while (!stopped) {
    const result = await runOne(store, driver, `demo-worker-${process.pid}`, {
      leaseMs: 15000,
      maxCostMicros: 0,
    });
    await outbox.dispatchOne(`demo-football-${process.pid}`);
    if (result.status !== "idle")
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (process.argv.includes("--once")) break;
    await pause(result.status === "idle" ? 500 : 10);
  }
} finally {
  await db.end();
}
