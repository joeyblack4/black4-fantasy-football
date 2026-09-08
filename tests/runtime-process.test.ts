import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
it("recovers after actual worker SIGKILL with durable work and uncertain charge intact", async () => {
  const fixture = await testDb();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new RuntimeStore(fixture.db);
    await store.createAgent({
      id: "owner",
      model: "test/model",
      budgetMicros: 1000,
    });
    await store.ingestEvent({
      agentId: "owner",
      causalId: "crash-fixture",
      payload: { synthetic: true },
    });
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./runtime-crash-child.ts", import.meta.url)),
      ],
      {
        env: { ...process.env, RUNTIME_TEST_SCHEMA: fixture.schema },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const killed = await new Promise<{
      claim: { fence: number };
      reservationId: string;
    }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("Child failed to claim")),
        5000,
      );
      child!.stdout!.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) {
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, end)));
        }
      });
      child!.on("error", reject);
      child!.stderr!.on("data", (chunk) => {
        clearTimeout(timer);
        reject(new Error(String(chunk)));
      });
    });
    const exit = new Promise((resolve) =>
      child!.once("exit", (_code, signal) => resolve(signal)),
    );
    child.kill("SIGKILL");
    expect(await exit).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 650));
    const result = await runOne(
      new RuntimeStore(fixture.db),
      new TestDriver("test/model"),
      "replacement",
      { maxCostMicros: 100 },
    );
    expect(result.status).toBe("completed");
    const snap = await store.snapshot();
    expect(snap.jobs[0].fence).toBe(killed.claim.fence + 1);
    expect(
      snap.reservations.find((r) => r.id === killed.reservationId).status,
    ).toBe("uncertain");
    expect(Number(snap.agents[0].reserved_micros)).toBe(100);
    expect(
      snap.receipts.filter((r) => r.type === "job.completed"),
    ).toHaveLength(1);
  } finally {
    child?.kill("SIGKILL");
    await fixture.close();
  }
}, 10000);
