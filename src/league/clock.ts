import { requireCustomHost } from "./host.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { LeagueService, type CommandReceipt } from "./index.js";
import { LeagueError, type Actor } from "./schema.js";
const tickSchema = z
  .object({
    leagueId: z.string().min(1).max(120),
    maxCommands: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export type LeagueClockWork = {
  kind: "draft" | "waivers";
  reference: string;
  status: "applied" | "replayed" | "paused" | "blocked" | "skipped";
  receipt?: CommandReceipt;
  code?: string;
  message?: string;
};
/** Trusted scheduler primitive, not a new owner capability. All mutations use the command service. */
export class LeagueClock {
  private readonly service: LeagueService;
  constructor(private readonly db: Db) {
    this.service = new LeagueService(db);
  }
  async tick(actor: Actor, input: { leagueId: string; maxCommands?: number }) {
    const config = tickSchema.parse(input);
    if (
      !actor.id ||
      actor.leagueId !== config.leagueId ||
      !["commissioner", "system"].includes(actor.role)
    )
      throw new LeagueError(
        "FORBIDDEN",
        "A league-scoped commissioner or system identity is required for clock ticks",
      );
    await requireCustomHost(this.db, config.leagueId);
    const exists = await this.db.query("SELECT 1 FROM leagues WHERE id=$1", [
      config.leagueId,
    ]);
    if (!exists.rowCount)
      throw new LeagueError("NOT_FOUND", "League does not exist");
    // One database timestamp and one bounded due-work snapshot. No client clock can advance a deadline.
    const checkedAt: string = (
      await this.db.query("SELECT clock_timestamp()::text AS now")
    ).rows[0].now;
    const due = (
      await this.db.query(
        `
   SELECT kind,reference,epoch,due_at FROM (
    SELECT 'draft'::text AS kind,next_pick::text AS reference,draft_epoch AS epoch,pick_deadline AS due_at
    FROM leagues WHERE id=$1 AND status='drafting' AND draft_paused_at IS NULL AND pick_deadline<=$2
    UNION ALL
    SELECT 'waivers'::text AS kind,w.id AS reference,0 AS epoch,w.closes_at AS due_at
    FROM league_waiver_periods w JOIN leagues l ON l.id=w.league_id
    WHERE w.league_id=$1 AND l.status='active' AND w.status='open' AND w.closes_at<=$2
   ) due ORDER BY due_at,kind,reference LIMIT $3`,
        [config.leagueId, checkedAt, config.maxCommands],
      )
    ).rows;
    const work: LeagueClockWork[] = [];
    for (const item of due) {
      const kind = item.kind as "draft" | "waivers",
        reference = String(item.reference);
      const command =
        kind === "draft"
          ? {
              type: "autoDraftPick" as const,
              expectedPick: Number(reference),
              expectedDraftEpoch: Number(item.epoch),
            }
          : { type: "resolveWaivers" as const, periodId: reference };
      try {
        const receipt = await this.service.execute(actor, {
          ...command,
          leagueId: config.leagueId,
          idempotencyKey: `clock:${kind}:${reference}${kind === "draft" ? ":" + item.epoch : ""}`,
        });
        work.push({
          kind,
          reference,
          status:
            receipt.result.status === "paused"
              ? "paused"
              : receipt.replayed
                ? "replayed"
                : "applied",
          receipt,
        });
      } catch (error) {
        if (!(error instanceof LeagueError)) throw error;
        // Another worker may have progressed after our read. Domain failures remain visible.
        const stale = ["STALE_PICK", "INVALID_STATE", "NOT_DUE"].includes(
          error.code,
        );
        work.push({
          kind,
          reference,
          status: stale ? "skipped" : "blocked",
          code: error.code,
          message: error.message,
        });
      }
    }
    return {
      leagueId: config.leagueId,
      checkedAt: new Date(checkedAt).toISOString(),
      considered: due.length,
      work,
      needsAttention: work.some(
        (w) => w.status === "blocked" || w.status === "paused",
      ),
    };
  }
}
