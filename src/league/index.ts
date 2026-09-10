import { requireCustomHost } from "./host.js";
import { leagueCapabilities, leagueCapabilityVersion } from "./capabilities.js";
import { createHash, randomUUID } from "node:crypto";
import { validateDecision } from "../governance/validation.js";
import { transaction, type Db, type Tx } from "../db.js";
import {
  leagueCommandSchema,
  type LeagueCommand,
  type LeagueRules,
  type Actor,
  LeagueError,
} from "./schema.js";
export * from "./schema.js";
export type CommandReceipt = {
  receiptId: string;
  eventId: string;
  result: Record<string, unknown>;
  replayed: boolean;
};
type League = {
  id: string;
  rules: LeagueRules;
  status: "setup" | "drafting" | "active";
  current_week: number;
  next_pick: number;
  pick_deadline: Date | null;
  constitution_version: string | null;
  draft_paused_at: Date | null;
  draft_pause_reason: string | null;
  draft_pause_remaining_ms: number | null;
  draft_epoch: number;
};
type Context = {
  tx: Tx;
  league: League;
  actor: Actor;
  now: Date;
  receiptId?: string;
};
function fail(code: string, message: string): never {
  throw new LeagueError(code, message);
}
function check(value: unknown, code: string, message: string): asserts value {
  if (!value) fail(code, message);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function admin(actor: Actor) {
  check(
    actor.role === "commissioner" || actor.role === "system",
    "FORBIDDEN",
    "Commissioner or system capability required",
  );
}
function active(league: League) {
  check(
    league.status === "active",
    "INVALID_STATE",
    "League must have completed its draft",
  );
}
function privateType(type: LeagueCommand["type"]) {
  return [
    "setDraftQueue",
    "proposeTrade",
    "cancelTrade",
    "rejectTrade",
    "submitClaim",
    "cancelClaim",
  ].includes(type);
}
export function draftPosition(
  pickIndex: number,
  teamCount: number,
  order: "snake" | "linear",
): number {
  const round = Math.floor(pickIndex / teamCount),
    offset = pickIndex % teamCount;
  return order === "snake" && round % 2 === 1 ? teamCount - 1 - offset : offset;
}
/** Every transport must supply an authenticated actor; command bodies never confer authority. */
export class LeagueService {
  constructor(private readonly db: Db) {}
  async execute(
    verifiedActor: Actor,
    input: LeagueCommand | unknown,
  ): Promise<CommandReceipt> {
    const command = leagueCommandSchema.parse(input);
    check(
      verifiedActor.leagueId === command.leagueId,
      "FORBIDDEN",
      "Credential is bound to another league",
    );
    check(
      verifiedActor.id &&
        ["owner", "commissioner", "system"].includes(verifiedActor.role),
      "FORBIDDEN",
      "Verified identity is required",
    );
    const hash = createHash("sha256")
      .update(canonical({ actor: verifiedActor, command }))
      .digest("hex");
    return transaction(this.db, async (tx) => {
      // Serialize all commands for this league; independent leagues remain concurrent.
      // Advisory lock also serializes createLeague before a league row exists.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 7044))",
        [command.leagueId],
      );
      await requireCustomHost(tx, command.leagueId);
      const previous = await tx.query(
        "SELECT payload_hash,response FROM league_command_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [command.leagueId, verifiedActor.id, command.idempotencyKey],
      );
      if (previous.rowCount) {
        check(
          previous.rows[0].payload_hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "This key already identifies a different command",
        );
        return { ...previous.rows[0].response, replayed: true };
      }
      const receiptId = randomUUID();
      await tx.query(
        "INSERT INTO league_command_receipts(league_id,actor_id,idempotency_key,id,payload_hash) VALUES($1,$2,$3,$4,$5)",
        [
          command.leagueId,
          verifiedActor.id,
          command.idempotencyKey,
          receiptId,
          hash,
        ],
      );
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      let result: Record<string, unknown>;
      if (command.type === "createLeague")
        result = await this.create(tx, verifiedActor, command);
      else {
        const rows = await tx.query(
          "SELECT * FROM leagues WHERE id=$1 FOR UPDATE",
          [command.leagueId],
        );
        check(rows.rowCount, "NOT_FOUND", "League does not exist");
        const context: Context = {
          tx,
          league: rows.rows[0],
          actor: verifiedActor,
          now,
          receiptId,
        };
        // Bind owner identity to its persisted franchise, not only a claimed team ID.
        if (verifiedActor.role === "owner") await this.owner(context);
        result = await this.dispatch(context, command);
      }
      const teams = Array.from(
        new Set(
          [
            verifiedActor.teamId,
            typeof result.fromTeamId === "string"
              ? result.fromTeamId
              : undefined,
            typeof result.toTeamId === "string" ? result.toTeamId : undefined,
          ].filter((x): x is string => !!x),
        ),
      );
      const event = await tx.query(
        "INSERT INTO league_events(league_id,receipt_id,actor_id,type,visibility,participant_team_ids,payload) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          command.leagueId,
          receiptId,
          verifiedActor.id,
          command.type === "autoDraftPick" && result.status === "paused"
            ? "draftPaused"
            : command.type,
          privateType(command.type) ? "private" : "public",
          teams,
          JSON.stringify(result),
        ],
      );
      const response: CommandReceipt = {
        receiptId,
        eventId: String(event.rows[0].id),
        result,
        replayed: false,
      };
      await tx.query(
        "UPDATE league_command_receipts SET response=$1 WHERE id=$2",
        [JSON.stringify(response), receiptId],
      );
      return response;
    });
  }
  private async create(
    tx: Tx,
    actor: Actor,
    c: Extract<LeagueCommand, { type: "createLeague" }>,
  ) {
    admin(actor);
    check(
      !(await tx.query("SELECT 1 FROM leagues WHERE id=$1", [c.leagueId]))
        .rowCount,
      "ALREADY_EXISTS",
      "League already exists",
    );
    await tx.query("INSERT INTO leagues(id,name,rules) VALUES($1,$2,$3)", [
      c.leagueId,
      c.name,
      JSON.stringify(c.rules),
    ]);
    for (const [i, t] of c.teams.entries())
      await tx.query(
        "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          c.leagueId,
          t.id,
          t.name,
          t.ownerId,
          t.kind,
          i,
          11 - i,
          c.rules.faabBudget,
        ],
      );
    return {
      leagueId: c.leagueId,
      name: c.name,
      status: "setup",
      teams: c.teams,
      rules: c.rules,
      constitutionStatus: "unratified",
    };
  }
  private async owner(c: Context): Promise<string> {
    check(
      c.actor.role === "owner" && c.actor.teamId,
      "FORBIDDEN",
      "Owner capability required",
    );
    const row = await c.tx.query(
      "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
      [c.league.id, c.actor.teamId, c.actor.id],
    );
    check(row.rowCount, "FORBIDDEN", "Identity does not own this franchise");
    return c.actor.teamId;
  }
  private async existsPlayer(c: Context, id: string) {
    check(
      (
        await c.tx.query(
          "SELECT 1 FROM league_players WHERE league_id=$1 AND id=$2",
          [c.league.id, id],
        )
      ).rowCount,
      "NOT_FOUND",
      `Unknown player ${id}`,
    );
  }
  private async owned(c: Context, team: string, players: string[]) {
    const rows = await c.tx.query(
      "SELECT player_id FROM league_rosters WHERE league_id=$1 AND team_id=$2 AND player_id=ANY($3::text[])",
      [c.league.id, team, players],
    );
    check(
      rows.rowCount === players.length,
      "OWNERSHIP_CONFLICT",
      "A player is no longer owned by the expected franchise",
    );
  }
  private async movable(
    c: Context,
    players: string[],
    week = c.league.current_week,
  ) {
    for (const id of new Set(players)) {
      const rows = await c.tx.query(
        "SELECT * FROM league_player_games WHERE league_id=$1 AND player_id=$2 AND week=$3",
        [c.league.id, id, week],
      );
      check(
        rows.rowCount,
        "UNKNOWN_GAME_TIME",
        `No verified game or bye record for ${id}, week ${week}`,
      );
      const game = rows.rows[0];
      if (game.status === "cancelled" || game.status === "bye") continue;
      check(
        game.status !== "postponed",
        "UNKNOWN_GAME_TIME",
        `Game timing is unconfirmed for ${id}`,
      );
      check(
        game.status !== "final" && game.kickoff_at.getTime() > c.now.getTime(),
        "PLAYER_LOCKED",
        `Player ${id} has locked for week ${week}`,
      );
    }
  }
  private async capacity(c: Context, team: string, delta: number) {
    const n = Number(
      (
        await c.tx.query(
          "SELECT count(*) FROM league_rosters WHERE league_id=$1 AND team_id=$2",
          [c.league.id, team],
        )
      ).rows[0].count,
    );
    check(
      n + delta <= c.league.rules.rosterSize,
      "ROSTER_FULL",
      "Roster size would exceed the constitution limit",
    );
  }
  private async clearFutureLineups(c: Context, players: string[]) {
    await c.tx.query(
      "DELETE FROM league_lineups WHERE league_id=$1 AND player_id=ANY($2::text[]) AND week >= $3",
      [c.league.id, players, c.league.current_week],
    );
  }
  private async pause(c: Context, reason: string, automatic: boolean) {
    check(
      c.league.status === "drafting" && !c.league.draft_paused_at,
      "INVALID_STATE",
      "Only a running draft can be paused",
    );
    const remaining = Math.max(
      0,
      (c.league.pick_deadline?.getTime() ?? c.now.getTime()) - c.now.getTime(),
    );
    await c.tx.query(
      "UPDATE leagues SET draft_paused_at=$2,draft_pause_reason=$3,draft_pause_remaining_ms=$4,pick_deadline=NULL WHERE id=$1",
      [c.league.id, c.now, reason, remaining],
    );
    return {
      status: "paused",
      reason,
      automatic,
      nextPick: c.league.next_pick,
      draftEpoch: c.league.draft_epoch,
      remainingMs: remaining,
    };
  }
  private tradeOpen(c: Context) {
    check(
      !c.league.rules.tradeDeadlineAt ||
        new Date(c.league.rules.tradeDeadlineAt) > c.now,
      "TRADE_DEADLINE_PASSED",
      "The ratified trade deadline has passed",
    );
  }
  private async acquisitionAllowed(c: Context, player: string, at = c.now) {
    const hold = (
      await c.tx.query(
        "SELECT expires_at FROM league_player_holds WHERE league_id=$1 AND player_id=$2",
        [c.league.id, player],
      )
    ).rows[0];
    check(
      !hold || hold.expires_at <= at,
      "PLAYER_ON_HOLD",
      "Dropped player remains on a time-bound acquisition hold",
    );
  }
  private async holdDropped(
    c: Context,
    player: string,
    team: string,
    reason: "waiver_drop" | "free_agent_drop",
  ) {
    const hours = c.league.rules.droppedPlayerHoldHours ?? 0;
    if (hours === 0) return;
    await c.tx.query(
      "INSERT INTO league_player_holds(league_id,player_id,dropping_team_id,expires_at,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(league_id,player_id) DO UPDATE SET dropping_team_id=excluded.dropping_team_id,expires_at=excluded.expires_at,reason=excluded.reason,created_at=clock_timestamp()",
      [
        c.league.id,
        player,
        team,
        new Date(c.now.getTime() + hours * 3600000),
        reason,
      ],
    );
  }
  private async dispatch(
    c: Context,
    command: Exclude<LeagueCommand, { type: "createLeague" }>,
  ): Promise<Record<string, unknown>> {
    const { tx, league, actor, now } = c;
    const lid = league.id;
    switch (command.type) {
      case "importPlayers": {
        admin(actor);
        for (const p of command.players) {
          const old = await tx.query(
            "SELECT positions FROM league_players WHERE league_id=$1 AND id=$2",
            [lid, p.id],
          );
          if (old.rowCount && league.status !== "setup")
            check(
              canonical([...old.rows[0].positions].sort()) ===
                canonical([...p.positions].sort()),
              "RULES_FROZEN",
              "Position eligibility is frozen once drafting starts",
            );
          await tx.query(
            "INSERT INTO league_players(league_id,id,name,positions) VALUES($1,$2,$3,$4) ON CONFLICT(league_id,id) DO UPDATE SET name=excluded.name,positions=excluded.positions",
            [lid, p.id, p.name, p.positions],
          );
        }
        return { imported: command.players.length };
      }
      case "importSchedule": {
        admin(actor);
        for (const g of command.games) {
          await this.existsPlayer(c, g.playerId);
          const old = await tx.query(
            "SELECT * FROM league_player_games WHERE league_id=$1 AND player_id=$2 AND week=$3",
            [lid, g.playerId, g.week],
          );
          // A late feed correction cannot silently unlock a player whose known kickoff passed.
          if (
            old.rowCount &&
            (old.rows[0].status === "final" ||
              (old.rows[0].status === "scheduled" &&
                old.rows[0].kickoff_at <= now))
          ) {
            check(
              new Date(g.kickoffAt) <= now &&
                ["scheduled", "final"].includes(g.status),
              "LOCK_REGRESSION",
              "Cannot automatically move a locked game into an unlocked state",
            );
          }
          await tx.query(
            "INSERT INTO league_player_games(league_id,player_id,week,kickoff_at,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(league_id,player_id,week) DO UPDATE SET kickoff_at=excluded.kickoff_at,status=excluded.status",
            [lid, g.playerId, g.week, g.kickoffAt, g.status],
          );
        }
        return { imported: command.games.length };
      }
      case "ratifyConstitution": {
        check(
          actor.role === "commissioner",
          "FORBIDDEN",
          "Only the commissioner can ratify a constitution",
        );
        check(
          league.status === "setup" && !league.constitution_version,
          "RULES_FROZEN",
          "Constitution is already ratified or drafting started",
        );
        const approved = await validateDecision(
          tx,
          lid,
          command.decisionReceipt,
          command.version,
          now,
          command.rules,
        );
        check(
          !command.proposalId || approved.proposal.id === command.proposalId,
          "PROPOSAL_MISMATCH",
          "Prepared decision belongs to another proposal",
        );
        check(
          !command.proposalHash ||
            approved.proposal.content_hash === command.proposalHash,
          "PROPOSAL_MISMATCH",
          "Prepared proposal hash differs from the reviewed version",
        );
        const rules = approved.rules;
        const rulesHash = createHash("sha256")
          .update(
            canonical({
              rules,
              scoringRules: approved.scoringRules,
              capabilityVersion: approved.proposal.capability_version,
              teamOrder: approved.proposal.team_order,
            }),
          )
          .digest("hex");
        await tx.query(
          "UPDATE leagues SET rules=$2,constitution_version=$3,constitution_receipt=$4,constitution_rules_hash=$5,constitution_ratified_at=$6,ratified_scoring_rules=$7,ratified_capability_version=$8 WHERE id=$1",
          [
            lid,
            JSON.stringify(rules),
            command.version,
            command.decisionReceipt,
            rulesHash,
            now,
            JSON.stringify(approved.scoringRules),
            approved.proposal.capability_version,
          ],
        );
        await tx.query("UPDATE league_teams SET faab=$2 WHERE league_id=$1", [
          lid,
          rules.faabBudget,
        ]);
        await tx.query(
          "SET CONSTRAINTS league_teams_league_id_draft_position_key DEFERRED",
        );
        for (const [position, teamId] of approved.proposal.team_order.entries())
          await tx.query(
            "UPDATE league_teams SET draft_position=$3,waiver_priority=$4 WHERE league_id=$1 AND id=$2",
            [lid, teamId, position, 11 - position],
          );
        await tx.query(
          "UPDATE governance_decisions SET consumed_at=$3,ratification_receipt_id=$4 WHERE league_id=$1 AND id=$2",
          [lid, command.decisionReceipt, now, c.receiptId],
        );
        return {
          version: command.version,
          decisionReceipt: command.decisionReceipt,
          rulesHash,
          rules,
          scoringRules: approved.scoringRules,
          capabilityVersion: approved.proposal.capability_version,
          teamOrder: approved.proposal.team_order,
          status: "ratified",
          ratifiedAt: now.toISOString(),
        };
      }
      case "startDraft": {
        admin(actor);
        check(
          league.status === "setup",
          "INVALID_STATE",
          "Draft already started",
        );
        check(
          league.constitution_version,
          "CONSTITUTION_UNRATIFIED",
          "Commissioner must ratify the constitution before drafting",
        );
        const count = Number(
          (
            await tx.query(
              "SELECT count(*) FROM league_players WHERE league_id=$1",
              [lid],
            )
          ).rows[0].count,
        );
        check(
          count >= 12 * league.rules.rosterSize,
          "INSUFFICIENT_PLAYERS",
          "Player pool cannot fill all rosters",
        );
        const deadline = new Date(
          now.getTime() + league.rules.draftPickSeconds * 1000,
        );
        await tx.query(
          "UPDATE leagues SET status='drafting',pick_deadline=$2 WHERE id=$1",
          [lid, deadline],
        );
        return {
          status: "drafting",
          nextPick: 0,
          pickDeadline: deadline.toISOString(),
        };
      }
      case "pauseDraft": {
        check(
          actor.role === "commissioner",
          "FORBIDDEN",
          "Only the commissioner can manually pause the draft",
        );
        return this.pause(c, command.reason, false);
      }
      case "resumeDraft": {
        check(
          actor.role === "commissioner",
          "FORBIDDEN",
          "Only the commissioner can resume a paused draft",
        );
        check(
          league.status === "drafting" && league.draft_paused_at,
          "INVALID_STATE",
          "Draft is not paused",
        );
        const remaining =
          league.draft_pause_remaining_ms ||
          league.rules.draftPickSeconds * 1000;
        const deadline = new Date(now.getTime() + remaining);
        await tx.query(
          "UPDATE leagues SET draft_paused_at=NULL,draft_pause_reason=NULL,draft_pause_remaining_ms=NULL,draft_epoch=draft_epoch+1,pick_deadline=$2 WHERE id=$1",
          [lid, deadline],
        );
        return {
          status: "drafting",
          reason: command.reason,
          nextPick: league.next_pick,
          draftEpoch: league.draft_epoch + 1,
          pickDeadline: deadline.toISOString(),
        };
      }
      case "setDraftQueue": {
        const team = await this.owner(c);
        check(
          league.status !== "active",
          "INVALID_STATE",
          "Draft has completed",
        );
        for (const p of command.playerIds) await this.existsPlayer(c, p);
        await tx.query(
          "INSERT INTO league_draft_queues(league_id,team_id,player_ids) VALUES($1,$2,$3) ON CONFLICT(league_id,team_id) DO UPDATE SET player_ids=excluded.player_ids",
          [lid, team, command.playerIds],
        );
        return { teamId: team, queued: command.playerIds.length };
      }
      case "draftPick":
      case "autoDraftPick": {
        check(
          league.status === "drafting",
          "INVALID_STATE",
          "Draft is not in progress",
        );
        check(
          !league.draft_paused_at,
          "DRAFT_PAUSED",
          "Commissioner must resume the draft before a pick can be made",
        );
        check(
          command.expectedDraftEpoch === undefined ||
            command.expectedDraftEpoch === league.draft_epoch,
          "STALE_DRAFT_EPOCH",
          "Draft was paused or resumed after this command was prepared",
        );
        check(
          command.expectedPick === league.next_pick,
          "STALE_PICK",
          "The draft has advanced",
        );
        const position = draftPosition(
          league.next_pick,
          12,
          league.rules.draftOrder,
        );
        const team = (
          await tx.query(
            "SELECT id FROM league_teams WHERE league_id=$1 AND draft_position=$2",
            [lid, position],
          )
        ).rows[0].id;
        let player: string;
        if (command.type === "draftPick") {
          check(
            (await this.owner(c)) === team,
            "NOT_YOUR_TURN",
            "Another franchise is on the clock",
          );
          check(
            league.pick_deadline && now < league.pick_deadline,
            "PICK_EXPIRED",
            "Pick deadline passed; the owner-authored queue must resolve this pick",
          );
          player = command.playerId;
        } else {
          admin(actor);
          check(
            league.pick_deadline && now >= league.pick_deadline,
            "NOT_DUE",
            "Pick deadline has not passed",
          );
          const queue = await tx.query(
            "SELECT p.id FROM league_draft_queues q CROSS JOIN LATERAL unnest(q.player_ids) WITH ORDINALITY x(id,rank) JOIN league_players p ON p.league_id=q.league_id AND p.id=x.id LEFT JOIN league_rosters r ON r.league_id=q.league_id AND r.player_id=p.id WHERE q.league_id=$1 AND q.team_id=$2 AND r.player_id IS NULL ORDER BY x.rank LIMIT 1",
            [lid, team],
          );
          if (!queue.rowCount)
            return this.pause(
              c,
              "QUEUE_EXHAUSTED: owner-authored queue has no available player",
              true,
            );
          player = queue.rows[0].id;
        }
        await this.existsPlayer(c, player);
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_rosters WHERE league_id=$1 AND player_id=$2",
              [lid, player],
            )
          ).rowCount,
          "PLAYER_UNAVAILABLE",
          "Player has already been drafted",
        );
        await this.capacity(c, team, 1);
        await tx.query(
          "INSERT INTO league_rosters(league_id,player_id,team_id) VALUES($1,$2,$3)",
          [lid, player, team],
        );
        await tx.query(
          "INSERT INTO league_draft_picks(league_id,pick_index,team_id,player_id,automatic) VALUES($1,$2,$3,$4,$5)",
          [
            lid,
            league.next_pick,
            team,
            player,
            command.type === "autoDraftPick",
          ],
        );
        const next = league.next_pick + 1,
          done = next >= 12 * league.rules.rosterSize;
        const deadline = done
          ? null
          : new Date(now.getTime() + league.rules.draftPickSeconds * 1000);
        await tx.query(
          "UPDATE leagues SET next_pick=$2,status=$3,pick_deadline=$4 WHERE id=$1",
          [lid, next, done ? "active" : "drafting", deadline],
        );
        return {
          pickIndex: league.next_pick,
          teamId: team,
          playerId: player,
          automatic: command.type === "autoDraftPick",
          nextPick: next,
          status: done ? "active" : "drafting",
          pickDeadline: deadline?.toISOString() ?? null,
        };
      }
      case "setLineup": {
        active(league);
        const team = await this.owner(c);
        check(
          command.week >= league.current_week,
          "PAST_WEEK",
          "Historical lineups cannot be edited",
        );
        const entries = Object.entries(command.slots);
        check(
          new Set(entries.map(([, p]) => p)).size === entries.length,
          "DUPLICATE_PLAYER",
          "A player cannot fill two slots",
        );
        await this.owned(
          c,
          team,
          entries.map(([, p]) => p),
        );
        const previous = (
          await tx.query(
            "SELECT slot_id,player_id FROM league_lineups WHERE league_id=$1 AND team_id=$2 AND week=$3",
            [lid, team, command.week],
          )
        ).rows;
        const prior = Object.fromEntries(
          previous.map((p) => [p.slot_id, p.player_id]),
        );
        const changed = new Set<string>();
        for (const slot of new Set([
          ...Object.keys(prior),
          ...Object.keys(command.slots),
        ]))
          if (prior[slot] !== command.slots[slot]) {
            if (prior[slot]) changed.add(prior[slot]);
            if (command.slots[slot]) changed.add(command.slots[slot]);
          }
        await this.movable(c, [...changed], command.week);
        for (const [slotId, player] of entries) {
          const slot = league.rules.lineupSlots.find((s) => s.id === slotId);
          check(slot, "INVALID_SLOT", `Unknown slot ${slotId}`);
          const positions = (
            await tx.query(
              "SELECT positions FROM league_players WHERE league_id=$1 AND id=$2",
              [lid, player],
            )
          ).rows[0].positions as string[];
          check(
            slot.positions.some((p) => positions.includes(p)),
            "INELIGIBLE_POSITION",
            `${player} is not eligible for ${slotId}`,
          );
        }
        await tx.query(
          "DELETE FROM league_lineups WHERE league_id=$1 AND team_id=$2 AND week=$3",
          [lid, team, command.week],
        );
        for (const [slot, player] of entries)
          await tx.query(
            "INSERT INTO league_lineups(league_id,team_id,week,slot_id,player_id) VALUES($1,$2,$3,$4,$5)",
            [lid, team, command.week, slot, player],
          );
        return { teamId: team, week: command.week, slots: command.slots };
      }
      case "advanceWeek": {
        admin(actor);
        active(league);
        check(
          command.week === league.current_week + 1,
          "INVALID_WEEK",
          "Advance exactly one week at a time",
        );
        // Require explicit completion records for every current-week scheduled player.
        const missing = await tx.query(
          "SELECT 1 FROM league_rosters r LEFT JOIN league_player_games g ON g.league_id=r.league_id AND g.player_id=r.player_id AND g.week=$2 WHERE r.league_id=$1 AND g.player_id IS NULL LIMIT 1",
          [lid, league.current_week],
        );
        check(
          !missing.rowCount,
          "UNKNOWN_GAME_TIME",
          "Every rostered player needs an explicit current-week game or bye record",
        );
        const open = await tx.query(
          "SELECT 1 FROM league_player_games WHERE league_id=$1 AND week=$2 AND status NOT IN ('final','cancelled','bye') LIMIT 1",
          [lid, league.current_week],
        );
        check(
          !open.rowCount,
          "GAMES_NOT_FINAL",
          "Current-week games must be marked final, cancelled, or bye",
        );
        check(
          (
            await tx.query(
              "SELECT 1 FROM league_player_games WHERE league_id=$1 AND week=$2 LIMIT 1",
              [lid, league.current_week],
            )
          ).rowCount,
          "UNKNOWN_GAME_TIME",
          "Cannot advance an unobserved week",
        );
        await tx.query("UPDATE leagues SET current_week=$2 WHERE id=$1", [
          lid,
          command.week,
        ]);
        return { week: command.week };
      }
      case "proposeTrade": {
        active(league);
        this.tradeOpen(c);
        const team = await this.owner(c);
        check(
          team !== command.toTeamId,
          "INVALID_TRADE",
          "Cannot trade with the same franchise",
        );
        check(
          new Date(command.expiresAt) > now,
          "EXPIRED",
          "Trade expiration must be in the future",
        );
        check(
          !command.givePlayers.some((p) => command.receivePlayers.includes(p)),
          "INVALID_TRADE",
          "Trade sides must be disjoint",
        );
        await this.owned(c, team, command.givePlayers);
        await this.owned(c, command.toTeamId, command.receivePlayers);
        await this.movable(c, [
          ...command.givePlayers,
          ...command.receivePlayers,
        ]);
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_trades WHERE league_id=$1 AND id=$2",
              [lid, command.tradeId],
            )
          ).rowCount,
          "ALREADY_EXISTS",
          "Trade ID exists",
        );
        await tx.query(
          "INSERT INTO league_trades(league_id,id,from_team,to_team,give_players,receive_players,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            lid,
            command.tradeId,
            team,
            command.toTeamId,
            command.givePlayers,
            command.receivePlayers,
            command.expiresAt,
          ],
        );
        return {
          tradeId: command.tradeId,
          fromTeamId: team,
          toTeamId: command.toTeamId,
          givePlayers: command.givePlayers,
          receivePlayers: command.receivePlayers,
          status: "proposed",
          expiresAt: command.expiresAt,
        };
      }
      case "acceptTrade":
      case "cancelTrade":
      case "rejectTrade": {
        active(league);
        const team = await this.owner(c);
        const row = await tx.query(
          "SELECT * FROM league_trades WHERE league_id=$1 AND id=$2",
          [lid, command.tradeId],
        );
        check(row.rowCount, "NOT_FOUND", "Trade does not exist");
        const t = row.rows[0];
        check(
          t.status === "proposed",
          "INVALID_STATE",
          "Trade is no longer open",
        );
        check(
          team === (command.type === "cancelTrade" ? t.from_team : t.to_team),
          "FORBIDDEN",
          "Only the designated trade participant can perform this action",
        );
        if (command.type === "acceptTrade") {
          this.tradeOpen(c);
          check(t.expires_at > now, "EXPIRED", "Trade offer expired");
          await this.owned(c, t.from_team, t.give_players);
          await this.owned(c, t.to_team, t.receive_players);
          await this.movable(c, [...t.give_players, ...t.receive_players]);
          await this.capacity(
            c,
            t.from_team,
            t.receive_players.length - t.give_players.length,
          );
          await this.capacity(
            c,
            t.to_team,
            t.give_players.length - t.receive_players.length,
          );
          await tx.query(
            "UPDATE league_rosters SET team_id=$3 WHERE league_id=$1 AND player_id=ANY($2::text[])",
            [lid, t.give_players, t.to_team],
          );
          await tx.query(
            "UPDATE league_rosters SET team_id=$3 WHERE league_id=$1 AND player_id=ANY($2::text[])",
            [lid, t.receive_players, t.from_team],
          );
          await this.clearFutureLineups(c, [
            ...t.give_players,
            ...t.receive_players,
          ]);
        }
        const status =
          command.type === "acceptTrade"
            ? "accepted"
            : command.type === "cancelTrade"
              ? "cancelled"
              : "rejected";
        await tx.query(
          "UPDATE league_trades SET status=$3 WHERE league_id=$1 AND id=$2",
          [lid, t.id, status],
        );
        return {
          tradeId: t.id,
          status,
          fromTeamId: t.from_team,
          toTeamId: t.to_team,
          ...(status === "accepted"
            ? { givePlayers: t.give_players, receivePlayers: t.receive_players }
            : {}),
        };
      }
      case "openWaivers": {
        admin(actor);
        active(league);
        check(
          new Date(command.closesAt) > now,
          "EXPIRED",
          "Waiver deadline must be in the future",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_waiver_periods WHERE league_id=$1 AND status='open'",
              [lid],
            )
          ).rowCount,
          "INVALID_STATE",
          "Resolve the current waiver period before opening another",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_free_agent_windows WHERE league_id=$1 AND closes_at>$2 AND opens_at<$3",
              [lid, now, command.closesAt],
            )
          ).rowCount,
          "WINDOW_CONFLICT",
          "Waivers cannot overlap a free-agent window",
        );
        await tx.query(
          "INSERT INTO league_waiver_periods(league_id,id,closes_at) VALUES($1,$2,$3)",
          [lid, command.periodId, command.closesAt],
        );
        return { periodId: command.periodId, closesAt: command.closesAt };
      }
      case "submitClaim": {
        active(league);
        const team = await this.owner(c);
        const period = await tx.query(
          "SELECT * FROM league_waiver_periods WHERE league_id=$1 AND id=$2",
          [lid, command.periodId],
        );
        check(period.rowCount, "NOT_FOUND", "Waiver period does not exist");
        check(
          period.rows[0].status === "open" && period.rows[0].closes_at > now,
          "WAIVERS_CLOSED",
          "Waiver deadline passed",
        );
        check(
          command.addPlayerId !== command.dropPlayerId,
          "INVALID_CLAIM",
          "Cannot add and drop the same player",
        );
        await this.existsPlayer(c, command.addPlayerId);
        await this.acquisitionAllowed(
          c,
          command.addPlayerId,
          period.rows[0].closes_at,
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_rosters WHERE league_id=$1 AND player_id=$2",
              [lid, command.addPlayerId],
            )
          ).rowCount,
          "PLAYER_UNAVAILABLE",
          "Requested player is already rostered",
        );
        if (command.dropPlayerId)
          await this.owned(c, team, [command.dropPlayerId]);
        await this.movable(c, [
          command.addPlayerId,
          ...(command.dropPlayerId ? [command.dropPlayerId] : []),
        ]);
        const faab = (
          await tx.query(
            "SELECT faab FROM league_teams WHERE league_id=$1 AND id=$2",
            [lid, team],
          )
        ).rows[0].faab;
        check(
          command.bid <= faab,
          "INSUFFICIENT_FAAB",
          "Bid exceeds remaining budget",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_waiver_claims WHERE league_id=$1 AND id=$2",
              [lid, command.claimId],
            )
          ).rowCount,
          "ALREADY_EXISTS",
          "Claim ID exists; cancel before submitting a replacement",
        );
        await tx.query(
          "INSERT INTO league_waiver_claims(league_id,id,period_id,team_id,add_player,drop_player,bid,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            lid,
            command.claimId,
            command.periodId,
            team,
            command.addPlayerId,
            command.dropPlayerId ?? null,
            command.bid,
            command.priority,
          ],
        );
        return {
          claimId: command.claimId,
          periodId: command.periodId,
          teamId: team,
          bid: command.bid,
          addPlayerId: command.addPlayerId,
          dropPlayerId: command.dropPlayerId ?? null,
          status: "pending",
        };
      }
      case "cancelClaim": {
        const team = await this.owner(c);
        const rows = await tx.query(
          "SELECT c.*,p.closes_at,p.status AS period_status FROM league_waiver_claims c JOIN league_waiver_periods p ON p.league_id=c.league_id AND p.id=c.period_id WHERE c.league_id=$1 AND c.id=$2",
          [lid, command.claimId],
        );
        check(rows.rowCount, "NOT_FOUND", "Claim does not exist");
        const claim = rows.rows[0];
        check(
          claim.team_id === team,
          "FORBIDDEN",
          "Cannot cancel another franchise claim",
        );
        check(
          claim.status === "pending" &&
            claim.period_status === "open" &&
            claim.closes_at > now,
          "WAIVERS_CLOSED",
          "Claim can no longer be cancelled",
        );
        await tx.query(
          "UPDATE league_waiver_claims SET status='cancelled' WHERE league_id=$1 AND id=$2",
          [lid, command.claimId],
        );
        return { claimId: command.claimId, status: "cancelled" };
      }
      case "resolveWaivers":
        return this.resolve(c, command.periodId);
      case "openFreeAgency": {
        admin(actor);
        active(league);
        check(
          league.rules.freeAgentMode === "scheduledFirstCome",
          "RULES_FORBID",
          "Constitution does not permit first-come acquisitions",
        );
        const opens = new Date(command.opensAt),
          closes = new Date(command.closesAt);
        check(
          closes > now && closes > opens,
          "INVALID_WINDOW",
          "Window must end in the future and after it starts",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_waiver_periods WHERE league_id=$1 AND status='open'",
              [lid],
            )
          ).rowCount,
          "WINDOW_CONFLICT",
          "Resolve pending waivers before opening free agency",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_free_agent_windows WHERE league_id=$1 AND opens_at<$3 AND closes_at>$2",
              [lid, opens, closes],
            )
          ).rowCount,
          "WINDOW_CONFLICT",
          "Free-agent windows cannot overlap",
        );
        await tx.query(
          "INSERT INTO league_free_agent_windows(league_id,id,opens_at,closes_at) VALUES($1,$2,$3,$4)",
          [lid, command.windowId, opens, closes],
        );
        return {
          windowId: command.windowId,
          opensAt: command.opensAt,
          closesAt: command.closesAt,
        };
      }
      case "addFreeAgent": {
        active(league);
        const team = await this.owner(c);
        check(
          league.rules.freeAgentMode === "scheduledFirstCome",
          "RULES_FORBID",
          "Constitution does not permit first-come acquisitions",
        );
        const windows = await tx.query(
          "SELECT * FROM league_free_agent_windows WHERE league_id=$1 AND id=$2",
          [lid, command.windowId],
        );
        check(
          windows.rowCount,
          "NOT_FOUND",
          "Free-agent window does not exist",
        );
        const window = windows.rows[0];
        check(
          window.opens_at <= now && now < window.closes_at,
          "WINDOW_CLOSED",
          "Free-agent window is not open",
        );
        check(
          command.addPlayerId !== command.dropPlayerId,
          "INVALID_CLAIM",
          "Cannot add and drop the same player",
        );
        await this.existsPlayer(c, command.addPlayerId);
        await this.acquisitionAllowed(c, command.addPlayerId);
        check(
          !(
            await tx.query(
              "SELECT 1 FROM league_rosters WHERE league_id=$1 AND player_id=$2",
              [lid, command.addPlayerId],
            )
          ).rowCount,
          "PLAYER_UNAVAILABLE",
          "Player is already rostered",
        );
        if (command.dropPlayerId)
          await this.owned(c, team, [command.dropPlayerId]);
        await this.capacity(c, team, command.dropPlayerId ? 0 : 1);
        await this.movable(c, [
          command.addPlayerId,
          ...(command.dropPlayerId ? [command.dropPlayerId] : []),
        ]);
        if (command.dropPlayerId) {
          await tx.query(
            "DELETE FROM league_rosters WHERE league_id=$1 AND player_id=$2",
            [lid, command.dropPlayerId],
          );
          await this.clearFutureLineups(c, [command.dropPlayerId]);
          await this.holdDropped(
            c,
            command.dropPlayerId,
            team,
            "free_agent_drop",
          );
        }
        await tx.query(
          "INSERT INTO league_rosters(league_id,player_id,team_id) VALUES($1,$2,$3)",
          [lid, command.addPlayerId, team],
        );
        return {
          windowId: command.windowId,
          teamId: team,
          addPlayerId: command.addPlayerId,
          dropPlayerId: command.dropPlayerId ?? null,
        };
      }
    }
  }
  private async resolve(
    c: Context,
    periodId: string,
  ): Promise<Record<string, unknown>> {
    admin(c.actor);
    active(c.league);
    const { tx, league, now } = c,
      lid = league.id;
    const period = await tx.query(
      "SELECT * FROM league_waiver_periods WHERE league_id=$1 AND id=$2",
      [lid, periodId],
    );
    check(period.rowCount, "NOT_FOUND", "Waiver period does not exist");
    check(
      period.rows[0].status === "open",
      "INVALID_STATE",
      "Waivers already resolved",
    );
    check(
      period.rows[0].closes_at <= now,
      "NOT_DUE",
      "Waiver deadline has not passed",
    );
    // Published deterministic ordering: bid descending, reverse-draft tiebreak, owner priority, submission time, ID.
    const claims = (
      await tx.query(
        "SELECT c.* FROM league_waiver_claims c JOIN league_teams t ON t.league_id=c.league_id AND t.id=c.team_id WHERE c.league_id=$1 AND c.period_id=$2 AND c.status='pending' ORDER BY c.bid DESC,t.waiver_priority ASC,c.priority ASC,c.created_at ASC,c.id ASC",
        [lid, periodId],
      )
    ).rows;
    const outcomes: Record<string, unknown>[] = [];
    for (const claim of claims) {
      let reason: string | null = null;
      if (
        (
          await tx.query(
            "SELECT 1 FROM league_rosters WHERE league_id=$1 AND player_id=$2",
            [lid, claim.add_player],
          )
        ).rowCount
      )
        reason = "PLAYER_UNAVAILABLE";
      if (
        !reason &&
        claim.drop_player &&
        !(
          await tx.query(
            "SELECT 1 FROM league_rosters WHERE league_id=$1 AND team_id=$2 AND player_id=$3",
            [lid, claim.team_id, claim.drop_player],
          )
        ).rowCount
      )
        reason = "DROP_NOT_OWNED";
      const faab = (
        await tx.query(
          "SELECT faab FROM league_teams WHERE league_id=$1 AND id=$2",
          [lid, claim.team_id],
        )
      ).rows[0].faab;
      if (!reason && claim.bid > faab) reason = "INSUFFICIENT_FAAB";
      if (!reason) {
        try {
          await this.acquisitionAllowed(c, claim.add_player);
          await this.capacity(c, claim.team_id, claim.drop_player ? 0 : 1);
          await this.movable(c, [
            claim.add_player,
            ...(claim.drop_player ? [claim.drop_player] : []),
          ]);
        } catch (error) {
          if (error instanceof LeagueError) reason = error.code;
          else throw error;
        }
      }
      if (!reason) {
        if (claim.drop_player) {
          await tx.query(
            "DELETE FROM league_rosters WHERE league_id=$1 AND player_id=$2",
            [lid, claim.drop_player],
          );
          await this.clearFutureLineups(c, [claim.drop_player]);
          await this.holdDropped(
            c,
            claim.drop_player,
            claim.team_id,
            "waiver_drop",
          );
        }
        await tx.query(
          "INSERT INTO league_rosters(league_id,player_id,team_id) VALUES($1,$2,$3)",
          [lid, claim.add_player, claim.team_id],
        );
        await tx.query(
          "UPDATE league_teams SET faab=faab-$3 WHERE league_id=$1 AND id=$2",
          [lid, claim.team_id, claim.bid],
        );
      }
      const status = reason ? "lost" : "won";
      await tx.query(
        "UPDATE league_waiver_claims SET status=$3,reason=$4 WHERE league_id=$1 AND id=$2",
        [lid, claim.id, status, reason],
      );
      // Public resolution exposes winning bids only; losing claims stay private to their owners.
      if (!reason)
        outcomes.push({
          claimId: claim.id,
          teamId: claim.team_id,
          addPlayerId: claim.add_player,
          dropPlayerId: claim.drop_player,
          bid: claim.bid,
          status,
        });
    }
    await tx.query(
      "UPDATE league_waiver_periods SET status='resolved' WHERE league_id=$1 AND id=$2",
      [lid, periodId],
    );
    return {
      periodId,
      status: "resolved",
      processed: claims.length,
      winners: outcomes,
    };
  }
  /** Public by default. A verified league-scoped actor can additionally view its own private state. */
  async snapshot(leagueId: string, actor?: Actor) {
    if (actor) {
      check(
        actor.leagueId === leagueId,
        "FORBIDDEN",
        "Credential is bound to another league",
      );
      check(
        ["owner", "commissioner", "system"].includes(actor.role),
        "FORBIDDEN",
        "Unknown actor role",
      );
    }
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const league = (
        await tx.query("SELECT * FROM leagues WHERE id=$1", [leagueId])
      ).rows[0];
      check(league, "NOT_FOUND", "League does not exist");
      if (actor?.role === "owner")
        await this.owner({ tx, league, actor, now: new Date() });
      const all = !!actor && ["commissioner", "system"].includes(actor.role);
      const args = [leagueId];
      const checkedAt: Date = (
        await tx.query("SELECT clock_timestamp() AS now")
      ).rows[0].now;
      const teams = (
        await tx.query(
          "SELECT id,name,kind,draft_position,waiver_priority,faab FROM league_teams WHERE league_id=$1 ORDER BY draft_position",
          args,
        )
      ).rows;
      const players = (
        await tx.query(
          "SELECT id,name,positions FROM league_players WHERE league_id=$1 ORDER BY id",
          args,
        )
      ).rows;
      const rosters = (
        await tx.query(
          "SELECT team_id,player_id FROM league_rosters WHERE league_id=$1 ORDER BY team_id,player_id",
          args,
        )
      ).rows;
      const picks = (
        await tx.query(
          "SELECT pick_index,team_id,player_id,automatic,picked_at FROM league_draft_picks WHERE league_id=$1 ORDER BY pick_index",
          args,
        )
      ).rows;
      const lineups = (
        await tx.query(
          "SELECT team_id,week,slot_id,player_id FROM league_lineups WHERE league_id=$1 ORDER BY week,team_id,slot_id",
          args,
        )
      ).rows;
      const trades = (
        await tx.query(
          "SELECT * FROM league_trades WHERE league_id=$1 AND (status='accepted' OR $2::boolean OR from_team=$3 OR to_team=$3) ORDER BY created_at",
          [leagueId, all, actor?.teamId ?? null],
        )
      ).rows;
      const claims = (
        await tx.query(
          "SELECT * FROM league_waiver_claims WHERE league_id=$1 AND (status='won' OR $2::boolean OR team_id=$3) ORDER BY created_at",
          [leagueId, all, actor?.teamId ?? null],
        )
      ).rows;
      const games = (
        await tx.query(
          "SELECT player_id,week,kickoff_at,status FROM league_player_games WHERE league_id=$1 ORDER BY week,player_id",
          args,
        )
      ).rows;
      const waiverPeriods = (
        await tx.query(
          "SELECT id,closes_at,status,(status='open' AND closes_at>$2) AS accepting_claims,(status='open' AND closes_at<=$2) AS resolution_due FROM league_waiver_periods WHERE league_id=$1 ORDER BY closes_at,id",
          [leagueId, checkedAt],
        )
      ).rows;
      const freeAgentWindows = (
        await tx.query(
          "SELECT id,opens_at,closes_at,CASE WHEN $2<opens_at THEN 'scheduled' WHEN $2<closes_at THEN 'open' ELSE 'closed' END AS state FROM league_free_agent_windows WHERE league_id=$1 ORDER BY opens_at,id",
          [leagueId, checkedAt],
        )
      ).rows;
      const playerHolds = (
        await tx.query(
          "SELECT player_id,dropping_team_id,expires_at,reason FROM league_player_holds WHERE league_id=$1 AND expires_at>$2 ORDER BY expires_at,player_id",
          [leagueId, checkedAt],
        )
      ).rows;
      const draftQueues = actor
        ? (
            await tx.query(
              "SELECT team_id,player_ids FROM league_draft_queues WHERE league_id=$1 AND ($2::boolean OR team_id=$3)",
              [leagueId, all, actor.teamId ?? null],
            )
          ).rows
        : [];
      return {
        league,
        capabilities: leagueCapabilities,
        capabilityStatus: !league.constitution_version
          ? "unratified"
          : league.ratified_capability_version === leagueCapabilityVersion
            ? "current"
            : "legacy-unverified",
        teams,
        players,
        rosters,
        picks,
        lineups,
        trades,
        claims,
        draftQueues,
        games,
        playerHolds,
        waiverPeriods,
        freeAgentWindows,
        checkedAt: checkedAt.toISOString(),
      };
    });
  }
}
export { LeagueClock, type LeagueClockWork } from "./clock.js";

export { leagueCapabilities, leagueCapabilityVersion } from "./capabilities.js";
export { LeagueEventDispatcher, leagueWakeEventTypes } from "./dispatcher.js";
