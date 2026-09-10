import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { RehearsalRuntime } from "../src/runtime/rehearsal.js";
import { ConversationRuntime } from "../src/runtime/conversation.js";
import { bindHost } from "../src/league/host.js";
import { createBuzzChannelReadTools } from "../src/buzz/read-tools.js";
import {
  BuzzArchiveService,
  BuzzEventSchema,
  nostrEventId,
} from "../src/buzz/archive.js";

it("SYNTHETIC eleven-member human announcement delivers once to all ten AI owners and never loops an unmentioned AI answer", async () => {
  const f = await testDb();
  try {
    const leagueId = "synthetic-human-broadcast-ten",
      channelId = "12345678-1234-4234-9234-123456789abc",
      communityUrl = "wss://broadcast.example.test";
    const actor = {
        id: "commissioner",
        role: "commissioner" as const,
        leagueId,
      },
      archive = new BuzzArchiveService(f.db),
      runtime = new RuntimeStore(f.db);
    const agents = Array.from({ length: 10 }, (_, i) => ({
      pubkey: (i + 1).toString(16).padStart(64, "0"),
      agentId: `broadcast-ai-${i}`,
      teamId: `team-${i}`,
      ownerId: `owner-${i}`,
      kind: "agent" as const,
      ownerPubkey: "e".repeat(64),
    }));
    const human = {
      pubkey: "d".repeat(64),
      teamId: "team-human",
      ownerId: "human-owner",
      kind: "human" as const,
    };
    await f.db.query(
      "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC broadcast','{}')",
      [leagueId],
    );
    for (const [i, m] of [...agents, human].entries()) {
      await f.db.query(
        "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
        [leagueId, m.teamId, m.ownerId, m.kind === "agent" ? "ai" : "human", i],
      );
      if ("agentId" in m) {
        await runtime.createAgent({
          id: m.agentId,
          model: "synthetic/model",
          budgetMicros: 10000,
        });
        await f.db.query(
          "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
          [m.agentId, leagueId, m.teamId],
        );
      }
    }
    await archive.configure(actor, {
      leagueId,
      communityUrl,
      mode: "mock",
      bindingReceiptId: "synthetic",
      archiveConsentReceiptId: "synthetic",
      participants: [...agents, human],
    });
    const memberPubkeys = [...agents, human].map((m) => m.pubkey);
    await archive.registerChannel(actor, {
      leagueId,
      channelId,
      memberPubkeys,
      receiptId: "synthetic-private-membership",
    });
    const policy = await archive.configureHumanBroadcast(actor, {
      leagueId,
      channelId,
      enabled: true,
      expectedVersion: 0,
      idempotencyKey: "enable",
      reason: "SYNTHETIC whole-owner conversation",
    });
    const fields = {
      pubkey: human.pubkey,
      kind: 9,
      content: "SYNTHETIC whole team announcement",
      tags: [["h", channelId]],
      created_at: Number(policy.policy.effective_after_seconds),
    };
    const event = { ...fields, id: nostrEventId(fields) },
      batch = { channelId, memberPubkeys, events: [event], complete: true };
    const a = await archive.ingestBatch(
      { leagueId, communityUrl, pubkey: agents[0]!.pubkey, mode: "mock" },
      batch,
    );
    expect(a.delivered).toBe(10);
    for (const m of agents)
      expect(
        (
          await archive.ingestBatch(
            { leagueId, communityUrl, pubkey: m.pubkey, mode: "mock" },
            batch,
          )
        ).delivered,
      ).toBe(0);
    expect(
      (
        await f.db.query("SELECT agent_id FROM runtime_jobs ORDER BY agent_id")
      ).rows.map((x) => x.agent_id),
    ).toEqual(agents.map((x) => x.agentId).sort());
    const replyFields = {
      ...fields,
      pubkey: agents[0]!.pubkey,
      content: "SYNTHETIC unmentioned agent answer",
    };
    expect(
      (
        await archive.ingestBatch(
          { leagueId, communityUrl, pubkey: agents[0]!.pubkey, mode: "mock" },
          {
            ...batch,
            events: [{ ...replyFields, id: nostrEventId(replyFields) }],
          },
        )
      ).delivered,
    ).toBe(0);
    expect(
      (await f.db.query("SELECT * FROM buzz_inbound_deliveries")).rowCount,
    ).toBe(10);
    // Regression: live conversation owners deliberately remain disabled. Ordinary
    // pending owner jobs survive, but only canonical session deliveries are admitted.
    await f.db.query("UPDATE runtime_agents SET enabled=false");
    await bindHost(f.db, actor, {
      leagueId,
      expectedVersion: 0,
      host: "mfl",
      config: {
        season: 2026,
        leagueId: "62282",
        configRef: "synthetic-production",
      },
      idempotencyKey: "host",
      reason: "Synthetic disabled-owner conversation fixture",
    });
    await new RehearsalRuntime(f.db, runtime).arm(actor, {
      epoch: "synthetic-paused-trial",
      expectedHostVersion: 1,
      trialConfigRef: "synthetic46625",
      capMicros: 10000,
      synthetic: true,
      operatorEvidenceRef: "synthetic",
      reason: "Synthetic paused trial for conversation",
    });
    const session = await new ConversationRuntime(f.db).open(actor, {
      epoch: "synthetic-paused-trial",
      expectedHostVersion: 2,
      channelIds: [channelId],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maxTurnsPerOwner: 2,
      maxSpendMicrosPerOwner: 1000,
      idempotencyKey: "conversation",
      reason: "Synthetic disabled-owner group session",
    });
    expect(
      (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
    ).toBe(0);
    const freshFields = {
      ...fields,
      content: "SYNTHETIC new message to disabled owners",
      created_at: Math.ceil(Date.now() / 1000),
    };
    const fresh = { ...freshFields, id: nostrEventId(freshFields) };
    const freshBatch = { ...batch, events: [fresh] };
    expect(
      (
        await archive.ingestBatch(
          { leagueId, communityUrl, pubkey: agents[0]!.pubkey, mode: "mock" },
          freshBatch,
        )
      ).delivered,
    ).toBe(10);
    expect(
      (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
    ).toBe(0);
    const conversations = (
      await f.db.query(
        "SELECT agent_id,execution_mode FROM runtime_jobs WHERE payload->>'eventId'=$1 ORDER BY agent_id",
        [fresh.id],
      )
    ).rows;
    expect(conversations.map((j) => j.agent_id)).toEqual(
      agents.map((a) => a.agentId).sort(),
    );
    expect(
      conversations.every((j) => j.execution_mode === "conversation"),
    ).toBe(true);
    expect(
      (
        await archive.ingestBatch(
          { leagueId, communityUrl, pubkey: agents[1]!.pubkey, mode: "mock" },
          freshBatch,
        )
      ).delivered,
    ).toBe(0);
    // Reproduce the old archived-without-delivery state with an explicit fixture.
    // Recovery marks the canonical event held, never deletes/reposts or invents text.
    const missedFields = {
      ...freshFields,
      content: "SYNTHETIC already archived disabled-recipient message",
    };
    const missed = { ...missedFields, id: nostrEventId(missedFields) };
    const archived = (
      await f.db.query(
        `INSERT INTO buzz_archive_events(league_id,channel_id,event_id,author_pubkey,kind,content,tags,source_created_at,payload_hash,relation_status,mode,provenance)
      VALUES($1,$2,$3,$4,9,$5,$6,$7,$8,'none','mock','SYNTHETIC prior disabled-recipient bug') RETURNING sequence`,
        [
          leagueId,
          channelId,
          missed.id,
          human.pubkey,
          missed.content,
          JSON.stringify(missed.tags),
          missed.created_at,
          createHash("sha256")
            .update(JSON.stringify(BuzzEventSchema.parse(missed)))
            .digest("hex"),
        ],
      )
    ).rows[0];
    const recoveryBatch = { ...batch, events: [missed] };
    const recoveryListener = {
      leagueId,
      communityUrl,
      pubkey: agents[0]!.pubkey,
      mode: "mock" as const,
    };
    expect(
      (await archive.ingestBatch(recoveryListener, recoveryBatch)).delivered,
    ).toBe(0);
    await f.db.query(
      "INSERT INTO buzz_archive_held_events(league_id,event_id,reason) VALUES($1,$2,'SYNTHETIC operator disabled-recipient repair')",
      [leagueId, missed.id],
    );
    expect(
      (await archive.ingestBatch(recoveryListener, recoveryBatch)).delivered,
    ).toBe(10);
    expect(
      (await archive.ingestBatch(recoveryListener, recoveryBatch)).delivered,
    ).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT sequence FROM buzz_archive_events WHERE event_id=$1",
          [missed.id],
        )
      ).rows[0].sequence,
    ).toBe(archived.sequence);
    expect(
      (
        await f.db.query(
          "SELECT 1 FROM buzz_archive_held_events WHERE event_id=$1",
          [missed.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(await runtime.claim("ordinary-worker", 30000)).toBeNull();
    const job = await runtime.claim(
      "conversation-reader",
      30000,
      undefined,
      [agents[0]!.agentId],
      undefined,
      session.id,
    );
    expect(job).not.toBeNull();
    const tool = createBuzzChannelReadTools(f.db)[0]!;
    const read = (await tool.execute(job!, {
      type: "event",
      channelId,
      eventId: fresh.id,
    })) as any;
    expect(read.event.content).toBe(fresh.content);
    expect(read.event.author_pubkey).toBe(human.pubkey);
    await expect(
      tool.execute({ ...job!, fence: job!.fence + 1 }, { type: "channels" }),
    ).rejects.toThrow("BUZZ_READ_JOB_AUTHORITY_EXPIRED");
    await expect(
      tool.execute(job!, {
        type: "messages",
        channelId: "22345678-1234-4234-9234-123456789abc",
      }),
    ).rejects.toThrow("CONVERSATION_CHANNEL_FORBIDDEN");
    await f.db.query(
      "UPDATE runtime_conversation_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [session.id],
    );
    await expect(tool.execute(job!, { type: "channels" })).rejects.toThrow(
      "CONVERSATION_AUTHORITY_CLOSED",
    );
    const expiredFields = {
      ...freshFields,
      content: "SYNTHETIC expired session cannot wake disabled owners",
    };
    expect(
      (
        await archive.ingestBatch(
          { leagueId, communityUrl, pubkey: agents[0]!.pubkey, mode: "mock" },
          {
            ...batch,
            events: [{ ...expiredFields, id: nostrEventId(expiredFields) }],
          },
        )
      ).delivered,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
