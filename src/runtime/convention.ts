import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { getFootballHost } from "../league/host.js";
import { GovernanceService } from "../governance/index.js";
import type { OwnerReadTool } from "../providers/openrouter.js";
import { RuntimeError, type Job, type RuntimeStore } from "./index.js";

export const ConventionLimitsSchema = z
  .object({
    proposalTurns: z.number().int().min(1).max(10),
    votingTurns: z.number().int().min(1).max(20),
    closedTurns: z.number().int().min(0).max(3),
    maxSpendMicros: z.number().int().positive().max(100_000_000),
    maxReservationMicros: z.number().int().positive().max(10_000_000),
  })
  .strict()
  .refine((v) => v.maxReservationMicros <= v.maxSpendMicros);
export const StartConventionSchema = z
  .object({
    meetingId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    limits: ConventionLimitsSchema,
    synthetic: z.boolean().default(false),
  })
  .strict();
const readId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const GovernanceReadSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("summary"),
      offset: z.number().int().min(0).max(1000).default(0),
      limit: z.number().int().min(1).max(12).default(10),
    })
    .strict(),
  z
    .object({
      view: z.literal("proposal"),
      proposalId: readId,
      section: z
        .enum(["all", "content", "rationale", "leaguePolicies"])
        .default("all"),
      offset: z.number().int().min(0).max(1000000).default(0),
    })
    .strict(),
  z
    .object({
      view: z.literal("menu"),
      questionId: readId.optional(),
      optionId: readId.optional(),
      section: z.enum(["all", "content"]).default("all"),
      offset: z.number().int().min(0).max(1000000).default(0),
    })
    .strict(),
]);
const governanceReadInstruction =
  "governance_state {} returns a compact summary. Follow nextOffset with view:summary to read every visible proposal. Choices and hashes are exact; rationale and leaguePolicies are omitted from summaries explicitly. Before endorsing or voting, retrieve the exact candidate with view:proposal and proposalId. If tooLarge, read section:rationale, section:leaguePolicies, or section:content, following nextOffset until hasMore=false. Section offsets count Unicode code points; content pages are exact JSON fragments, not summaries. Use view:menu for full native options, or questionId/optionId to narrow; section:content pages an oversized menu. Sealed peer proposals remain unavailable.";
const encodedBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value));
const projectionBudget = 20500;
function textPage(value: string, offset: number) {
  const points = Array.from(value);
  if (offset > points.length) throw new RuntimeError("GOVERNANCE_OFFSET_AHEAD");
  const end = Math.min(points.length, offset + 3500);
  return {
    text: points.slice(offset, end).join(""),
    offset,
    nextOffset: end,
    totalCodePoints: points.length,
    hasMore: end < points.length,
    offsetUnit: "unicode-code-points",
    truncated: false,
    paginated: true,
  };
}
/** Pure projection of an already-authorized snapshot; never reads hidden proposals. */
export function projectGovernanceSnapshot(
  snapshot: any,
  request: z.infer<typeof GovernanceReadSchema>,
) {
  const identity = {
    meetingId: snapshot.meeting.id,
    phase: snapshot.phase,
    host: snapshot.host,
    hostVersion: snapshot.hostVersion,
    menuHash: snapshot.menuHash,
  };
  const detail = (value: any, meta: any) =>
    encodedBytes({ ...identity, ...meta, value }) <= projectionBudget
      ? { ...identity, ...meta, status: "complete", value }
      : {
          ...identity,
          ...meta,
          status: "tooLarge",
          contentReturned: false,
          instruction:
            "Use section:content for exact bounded JSON pages; proposal rationale and leaguePolicies also have direct section reads.",
        };
  if (request.view === "proposal") {
    const proposal = snapshot.proposals.find(
      (p: any) => p.id === request.proposalId,
    );
    if (!proposal)
      return {
        ...identity,
        status: "not_visible",
        proposalId: request.proposalId,
        instruction:
          "Unknown or sealed proposal in this meeting; no content disclosed.",
      };
    const meta = {
      proposalId: proposal.id,
      version: proposal.version,
      contentHash: proposal.content_hash,
      authorTeamId: proposal.author_team_id,
      ballotEligible: proposal.ballot_eligible ?? true,
      section: request.section,
    };
    if (request.section === "all") {
      if (request.offset)
        throw new RuntimeError("GOVERNANCE_SECTION_REQUIRED_FOR_OFFSET");
      return detail(proposal, meta);
    }
    const content = proposal.content ?? proposal;
    const value =
      request.section === "content"
        ? JSON.stringify(content)
        : (content[request.section] ?? "");
    return {
      ...identity,
      ...meta,
      status: "section",
      ...textPage(value, request.offset),
    };
  }
  if (request.view === "menu") {
    if (!snapshot.menu)
      return {
        ...identity,
        status: "not_available",
        instruction: "This host has no native menu.",
      };
    let value = snapshot.menu;
    if (request.optionId && !request.questionId)
      throw new RuntimeError("GOVERNANCE_QUESTION_REQUIRED");
    if (request.questionId) {
      value = snapshot.menu.questions.find(
        (q: any) => q.id === request.questionId,
      );
      if (request.optionId)
        value = value?.options.find((o: any) => o.id === request.optionId);
      if (!value) return { ...identity, status: "not_available" };
    }
    const meta = {
      menuId: snapshot.menu.menuId,
      questionId: request.questionId,
      optionId: request.optionId,
      section: request.section,
    };
    if (request.section === "content")
      return {
        ...identity,
        ...meta,
        status: "section",
        ...textPage(JSON.stringify(value), request.offset),
      };
    if (request.offset)
      throw new RuntimeError("GOVERNANCE_SECTION_REQUIRED_FOR_OFFSET");
    return detail(value, meta);
  }
  if (request.offset > snapshot.proposals.length)
    throw new RuntimeError("GOVERNANCE_OFFSET_AHEAD");
  const menu = snapshot.menu
    ? {
        menuId: snapshot.menu.menuId,
        title: snapshot.menu.title,
        questions: snapshot.menu.questions.map((q: any) => ({
          id: q.id,
          label: q.label,
          options: q.options.map((o: any) => ({
            id: o.id,
            label: o.label,
            contentCodePoints: Array.from(o.content).length,
          })),
        })),
        applicationSections: snapshot.menu.applicationSections,
        detailsOmitted: ["option.content", "option.evidenceRefs", "sourceNote"],
        readDetails: { view: "menu" },
      }
    : undefined;
  const result: any = {
    ...identity,
    meeting: snapshot.meeting,
    members: snapshot.members,
    phase: snapshot.phase,
    threshold: snapshot.threshold,
    electorate: snapshot.electorate,
    menu,
    configurationStatus: snapshot.configurationStatus,
    approval: snapshot.approval
      ? {
          id: snapshot.approval.id,
          proposal_id: snapshot.approval.proposal_id,
          proposal_hash: snapshot.approval.proposal_hash,
          version: snapshot.approval.version,
        }
      : null,
    application: snapshot.application,
    proposals: [],
    votes: [],
    votesScope: "returned_proposals_only",
    projection: "summary",
    totalVisibleProposals: snapshot.proposals.length,
    offset: request.offset,
    nextOffset: request.offset,
    hasMore: request.offset < snapshot.proposals.length,
    omittedProposalFields: [
      "rationale",
      "leaguePolicies",
      "teamOrder",
      "rules",
      "scoringRules",
    ],
    detailReadRequiredBeforeVote: true,
  };
  if (encodedBytes(result) > projectionBudget)
    result.menu = snapshot.menu
      ? {
          menuId: snapshot.menu.menuId,
          status: "detail_required",
          reason: "Menu labels exceed summary budget",
          readDetails: { view: "menu", section: "content" },
        }
      : undefined;
  for (const proposal of snapshot.proposals.slice(
    request.offset,
    request.offset + request.limit,
  )) {
    const content = proposal.content ?? proposal;
    const p = {
      id: proposal.id,
      author_team_id: proposal.author_team_id,
      version: proposal.version,
      content_hash: proposal.content_hash,
      ballot_eligible: proposal.ballot_eligible ?? true,
      title: proposal.title,
      choices: content.selections,
      revision_no: proposal.revision_no,
      replaces_proposal_id: proposal.replaces_proposal_id,
      rationaleCodePoints: Array.from(content.rationale ?? "").length,
      leaguePoliciesCodePoints: Array.from(content.leaguePolicies ?? "").length,
    };
    const votes = snapshot.votes
      .filter((v: any) => v.proposal_id === proposal.id)
      .map((v: any) => ({
        proposal_id: v.proposal_id,
        team_id: v.team_id,
        choice: v.choice,
      }));
    if (
      encodedBytes({
        ...result,
        proposals: [...result.proposals, p],
        votes: [...result.votes, ...votes],
      }) > projectionBudget
    )
      break;
    result.proposals.push(p);
    result.votes.push(...votes);
    result.nextOffset++;
  }
  result.hasMore = result.nextOffset < snapshot.proposals.length;
  if (result.hasMore && result.nextOffset === request.offset)
    return {
      ...identity,
      status: "tooLarge",
      instruction:
        "This proposal summary exceeds the response budget. Use view:proposal with nextProposalId and section:content.",
      nextProposalId: snapshot.proposals[request.offset].id,
      nextOffset: request.offset + 1,
      hasMore: request.offset + 1 < snapshot.proposals.length,
    };
  return result;
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new RuntimeError(code);
}
function phase(row: any, now: Date): "proposals" | "voting" | "closed" {
  return now < row.proposal_deadline
    ? "proposals"
    : now < row.vote_deadline
      ? "voting"
      : "closed";
}
function phaseInstruction(stage: string) {
  const task =
    stage === "proposals"
      ? "Read governance_state with view=menu for the full supported native option text before proposing; the default summary has labels only. Also make one native mfl_read request with type=rules for the currently bound league; read your own roster only if needed. Cite the actual read receipt and any configuration gap in your proposal rationale. Preserve your existing owner-chosen brand and durable operating memory from onboarding; focus this assignment on league rules rather than repeating naming or introductions. Before discussionOpensAt, do not share rule choices in Buzz."
      : stage === "discussion" || stage === "consolidation"
        ? "Read governance_state peer proposals and buzz_read. Post your actual choices and rationale; negotiate one consolidated candidate. Before cutoff, revise your own proposal with a fresh ID/version and replacesProposalId; never edit or invent another owner's work."
        : stage === "closed"
          ? "Read recorded outcomes. Commissioner ratification/application remains required. Do not start the draft or claim consensus."
          : "Read final candidates and actual votes. Cast only your own ballot on the exact agreed candidate via governance. Chat is not a vote; recorded votes are immutable.";
  return (
    task +
    " " +
    governanceReadInstruction +
    " Goals: win the league and learn useful human/agent collaboration. Rewards are nonmonetary; in-season compute budgets stay unchanged. Human last-place consequences require individual opt-in; absent Chris has no proxy vote. Defer large SVG/content production until rules finish. Old Buzz tool-unavailable posts are historical; current trusted context and your own fresh tool receipts govern availability. Shared search credits are a paid internal allocation, not free resources. Database receipt completion times are authoritative over model-authored timestamps. Stay within meeting turns/spend."
  );
}
async function consumption(
  tx: Pick<Db, "query">,
  leagueId: string,
  meetingId: string,
  agentId: string,
) {
  const rows = (
    await tx.query(
      `SELECT t.phase,count(*)::int AS turns,
      COALESCE(sum(CASE WHEN r.status='released' THEN 0 WHEN r.status='settled' THEN COALESCE(r.actual_micros,r.observed_micros,r.amount_micros)
        ELSE GREATEST(r.amount_micros,COALESCE(r.observed_micros,r.amount_micros)) END),0)::text AS committed_micros
     FROM runtime_convention_turns t JOIN runtime_reservations r ON r.job_id=t.job_id AND r.fence=t.fence
     WHERE t.league_id=$1 AND t.meeting_id=$2 AND t.agent_id=$3 GROUP BY t.phase`,
      [leagueId, meetingId, agentId],
    )
  ).rows;
  return {
    turns: Object.fromEntries(rows.map((r) => [r.phase, Number(r.turns)])),
    committedMicros: rows.reduce(
      (sum, r) => sum + Number(r.committed_micros),
      0,
    ),
  };
}

/** Called inside reserve() after the agent/fence lock. All jobs count, including peer chatter and staff. */
export async function reserveConventionTurn(
  tx: Tx,
  job: Job,
  amountMicros: number,
) {
  const row = (
    await tx.query(
      `SELECT c.*,clock_timestamp() AS now FROM runtime_conventions c JOIN runtime_bindings b ON b.league_id=c.league_id
     WHERE b.agent_id=$1 AND c.status='active'`,
      [job.agentId],
    )
  ).rows[0];
  if (!row) return;
  const mode = (
    await tx.query("SELECT execution_mode FROM runtime_jobs WHERE id=$1", [
      job.id,
    ])
  ).rows[0]?.execution_mode;
  if (mode === "provider_canary") return;
  const host = await getFootballHost(tx, row.league_id);
  check(
    host.kind === row.host_kind && host.version === row.host_version,
    "CONVENTION_HOST_CHANGED",
  );
  const limits = ConventionLimitsSchema.parse(row.limits),
    current = phase(row, row.now);
  const used = await consumption(
    tx,
    row.league_id,
    row.meeting_id,
    job.agentId,
  );
  const maxTurns =
    current === "proposals"
      ? limits.proposalTurns
      : current === "voting"
        ? limits.votingTurns
        : limits.closedTurns;
  check((used.turns[current] ?? 0) < maxTurns, "CONVENTION_TURN_LIMIT");
  const futureWaves = Number(
    (
      await tx.query(
        "SELECT count(*)::int AS n FROM runtime_convention_waves WHERE league_id=$1 AND meeting_id=$2 AND phase=$3 AND status='pending' AND due_at>clock_timestamp()",
        [row.league_id, row.meeting_id, current],
      )
    ).rows[0].n,
  );
  check(
    (used.turns[current] ?? 0) + futureWaves < maxTurns,
    "CONVENTION_TURNS_RESERVED_FOR_WAVES",
  );
  check(
    amountMicros <= limits.maxReservationMicros &&
      used.committedMicros + amountMicros <= limits.maxSpendMicros,
    "CONVENTION_SPEND_LIMIT",
  );
  await tx.query(
    "INSERT INTO runtime_convention_turns(league_id,meeting_id,agent_id,job_id,fence,phase) VALUES($1,$2,$3,$4,$5,$6)",
    [row.league_id, row.meeting_id, job.agentId, job.id, job.fence, current],
  );
}

export class ConventionRuntime {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
    readonly governance = new GovernanceService(db),
  ) {}
  /** Explicit commissioner start after the meeting exists; this never creates proposals or votes. */
  async start(actor: Actor, input: unknown) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "CONVENTION_COMMISSIONER_REQUIRED",
    );
    const request = StartConventionSchema.parse(input);
    const expectedHost = await getFootballHost(this.db, actor.leagueId!);
    const snap = await this.governance.snapshot(actor, request.meetingId);
    const proposal = new Date(snap.meeting.proposal_deadline),
      vote = new Date(snap.meeting.vote_deadline);
    const discussion = snap.meeting.discussion_opens_at
      ? new Date(snap.meeting.discussion_opens_at)
      : null;
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const old = (
        await tx.query(
          "SELECT * FROM runtime_conventions WHERE league_id=$1 AND meeting_id=$2",
          [actor.leagueId, request.meetingId],
        )
      ).rows[0];
      if (old) {
        check(
          JSON.stringify(ConventionLimitsSchema.parse(old.limits)) ===
            JSON.stringify(request.limits) &&
            old.synthetic === request.synthetic,
          "CONVENTION_CONFIG_CONFLICT",
        );
        return old;
      }
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      check(proposal > now && vote > proposal, "CONVENTION_WINDOW_CLOSED");
      if (expectedHost.kind === "mfl")
        check(
          discussion &&
            discussion > now &&
            discussion < proposal &&
            request.limits.proposalTurns >= 3 &&
            request.limits.votingTurns >= 2,
          "CONVENTION_DISCUSSION_WINDOW_REQUIRED",
        );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running'",
            [actor.leagueId],
          )
        ).rowCount,
        "CONVENTION_OWNER_TURN_IN_FLIGHT",
      );
      const host = await getFootballHost(tx, actor.leagueId!);
      check(
        host.kind === expectedHost.kind &&
          host.version === expectedHost.version,
        "CONVENTION_HOST_CHANGED",
      );
      const owners = (
        await tx.query(
          `SELECT t.id,t.kind,a.id AS agent_id,a.model,a.enabled,a.kind AS runtime_kind FROM league_teams t
         LEFT JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id LEFT JOIN runtime_agents a ON a.id=b.agent_id
         WHERE t.league_id=$1 ORDER BY t.id`,
          [actor.leagueId],
        )
      ).rows;
      check(
        owners.length === 12 &&
          owners.filter((o) => o.kind === "ai").length === 10 &&
          owners.every((o) => o.agent_id && o.kind === o.runtime_kind),
        "CONVENTION_FRANCHISE_BINDINGS_REQUIRED",
      );
      for (const owner of owners.filter((o) => o.kind === "ai")) {
        check(owner.enabled, "CONVENTION_AGENT_DISABLED");
        if (request.synthetic)
          check(
            owner.model.startsWith("synthetic/"),
            "CONVENTION_SYNTHETIC_MODEL_REQUIRED",
          );
        else {
          const manifest = (
            await tx.query(
              `SELECT m.document FROM provider_manifests m WHERE m.agent_id=$1 AND m.league_id=$2 AND m.status='active' AND m.document->>'model'=$3
             AND EXISTS(SELECT 1 FROM provider_calls p WHERE p.manifest_id=m.id AND p.purpose='canary' AND p.status='verified'
               AND p.reconciliation_status='verified' AND p.cost_micros IS NOT NULL AND p.generation_id IS NOT NULL
               AND EXISTS(SELECT 1 FROM runtime_jobs j WHERE j.id=p.job_id AND j.status='completed' AND j.execution_mode='provider_canary'))`,
              [owner.agent_id, actor.leagueId, owner.model],
            )
          ).rows[0];
          check(manifest, "CONVENTION_MODEL_CANARY_REQUIRED");
          const required = [
            "governance",
            "governance_state",
            "buzz_channel",
            "buzz_read",
            ...(host.kind === "mfl" ? ["mfl_read"] : []),
          ];
          check(
            required.every((permission) =>
              manifest.document.toolPermissions?.includes(permission),
            ),
            "CONVENTION_MODEL_PERMISSIONS_REQUIRED",
          );
        }
      }
      const row = (
        await tx.query(
          `INSERT INTO runtime_conventions(league_id,meeting_id,host_kind,host_version,proposal_deadline,vote_deadline,limits,synthetic,created_by,discussion_opens_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            actor.leagueId,
            request.meetingId,
            host.kind,
            host.version,
            proposal,
            vote,
            request.limits,
            request.synthetic,
            actor.id,
            discussion,
          ],
        )
      ).rows[0];
      const midpoint = new Date((proposal.getTime() + vote.getTime()) / 2);
      const waves = [
        ["proposals", "proposals", now, discussion ?? proposal],
        ...(discussion
          ? [
              [
                "discussion",
                "proposals",
                discussion,
                new Date((discussion.getTime() + proposal.getTime()) / 2),
              ],
              [
                "consolidation",
                "proposals",
                new Date((discussion.getTime() + proposal.getTime()) / 2),
                proposal,
              ],
            ]
          : []),
        ["voting-open", "voting", proposal, midpoint],
        ["voting-review", "voting", midpoint, vote],
        ["closed", "closed", vote, new Date(vote.getTime() + 20 * 60_000)],
      ];
      for (const [wave, p, due, expires] of waves)
        await tx.query(
          "INSERT INTO runtime_convention_waves(league_id,meeting_id,wave,phase,due_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
          [actor.leagueId, request.meetingId, wave, p, due, expires],
        );
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('convention.configured',$1)",
        [
          {
            leagueId: actor.leagueId,
            meetingId: request.meetingId,
            limits: request.limits,
            synthetic: request.synthetic,
            configuredBy: actor.id,
          },
        ],
      );
      return row;
    });
  }
  /** Safe to repeat after crashes. Wake job and wave receipt commit atomically. */
  async tick(leagueId: string) {
    return transaction(this.db, async (tx) => {
      const waves = (
        await tx.query(
          `SELECT w.*,c.host_kind,c.host_version,c.synthetic,clock_timestamp() AS now FROM runtime_convention_waves w JOIN runtime_conventions c USING(league_id,meeting_id)
         WHERE w.league_id=$1 AND c.status='active' AND w.status='pending' AND w.due_at<=clock_timestamp()
         ORDER BY w.due_at FOR UPDATE OF w SKIP LOCKED`,
          [leagueId],
        )
      ).rows;
      const work: { wave: string; status: string; wakes: number }[] = [];
      for (const wave of waves) {
        const host = await getFootballHost(tx, leagueId);
        check(
          host.kind === wave.host_kind && host.version === wave.host_version,
          "CONVENTION_HOST_CHANGED",
        );
        if (wave.now >= wave.expires_at) {
          await tx.query(
            "UPDATE runtime_convention_waves SET status='skipped',completed_at=clock_timestamp() WHERE league_id=$1 AND meeting_id=$2 AND wave=$3",
            [leagueId, wave.meeting_id, wave.wave],
          );
          work.push({ wave: wave.wave, status: "skipped-expired", wakes: 0 });
          continue;
        }
        const owners = (
          await tx.query(
            "SELECT agent_id FROM runtime_bindings WHERE league_id=$1 ORDER BY agent_id",
            [leagueId],
          )
        ).rows;
        for (const owner of owners)
          await this.runtime.ingestEventTx(tx, {
            agentId: owner.agent_id,
            priority: "urgent",
            causalId: `convention:${wave.meeting_id}:${wave.wave}`,
            payload: {
              kind: "governance.phase",
              meetingId: wave.meeting_id,
              phase: wave.phase,
              wave: wave.wave,
              synthetic: wave.synthetic,
              instruction: phaseInstruction(wave.wave),
            },
          });
        await tx.query(
          "UPDATE runtime_convention_waves SET status='dispatched',completed_at=clock_timestamp() WHERE league_id=$1 AND meeting_id=$2 AND wave=$3",
          [leagueId, wave.meeting_id, wave.wave],
        );
        work.push({
          wave: wave.wave,
          status: "dispatched",
          wakes: owners.length,
        });
      }
      return work;
    });
  }
  async context(
    agentId: string,
    request = GovernanceReadSchema.parse({ view: "summary" }),
  ) {
    const b = (
      await this.db.query(
        "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1",
        [agentId],
      )
    ).rows[0];
    check(b, "CONVENTION_OWNER_BINDING_REQUIRED");
    const row = (
      await this.db.query(
        "SELECT *,clock_timestamp() AS now FROM runtime_conventions WHERE league_id=$1 AND status='active'",
        [b.league_id],
      )
    ).rows[0];
    if (!row) return { status: "not-started" };
    return {
      status: "managed",
      meetingId: row.meeting_id,
      phase: phase(row, row.now),
      limits: row.limits,
      usage: await consumption(this.db, row.league_id, row.meeting_id, agentId),
      governance: projectGovernanceSnapshot(
        await this.governance.snapshot(
          {
            id: b.owner_id,
            role: "owner",
            leagueId: b.league_id,
            teamId: b.team_id,
          },
          row.meeting_id,
        ),
        request,
      ),
      instruction: phaseInstruction(
        phase(row, row.now) === "proposals" &&
          row.discussion_opens_at &&
          row.now >= row.discussion_opens_at
          ? "discussion"
          : phase(row, row.now),
      ),
    };
  }
}

export function createGovernanceReadTools(
  db: Db,
  runtime: RuntimeStore,
): OwnerReadTool[] {
  const service = new GovernanceService(db),
    convention = new ConventionRuntime(db, runtime, service);
  async function scope(job: Job) {
    const row = (
      await db.query(
        `SELECT b.*,t.owner_id FROM runtime_jobs j JOIN runtime_agents a ON a.id=j.agent_id
      JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id
      WHERE j.id=$1 AND j.agent_id=$2 AND j.fence=$3 AND j.worker_id=$4 AND j.status='running' AND j.lease_until>clock_timestamp() AND a.enabled AND a.model=$5`,
        [job.id, job.agentId, job.fence, job.workerId, job.model],
      )
    ).rows[0];
    check(row, "GOVERNANCE_JOB_AUTHORITY_EXPIRED");
    return row;
  }
  return [
    {
      name: "governance_state",
      description: governanceReadInstruction,
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["summary", "proposal", "menu"] },
          proposalId: { type: "string" },
          questionId: { type: "string" },
          optionId: { type: "string" },
          section: {
            type: "string",
            enum: ["all", "content", "rationale", "leaguePolicies"],
          },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
        additionalProperties: false,
      },
      execute: async (job, input) => {
        const object = z.record(z.string(), z.unknown()).parse(input);
        const request = GovernanceReadSchema.parse({
          view: "summary",
          ...object,
        });
        await scope(job);
        const result = await convention.context(job.agentId, request);
        await scope(job);
        return result;
      },
    },
  ];
}
