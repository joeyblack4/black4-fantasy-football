import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { hostBinding } from "../league/host.js";
import { fingerprint } from "../governance/validation.js";
import { MflError, PlayerId } from "./contracts.js";
const playerIds = z
  .array(PlayerId)
  .max(200)
  .refine((x) => new Set(x).size === x.length, "Duplicate queue player IDs");
export const MflLocalDraftQueueCommandSchema = z
  .object({
    type: z.literal("mflLocalDraftQueue"),
    expectedVersion: z.number().int().min(0).max(10000),
    playerIds,
  })
  .strict();
export const MflDraftQueueSaveSchema = z
  .object({
    leagueId: z.string().min(1).max(120),
    idempotencyKey: z.string().min(1).max(200),
    expectedVersion: MflLocalDraftQueueCommandSchema.shape.expectedVersion,
    playerIds,
  })
  .strict();
export type MflDraftQueueSave = z.infer<typeof MflDraftQueueSaveSchema>;
function check(value: unknown, code: string): asserts value {
  if (!value) throw new MflError(code);
}
async function scope(db: Db | Tx, actor: Actor) {
  check(actor.role === "owner" && actor.teamId, "MFL_OWNER_BINDING_REQUIRED");
  check(
    (
      await db.query(
        "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
        [actor.leagueId, actor.teamId, actor.id],
      )
    ).rowCount,
    "MFL_OWNER_BINDING_REQUIRED",
  );
  const host = await hostBinding(db, actor.leagueId);
  check(host.host === "mfl", "MFL_HOST_NOT_SELECTED");
  return host;
}
export class MflDraftQueueService {
  constructor(private db: Db) {}
  /** Preferences only. No MFL request or pick; the owner must issue an exact draft action after a fresh read. */
  async saveQueue(actor: Actor, input: unknown) {
    const command = MflDraftQueueSaveSchema.parse(input);
    check(actor.leagueId === command.leagueId, "MFL_OWNER_BINDING_REQUIRED");
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const host = await scope(tx, actor),
        hash = fingerprint({ actor, command, host });
      const old = (
        await tx.query(
          "SELECT * FROM mfl_draft_queue_receipts WHERE league_id=$1 AND owner_id=$2 AND idempotency_key=$3",
          [actor.leagueId, actor.id, command.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        check(old.payload_hash === hash, "MFL_QUEUE_IDEMPOTENCY_CONFLICT");
        return { ...old.response, replayed: true };
      }
      const prior = (
        await tx.query(
          "SELECT * FROM mfl_draft_queue_revisions WHERE league_id=$1 AND team_id=$2 AND host_version=$3 ORDER BY version DESC LIMIT 1",
          [actor.leagueId, actor.teamId, host.version],
        )
      ).rows[0];
      const currentVersion = prior?.version ?? 0;
      check(
        command.expectedVersion === currentVersion,
        "MFL_QUEUE_VERSION_CONFLICT",
      );
      const receiptId = randomUUID(),
        result = {
          teamId: actor.teamId,
          hostVersion: host.version,
          version: currentVersion + 1,
          playerIds: command.playerIds,
          source: "local-owner-preferences",
          nativeQueueUploaded: false,
          eligibility: "unchecked-until-fresh-mfl-read",
          automaticPickAuthorized: false,
        };
      const receipt = { receiptId, result, replayed: false };
      await tx.query(
        "INSERT INTO mfl_draft_queue_receipts(id,league_id,team_id,owner_id,host_version,idempotency_key,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          receiptId,
          actor.leagueId,
          actor.teamId,
          actor.id,
          host.version,
          command.idempotencyKey,
          hash,
          JSON.stringify(receipt),
        ],
      );
      await tx.query(
        "INSERT INTO mfl_draft_queue_revisions(league_id,team_id,host_version,version,player_ids,owner_id,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          actor.leagueId,
          actor.teamId,
          host.version,
          result.version,
          command.playerIds,
          actor.id,
          receiptId,
        ],
      );
      return receipt;
    });
  }
  async snapshot(actor: Actor) {
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const host = await scope(tx, actor);
      const row = (
        await tx.query(
          "SELECT * FROM mfl_draft_queue_revisions WHERE league_id=$1 AND team_id=$2 AND host_version=$3 AND owner_id=$4 ORDER BY version DESC LIMIT 1",
          [actor.leagueId, actor.teamId, host.version, actor.id],
        )
      ).rows[0];
      return {
        teamId: actor.teamId,
        hostVersion: host.version,
        version: row?.version ?? 0,
        playerIds: row?.player_ids ?? [],
        receiptId: row?.receipt_id ?? null,
        updatedAt: row?.created_at ?? null,
        source: "local-owner-preferences",
        nativeQueueUploaded: false,
        eligibility: "unchecked-until-fresh-mfl-read",
        automaticPickAuthorized: false,
      };
    });
  }
  /** Dispatcher read-back in its own transaction. Checks exact request, current binding and persisted revision. */
  async verifyReceipt(tx: Tx, actor: Actor, input: unknown, receiptId: string) {
    const command = MflDraftQueueSaveSchema.parse(input);
    check(command.leagueId === actor.leagueId, "MFL_OWNER_BINDING_REQUIRED");
    const host = await scope(tx, actor);
    const hash = fingerprint({ actor, command, host });
    const row = (
      await tx.query(
        "SELECT r.*,q.player_ids,q.version FROM mfl_draft_queue_receipts r JOIN mfl_draft_queue_revisions q ON q.receipt_id=r.id WHERE r.id=$1 AND r.league_id=$2 AND r.owner_id=$3 AND r.team_id=$4",
        [receiptId, actor.leagueId, actor.id, actor.teamId],
      )
    ).rows[0];
    check(
      row &&
        row.host_version === host.version &&
        row.idempotency_key === command.idempotencyKey &&
        row.payload_hash === hash,
      "MFL_QUEUE_RECEIPT_MISMATCH",
    );
    check(
      row.version === command.expectedVersion + 1 &&
        fingerprint(row.player_ids) === fingerprint(command.playerIds),
      "MFL_QUEUE_RECEIPT_MISMATCH",
    );
    check(
      row.response.receiptId === row.id &&
        row.response.result.version === row.version &&
        fingerprint(row.response.result.playerIds) ===
          fingerprint(row.player_ids),
      "MFL_QUEUE_RECEIPT_MISMATCH",
    );
    return row.response;
  }
}
