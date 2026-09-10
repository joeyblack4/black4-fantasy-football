import { createHash } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import type { Principal } from "../auth.js";
import { getFootballHost } from "../league/host.js";
export const NATIVE_DRAFT_CHANNEL = "51adcc84-3bed-455a-95b1-32f46d356d5e";
export type NativeDraftNotice = {
  kind: "on-clock" | "pick-confirmed";
  epoch: string;
  round: number;
  pick: number;
  franchiseId: string;
  teamId: string;
  teamName?: string;
  mflLeagueId?: string;
  recipientPubkey: string;
  playerId?: string;
  synthetic: boolean;
  rehearsal?: boolean;
  resume: number;
};
export function nativeDraftNoticeId(
  leagueId: string,
  notice: NativeDraftNotice,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        leagueId,
        notice.epoch,
        notice.kind,
        notice.round,
        notice.pick,
        notice.franchiseId,
        notice.playerId ?? null,
        notice.kind === "on-clock" ? notice.resume : 0,
      ]),
    )
    .digest("hex");
}
export function nativeDraftNoticeContent(notice: NativeDraftNotice) {
  const label = notice.synthetic || notice.rehearsal ? "REHEARSAL — " : "";
  const league = notice.mflLeagueId
    ? `MFL league ${notice.mflLeagueId}`
    : "MFL";
  const team = notice.teamName ?? notice.teamId;
  return notice.kind === "on-clock"
    ? `${label}${team} — ${league} reports your turn: round ${notice.round}, pick ${notice.pick}. Read fresh MFL draft state and available players, use your own preparation, and submit your pick through the league mfl_command tool if it is still your turn. Grow the league together; compete to win. [draft:${notice.epoch}:${notice.round}:${notice.pick}:${notice.resume}]`
    : `${label}${league} confirmed round ${notice.round}, pick ${notice.pick}: ${team} selected player ${notice.playerId}. [draft-pick:${notice.epoch}:${notice.round}:${notice.pick}:${notice.playerId}]`;
}
export async function enqueueNativeDraftNotice(
  tx: Tx,
  leagueId: string,
  notice: NativeDraftNotice,
) {
  const id = nativeDraftNoticeId(leagueId, notice);
  const result = await tx.query(
    "INSERT INTO runtime_native_draft_notifications(id,league_id,epoch,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id",
    [id, leagueId, notice.epoch, notice.kind, notice],
  );
  return result.rows[0]?.id as string | undefined;
}
export type NativeDraftSender = (input: {
  id: string;
  channelId: string;
  content: string;
  recipientPubkey?: string;
}) => Promise<{ eventId: string }>;
/** A send whose outcome is unknown is never retried automatically. Reconnects cannot mint duplicate messages. */
export class NativeDraftNotifications {
  constructor(
    readonly db: Db,
    readonly send: NativeDraftSender,
    readonly teamNames: Record<string, string> = {},
  ) {}
  async deliverOne(actor: Principal) {
    if (actor.role !== "commissioner")
      throw Error("DRAFT_OBSERVER_COMMISSIONER_REQUIRED");
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const observer = (
        await tx.query(
          "SELECT * FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
          [actor.leagueId],
        )
      ).rows[0];
      if (
        !observer ||
        observer.delivery_mode !== "native-buzz" ||
        observer.status !== "active" ||
        !observer.last_observed_at ||
        ((observer.last_state?.paused || observer.last_state?.stopped) &&
          !observer.last_state?.over)
      )
        return { status: "held" };
      const host = await getFootballHost(tx, actor.leagueId);
      if (
        host.kind !== "mfl" ||
        host.version !== observer.host_version ||
        JSON.stringify(host.identity) !== JSON.stringify(observer.host_identity)
      )
        return { status: "held" };
      // 'sending' means a prior process could have sent successfully before its connection died.
      const uncertain = (
        await tx.query(
          "SELECT id FROM runtime_native_draft_notifications WHERE league_id=$1 AND status IN ('sending','uncertain') LIMIT 1",
          [actor.leagueId],
        )
      ).rows[0];
      if (uncertain) return { status: "uncertain", id: uncertain.id };
      const row = (
        await tx.query(
          "SELECT * FROM runtime_native_draft_notifications WHERE league_id=$1 AND status='pending' ORDER BY CASE WHEN kind='pick-confirmed' THEN 0 ELSE 1 END,created_at,id LIMIT 1 FOR UPDATE",
          [actor.leagueId],
        )
      ).rows[0];
      if (!row) return { status: "idle" };
      const notice = row.payload as NativeDraftNotice,
        state = observer.last_state;
      if (
        row.epoch !== observer.epoch ||
        (row.kind === "on-clock" &&
          (!state ||
            state.over ||
            state.round !== notice.round ||
            state.pick !== notice.pick ||
            state.franchiseId !== notice.franchiseId ||
            Number(observer.resume_number) !== notice.resume))
      ) {
        await tx.query(
          "UPDATE runtime_native_draft_notifications SET status='superseded' WHERE id=$1",
          [row.id],
        );
        return { status: "superseded", id: row.id };
      }
      // Commit the attempt before network I/O while retaining a session advisory lock across the send.
      await tx.query("SELECT pg_advisory_lock(hashtextextended($1,7044))", [
        actor.leagueId,
      ]);
      try {
        await tx.query(
          "UPDATE runtime_native_draft_notifications SET status='sending',attempted_at=clock_timestamp() WHERE id=$1",
          [row.id],
        );
        await tx.query("COMMIT");
        try {
          const result = await this.send({
            id: row.id,
            channelId: NATIVE_DRAFT_CHANNEL,
            content: nativeDraftNoticeContent({
              ...notice,
              mflLeagueId: notice.mflLeagueId ?? host.identity?.leagueId,
              teamName:
                notice.teamName ??
                this.teamNames[notice.teamId] ??
                (
                  await tx.query(
                    "SELECT name FROM league_teams WHERE league_id=$1 AND id=$2",
                    [actor.leagueId, notice.teamId],
                  )
                ).rows[0]?.name,
            }),
            ...(notice.kind === "on-clock"
              ? { recipientPubkey: notice.recipientPubkey }
              : {}),
          });
          if (!/^[a-f0-9]{64}$/.test(result.eventId))
            throw Error("Signed Buzz event id missing");
          await tx.query(
            "UPDATE runtime_native_draft_notifications SET status='sent',event_id=$2,delivered_at=clock_timestamp() WHERE id=$1",
            [row.id, result.eventId],
          );
          return { status: "sent", id: row.id, eventId: result.eventId };
        } catch {
          await tx.query(
            "UPDATE runtime_native_draft_notifications SET status='uncertain',error='Buzz delivery outcome requires readback; automatic resend disabled' WHERE id=$1",
            [row.id],
          );
          return { status: "uncertain", id: row.id };
        }
      } finally {
        await tx.query("SELECT pg_advisory_unlock(hashtextextended($1,7044))", [
          actor.leagueId,
        ]);
        await tx.query("BEGIN");
      }
    });
  }
}
