import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db.js";
import { ManifestSchema } from "../src/providers/manifests.js";
import { leagueCapabilityVersion } from "../src/league/capabilities.js";
import { fingerprint, quorum, stable } from "../src/governance/validation.js";

type Status = "pass" | "fail" | "missing" | "unknown";
type Gate = {
  id: string;
  status: Status;
  requiredForDraft: boolean;
  reason: string;
  evidence?: Record<string, unknown>;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const definitions: [string, boolean][] = [
  ["database", true],
  ["schema", true],
  ["league", true],
  ["field", true],
  ["human_owners", true],
  ["runtime_bindings", true],
  ["active_models", true],
  ["provider_guardrails", true],
  ["provider_canaries", true],
  ["billing", true],
  ["governance", true],
  ["player_pool", true],
  ["player_pool_source", true],
  ["owner_queues", true],
  ["buzz_binding", true],
  ["buzz_participants", true],
  ["buzz_ingress", true],
  ["buzz_peer_canary", true],
  ["owner_runtime", true],
  ["service_liveness", true],
  ["live_scoring", false],
  ["offdevice_recovery", false],
  ["public_release", false],
];
const gates = new Map<string, Gate>(
  definitions.map(([id, requiredForDraft]) => [
    id,
    { id, requiredForDraft, status: "unknown", reason: "Not evaluated" },
  ]),
);
function gate(
  id: string,
  status: Status,
  reason: string,
  evidence?: Record<string, unknown>,
) {
  gates.set(id, {
    id,
    status,
    requiredForDraft: gates.get(id)?.requiredForDraft ?? true,
    reason,
    ...(evidence ? { evidence } : {}),
  });
}
const leagueId = process.env.FOOTBALL_LEAGUE_ID;
const maxAge = Number(
  process.env.FOOTBALL_READINESS_MAX_EVIDENCE_AGE_SECONDS ?? 86400,
);
const checkedAt = new Date();
const fresh = (value: unknown) => {
  const age = checkedAt.getTime() - new Date(String(value)).getTime();
  return Number.isFinite(age) && age >= -60000 && age <= maxAge * 1000;
};
const files: Record<string, unknown>[] = [];
// Known evidence files are contextual only. Presence, filenames and synthetic success never turn live gates green.
for (const name of [
  "deployment-validation.json",
  "container-rehearsal.json",
  "backup-restore.json",
  "buzz-dm-canary-mock.json",
  "buzz-league-connectivity.json",
  "runtime-soak-scoped-final.json",
]) {
  try {
    const raw = await readFile(path.join(root, "evidence", name));
    const value = JSON.parse(raw.toString());
    files.push({
      file: "evidence/" + name,
      sha256: createHash("sha256").update(raw).digest("hex"),
      classification:
        value.synthetic === true ||
        /synthetic/i.test(String(value.scope)) ||
        /mock|soak/.test(name)
          ? "synthetic_or_local_test"
          : "historical_observation",
      provesCurrentLeagueReady: false,
    });
  } catch {
    files.push({
      file: "evidence/" + name,
      classification: "missing_or_invalid",
      provesCurrentLeagueReady: false,
    });
  }
}
let db: ReturnType<typeof createDb> | undefined;
try {
  if (!leagueId || !Number.isInteger(maxAge) || maxAge < 60 || maxAge > 604800)
    throw Error("CONFIG_REQUIRED");
  const secretFile = process.env.DATABASE_URL_FILE;
  const url =
    process.env.DATABASE_URL ??
    (secretFile ? (await readFile(secretFile, "utf8")).trim() : undefined);
  if (!url) throw Error("DATABASE_CONFIG_REQUIRED");
  db = createDb(url);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout='5s'");
    gate(
      "database",
      "pass",
      "Explicit database reachable; consistent read-only snapshot",
    );
    const expected = (await readdir(path.join(root, "migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    const actual = new Set(
      (await tx.query("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const missing = expected.filter((n) => !actual.has(n));
    gate(
      "schema",
      missing.length ? "missing" : "pass",
      missing.length
        ? "Database migrations lag the current checkout; no migration was applied"
        : "All current migration names are recorded",
      { expected: expected.length, applied: actual.size, missing },
    );
    if (missing.length) throw Error("SCHEMA_INCOMPLETE");
    const league = (
      await tx.query("SELECT * FROM leagues WHERE id=$1", [leagueId])
    ).rows[0];
    if (!league) {
      gate("league", "missing", "Requested league does not exist");
      throw Error("LEAGUE_MISSING");
    }
    gate(
      "league",
      league.status === "setup" && !league.draft_paused_at ? "pass" : "fail",
      league.status === "setup"
        ? "League is in setup"
        : "Draft is already started, paused or completed; this report does not authorize a new start",
      { status: league.status },
    );
    const teams = (
      await tx.query(
        "SELECT id,name,owner_id,kind FROM league_teams WHERE league_id=$1 ORDER BY draft_position",
        [leagueId],
      )
    ).rows;
    const ai = teams.filter((t) => t.kind === "ai"),
      humans = teams.filter((t) => t.kind === "human");
    gate(
      "field",
      teams.length === 12 && ai.length === 10 && humans.length === 2
        ? "pass"
        : "missing",
      "Required field: ten AI franchises and two human franchises",
      { total: teams.length, ai: ai.length, humans: humans.length },
    );
    const credentials = (
      await tx.query(
        "SELECT actor_id,team_id FROM api_credentials WHERE league_id=$1 AND role='owner' AND revoked_at IS NULL",
        [leagueId],
      )
    ).rows;
    const missingHumans = humans
      .filter(
        (t) =>
          /unassigned|placeholder|unknown|pending/i.test(t.name) ||
          !credentials.some(
            (c) => c.actor_id === t.owner_id && c.team_id === t.id,
          ),
      )
      .map((t) => t.id);
    gate(
      "human_owners",
      humans.length === 2 && !missingHumans.length ? "pass" : "missing",
      "Two named human owners require their own unrevoked credentials; draft availability remains an operator confirmation",
      { missingTeamIds: missingHumans },
    );
    const bound = (
      await tx.query(
        "SELECT b.team_id,a.id,a.model,a.kind,a.enabled,a.budget_micros,a.spent_micros,a.reserved_micros FROM runtime_bindings b JOIN runtime_agents a ON a.id=b.agent_id WHERE b.league_id=$1",
        [leagueId],
      )
    ).rows;
    const badBindings = teams
      .filter(
        (t) => !bound.some((a) => a.team_id === t.id && a.kind === t.kind),
      )
      .map((t) => t.id);
    gate(
      "runtime_bindings",
      teams.length === 12 && !badBindings.length ? "pass" : "missing",
      "Each franchise needs its own persisted runtime identity and matching AI/human kind",
      { bound: bound.length, missingTeamIds: badBindings },
    );
    const models = (
      await tx.query(
        "SELECT id,agent_id,status,document FROM provider_manifests WHERE league_id=$1 AND status='active'",
        [leagueId],
      )
    ).rows;
    const modelByAgent = new Map<string, (typeof models)[number]>();
    const invalidModels: string[] = [];
    for (const m of models) {
      const parsed = ManifestSchema.safeParse(m.document),
        owner = bound.find((a) => a.id === m.agent_id);
      if (
        !parsed.success ||
        !owner ||
        owner.kind !== "ai" ||
        !owner.enabled ||
        parsed.data.agentId !== owner.id ||
        parsed.data.leagueId !== leagueId ||
        parsed.data.model !== owner.model ||
        /synthetic|test|unactivated/i.test(parsed.data.model)
      )
        invalidModels.push(m.agent_id);
      else modelByAgent.set(m.agent_id, m);
    }
    const aiBound = bound.filter((a) => a.kind === "ai");
    const modelMissing = aiBound
      .filter((a) => !modelByAgent.has(a.id))
      .map((a) => a.id);
    const developers = new Set(
      [...modelByAgent.values()].map((m) => m.document.developer),
    );
    gate(
      "active_models",
      modelByAgent.size === 10 &&
        developers.size === 10 &&
        !modelMissing.length &&
        !invalidModels.length
        ? "pass"
        : "missing",
      "Ten distinct developers need active exact model/provider manifests matching enabled franchise identities",
      {
        validActive: modelByAgent.size,
        uniqueDevelopers: developers.size,
        missingAgentIds: modelMissing,
        invalidAgentIds: invalidModels,
      },
    );
    const guardrailMissing: string[] = [],
      canaryMissing: string[] = [];
    for (const owner of aiBound) {
      const m = modelByAgent.get(owner.id);
      if (!m) {
        guardrailMissing.push(owner.id);
        canaryMissing.push(owner.id);
        continue;
      }
      const checks = (
        await tx.query(
          "SELECT DISTINCT ON(check_kind) check_kind,passed,synthetic,created_at FROM provider_guardrail_checks WHERE manifest_id=$1 ORDER BY check_kind,created_at DESC",
          [m.id],
        )
      ).rows;
      if (
        checks.length !== 4 ||
        checks.some((c) => !c.passed || c.synthetic || !fresh(c.created_at))
      )
        guardrailMissing.push(owner.id);
      const calls = (
        await tx.query(
          "SELECT generation_id,reported_model,reported_provider,cost_micros,completed_at FROM provider_calls WHERE manifest_id=$1 AND purpose='canary' AND status='verified' AND reconciliation_status='verified' ORDER BY completed_at DESC",
          [m.id],
        )
      ).rows;
      if (
        !calls.some(
          (c) =>
            c.generation_id &&
            c.reported_model === m.document.model &&
            m.document.reportedProviderNames.includes(c.reported_provider) &&
            c.cost_micros !== null &&
            fresh(c.completed_at),
        )
      )
        canaryMissing.push(owner.id);
    }
    gate(
      "provider_guardrails",
      aiBound.length === 10 && !guardrailMissing.length ? "pass" : "missing",
      "Latest assignment, wrong-model, wrong-provider and key-limit checks must all pass with nonsynthetic recent evidence",
      { missingAgentIds: guardrailMissing, maxAgeSeconds: maxAge },
    );
    gate(
      "provider_canaries",
      aiBound.length === 10 && !canaryMissing.length ? "pass" : "missing",
      "Each active manifest needs a recent reconciled exact-model/provider generation canary",
      { missingAgentIds: canaryMissing, maxAgeSeconds: maxAge },
    );
    const uncertain = Number(
      (
        await tx.query(
          "SELECT count(*) FROM runtime_reservations r JOIN runtime_bindings b ON b.agent_id=r.agent_id WHERE b.league_id=$1 AND r.status='uncertain'",
          [leagueId],
        )
      ).rows[0].count,
    );
    const callsUnresolved = Number(
      (
        await tx.query(
          "SELECT count(*) FROM provider_calls c JOIN provider_manifests m ON m.id=c.manifest_id WHERE m.league_id=$1 AND c.reconciliation_status<>'verified'",
          [leagueId],
        )
      ).rows[0].count,
    );
    const expenses = Number(
      (
        await tx.query(
          "SELECT count(*) FROM franchise_expenses WHERE league_id=$1 AND status='uncertain'",
          [leagueId],
        )
      ).rows[0].count,
    );
    const discrepancies = Number(
      (
        await tx.query(
          "SELECT count(*) FROM runtime_receipts r JOIN runtime_bindings b ON b.agent_id=r.agent_id WHERE b.league_id=$1 AND r.type='billing.discrepancy'",
          [leagueId],
        )
      ).rows[0].count,
    );
    const walletsBad = aiBound
      .filter(
        (a) =>
          Number(a.spent_micros) + Number(a.reserved_micros) >=
          Number(a.budget_micros),
      )
      .map((a) => a.id);
    gate(
      "billing",
      uncertain + callsUnresolved + expenses + discrepancies === 0 &&
        !walletsBad.length
        ? "pass"
        : "fail",
      "No unresolved inference/service costs or discrepancy alerts; wallets retain headroom. Zero activity is not proof of funded upstream credit",
      {
        uncertainReservations: uncertain,
        unresolvedProviderCalls: callsUnresolved,
        uncertainExpenses: expenses,
        discrepancyAlerts: discrepancies,
        noHeadroomAgentIds: walletsBad,
      },
    );
    try {
      if (
        !league.constitution_version ||
        !league.constitution_receipt ||
        !league.constitution_ratified_at ||
        !league.ratified_scoring_rules
      )
        throw Error("MISSING");
      const decision = (
        await tx.query(
          "SELECT * FROM governance_decisions WHERE league_id=$1 AND id=$2",
          [leagueId, league.constitution_receipt],
        )
      ).rows[0];
      if (!decision?.consumed_at || !decision.ratification_receipt_id)
        throw Error("MISSING");
      const approved = await quorum(
        tx,
        leagueId,
        decision.proposal_id,
        checkedAt,
      );
      const hash = fingerprint({
        rules: approved.rules,
        scoringRules: approved.scoringRules,
        capabilityVersion: approved.proposal.capability_version,
        teamOrder: approved.proposal.team_order,
      });
      if (
        hash !== league.constitution_rules_hash ||
        league.ratified_capability_version !== leagueCapabilityVersion ||
        stable(league.rules) !== stable(approved.rules) ||
        stable(league.ratified_scoring_rules) !== stable(approved.scoringRules)
      )
        throw Error("MISMATCH");
      gate(
        "governance",
        "pass",
        "Ratification matches the immutable proposal, authenticated owner quorum, current capabilities, scoring and rules hash",
        { version: league.constitution_version, yesVotes: approved.yes },
      );
    } catch {
      gate(
        "governance",
        "missing",
        "Owner quorum and hash-linked commissioner ratification are missing or unverifiable",
      );
    }
    const players = (
      await tx.query(
        "SELECT id,positions FROM league_players WHERE league_id=$1",
        [leagueId],
      )
    ).rows;
    const needed = 12 * Number(league.rules.rosterSize),
      playersValid =
        players.length >= needed &&
        players.every(
          (p) => p.positions.length > 0 && !/^SYNTHETIC/i.test(p.id),
        );
    gate(
      "player_pool",
      playersValid ? "pass" : "missing",
      "Structural pool must cover all roster spots and contain explicit positions; this alone does not verify the source",
      {
        players: players.length,
        required: Number.isFinite(needed) ? needed : null,
      },
    );
    gate(
      "player_pool_source",
      players.length ? "unknown" : "missing",
      "Current import table lacks authenticated source/identity verification receipts. A count or structural mapper report cannot establish a verified NFL player pool",
    );
    const queues = (
      await tx.query(
        "SELECT team_id,player_ids FROM league_draft_queues WHERE league_id=$1",
        [leagueId],
      )
    ).rows;
    const events = (
      await tx.query(
        "SELECT actor_id,participant_team_ids FROM league_events WHERE league_id=$1 AND type='setDraftQueue'",
        [leagueId],
      )
    ).rows;
    const modelQueueActions = (
      await tx.query(
        "SELECT f.team_id,f.command->'playerIds' AS player_ids FROM runtime_football_outbox f WHERE f.league_id=$1 AND f.status='delivered' AND f.command->>'type'='setDraftQueue' AND EXISTS (SELECT 1 FROM runtime_receipts r WHERE r.job_id=f.job_id AND r.type='job.completed' AND r.details->>'synthetic'='false')",
        [leagueId],
      )
    ).rows;
    const missingQueues = teams
      .filter((t) => {
        const q = queues.find((q) => q.team_id === t.id);
        return (
          !q?.player_ids.length ||
          new Set(q.player_ids).size !== q.player_ids.length ||
          !q.player_ids.every((id: string) =>
            players.some((p) => p.id === id),
          ) ||
          (t.kind === "ai" &&
            !modelQueueActions.some(
              (a) =>
                a.team_id === t.id &&
                stable(a.player_ids) === stable(q.player_ids),
            )) ||
          !events.some(
            (e) =>
              e.actor_id === t.owner_id &&
              e.participant_team_ids.includes(t.id),
          )
        );
      })
      .map((t) => t.id);
    gate(
      "owner_queues",
      teams.length === 12 && !missingQueues.length ? "pass" : "missing",
      "Each team needs a valid saved queue and owner command receipt; AI queues also require a matching nonsynthetic owner-turn outbox action. Queue length cannot guarantee it will not exhaust",
      { saved: queues.length, missingTeamIds: missingQueues },
    );
    const buzz = (
      await tx.query(
        "SELECT mode,archive_consent_receipt_id,binding_receipt_id FROM buzz_league_bindings WHERE league_id=$1",
        [leagueId],
      )
    ).rows[0];
    gate(
      "buzz_binding",
      buzz?.mode === "real" &&
        buzz.archive_consent_receipt_id &&
        buzz.binding_receipt_id
        ? "pass"
        : "missing",
      "Dedicated real Buzz community binding and archive consent receipts required",
    );
    const participants = (
      await tx.query(
        "SELECT p.team_id,p.owner_id,p.agent_id,p.kind FROM buzz_participants p WHERE league_id=$1",
        [leagueId],
      )
    ).rows;
    const missingParticipants = teams
      .filter(
        (t) =>
          !participants.some(
            (p) =>
              p.team_id === t.id &&
              p.owner_id === t.owner_id &&
              p.kind === (t.kind === "ai" ? "agent" : "human") &&
              (t.kind === "human" ||
                bound.some((a) => a.team_id === t.id && a.id === p.agent_id)),
          ),
      )
      .map((t) => t.id);
    gate(
      "buzz_participants",
      teams.length === 12 && !missingParticipants.length ? "pass" : "missing",
      "All owners require matching scoped Buzz identities",
      {
        participants: participants.length,
        missingTeamIds: missingParticipants,
      },
    );
    const delivered = new Set(
      (
        await tx.query(
          "SELECT DISTINCT agent_id FROM buzz_acp_deliveries WHERE league_id=$1 AND NOT synthetic UNION SELECT DISTINCT d.agent_id FROM buzz_inbound_deliveries d JOIN buzz_archive_events e ON e.league_id=d.league_id AND e.event_id=d.event_id WHERE d.league_id=$1 AND e.mode='real'",
          [leagueId],
        )
      ).rows.map((r) => r.agent_id),
    );
    const missingIngress = aiBound
      .filter((a) => !delivered.has(a.id))
      .map((a) => a.id);
    gate(
      "buzz_ingress",
      aiBound.length === 10 && !missingIngress.length ? "pass" : "missing",
      "Every AI identity needs an observed real ACP/relay event delivered to its durable inbox; registration alone is insufficient",
      { missingAgentIds: missingIngress },
    );
    const peer = Number(
      (
        await tx.query(
          "SELECT count(*) FROM buzz_runtime_outbound a JOIN buzz_runtime_outbound b ON b.league_id=a.league_id AND b.sender_agent_id=a.recipient_agent_id AND b.recipient_agent_id=a.sender_agent_id AND b.channel_id=a.channel_id JOIN buzz_conversations dm ON dm.league_id=a.league_id AND dm.channel_id=a.channel_id AND dm.kind='dm' JOIN runtime_messages reply ON reply.id=b.runtime_message_id AND reply.reply_to=a.runtime_message_id JOIN buzz_archive_events e1 ON e1.league_id=a.league_id AND e1.event_id=a.event_id AND e1.mode='real' JOIN buzz_archive_events e2 ON e2.league_id=b.league_id AND e2.event_id=b.event_id AND e2.mode='real' WHERE a.league_id=$1 AND a.status='accepted' AND b.status='accepted'",
          [leagueId],
        )
      ).rows[0].count,
    );
    gate(
      "buzz_peer_canary",
      peer ? "pass" : "missing",
      "Requires an accepted real peer DM and linked reciprocal reply, both independently archived; mock DMs and community reachability do not count",
      { observedReplyPairs: peer },
    );
    const ownersRun = new Set(
      (
        await tx.query(
          "SELECT DISTINCT r.agent_id FROM runtime_receipts r JOIN runtime_jobs j ON j.id=r.job_id JOIN runtime_bindings b ON b.agent_id=r.agent_id WHERE b.league_id=$1 AND r.type='job.completed' AND r.details->>'synthetic'='false' AND j.execution_mode='owner' AND r.created_at>=clock_timestamp()-$2*interval '1 second'",
          [leagueId, maxAge],
        )
      ).rows.map((r) => r.agent_id),
    );
    const missingRuns = aiBound
      .filter((a) => !ownersRun.has(a.id))
      .map((a) => a.id);
    gate(
      "owner_runtime",
      aiBound.length === 10 && !missingRuns.length ? "pass" : "missing",
      "Every AI needs a recent completed nonsynthetic owner turn; provider identity canaries alone do not prove the owner loop",
      { missingAgentIds: missingRuns },
    );
    gate(
      "service_liveness",
      "unknown",
      "No durable worker/clock/bridge heartbeat registry exists. Historical process tests and recent turns cannot prove current service supervision or alert delivery",
    );
    const live = Number(
      (
        await tx.query(
          "SELECT count(DISTINCT s.id) FROM data_stat_snapshots s JOIN scoring_configs c ON c.feed_id=s.feed_id WHERE c.league_id=$1 AND NOT s.synthetic AND s.source_at IS NOT NULL",
          [leagueId],
        )
      ).rows[0].count,
    );
    gate(
      "live_scoring",
      "unknown",
      "Authenticated mapper semantics, correction reconciliation, quota and commercial display rights need separate source-bound evidence; structural/stat row presence alone is insufficient",
      { nonsyntheticSourceDatedSnapshots: live },
    );
    gate(
      "offdevice_recovery",
      "unknown",
      "Local encrypted restore evidence is available separately; no current-league off-device restore/custody receipt is verified here",
    );
    gate(
      "public_release",
      "unknown",
      "This draft report does not verify deployed website, approved exact content batch, X authorization or lead delivery",
    );
    await tx.query("ROLLBACK");
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    if (!(
      error instanceof Error &&
      ["SCHEMA_INCOMPLETE", "LEAGUE_MISSING"].includes(error.message)
    ))
      gate(
        "database",
        "unknown",
        "A read-only query failed; remaining gates were not verified",
      );
  } finally {
    tx.release();
  }
} catch {
  gate(
    "database",
    "unknown",
    "Explicit league/database configuration or connectivity unavailable; no fallback database was selected",
  );
} finally {
  if (db) await db.end();
}
const all = [...gates.values()],
  blockers = all.filter((g) => g.requiredForDraft && g.status !== "pass");
console.log(
  JSON.stringify(
    {
      checkedAt: checkedAt.toISOString(),
      leagueId: leagueId ?? null,
      mode: "read-only",
      readyForDraft: blockers.length === 0,
      missingGates: blockers.map((g) => g.id),
      gates: all,
      filesystemEvidence: files,
      scope:
        "Draft preparation evidence only; no activation, migration, provider request, message or publication was performed",
    },
    null,
    2,
  ),
);
process.exitCode = blockers.length ? 2 : 0;
