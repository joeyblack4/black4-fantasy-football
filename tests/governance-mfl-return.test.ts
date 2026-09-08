import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { bindHost, hostBinding } from "../src/league/host.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { GovernanceService } from "../src/governance/index.js";
import {
  prepareMflReturnAnchor,
  revalidateMflReturn,
} from "../src/governance/mfl.js";
import { fingerprint } from "../src/governance/validation.js";

// Every row below is an isolated synthetic fixture, including production/trial IDs used only
// to exercise exact scope checks. No MFL adapter, model, live DB, credentials or network calls.
async function fixture() {
  const f = await testDb(),
    leagueId = "synthetic-return",
    c: Actor = { id: "operator", role: "commissioner", leagueId };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: "owner" + i,
    teamId: "team" + i,
    role: "owner",
    leagueId,
  }));
  const league = new LeagueService(f.db),
    runtime = new RuntimeStore(f.db),
    g = new GovernanceService(f.db);
  await league.execute(c, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC return fixture",
    rules: {
      rosterSize: 2,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      freeAgentMode: "waiversOnly",
      lineupSlots: [{ id: "FLEX", positions: ["RB", "WR", "TE"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId!,
      ownerId: o.id,
      name: "SYNTHETIC " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  for (let i = 0; i < 12; i++) {
    await runtime.createAgent({
      id: "agent" + i,
      model: "synthetic/model" + i,
      budgetMicros: 100000,
      kind: i < 10 ? "ai" : "human",
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
    if (i < 10)
      await f.db.query(
        "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status) VALUES($1,$2,$3,1,$4,'SYNTHETIC','active')",
        [randomUUID(), leagueId, "agent" + i, { model: "synthetic/model" + i }],
      );
  }
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await bindHost(f.db, c, {
    leagueId,
    expectedVersion: 0,
    host: "mfl",
    config: {
      season: 2026,
      leagueId: "62282",
      configRef: "synthetic-original",
    },
    idempotencyKey: "original",
    reason: "SYNTHETIC original only",
  });
  const exec = (actor: Actor, input: any, key: string = randomUUID()) =>
    g.execute(actor, { leagueId, idempotencyKey: key, ...input });
  await exec(c, {
    type: "registerMflMenu",
    menuId: "menu",
    title: "SYNTHETIC menu",
    questions: [
      {
        id: "scoring",
        label: "SYNTHETIC",
        options: [
          {
            id: "ppr",
            label: "PPR",
            content: "SYNTHETIC option, no live rules evidence",
            evidenceRefs: ["synthetic-only"],
          },
        ],
      },
    ],
    applicationSections: [{ id: "scoring", label: "SYNTHETIC scoring" }],
    sourceNote: "SYNTHETIC isolated fixtures only",
  });
  await exec(c, {
    type: "openMeeting",
    meetingId: "meeting",
    menuId: "menu",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  await exec(owners[0]!, {
    type: "submitMflProposal",
    meetingId: "meeting",
    proposalId: "candidate",
    version: "v1",
    title: "SYNTHETIC chosen proposal",
    rationale: "SYNTHETIC no real owner choice",
    menuId: "menu",
    selections: { scoring: "ppr" },
    teamOrder: owners.map((o) => o.teamId),
    leaguePolicies: "SYNTHETIC policy",
  });
  await f.db.query(
    "UPDATE mfl_governance_meetings SET proposal_deadline=clock_timestamp()-interval '1 second'",
  );
  for (const o of owners.slice(0, 8))
    await exec(o, { type: "castVote", proposalId: "candidate", choice: "yes" });
  await f.db.query(
    "UPDATE mfl_governance_meetings SET vote_deadline=clock_timestamp()-interval '1 millisecond'",
  );
  const decision = (
    await exec(c, { type: "prepareRatification", proposalId: "candidate" })
  ).result as any;
  const menu = (await f.db.query("SELECT * FROM mfl_governance_menus")).rows[0];
  const mapping = {
    host: "www43.myfantasyleague.com" as const,
    season: 2026 as const,
    mflLeagueId: "62282" as const,
    configRef: "synthetic-original",
    franchises: owners.map((o, i) => ({
      teamId: o.teamId!,
      ownerId: o.id,
      franchiseId: String(i + 1).padStart(4, "0"),
    })),
  };
  const anchorInput = {
    leagueId,
    idempotencyKey: "anchor",
    expectedHostVersion: 1,
    decisionId: decision.decisionId,
    proposalId: "candidate",
    proposalHash: decision.proposalHash,
    menuHash: menu.content_hash,
    mapping,
    reason: "SYNTHETIC reviewed candidate and mapping",
    evidenceRef: "synthetic:verified-fixture-map",
  };
  const anchor = () => prepareMflReturnAnchor(f.db, c, anchorInput);
  const epoch = "synthetic-epoch";
  async function restore() {
    const original = await hostBinding(f.db, leagueId);
    await f.db.query(
      "INSERT INTO runtime_rehearsals(league_id,epoch,status,request_hash,original_host,cap_micros,synthetic,operator_evidence_ref,reason,configured_by,start_receipt_seq) VALUES($1,$2,'arming','synthetic',$3,100,false,'synthetic','SYNTHETIC fake epoch for contract tests','operator',0)",
      [leagueId, epoch, original],
    );
    await f.db.query(
      `INSERT INTO runtime_rehearsal_owners(league_id,epoch,agent_id,team_id,owner_id,model,manifest_id,binding_hash) SELECT b.league_id,$2,a.id,t.id,t.owner_id,a.model,m.id,'SYNTHETIC' FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN provider_manifests m ON m.agent_id=a.id WHERE b.league_id=$1 AND t.kind='ai'`,
      [leagueId, epoch],
    );
    const trial = await bindHost(f.db, c, {
      leagueId,
      expectedVersion: 1,
      host: "mfl",
      config: { season: 2026, leagueId: "46625", configRef: "synthetic-trial" },
      idempotencyKey: `rehearsal:${epoch}:arm`,
      reason: "SYNTHETIC arm fixture",
    });
    await f.db.query(
      "UPDATE runtime_rehearsals SET trial_host=$3,status='stopped' WHERE league_id=$1 AND epoch=$2",
      [leagueId, epoch, trial.binding],
    );
    await f.db.query(
      "INSERT INTO runtime_receipts(type,details) VALUES('rehearsal.armed',$1),('rehearsal.stopped',$2)",
      [
        {
          leagueId,
          epoch,
          host: trial.binding,
          hostReceiptId: trial.receiptId,
        },
        { leagueId, epoch, reason: "SYNTHETIC stop fixture" },
      ],
    );
    const restored = await bindHost(f.db, c, {
      leagueId,
      expectedVersion: 2,
      host: "mfl",
      config: (original as any).config,
      idempotencyKey: `rehearsal:${epoch}:restore`,
      reason: "SYNTHETIC restore fixture",
    });
    await f.db.query(
      "INSERT INTO runtime_receipts(type,details) VALUES('rehearsal.restored',$1)",
      [
        {
          leagueId,
          epoch,
          host: restored.binding,
          hostReceiptId: restored.receiptId,
        },
      ],
    );
    await f.db.query(
      "UPDATE runtime_rehearsals SET status='restored' WHERE league_id=$1 AND epoch=$2",
      [leagueId, epoch],
    );
    return { trial, restored };
  }
  const revalidate = (anchorReceiptId: string, changes: any = {}) =>
    revalidateMflReturn(f.db, c, {
      leagueId,
      idempotencyKey: "revalidate",
      expectedHostVersion: 3,
      anchorReceiptId,
      rehearsalEpoch: epoch,
      mapping,
      reason: "SYNTHETIC unchanged production return",
      evidenceRef: "synthetic:restored-readback",
      ...changes,
    });
  return {
    ...f,
    leagueId,
    c,
    owners,
    g,
    exec,
    decision,
    mapping,
    anchorInput,
    anchor,
    restore,
    revalidate,
    epoch,
  };
}

it("revalidates only the canonical return, preserves original decision/votes and still requires explicit approval/application", async () => {
  const f = await fixture();
  try {
    const before = (
      await f.db.query("SELECT * FROM mfl_governance_votes ORDER BY team_id")
    ).rows;
    const a = await f.anchor();
    expect((await f.anchor()).receiptId).toBe(a.receiptId);
    await f.restore();
    const r = await f.revalidate(a.receiptId);
    expect(r.result).toMatchObject({
      type: "mfl-decision-revalidated",
      approved: false,
      configured: false,
      externalWritePerformed: false,
    });
    expect((await f.revalidate(a.receiptId)).receiptId).toBe(r.receiptId);
    expect(
      (await f.db.query("SELECT * FROM mfl_governance_votes ORDER BY team_id"))
        .rows,
    ).toEqual(before);
    expect(
      (await f.db.query("SELECT host_version FROM mfl_governance_decisions"))
        .rows,
    ).toEqual([{ host_version: 1 }]);
    expect(
      (await f.db.query("SELECT * FROM mfl_governance_approvals")).rowCount,
    ).toBe(0);
    await expect(
      f.exec(f.c, {
        type: "approveMflConstitution",
        decisionId: f.decision.decisionId,
        proposalId: "candidate",
        proposalHash: f.decision.proposalHash,
        version: "v1",
      }),
    ).rejects.toMatchObject({ code: "HOST_VERSION_CONFLICT" });
    const approval = (
      await f.exec(f.c, {
        type: "approveMflConstitution",
        decisionId: f.decision.decisionId,
        proposalId: "candidate",
        proposalHash: f.decision.proposalHash,
        version: "v1",
        revalidationReceiptId: r.receiptId,
      })
    ).result as any;
    expect(approval).toMatchObject({
      hostVersion: 3,
      revalidationReceiptId: r.receiptId,
      configured: false,
    });
    expect(
      (await f.db.query("SELECT * FROM mfl_governance_applications")).rowCount,
    ).toBe(0);
    const now = (
      await f.db.query("SELECT clock_timestamp() now")
    ).rows[0].now.toISOString();
    for (const nativeScope of [
      undefined,
      { host: "www43.myfantasyleague.com", season: 2026, leagueId: "46625" },
    ]) {
      await expect(
        f.exec(f.c, {
          type: "recordMflApplication",
          approvalId: approval.approvalId,
          proposalHash: f.decision.proposalHash,
          hostVersion: 3,
          attestation: "matches-approved-constitution",
          evidence: [
            {
              sectionId: "scoring",
              source: "mfl-native-ui",
              nativeScope,
              reference: "synthetic:trial-cannot-count",
              observedHash: "a".repeat(64),
              summary: "SYNTHETIC wrong native scope",
              observedAt: now,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "REVALIDATION_PRODUCTION_READBACK_REQUIRED",
      });
    }
    const applied = await f.exec(f.c, {
      type: "recordMflApplication",
      approvalId: approval.approvalId,
      proposalHash: f.decision.proposalHash,
      hostVersion: 3,
      attestation: "matches-approved-constitution",
      evidence: [
        {
          sectionId: "scoring",
          nativeScope: {
            host: "www43.myfantasyleague.com",
            season: 2026,
            leagueId: "62282",
          },
          source: "mfl-native-ui",
          reference: "synthetic:production-readback",
          observedHash: "a".repeat(64),
          summary: "SYNTHETIC no native calls",
          observedAt: now,
        },
      ],
    });
    expect(applied.result).toMatchObject({
      hostVersion: 3,
      externalWritePerformed: false,
    });
    expect(
      (await f.db.query("SELECT count(*)::int n FROM mfl_governance_decisions"))
        .rows[0].n,
    ).toBe(1);
    expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
  } finally {
    await f.close();
  }
});
it("rejects owner/system/foreign-league authority and candidate/mapping mismatch before anchor", async () => {
  const f = await fixture();
  try {
    for (const actor of [
      f.owners[0]!,
      { ...f.c, role: "system" as const },
      { ...f.c, leagueId: "foreign" },
    ])
      await expect(
        prepareMflReturnAnchor(f.db, actor, f.anchorInput),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      prepareMflReturnAnchor(f.db, f.c, {
        ...f.anchorInput,
        proposalHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "REVALIDATION_CANDIDATE_MISMATCH" });
    const map = {
      ...f.mapping,
      franchises: f.mapping.franchises.map((m, i) => ({
        ...m,
        ownerId: i === 0 ? "wrong" : m.ownerId,
      })),
    };
    await expect(
      prepareMflReturnAnchor(f.db, f.c, { ...f.anchorInput, mapping: map }),
    ).rejects.toMatchObject({ code: "REVALIDATION_MAPPING_MISMATCH" });
    await f.db.query(
      "UPDATE runtime_agents SET enabled=true WHERE id='agent0'",
    );
    await expect(f.anchor()).rejects.toMatchObject({
      code: "REVALIDATION_REQUIRES_QUIESCENCE",
    });
  } finally {
    await f.close();
  }
});
it.each([
  [
    "proposal",
    "UPDATE mfl_governance_proposals SET content=jsonb_set(content,'{leaguePolicies}','\"changed\"')",
    "PROPOSAL_CHANGED",
  ],
  [
    "menu",
    "UPDATE mfl_governance_menus SET content=jsonb_set(content,'{sourceNote}','\"changed\"')",
    "MENU_CHANGED",
  ],
  [
    "vote timestamp",
    "UPDATE mfl_governance_votes SET created_at=created_at+interval '1 second' WHERE team_id='team0'",
    "REVALIDATION_EVIDENCE_CHANGED",
  ],
  [
    "voter ownership",
    "UPDATE league_teams SET owner_id='replacement' WHERE id='team0'",
    "QUORUM_NOT_MET",
  ],
  [
    "native lineage",
    "UPDATE league_host_receipts SET idempotency_key='unrelated-switch' WHERE binding->>'version'='2'",
    "REVALIDATION_HOST_RECEIPTS_REQUIRED",
  ],
  [
    "runtime receipt",
    "UPDATE runtime_receipts SET details=details||'{\"hostReceiptId\":\"wrong\"}'::jsonb WHERE type='rehearsal.restored'",
    "REVALIDATION_EPOCH_RECEIPTS_REQUIRED",
  ],
  [
    "trial unfinished",
    "UPDATE runtime_rehearsals SET status='stopped'",
    "REVALIDATION_REQUIRES_QUIESCENCE",
  ],
  [
    "changed runtime model",
    "UPDATE runtime_agents SET model='synthetic/replaced' WHERE id='agent0'",
    "REVALIDATION_EVIDENCE_CHANGED",
  ],
  [
    "missing trial owner",
    "DELETE FROM runtime_rehearsal_owners WHERE agent_id='agent0'",
    "REVALIDATION_EPOCH_OWNERS_CHANGED",
  ],
  [
    "host receipt hash",
    "UPDATE league_host_receipts SET payload_hash='tampered' WHERE binding->>'version'='2'",
    "REVALIDATION_HOST_RECEIPT_HASH_CHANGED",
  ],
  [
    "wrong restored configuration",
    "UPDATE league_host_bindings SET config=jsonb_set(config,'{configRef}','\"wrong\"')",
    "REVALIDATION_PRODUCTION_SCOPE",
  ],
  [
    "missing actual vote receipt",
    "DELETE FROM governance_receipts WHERE response#>>'{result,teamId}'='team0'",
    "REVALIDATION_VOTE_RECEIPT_REQUIRED",
  ],
] as const)(
  "refuses changed %s without changing history",
  async (_label, sql, code) => {
    const f = await fixture();
    try {
      const a = await f.anchor();
      await f.restore();
      await f.db.query(sql);
      await expect(f.revalidate(a.receiptId)).rejects.toMatchObject({ code });
      expect(
        (await f.db.query("SELECT * FROM mfl_governance_approvals")).rowCount,
      ).toBe(0);
    } finally {
      await f.close();
    }
  },
);
it("rejects changed native franchise mapping, foreign anchor, missing epoch and replay drift", async () => {
  const f = await fixture();
  try {
    const a = await f.anchor();
    await f.restore();
    const mapping = {
      ...f.mapping,
      franchises: f.mapping.franchises.map((m, i) => ({
        ...m,
        franchiseId: i === 0 ? "0099" : m.franchiseId,
      })),
    };
    await expect(f.revalidate(a.receiptId, { mapping })).rejects.toMatchObject({
      code: "REVALIDATION_EVIDENCE_CHANGED",
    });
    await expect(f.revalidate(randomUUID())).rejects.toMatchObject({
      code: "REVALIDATION_RECEIPT_INVALID",
    });
    await expect(
      f.revalidate(a.receiptId, { rehearsalEpoch: "missing" }),
    ).rejects.toMatchObject({
      code: "REVALIDATION_RESTORED_REHEARSAL_REQUIRED",
    });
    const r = await f.revalidate(a.receiptId);
    await expect(
      f.revalidate(a.receiptId, { reason: "SYNTHETIC changed reason" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      f.revalidate(a.receiptId, { idempotencyKey: "new-key" }),
    ).rejects.toMatchObject({ code: "REVALIDATION_ALREADY_RECORDED" });
    await f.db.query(
      "UPDATE mfl_governance_votes SET created_at=created_at+interval '1 second' WHERE team_id='team0'",
    );
    await expect(f.revalidate(a.receiptId)).rejects.toMatchObject({
      code: "REVALIDATION_EVIDENCE_CHANGED",
    });
    await expect(
      f.exec(f.c, {
        type: "approveMflConstitution",
        decisionId: f.decision.decisionId,
        proposalId: "candidate",
        proposalHash: f.decision.proposalHash,
        version: "v1",
        revalidationReceiptId: r.receiptId,
      }),
    ).rejects.toMatchObject({ code: "REVALIDATION_EVIDENCE_CHANGED" });
  } finally {
    await f.close();
  }
});

it("serializes duplicate revalidation and rejects a host switch that wins before revalidation", async () => {
  const f = await fixture();
  try {
    const a = await f.anchor();
    await f.restore();
    const receipts = await Promise.all([
      f.revalidate(a.receiptId),
      f.revalidate(a.receiptId),
    ]);
    expect(receipts[0].receiptId).toBe(receipts[1].receiptId);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM governance_receipts WHERE response#>>'{result,type}'='mfl-decision-revalidated'",
        )
      ).rows[0].n,
    ).toBe(1);
    const blocker = await f.db.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM runtime_agents WHERE id='agent0' FOR UPDATE",
    );
    const pending = f.revalidate(a.receiptId).then(
      () => null,
      (e) => e,
    );
    await bindHost(f.db, f.c, {
      leagueId: f.leagueId,
      expectedVersion: 3,
      host: "mfl",
      config: {
        season: 2026,
        leagueId: "62282",
        configRef: "new-unreviewed-config",
      },
      idempotencyKey: "later-switch",
      reason: "SYNTHETIC unrelated later host change",
    });
    await blocker.query("ROLLBACK");
    blocker.release();
    expect(await pending).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      f.exec(f.c, {
        type: "approveMflConstitution",
        decisionId: f.decision.decisionId,
        proposalId: "candidate",
        proposalHash: f.decision.proposalHash,
        version: "v1",
        revalidationReceiptId: receipts[0].receiptId,
      }),
    ).rejects.toMatchObject({ code: "HOST_VERSION_CONFLICT" });
  } finally {
    await f.close();
  }
});
it("preserves old held football intents and never wakes an owner during return", async () => {
  const f = await fixture();
  try {
    const a = await f.anchor(),
      jobId = randomUUID(),
      outboxId = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,status) VALUES($1,'agent0','synthetic-old','fixture','event','{}',clock_timestamp(),'completed')",
      [jobId],
    );
    await f.db.query(
      "INSERT INTO runtime_football_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,command,host_kind,host_version) VALUES($1,'agent0',$2,'old-native-intent','fixture',0,$3,'team0','owner0','{}','mfl',1)",
      [outboxId, jobId, f.leagueId],
    );
    await f.restore();
    const before = (
      await f.db.query("SELECT * FROM runtime_football_outbox WHERE id=$1", [
        outboxId,
      ])
    ).rows[0];
    expect(before.status).toBe("held");
    await f.revalidate(a.receiptId);
    expect(
      (
        await f.db.query("SELECT * FROM runtime_football_outbox WHERE id=$1", [
          outboxId,
        ])
      ).rows[0],
    ).toEqual(before);
    expect(
      (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it("rejects seven actual owners and a second candidate version rather than manufacturing new votes", async () => {
  const f = await fixture();
  try {
    const a = await f.anchor();
    await f.restore();
    await f.db.query(
      "INSERT INTO mfl_governance_proposals(league_id,id,meeting_id,author_team_id,author_id,version,title,content,content_hash,replaces_proposal_id,revision_no) SELECT league_id,'revision',meeting_id,author_team_id,author_id,'v2',title,content,content_hash,id,2 FROM mfl_governance_proposals WHERE id='candidate'",
    );
    await expect(f.revalidate(a.receiptId)).rejects.toMatchObject({
      code: "PROPOSAL_SUPERSEDED",
    });
    await f.db.query(
      "DELETE FROM mfl_governance_proposals WHERE id='revision'",
    );
    await f.db.query("DELETE FROM mfl_governance_votes WHERE team_id='team0'");
    await expect(f.revalidate(a.receiptId)).rejects.toMatchObject({
      code: "QUORUM_NOT_MET",
    });
    expect(
      (await f.db.query("SELECT count(*)::int n FROM mfl_governance_votes"))
        .rows[0].n,
    ).toBe(7);
  } finally {
    await f.close();
  }
});
