import { createHash } from "node:crypto";
import type { Principal } from "../auth.js";
import type { Db } from "../db.js";
import type { MflOwnerRead, MflReadReceipt } from "../mfl/contracts.js";
import { expandCalendarOccurrences } from "../mfl/calendar-occurrences.js";
import { NativeSchedules } from "./native-schedules.js";
export type ScheduleFeedReader = (
  actor: Principal,
  query: MflOwnerRead,
) => Promise<MflReadReceipt>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeCode = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : "";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : "SOURCE_READ_FAILED";
};
/** One bounded source read per poll; the shared adapter cache is reused across all franchises. */
export class NativeScheduleFeeds {
  constructor(
    readonly db: Db,
    readonly schedules: NativeSchedules,
    readonly read: ScheduleFeedReader,
  ) {}
  async poll(input: {
    leagueId: string;
    owners: Principal[];
    baseWeek: number;
  }) {
    if (!input.owners.length) throw Error("FEED_OWNER_BINDING_REQUIRED");
    const now = new Date(),
      rows = (
        await this.db.query(
          "SELECT * FROM runtime_native_schedule_feeds WHERE league_id=$1",
          [input.leagueId],
        )
      ).rows;
    const state = new Map<string, any>(rows.map((row) => [row.source, row]));
    const opted = (
      await this.db.query(
        "SELECT DISTINCT team_id,timing->>'eventKind' AS kind FROM runtime_native_schedules WHERE league_id=$1 AND status='active' AND timing->>'kind'='subscription'",
        [input.leagueId],
      )
    ).rows;
    let week = Math.max(1, Math.min(22, input.baseWeek));
    // This only chooses which schedule pages to collect. It does not claim to set MFL's current week.
    while (week < 22) {
      const previous = state.get(`calendar:${week}`)?.cursor?.lastKickoff;
      if (!previous || Date.parse(previous) + 6 * 3600000 >= now.getTime())
        break;
      week++;
    }
    const candidates: {
      source: string;
      actor: Principal;
      query: MflOwnerRead;
      refresh: number;
    }[] = [
      {
        source: `calendar:${week}`,
        actor: input.owners[0]!,
        query: { type: "calendar", week },
        refresh: 300000,
      },
      ...(week < 22
        ? [
            {
              source: `calendar:${week + 1}`,
              actor: input.owners[0]!,
              query: { type: "calendar" as const, week: week + 1 },
              refresh: 300000,
            },
          ]
        : []),
    ];
    if (
      opted.some((row) =>
        ["waiver-processed", "transaction-completed"].includes(row.kind),
      )
    )
      candidates.push({
        source: "transactions",
        actor: input.owners[0]!,
        query: { type: "transactions", limit: 200 },
        refresh: 60000,
      });
    for (const actor of input.owners)
      if (
        opted.some(
          (row) => row.team_id === actor.teamId && row.kind === "trade-offer",
        )
      )
        candidates.push({
          source: `trades:${actor.teamId}`,
          actor,
          query: { type: "pendingTrades" },
          refresh: 60000,
        });
    // Select most overdue; uninitialized sources retain the deterministic order above.
    const candidate = candidates
      .filter(
        (row) =>
          !state.has(row.source) ||
          now.getTime() -
            new Date(state.get(row.source).observed_at).getTime() >=
            row.refresh,
      )
      .sort(
        (a, b) =>
          (state.has(a.source)
            ? new Date(state.get(a.source).observed_at).getTime()
            : 0) -
          (state.has(b.source)
            ? new Date(state.get(b.source).observed_at).getTime()
            : 0),
      )[0];
    if (!candidate) return { status: "idle" };
    try {
      const receipt = await this.read(candidate.actor, candidate.query);
      if (
        receipt.leagueId !== input.leagueId ||
        receipt.teamId !== candidate.actor.teamId
      )
        throw Error("FEED_RECEIPT_BINDING_MISMATCH");
      const data = receipt.data as any,
        prior = state.get(candidate.source)?.cursor;
      let cursor: any;
      if (candidate.query.type === "calendar") {
        if (!Array.isArray(data?.games) || !Array.isArray(data?.events))
          throw Error("CALENDAR_SOURCE_SHAPE");
        const times: string[] = [];
        for (const game of data.games)
          if (
            typeof game.id === "string" &&
            typeof game.kickoffAt === "string" &&
            Number.isFinite(Date.parse(game.kickoffAt))
          ) {
            await this.schedules.recordCalendarEvent(input.leagueId, {
              id: game.id,
              kind: "kickoff",
              occursAt: game.kickoffAt,
            });
            times.push(game.kickoffAt);
          }
        const calendar = expandCalendarOccurrences(data.events) as any[];
        const groups = new Map<string, Set<string>>();
        for (const event of calendar) {
          if (
            typeof event.id !== "string" ||
            !["timestamp", "resolved-week-kickoff"].includes(
              event.timingStatus,
            ) ||
            typeof event.startsAt !== "string" ||
            !Number.isFinite(Date.parse(event.startsAt))
          )
            continue;
          const id = event.schedulerEventId ?? `mfl-calendar:${event.id}`;
          const base = `mfl-calendar:${event.recurrenceBaseId ?? event.id}`;
          if (!groups.has(base)) groups.set(base, new Set());
          groups.get(base)!.add(id);
          await this.schedules.recordCalendarEvent(input.leagueId, {
            id,
            kind: event.type ?? "league-calendar",
            occursAt: event.startsAt,
          });
        }
        // A changed known recurrence definition replaces its own future derived
        // dates. Keep past records and never retract already delivered work.
        for (const [base, currentIds] of groups) {
          const previous = (
            await this.db.query(
              "SELECT id,kind,occurs_at FROM runtime_native_schedule_events WHERE league_id=$1 AND cancelled=false AND occurs_at>$2 AND (id=$3 OR left(id,length($3)+1)=$3||':')",
              [input.leagueId, now, base],
            )
          ).rows;
          for (const event of previous)
            if (!currentIds.has(event.id))
              await this.schedules.recordCalendarEvent(input.leagueId, {
                id: event.id,
                kind: event.kind,
                occursAt: new Date(event.occurs_at).toISOString(),
                cancelled: true,
              });
        }
        // Missing/cancelled games are not inferred from absent rows; source may be incomplete.
        cursor = {
          receiptId: receipt.id,
          sourceObservedAt: receipt.at,
          week: candidate.query.week,
          lastKickoff: times.sort().at(-1) ?? null,
          timedGames: times.length,
          calendarOccurrences: calendar.length,
          recurrenceTimezone: "America/New_York",
          unresolvedEvents: calendar.filter(
            (event: any) =>
              !["timestamp", "resolved-week-kickoff"].includes(
                event.timingStatus,
              ),
          ).length,
        };
      } else if (candidate.query.type === "transactions") {
        if (!Array.isArray(data?.transactions))
          throw Error("TRANSACTIONS_SOURCE_SHAPE");
        const transactions = data.transactions.filter(
          (row: any) =>
            typeof row.timestamp === "string" &&
            Number.isFinite(Date.parse(row.timestamp)) &&
            [
              "WAIVER",
              "BBID_WAIVER",
              "FREE_AGENT",
              "TRADE",
              "IR",
              "TAXI",
              "AUCTION_WON",
            ].includes(row.type),
        );
        const seen = new Set<string>(prior?.seen ?? []);
        if (
          prior?.initialized &&
          seen.size > 0 &&
          data.transactions.length >= 200 &&
          !transactions.some((row: any) => seen.has(digest(row)))
        ) {
          // The previous bounded window has disappeared. Neither a complete event stream
          // nor a successful catch-up can be inferred from this response.
          const code = "TRANSACTION_FEED_GAP_REQUIRES_RECONCILIATION";
          await this.save(
            input.leagueId,
            candidate.source,
            "unknown",
            {
              ...prior,
              gapDetectedAt: now.toISOString(),
              gapReceiptId: receipt.id,
              currentWindowCount: data.transactions.length,
            },
            code,
          );
          return {
            status: "unknown",
            source: candidate.source,
            errorCode: code,
          };
        }
        const newRows = prior?.initialized
          ? transactions.filter(
              (row: any) =>
                !seen.has(digest(row)) &&
                (!prior.baselineAt ||
                  Date.parse(row.timestamp) >= Date.parse(prior.baselineAt)),
            )
          : [];
        for (const row of newRows) {
          const id = digest(row);
          await this.schedules.recordLeagueEvent(input.leagueId, {
            id: `mfl-transaction:${id}`,
            kind: "transaction-completed",
            occurredAt: row.timestamp,
          });
          if (["WAIVER", "BBID_WAIVER"].includes(row.type))
            await this.schedules.recordLeagueEvent(input.leagueId, {
              id: `mfl-waiver-award:${id}`,
              kind: "waiver-processed",
              occurredAt: row.timestamp,
            });
        }
        cursor = {
          receiptId: receipt.id,
          sourceObservedAt: receipt.at,
          seen: transactions.map(digest),
          initialized: true,
          count: transactions.length,
          coverage:
            "bounded-200-completed-rows; zero-award waiver processing unknown",
          baselineOnly: !prior?.initialized,
          baselineAt:
            prior?.baselineAt ??
            new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
        };
      } else {
        if (!Array.isArray(data)) throw Error("TRADES_SOURCE_SHAPE");
        const trades = data.filter(
          (row: any) =>
            row.offeredToTeamId === candidate.actor.teamId &&
            typeof row.tradeId === "string",
        );
        const seen = new Set<string>(prior?.seen ?? []);
        // Initial existing offers are visible in pendingTrades; subscriptions watch newly observed changes after baseline.
        for (const offer of prior?.initialized
          ? trades.filter((row: any) => !seen.has(row.tradeId))
          : []) {
          const id = `mfl-trade-offer:${offer.tradeId}:${candidate.actor.teamId}`;
          const existing = (
            await this.db.query(
              "SELECT occurs_at FROM runtime_native_schedule_events WHERE league_id=$1 AND id=$2",
              [input.leagueId, id],
            )
          ).rows[0];
          await this.schedules.recordLeagueEvent(input.leagueId, {
            id,
            kind: "trade-offer",
            occurredAt: existing
              ? new Date(existing.occurs_at).toISOString()
              : receipt.at,
            audienceTeamId: candidate.actor.teamId,
          });
        }
        cursor = {
          receiptId: receipt.id,
          sourceObservedAt: receipt.at,
          seen: trades.map((row: any) => row.tradeId),
          initialized: true,
          count: trades.length,
          timing: "first-observed; upstream creation time unavailable",
          baselineOnly: !prior?.initialized,
          baselineAt:
            prior?.baselineAt ??
            new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
        };
      }
      await this.save(input.leagueId, candidate.source, "healthy", cursor);
      return { status: "healthy", source: candidate.source };
    } catch (error) {
      const code = safeCode(error);
      await this.save(
        input.leagueId,
        candidate.source,
        "failed",
        state.get(candidate.source)?.cursor ?? {},
        code,
      );
      return { status: "failed", source: candidate.source, errorCode: code };
    }
  }
  async save(
    leagueId: string,
    source: string,
    status: "healthy" | "failed" | "unknown",
    cursor: unknown = {},
    code?: string,
  ) {
    await this.db.query(
      "INSERT INTO runtime_native_schedule_feeds(league_id,source,status,last_success_at,error_code,cursor) VALUES($1,$2,$3,CASE WHEN $3='healthy' THEN clock_timestamp() ELSE NULL END,$4,$5) ON CONFLICT(league_id,source) DO UPDATE SET status=EXCLUDED.status,observed_at=clock_timestamp(),last_success_at=CASE WHEN EXCLUDED.status='healthy' THEN clock_timestamp() ELSE runtime_native_schedule_feeds.last_success_at END,error_code=EXCLUDED.error_code,cursor=EXCLUDED.cursor",
      [leagueId, source, status, code ?? null, cursor],
    );
  }
}
