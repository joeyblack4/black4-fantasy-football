import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  buildOwnerRuntimeStatus,
  createOwnerRuntimeStatusTools,
  type OwnerStatusConfig,
} from "../src/runtime/owner-status.js";
async function fixture() {
  const f = await testDb(),
    store = new RuntimeStore(f.db),
    manifestId = randomUUID(),
    patchReceiptId = randomUUID();
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES('status-test','SYNTHETIC','{}')",
  );
  for (const a of ["a", "b"]) {
    await store.createAgent({
      id: a,
      model: "synthetic/model",
      budgetMicros: 1000000,
    });
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES('status-test',$1,$1,$2,'ai',$3,$3,100)",
      [a, "owner-" + a, a === "a" ? 0 : 1],
    );
    await f.db.query(
      "INSERT INTO runtime_bindings VALUES($1,'status-test',$1)",
      [a],
    );
  }
  const document = {
    agentId: "a",
    leagueId: "status-test",
    developer: "OpenAI",
    model: "synthetic/model",
    canonicalModel: "synthetic/model-v1",
    providerSlug: "synthetic/provider",
    reportedProviderNames: ["Synthetic"],
    harnessId: "black4-owner-loop",
    harnessVersion: "synthetic-v1",
    buzzBridgeVersion: "synthetic-bridge",
    toolPermissions: ["mfl_read"],
    keyRef: "B4_LEAGUE_SECRET",
    upstreamKeyHash: "NEVER_SHARE_KEY_HASH",
    guardrailId: "NEVER_SHARE_GUARDRAIL",
  };
  await f.db.query(
    "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status,activated_at) VALUES($1,'status-test','a',1,$2,'NEVER_SHARE_FINGERPRINT','active',clock_timestamp())",
    [manifestId, document],
  );
  await store.ingestEvent({
    agentId: "a",
    causalId: "status-fixture",
    payload: { synthetic: true },
  });
  const job = (await store.claim("status-worker", 60000, undefined, ["a"]))!;
  await store.reserve(job, 25000);
  await f.db.query(
    "UPDATE runtime_agents SET spent_micros=999999 WHERE id='b'",
  );
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('operator.harness_patch_deployed',$1)",
    [
      {
        receiptId: patchReceiptId,
        patch: "synthetic-r1",
        manifestHarness: "synthetic-v1",
        sourceHash: "a".repeat(64),
        release: "/PRIVATE/HOST/PATH",
        apiKey: "NEVER_SHARE_KEY",
      },
    ],
  );
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('operator.reasoning_policy_configured',$1)",
    [
      {
        settings: [
          {
            agentId: "a",
            model: "synthetic/model",
            provider: "synthetic/provider",
            effort: "low",
            private: "NEVER_SHARE_POLICY",
          },
        ],
      },
    ],
  );
  const config: OwnerStatusConfig = {
    manifestId,
    maxOutputTokens: 6000,
    maxCallsPerTurn: 6,
    requestTimeoutMs: 300000,
    turnReservationMicros: 25000,
    reasoningEffort: "low",
    firecrawlConfigured: true,
    serverSearchEnabled: false,
    mflWritesEnabled: false,
    patchReceiptId,
  };
  return { ...f, job, store, config };
}
it("returns only the current owner identity/wallet and safe worker settings, without credentials or private deployment fields", async () => {
  const f = await fixture();
  try {
    const before = Number(
      (await f.db.query("SELECT count(*) FROM runtime_receipts")).rows[0].count,
    );
    const r = await buildOwnerRuntimeStatus(f.db, f.job, f.config);
    expect(r.identity).toMatchObject({
      model: "synthetic/model",
      canonicalModel: "synthetic/model-v1",
      harnessVersion: "synthetic-v1",
    });
    expect(r.wallet).toMatchObject({
      budgetMicros: 1000000,
      spentMicros: 0,
      heldMicros: 25000,
      availableMicros: 975000,
      breakdown: {
        unclassifiedHeldMicros: 0,
        modelJobs: { heldMicros: 25000 },
      },
    });
    expect(r.runtime).toMatchObject({
      configured: {
        reasoningEffort: "low",
        maxOutputTokens: 6000,
        maxReadToolsPerResponse: 4,
      },
      reasoningPolicy: { matchesRunningConfiguration: true },
      patch: { patch: "synthetic-r1" },
    });
    expect(r.football.nativeSettings.status).toBe("unknown");
    expect(JSON.stringify(r)).not.toMatch(
      /NEVER_SHARE|PRIVATE\/HOST|999999|keyRef|upstreamKeyHash|guardrailId/,
    );
    expect(
      Number(
        (await f.db.query("SELECT count(*) FROM runtime_receipts")).rows[0]
          .count,
      ),
    ).toBe(before);
    await f.db.query(
      "UPDATE runtime_agents SET spent_micros=1234 WHERE id='a'",
    );
    expect(
      (await buildOwnerRuntimeStatus(f.db, f.job, f.config)).wallet.spentMicros,
    ).toBe(1234);
  } finally {
    await f.close();
  }
});
it("rejects stale fences, foreign owners, changed models, inactive manifest and revoked job access", async () => {
  const f = await fixture();
  try {
    for (const job of [
      { ...f.job, fence: f.job.fence + 1 },
      { ...f.job, agentId: "b" },
      { ...f.job, model: "synthetic/wrong" },
      { ...f.job, workerId: "other" },
    ])
      await expect(
        buildOwnerRuntimeStatus(f.db, job, f.config),
      ).rejects.toThrow("OWNER_STATUS_JOB_AUTHORITY_EXPIRED");
    await f.db.query(
      "UPDATE provider_manifests SET status='retired' WHERE id=$1",
      [f.config.manifestId],
    );
    await expect(
      buildOwnerRuntimeStatus(f.db, f.job, f.config),
    ).rejects.toThrow("OWNER_STATUS_JOB_AUTHORITY_EXPIRED");
    await f.db.query(
      "UPDATE provider_manifests SET status='active' WHERE id=$1",
      [f.config.manifestId],
    );
    await f.db.query(
      "UPDATE runtime_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.job.id],
    );
    await expect(
      buildOwnerRuntimeStatus(f.db, f.job, f.config),
    ).rejects.toThrow("OWNER_STATUS_JOB_AUTHORITY_EXPIRED");
  } finally {
    await f.close();
  }
});
it("preserves uncertain liability and discloses only safe host identifiers; tool has object root and rejects actor inputs", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "UPDATE runtime_reservations SET status='uncertain' WHERE job_id=$1",
      [f.job.id],
    );
    await f.db.query(
      "INSERT INTO league_host_bindings(league_id,host,version,config,changed_by,reason) VALUES('status-test','mfl',1,$1,'operator','SYNTHETIC')",
      [{ season: 2026, leagueId: "46625", configRef: "PRIVATE_REFERENCE" }],
    );
    const tools = createOwnerRuntimeStatusTools(f.db, {
      ...f.config,
      patchReceiptId: randomUUID(),
      reasoningEffort: "high",
    });
    expect(tools[0]!.parameters.type).toBe("object");
    await expect(tools[0]!.execute(f.job, { agentId: "b" })).rejects.toThrow();
    const r = (await tools[0]!.execute(f.job, {})) as any;
    expect(r.wallet.breakdown.modelJobs).toMatchObject({
      heldMicros: 25000,
      settledMicros: 0,
    });
    expect(r.runtime.patch.status).toBe("unknown");
    expect(r.runtime.reasoningPolicy.matchesRunningConfiguration).toBe(false);
    expect(r.football).toMatchObject({
      host: "mfl",
      identity: { season: 2026, mflLeagueId: "46625" },
      writesEnabled: false,
    });
    expect(JSON.stringify(r)).not.toContain("PRIVATE_REFERENCE");
  } finally {
    await f.close();
  }
});

it("retains only the owner's reviewed research receipt references after onboarding closes", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "INSERT INTO runtime_owner_stages(league_id,id,stage,configuration,charter,assignment,content_hash,configured_by,receipt_id,status) VALUES('status-test','closed-stage','onboarding','{}','synthetic','synthetic','synthetic','operator',$1,'reviewed')",
      [randomUUID()],
    );
    for (const agent of ["a", "b"]) {
      await f.db.query(
        "INSERT INTO runtime_owner_stage_reviews(league_id,stage_id,agent_id,evidence_hash,evidence,note,reviewed_by,receipt_id) VALUES('status-test','closed-stage',$1,'synthetic',$2,'synthetic','operator',$3)",
        [
          agent,
          {
            researchBaseline: {
              status: "verified",
              search: {
                receiptId: agent + "-search",
                completedAt: "2026-09-08T07:00:00Z",
                source: "firecrawl",
                details: { private: "NEVER_EXPOSE_RESEARCH_BODY" },
              },
              page: {
                id: agent + "-page",
                completed_at: "2026-09-08T07:01:00Z",
                url: "https://example.com/" + agent,
                details: { private: "NEVER_EXPOSE_PAGE_BODY" },
              },
            },
          },
          randomUUID(),
        ],
      );
    }
    const r = await buildOwnerRuntimeStatus(f.db, f.job, f.config);
    expect(r.runtime.stage?.status).toBe("reviewed");
    expect(r.runtime.reviewedResearchBaseline).toMatchObject({
      status: "verified",
      search: { receiptId: "a-search", provider: "firecrawl" },
      page: { receiptId: "a-page", url: "https://example.com/a" },
    });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("b-search");
    expect(serialized).not.toContain("b-page");
    expect(serialized).not.toContain("NEVER_EXPOSE");
    expect(r.runtime.reviewedResearchBaseline?.note).toContain(
      "not a new retrieval",
    );
  } finally {
    await f.close();
  }
});
