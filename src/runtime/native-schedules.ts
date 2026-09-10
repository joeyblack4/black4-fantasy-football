import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type Principal } from "../auth.js";
import { transaction, type Db, type Tx } from "../db.js";

const iso = z.iso.datetime({ offset: true });
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Use an IANA time zone, for example America/Los_Angeles");
export const nativeScheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: iso }).strict(),
  z
    .object({
      kind: z.literal("interval"),
      startAt: iso,
      everySeconds: z
        .number()
        .int()
        .min(60)
        .max(366 * 86400),
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly"),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone,
    })
    .strict(),
  z
    .object({
      kind: z.literal("subscription"),
      eventKind: z.enum([
        "trade-offer",
        "waiver-processed",
        "transaction-completed",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      eventId: z.string().min(1).max(200),
      offsetSeconds: z
        .number()
        .int()
        .min(-366 * 86400)
        .max(366 * 86400),
    })
    .strict(),
]);
export type NativeScheduleTiming = z.infer<typeof nativeScheduleTimingSchema>;
const definition = {
  label: z.string().min(1).max(200),
  prompt: z.string().min(1).max(32000),
  timing: nativeScheduleTimingSchema,
};
export const nativeScheduleCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      idempotencyKey: z.string().min(1).max(200),
      ...definition,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      idempotencyKey: z.string().min(1).max(200),
      id: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      ...definition,
    })
    .strict(),
  z
    .object({
      operation: z.literal("acknowledge"),
      idempotencyKey: z.string().min(1).max(200),
      occurrenceId: z.string().min(1),
      state: z.enum(["started", "completed", "failed"]),
      note: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cancel"),
      idempotencyKey: z.string().min(1).max(200),
      id: z.string().min(1),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type NativeScheduleCommand = z.infer<typeof nativeScheduleCommandSchema>;
export type NativeScheduleTransport = {
  inspectOwner(input: { leagueId: string; teamId: string }): Promise<{
    status: "ready" | "busy" | "stopped" | "unavailable";
    reason?: string;
  }>;
  send(input: {
    leagueId: string;
    teamId: string;
    occurrenceId: string;
    prompt: string;
    scheduledFor: string;
    missedThrough: string;
    deliveryLane: 0 | 1;
  }): Promise<{ eventId: string }>;
  /** Only a definitive absence permits resend. Unknown readback never does. */
  reconcile(input: {
    leagueId: string;
    teamId: string;
    occurrenceId: string;
    deliveryLane: 0 | 1;
  }): Promise<
    { status: "found"; eventId: string } | { status: "absent" | "unknown" }
  >;
};
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
function owner(actor: Principal): string {
  if (actor.role !== "owner" || !actor.teamId)
    fail(403, "OWNER_REQUIRED", "Use the owning franchise credential.");
  return actor.teamId;
}
const canonical = (input: unknown): string =>
  JSON.stringify(input, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
const hash = (input: unknown): string =>
  createHash("sha256").update(canonical(input)).digest("hex");
const asIso = (value: Date | string) => new Date(value).toISOString();

/** Strictly after the supplied instant. Fall-back repeated local minutes fire once. Missing spring-forward minutes are skipped. */
export function nextNativeScheduleTime(
  timing: NativeScheduleTiming,
  after: Date,
): Date | null {
  if (timing.kind === "event" || timing.kind === "subscription") return null;
  if (timing.kind === "once")
    return new Date(timing.at) > after ? new Date(timing.at) : null;
  if (timing.kind === "interval") {
    const start = Date.parse(timing.startAt),
      step = timing.everySeconds * 1000;
    return new Date(
      start +
        Math.max(0, Math.floor((after.getTime() - start) / step) + 1) * step,
    );
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timing.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parts = (date: Date) =>
    Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
  const prior = parts(after);
  for (
    let ms = Math.floor(after.getTime() / 60000) * 60000 + 60000,
      end = ms + 8 * 86400000;
    ms < end;
    ms += 60000
  ) {
    const current = parts(new Date(ms));
    if (
      !timing.weekdays.includes(weekdays.indexOf(current.weekday)) ||
      `${current.hour}:${current.minute}` !== timing.time
    )
      continue;
    if (
      prior.year === current.year &&
      prior.month === current.month &&
      prior.day === current.day &&
      `${prior.hour}:${prior.minute}` >= timing.time
    )
      continue;
    return new Date(ms);
  }
  throw Error("SCHEDULE_NEXT_TIME_UNRESOLVED");
}

export class NativeSchedules {
  constructor(readonly db: Db) {}
  async command(actor: Principal, raw: unknown) {
    const teamId = owner(actor),
      input = nativeScheduleCommandSchema.parse(raw);
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7045))",
        [`${actor.leagueId}:${teamId}`],
      );
      const replay = (
        await tx.query(
          "SELECT * FROM runtime_native_schedule_commands WHERE league_id=$1 AND team_id=$2 AND idempotency_key=$3",
          [actor.leagueId, teamId, input.idempotencyKey],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== hash(input))
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key already identifies a different schedule command.",
          );
        return replay.result;
      }
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      let row;
      if (input.operation === "acknowledge") {
        const occurrence = (
          await tx.query(
            "SELECT * FROM runtime_native_schedule_occurrences WHERE id=$1 AND league_id=$2 AND team_id=$3 FOR UPDATE",
            [input.occurrenceId, actor.leagueId, teamId],
          )
        ).rows[0];
        if (!occurrence)
          fail(
            404,
            "OCCURRENCE_NOT_FOUND",
            "No occurrence with this ID belongs to this franchise.",
          );
        if (
          occurrence.status !== input.state &&
          !["delivered", "started"].includes(occurrence.status)
        )
          fail(
            409,
            "EXECUTION_TRANSITION_INVALID",
            "Only delivered work can be acknowledged.",
          );
        const evidence = {
          source: "owner-acknowledged",
          actorId: actor.id,
          eventId: occurrence.event_id,
          note: input.note ?? null,
        };
        await tx.query(
          "UPDATE runtime_native_schedule_occurrences SET status=$2,execution_evidence=$3,started_at=CASE WHEN $2='started' THEN COALESCE(started_at,clock_timestamp()) ELSE started_at END,completed_at=CASE WHEN $2 IN ('completed','failed') THEN COALESCE(completed_at,clock_timestamp()) ELSE completed_at END,updated_at=clock_timestamp() WHERE id=$1",
          [input.occurrenceId, input.state, evidence],
        );
        if (input.state === "completed")
          await tx.query(
            "UPDATE runtime_native_schedules SET status='completed',updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND next_due_at IS NULL AND timing->>'kind' IN ('once','event') AND status='active'",
            [occurrence.schedule_id, occurrence.schedule_version],
          );
        const result = {
          occurrenceId: input.occurrenceId,
          status: input.state,
          evidence,
        };
        await tx.query(
          "INSERT INTO runtime_native_schedule_commands(league_id,team_id,idempotency_key,payload_hash,result) VALUES($1,$2,$3,$4,$5)",
          [actor.leagueId, teamId, input.idempotencyKey, hash(input), result],
        );
        return result;
      }
      if (input.operation === "create") {
        const due = await this.initialDue(
          tx,
          actor.leagueId,
          teamId,
          input.timing,
          now,
        );
        row = (
          await tx.query(
            "INSERT INTO runtime_native_schedules(id,league_id,team_id,label,prompt,timing,next_due_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              actor.leagueId,
              teamId,
              input.label,
              input.prompt,
              input.timing,
              due,
            ],
          )
        ).rows[0];
      } else {
        const existing = (
          await tx.query(
            "SELECT * FROM runtime_native_schedules WHERE id=$1 AND league_id=$2 AND team_id=$3 FOR UPDATE",
            [input.id, actor.leagueId, teamId],
          )
        ).rows[0];
        if (!existing)
          fail(
            404,
            "SCHEDULE_NOT_FOUND",
            "No appointment with this ID belongs to this franchise.",
          );
        if (existing.version !== input.expectedVersion)
          fail(
            409,
            "SCHEDULE_VERSION_CONFLICT",
            "Read the current appointment before changing it.",
          );
        if (existing.status === "cancelled")
          fail(
            409,
            "SCHEDULE_CANCELLED",
            "Create a new appointment to resume cancelled work.",
          );
        // Sending/delivered work is already handed off and cannot honestly be withdrawn.
        await tx.query(
          "UPDATE runtime_native_schedule_occurrences SET status='cancelled',reason='Appointment changed before dispatch',updated_at=clock_timestamp() WHERE schedule_id=$1 AND status IN ('queued','blocked')",
          [input.id],
        );
        if (input.operation === "cancel")
          row = (
            await tx.query(
              "UPDATE runtime_native_schedules SET status='cancelled',next_due_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
              [input.id],
            )
          ).rows[0];
        else {
          const due = await this.initialDue(
            tx,
            actor.leagueId,
            teamId,
            input.timing,
            now,
          );
          row = (
            await tx.query(
              "UPDATE runtime_native_schedules SET label=$2,prompt=$3,timing=$4,next_due_at=$5,status='active',version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
              [input.id, input.label, input.prompt, input.timing, due],
            )
          ).rows[0];
        }
      }
      const result = this.present(row);
      await tx.query(
        "INSERT INTO runtime_native_schedule_commands(league_id,team_id,idempotency_key,payload_hash,result) VALUES($1,$2,$3,$4,$5)",
        [actor.leagueId, teamId, input.idempotencyKey, hash(input), result],
      );
      return result;
    });
  }
  private async initialDue(
    tx: Tx,
    leagueId: string,
    teamId: string,
    timing: NativeScheduleTiming,
    now: Date,
  ): Promise<Date | null> {
    if (timing.kind === "subscription") return null;
    if (timing.kind === "event") {
      const event = (
        await tx.query(
          "SELECT * FROM runtime_native_schedule_events WHERE league_id=$1 AND id=$2",
          [leagueId, timing.eventId],
        )
      ).rows[0];
      if (event?.audience_team_id && event.audience_team_id !== teamId)
        fail(
          404,
          "CALENDAR_EVENT_UNKNOWN",
          "This event is not available to this franchise.",
        );
      if (!event)
        fail(
          422,
          "CALENDAR_EVENT_UNKNOWN",
          "Read the shared calendar and use a known event ID.",
        );
      if (event.cancelled)
        fail(
          422,
          "CALENDAR_EVENT_CANCELLED",
          "This calendar event is cancelled.",
        );
      return new Date(
        new Date(event.occurs_at).getTime() + timing.offsetSeconds * 1000,
      );
    }
    // Explicit past one-shots/interval starts become one catch-up occurrence, not silently dropped.
    if (timing.kind === "once") return new Date(timing.at);
    if (timing.kind === "interval") return new Date(timing.startAt);
    return nextNativeScheduleTime(timing, now);
  }
  private present(row: any) {
    return {
      id: row.id,
      teamId: row.team_id,
      label: row.label,
      prompt: row.prompt,
      timing: row.timing,
      version: row.version,
      status: row.status,
      nextDueAt: row.next_due_at ? asIso(row.next_due_at) : null,
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
    };
  }
  async read(actor: Principal, input: { id?: string } = {}) {
    const teamId = owner(actor);
    const rows = (
      await this.db.query(
        "SELECT * FROM runtime_native_schedules WHERE league_id=$1 AND team_id=$2 AND ($3::text IS NULL OR id=$3) ORDER BY created_at,id",
        [actor.leagueId, teamId, input.id ?? null],
      )
    ).rows;
    if (input.id && !rows.length)
      fail(
        404,
        "SCHEDULE_NOT_FOUND",
        "No appointment with this ID belongs to this franchise.",
      );
    const occurrences = (
      await this.db.query(
        "SELECT id,schedule_id,schedule_version,scheduled_for,missed_through,status,event_id,attempt_at,delivered_at,started_at,completed_at,delivery_lane,reason,execution_evidence FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND team_id=$2 AND ($3::text IS NULL OR schedule_id=$3) ORDER BY scheduled_for DESC,id LIMIT 200",
        [actor.leagueId, teamId, input.id ?? null],
      )
    ).rows;
    const calendar = (
      await this.db.query(
        "SELECT id,kind,occurs_at,observed_at,cancelled FROM runtime_native_schedule_events WHERE league_id=$1 AND audience_team_id IS NULL AND kind NOT IN ('trade-offer','waiver-processed','transaction-completed') ORDER BY occurs_at,id",
        [actor.leagueId],
      )
    ).rows;
    const feeds = (
      await this.db.query(
        "SELECT source,status,observed_at,last_success_at,error_code FROM runtime_native_schedule_feeds WHERE league_id=$1 AND (source NOT LIKE 'trades:%' OR source=$2) ORDER BY source",
        [actor.leagueId, `trades:${teamId}`],
      )
    ).rows;
    return {
      schedules: rows.map((row) => this.present(row)),
      occurrences,
      receiptLimit: 200,
      calendarEvents: calendar,
      feeds,
    };
  }
  /** Infrastructure-only calendar ingestion; never accepts an owner-supplied date as league truth. */
  async recordCalendarEvent(
    leagueId: string,
    event: { id: string; kind: string; occursAt: string; cancelled?: boolean },
  ) {
    iso.parse(event.occursAt);
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7046))",
        [leagueId],
      );
      const old = (
        await tx.query(
          "SELECT * FROM runtime_native_schedule_events WHERE league_id=$1 AND id=$2",
          [leagueId, event.id],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO runtime_native_schedule_events(league_id,id,kind,occurs_at,cancelled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(league_id,id) DO UPDATE SET kind=EXCLUDED.kind,occurs_at=EXCLUDED.occurs_at,cancelled=EXCLUDED.cancelled,observed_at=clock_timestamp()",
        [
          leagueId,
          event.id,
          event.kind,
          event.occursAt,
          event.cancelled ?? false,
        ],
      );
      if (
        old &&
        asIso(old.occurs_at) === asIso(event.occursAt) &&
        old.cancelled === !!event.cancelled
      )
        return;
      const schedules = (
        await tx.query(
          "SELECT * FROM runtime_native_schedules WHERE league_id=$1 AND timing->>'kind'='event' AND timing->>'eventId'=$2 AND status='active' FOR UPDATE",
          [leagueId, event.id],
        )
      ).rows;
      for (const schedule of schedules) {
        await tx.query(
          "UPDATE runtime_native_schedule_occurrences SET status='cancelled',reason='Calendar event changed before dispatch',updated_at=clock_timestamp() WHERE schedule_id=$1 AND status IN ('queued','blocked')",
          [schedule.id],
        );
        await tx.query(
          "UPDATE runtime_native_schedules SET next_due_at=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [
            schedule.id,
            event.cancelled
              ? null
              : new Date(
                  Date.parse(event.occursAt) +
                    schedule.timing.offsetSeconds * 1000,
                ),
          ],
        );
      }
    });
  }
  /** Actual occurred events only. Pending bids / announced processing times are not completion events. */
  async recordLeagueEvent(
    leagueId: string,
    event: {
      id: string;
      kind: "trade-offer" | "waiver-processed" | "transaction-completed";
      occurredAt: string;
      audienceTeamId?: string;
    },
  ) {
    iso.parse(event.occurredAt);
    if (event.kind === "trade-offer" && !event.audienceTeamId)
      fail(
        422,
        "PRIVATE_EVENT_RECIPIENT_REQUIRED",
        "Trade offers require the receiving franchise binding.",
      );
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7046))",
        [leagueId],
      );
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      if (Date.parse(event.occurredAt) > now.getTime())
        fail(
          422,
          "EVENT_HAS_NOT_OCCURRED",
          "Subscriptions require an observed event, not a future promise.",
        );
      const old = (
        await tx.query(
          "SELECT * FROM runtime_native_schedule_events WHERE league_id=$1 AND id=$2",
          [leagueId, event.id],
        )
      ).rows[0];
      if (old) {
        if (
          old.kind !== event.kind ||
          asIso(old.occurs_at) !== asIso(event.occurredAt) ||
          old.audience_team_id !== (event.audienceTeamId ?? null)
        )
          fail(
            409,
            "EVENT_ID_CONFLICT",
            "The event ID already identifies different observed facts.",
          );
        return { created: 0 };
      }
      await tx.query(
        "INSERT INTO runtime_native_schedule_events(league_id,id,kind,occurs_at,audience_team_id) VALUES($1,$2,$3,$4,$5)",
        [
          leagueId,
          event.id,
          event.kind,
          event.occurredAt,
          event.audienceTeamId ?? null,
        ],
      );
      const matches = (
        await tx.query(
          "SELECT * FROM runtime_native_schedules WHERE league_id=$1 AND status='active' AND timing->>'kind'='subscription' AND timing->>'eventKind'=$2 AND ($3::text IS NULL OR team_id=$3) FOR UPDATE",
          [leagueId, event.kind, event.audienceTeamId ?? null],
        )
      ).rows;
      for (const schedule of matches) {
        const id = hash([schedule.id, schedule.version, event.id]);
        // Subscription work contains the owner's prompt and the event identity, never another owner's data.
        await tx.query(
          "INSERT INTO runtime_native_schedule_occurrences(id,schedule_id,league_id,team_id,schedule_version,prompt,scheduled_for,missed_through) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING",
          [
            id,
            schedule.id,
            leagueId,
            schedule.team_id,
            schedule.version,
            `${schedule.prompt}\n[League event: ${event.kind}; id: ${event.id}]`,
            event.occurredAt,
            now,
          ],
        );
      }
      return { created: matches.length };
    });
  }
  /** Persist one catch-up per due appointment and advance directly beyond server time. */
  async materializeDue(leagueId: string) {
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7046))",
        [leagueId],
      );
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      const schedules = (
        await tx.query(
          "SELECT * FROM runtime_native_schedules WHERE league_id=$1 AND status='active' AND next_due_at <= $2 ORDER BY next_due_at,id FOR UPDATE",
          [leagueId, now],
        )
      ).rows;
      const ids: string[] = [];
      for (const schedule of schedules) {
        // While this owner cannot run, coalesce new intervals into the existing queued work.
        const waiting = (
          await tx.query(
            "SELECT id FROM runtime_native_schedule_occurrences WHERE schedule_id=$1 AND schedule_version=$2 AND status IN ('queued','blocked') ORDER BY scheduled_for LIMIT 1 FOR UPDATE",
            [schedule.id, schedule.version],
          )
        ).rows[0];
        if (waiting)
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET missed_through=$2,updated_at=clock_timestamp() WHERE id=$1",
            [waiting.id, now],
          );
        else {
          const id = hash([
            schedule.id,
            schedule.version,
            asIso(schedule.next_due_at),
          ]);
          await tx.query(
            "INSERT INTO runtime_native_schedule_occurrences(id,schedule_id,league_id,team_id,schedule_version,prompt,scheduled_for,missed_through) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING",
            [
              id,
              schedule.id,
              leagueId,
              schedule.team_id,
              schedule.version,
              schedule.prompt,
              schedule.next_due_at,
              now,
            ],
          );
          ids.push(id);
        }
        const next = nextNativeScheduleTime(schedule.timing, now);
        await tx.query(
          "UPDATE runtime_native_schedules SET next_due_at=$2,updated_at=clock_timestamp() WHERE id=$1",
          [schedule.id, next],
        );
      }
      return { created: ids.length, occurrenceIds: ids };
    });
  }
  /** Process one occurrence per franchise under a session lock; process death preserves sending as uncertain. */
  async dispatchOne(leagueId: string, transport: NativeScheduleTransport) {
    const candidates = (
      await this.db.query(
        "SELECT DISTINCT team_id FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND status IN ('queued','blocked','sending','uncertain') ORDER BY team_id",
        [leagueId],
      )
    ).rows;
    for (const candidate of candidates) {
      const tx = await this.db.connect(),
        key = `${leagueId}:${candidate.team_id}`;
      let locked = false;
      try {
        locked = (
          await tx.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,7047)) AS locked",
            [key],
          )
        ).rows[0].locked;
        if (!locked) continue;
        // A delivered event may still be waiting in Buzz's native queue; do not steer its channel.
        const outstanding = (
          await tx.query(
            "SELECT id FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND team_id=$2 AND status IN ('delivered','started') LIMIT 1",
            [leagueId, candidate.team_id],
          )
        ).rows[0];
        if (outstanding) continue;
        let row = (
          await tx.query(
            "SELECT * FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND team_id=$2 AND status IN ('sending','uncertain','queued','blocked') ORDER BY CASE WHEN status IN ('sending','uncertain') THEN 0 ELSE 1 END,scheduled_for,id LIMIT 1",
            [leagueId, candidate.team_id],
          )
        ).rows[0];
        if (!row) continue;
        if (row.status === "sending" || row.status === "uncertain") {
          let result: Awaited<ReturnType<NativeScheduleTransport["reconcile"]>>;
          try {
            result = await transport.reconcile({
              leagueId,
              teamId: row.team_id,
              occurrenceId: row.id,
              deliveryLane: row.delivery_lane ?? 0,
            });
          } catch {
            result = { status: "unknown" };
          }
          if (result.status === "found" && result.eventId) {
            await tx.query(
              "UPDATE runtime_native_schedule_occurrences SET status='delivered',event_id=$2,delivered_at=clock_timestamp(),reason=NULL,updated_at=clock_timestamp() WHERE id=$1",
              [row.id, result.eventId],
            );
            return {
              status: "delivered",
              occurrenceId: row.id,
              reconciled: true,
            };
          }
          if (result.status !== "absent") {
            await tx.query(
              "UPDATE runtime_native_schedule_occurrences SET status='uncertain',reason='Delivery outcome unknown; awaiting transport reconciliation',updated_at=clock_timestamp() WHERE id=$1",
              [row.id],
            );
            continue;
          }
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET status='queued',reason='Transport confirmed prior attempt absent',updated_at=clock_timestamp() WHERE id=$1",
            [row.id],
          );
        }
        // Transport's busy check must cover external turns and deliveries awaiting execution.
        let health: Awaited<
          ReturnType<NativeScheduleTransport["inspectOwner"]>
        >;
        try {
          health = await transport.inspectOwner({
            leagueId,
            teamId: row.team_id,
          });
        } catch {
          health = {
            status: "unavailable",
            reason: "Runtime status unavailable",
          };
        }
        if (health.status !== "ready") {
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET status=$2,reason=$3,updated_at=clock_timestamp() WHERE id=$1 AND status IN ('queued','blocked')",
            [
              row.id,
              health.status === "busy" ? "queued" : "blocked",
              health.reason ?? health.status,
            ],
          );
          continue;
        }
        // Serialize with owner updates so cancelling a queued occurrence cannot race dispatch.
        await tx.query("BEGIN");
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,7045))",
          [key],
        );
        const previousDelivery = (
          await tx.query(
            "SELECT delivery_lane FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND team_id=$2 AND event_id IS NOT NULL ORDER BY delivered_at DESC,attempt_at DESC,id DESC LIMIT 1",
            [leagueId, candidate.team_id],
          )
        ).rows[0];
        // Only accepted delivery changes the lane. Cancelled/blocked materializations
        // and definitively absent sends must not advance it. A retry keeps its lane.
        const lane = previousDelivery
          ? previousDelivery.delivery_lane === 1
            ? 0
            : 1
          : 0;
        row = (
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET status='sending',attempt_at=clock_timestamp(),delivery_lane=COALESCE(delivery_lane,$2),reason=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status IN ('queued','blocked') RETURNING *",
            [row.id, lane],
          )
        ).rows[0];
        await tx.query("COMMIT");
        if (!row) continue;
        try {
          const receipt = await transport.send({
            leagueId,
            teamId: row.team_id,
            occurrenceId: row.id,
            prompt: row.prompt,
            scheduledFor: asIso(row.scheduled_for),
            missedThrough: asIso(row.missed_through),
            deliveryLane: row.delivery_lane,
          });
          if (!receipt.eventId) throw Error("Missing delivery receipt");
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET status='delivered',event_id=$2,delivered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
            [row.id, receipt.eventId],
          );
          return {
            status: "delivered",
            occurrenceId: row.id,
            eventId: receipt.eventId,
          };
        } catch {
          await tx.query(
            "UPDATE runtime_native_schedule_occurrences SET status='uncertain',reason='Delivery may have succeeded; automatic blind resend disabled',updated_at=clock_timestamp() WHERE id=$1",
            [row.id],
          );
          return { status: "uncertain", occurrenceId: row.id };
        }
      } finally {
        // A failed BEGIN block must release row/transaction locks before returning the connection.
        await tx.query("ROLLBACK");
        if (locked)
          await tx.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,7047))",
            [key],
          );
        tx.release();
      }
    }
    return { status: "idle" };
  }
  /** Called only by verified runtime receipt ingestion, never by an owner claiming it completed. */
  async recordExecution(
    leagueId: string,
    occurrenceId: string,
    status: "started" | "completed" | "failed",
    evidence: { eventId: string; [key: string]: unknown },
  ) {
    return transaction(this.db, async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND id=$2 FOR UPDATE",
          [leagueId, occurrenceId],
        )
      ).rows[0];
      if (!row || row.event_id !== evidence.eventId)
        fail(
          409,
          "EXECUTION_RECEIPT_MISMATCH",
          "Execution evidence must match the delivered event.",
        );
      if (row.status === status) return { status, occurrenceId };
      if (!["delivered", "started"].includes(row.status))
        fail(
          409,
          "EXECUTION_TRANSITION_INVALID",
          "The occurrence is not awaiting execution evidence.",
        );
      await tx.query(
        "UPDATE runtime_native_schedule_occurrences SET status=$2,execution_evidence=$3,started_at=CASE WHEN $2='started' THEN clock_timestamp() ELSE started_at END,completed_at=CASE WHEN $2 IN ('completed','failed') THEN clock_timestamp() ELSE completed_at END,updated_at=clock_timestamp() WHERE id=$1",
        [occurrenceId, status, evidence],
      );
      if (status === "completed")
        await tx.query(
          "UPDATE runtime_native_schedules SET status='completed',updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND next_due_at IS NULL AND timing->>'kind' IN ('once','event') AND status='active'",
          [row.schedule_id, row.schedule_version],
        );
      return { status, occurrenceId };
    });
  }
  /** Operator health deliberately excludes owner prompts and private strategy. */
  async health(leagueId: string) {
    const result = await this.db.query(
      "SELECT team_id,status,count(*)::int AS count,min(scheduled_for) AS oldest_due,max(updated_at) AS updated_at FROM runtime_native_schedule_occurrences WHERE league_id=$1 GROUP BY team_id,status ORDER BY team_id,status",
      [leagueId],
    );
    return { occurrences: result.rows };
  }
}
