import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import {
  ManifestRegistry,
  type ManifestDocument,
} from "../src/providers/manifests.js";
import { RuntimeStore, type Job } from "../src/runtime/index.js";
let f: Awaited<ReturnType<typeof testDb>>, registry: ManifestRegistry;
const actor = {
  id: "commissioner",
  role: "commissioner" as const,
  leagueId: "manifest-league",
};
const doc: ManifestDocument = {
  leagueId: actor.leagueId,
  agentId: "a",
  developer: "OpenAI",
  model: "synthetic/model",
  providerSlug: "synthetic-endpoint",
  reportedProviderNames: ["Synthetic Endpoint"],
  quantization: null,
  modelVersion: null,
  openWeight: null,
  license: null,
  keyRef: "B4_LEAGUE_TEST",
  upstreamKeyHash: "synthetic-key-hash",
  guardrailId: "synthetic-guardrail",
  harnessId: "black4-owner-loop",
  buzzBridgeVersion: "acp-v1-unverified",
  harnessVersion: "test",
  toolPermissions: ["research"],
  walletId: "a",
};
beforeEach(async () => {
  f = await testDb();
  registry = new ManifestRegistry(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Synthetic manifest fixture','{}')",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,'team','Synthetic','owner','ai',0,0,100)",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO runtime_agents(id,model,budget_micros) VALUES('a','synthetic/model',600000000)",
  );
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES('a',$1,'team')",
    [actor.leagueId],
  );
});
afterEach(async () => {
  await f.close();
});
it("binds exact key and agent, does not activate from an unverified manifest", async () => {
  const m = await registry.stage(actor, doc, "synthetic-secret");
  const canaryId = await registry.createCanaryJob(m.id);
  const job = (await new RuntimeStore(f.db).claim(
    "canary-test",
    30000,
    doc.model,
    ["a"],
    canaryId,
  ))!;
  await expect(
    registry.preflight(m.id, job, "other-secret", true),
  ).rejects.toThrow("MISMATCH");
  await expect(
    registry.preflight(
      m.id,
      { ...job, agentId: "b" },
      "synthetic-secret",
      true,
    ),
  ).rejects.toThrow("MISMATCH");
  await expect(
    registry.preflight(m.id, job, "synthetic-secret"),
  ).rejects.toThrow("MISMATCH");
  await expect(registry.activate(actor, m.id)).rejects.toThrow("TURN_ACTIVE");
  expect(
    (await registry.preflight(m.id, job, "synthetic-secret", true)).id,
  ).toBe(m.id);
});
it("synthetic guardrail evidence cannot authorize live activation", async () => {
  const m = await registry.stage(actor, doc, "synthetic-secret");
  for (const kind of [
    "assignment",
    "wrong_model",
    "wrong_provider",
    "key_limit",
  ] as const)
    await registry.recordGuardrailCheck(actor, m.id, {
      kind,
      passed: true,
      evidence: { fixture: true },
      synthetic: true,
    });
  await expect(registry.activate(actor, m.id)).rejects.toThrow(
    "GUARDRAIL_CANARIES_REQUIRED",
  );
  await expect(
    registry.stage({ ...actor, leagueId: "other" }, doc, "synthetic-secret"),
  ).rejects.toThrow("FORBIDDEN");
});
it("keeps immutable manifest versions and preserves wallet history", async () => {
  const first = await registry.stage(actor, doc, "synthetic-secret");
  const second = await registry.stage(
    actor,
    { ...doc, model: "synthetic/new-model" },
    "new-secret",
  );
  expect(second.version).toBe(first.version + 1);
  expect((await registry.get(first.id)).document.model).toBe("synthetic/model");
  expect(
    Number(
      (
        await f.db.query(
          "SELECT budget_micros FROM runtime_agents WHERE id='a'",
        )
      ).rows[0].budget_micros,
    ),
  ).toBe(600000000);
});

it("isolates a staged upgrade canary from pending owner work and preserves the owner model", async () => {
  const store = new RuntimeStore(f.db);
  await store.scheduleSelf("a", {
    causalId: "owner-appointment",
    dueAt: new Date(),
    payload: { task: "real owner work" },
  });
  const m = await registry.stage(
    actor,
    { ...doc, model: "synthetic/upgraded" },
    "synthetic-secret",
  );
  const canaryId = await registry.createCanaryJob(m.id);
  const job = (await store.claim(
    "isolated-canary",
    30000,
    doc.model,
    ["a"],
    canaryId,
  ))!;
  expect(job.id).toBe(canaryId);
  await expect(
    registry.preflight(
      m.id,
      { ...job, model: "synthetic/upgraded" },
      "synthetic-secret",
      true,
    ),
  ).resolves.toMatchObject({ id: m.id });
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_jobs WHERE causal_id='owner-appointment'",
      )
    ).rows[0].status,
  ).toBe("pending");
  expect(
    (await f.db.query("SELECT model FROM runtime_agents WHERE id='a'")).rows[0]
      .model,
  ).toBe(doc.model);
});
it("ordinary workers do not claim provider canaries", async () => {
  const m = await registry.stage(actor, doc, "synthetic-secret");
  await registry.createCanaryJob(m.id);
  expect(
    await new RuntimeStore(f.db).claim("ordinary", 30000, doc.model, ["a"]),
  ).toBeNull();
});

it("bare operator booleans cannot bypass durable guardrail evidence requirements", async () => {
  const m = await registry.stage(actor, doc, "synthetic-secret");
  for (const kind of [
    "assignment",
    "key_limit",
    "wrong_model",
    "wrong_provider",
  ] as const) {
    await registry.recordGuardrailCheck(actor, m.id, {
      kind,
      passed: true,
      synthetic: false,
      evidence: { operatorSaysSo: true },
    });
  }
  await expect(registry.activate(actor, m.id)).rejects.toThrow(
    "EVIDENCE_REQUIRED",
  );
  expect((await registry.get(m.id)).status).toBe("staged");
});
