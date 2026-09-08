import { RuntimeStore } from "../runtime/index.js";
import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import {
  FranchiseActionSchema,
  PrepareBatchSchema,
  ApproveBatchSchema,
  ReviewServiceSchema,
  type LocalFranchiseAction,
} from "./schema.js";
export class FranchiseError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
export function guard(value: unknown, code: string): asserts value {
  if (!value) throw new FranchiseError(code);
}
export function canonical(value: unknown): string {
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
export function fingerprint(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export type FranchiseReceipt = {
  receiptId: string;
  result: Record<string, unknown>;
  replayed: boolean;
};
export class FranchiseService {
  constructor(readonly db: Db) {}
  private async leagueLock(tx: Tx, leagueId: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7131))", [
      leagueId,
    ]);
  }
  private async owner(tx: Tx, actor: Actor, agentId: string) {
    guard(actor.role === "owner" && actor.teamId, "FORBIDDEN");
    const row = (
      await tx.query(
        "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1",
        [agentId],
      )
    ).rows[0];
    guard(
      row &&
        row.league_id === actor.leagueId &&
        row.team_id === actor.teamId &&
        row.owner_id === actor.id,
      "FRANCHISE_FORBIDDEN",
    );
    return row;
  }
  private commissioner(actor: Actor) {
    guard(actor.role === "commissioner", "FORBIDDEN");
  }
  async execute(
    actor: Actor,
    input: {
      agentId: string;
      idempotencyKey: string;
      action: LocalFranchiseAction;
    },
  ): Promise<FranchiseReceipt> {
    const action = FranchiseActionSchema.parse(input.action);
    guard(action.type !== "governance", "GOVERNANCE_ADAPTER_REQUIRED");
    guard(action.type !== "buzz_channel", "BUZZ_CHANNEL_ADAPTER_REQUIRED");
    guard(
      input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 200,
      "INVALID_IDEMPOTENCY_KEY",
    );
    const hash = fingerprint({ actor, agentId: input.agentId, action });
    return transaction(this.db, async (tx) => {
      await this.leagueLock(tx, actor.leagueId);
      await this.owner(tx, actor, input.agentId);
      const old = (
        await tx.query(
          "SELECT * FROM franchise_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [actor.leagueId, actor.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        guard(old.fingerprint === hash, "IDEMPOTENCY_CONFLICT");
        return { receiptId: old.id, result: old.result, replayed: true };
      }
      const receiptId = randomUUID();
      await tx.query(
        "INSERT INTO franchise_receipts(id,league_id,agent_id,actor_id,idempotency_key,fingerprint,type,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          receiptId,
          actor.leagueId,
          input.agentId,
          actor.id,
          input.idempotencyKey,
          hash,
          action.type,
          "{}",
        ],
      );
      let result: Record<string, unknown>;
      if (action.type === "brand") {
        const { type, causalId, ...brand } = action;
        const contentHash = fingerprint(brand);
        const version = (
          await tx.query(
            "SELECT COALESCE(max(version),0)+1 AS next FROM franchise_brand_versions WHERE league_id=$1 AND team_id=$2",
            [actor.leagueId, actor.teamId],
          )
        ).rows[0].next;
        await tx.query(
          "INSERT INTO franchise_brand_versions(league_id,team_id,version,payload,content_hash,receipt_id) VALUES($1,$2,$3,$4,$5,$6)",
          [
            actor.leagueId,
            actor.teamId,
            version,
            JSON.stringify(brand),
            contentHash,
            receiptId,
          ],
        );
        result = {
          kind: "brand.saved",
          teamId: actor.teamId,
          version,
          contentHash,
          artifactPolicy: "inert-source-only",
          published: false,
        };
      } else if (action.type === "service_request") {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO franchise_service_requests(id,league_id,team_id,agent_id,service,purpose,max_cost_micros,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            actor.leagueId,
            actor.teamId,
            input.agentId,
            action.service,
            action.purpose,
            action.maxCostMicros,
            receiptId,
          ],
        );
        result = {
          kind: "service.requested",
          requestId: id,
          status: "requested",
          chargedMicros: 0,
          provisioned: false,
        };
      } else {
        const content = {
          teamId: actor.teamId,
          draftId: action.draftId,
          title: action.title,
          body: action.body,
          channel: action.channel,
        };
        const contentHash = fingerprint(content);
        const version = (
          await tx.query(
            "SELECT COALESCE(max(version),0)+1 AS next FROM franchise_draft_versions WHERE league_id=$1 AND team_id=$2 AND draft_id=$3",
            [actor.leagueId, actor.teamId, action.draftId],
          )
        ).rows[0].next;
        await tx.query(
          "INSERT INTO franchise_draft_versions(league_id,team_id,draft_id,version,title,body,channel,content_hash,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            actor.leagueId,
            actor.teamId,
            action.draftId,
            version,
            action.title,
            action.body,
            action.channel,
            contentHash,
            receiptId,
          ],
        );
        // Updating a draft cannot inherit authorization for an earlier reviewed batch.
        await tx.query(
          "UPDATE franchise_publication_batches SET status='revoked' WHERE league_id=$1 AND status IN ('prepared','approved') AND EXISTS(SELECT 1 FROM jsonb_array_elements(items) i WHERE i->>'teamId'=$2 AND i->>'draftId'=$3)",
          [actor.leagueId, actor.teamId, action.draftId],
        );
        result = {
          kind: "public_draft.saved",
          draftId: action.draftId,
          teamId: actor.teamId,
          version,
          contentHash,
          published: false,
        };
      }
      await tx.query("UPDATE franchise_receipts SET result=$2 WHERE id=$1", [
        receiptId,
        JSON.stringify(result),
      ]);
      return { receiptId, result, replayed: false };
    });
  }
  async prepareBatch(actor: Actor, input: unknown) {
    this.commissioner(actor);
    const request = PrepareBatchSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.leagueLock(tx, actor.leagueId);
      const keys = request.items.map((i) => i.teamId + ":" + i.draftId);
      guard(new Set(keys).size === keys.length, "DUPLICATE_BATCH_ITEM");
      const items: Record<string, unknown>[] = [];
      for (const item of [...request.items].sort((a, b) =>
        (a.teamId + ":" + a.draftId).localeCompare(b.teamId + ":" + b.draftId),
      )) {
        const row = (
          await tx.query(
            "SELECT * FROM franchise_draft_versions WHERE league_id=$1 AND team_id=$2 AND draft_id=$3 ORDER BY version DESC LIMIT 1",
            [actor.leagueId, item.teamId, item.draftId],
          )
        ).rows[0];
        guard(
          row &&
            row.version === item.version &&
            row.content_hash === item.contentHash,
          "DRAFT_VERSION_CHANGED",
        );
        const content = {
          teamId: row.team_id,
          draftId: row.draft_id,
          title: row.title,
          body: row.body,
          channel: row.channel,
        };
        guard(
          fingerprint(content) === row.content_hash,
          "DRAFT_INTEGRITY_FAILURE",
        );
        items.push({
          ...content,
          version: row.version,
          contentHash: row.content_hash,
        });
      }
      const contentHash = fingerprint(items);
      const old = (
        await tx.query(
          "SELECT * FROM franchise_publication_batches WHERE league_id=$1 AND content_hash=$2",
          [actor.leagueId, contentHash],
        )
      ).rows[0];
      if (old) return old;
      const id = randomUUID();
      const row = (
        await tx.query(
          "INSERT INTO franchise_publication_batches(id,league_id,content_hash,items,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id, actor.leagueId, contentHash, JSON.stringify(items), actor.id],
        )
      ).rows[0];
      await this.operatorReceipt(tx, actor, "publication.prepared", {
        batchId: id,
        contentHash,
      });
      return row;
    });
  }
  async approveBatch(actor: Actor, input: unknown) {
    this.commissioner(actor);
    const request = ApproveBatchSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.leagueLock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "SELECT * FROM franchise_publication_batches WHERE id=$1 AND league_id=$2 FOR UPDATE",
          [request.batchId, actor.leagueId],
        )
      ).rows[0];
      guard(
        row &&
          row.status !== "revoked" &&
          row.content_hash === request.contentHash &&
          fingerprint(row.items) === request.contentHash,
        "BATCH_CHANGED_OR_REVOKED",
      );
      const old = (
        await tx.query(
          "SELECT * FROM franchise_publication_approvals WHERE batch_id=$1",
          [row.id],
        )
      ).rows[0];
      if (old) return old;
      const approval = (
        await tx.query(
          "INSERT INTO franchise_publication_approvals(id,batch_id,content_hash,approved_by) VALUES($1,$2,$3,$4) RETURNING *",
          [randomUUID(), row.id, row.content_hash, actor.id],
        )
      ).rows[0];
      await tx.query(
        "UPDATE franchise_publication_batches SET status='approved' WHERE id=$1",
        [row.id],
      );
      await this.operatorReceipt(tx, actor, "publication.approved", {
        batchId: row.id,
        contentHash: row.content_hash,
        approvalId: approval.id,
      });
      for (const teamId of [
        ...new Set<string>(row.items.map((item: any) => item.teamId)),
      ]) {
        const binding = (
          await tx.query(
            "SELECT agent_id FROM runtime_bindings WHERE league_id=$1 AND team_id=$2",
            [actor.leagueId, teamId],
          )
        ).rows[0];
        if (binding)
          await new RuntimeStore(this.db).ingestEventTx(tx, {
            agentId: binding.agent_id,
            causalId: "publication-approved:" + row.id,
            payload: {
              kind: "publication.approved",
              batchId: row.id,
              contentHash: row.content_hash,
              published: false,
            },
          });
      }
      return approval;
    });
  }
  async revokeBatch(actor: Actor, batchId: string) {
    this.commissioner(actor);
    return transaction(this.db, async (tx) => {
      await this.leagueLock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "UPDATE franchise_publication_batches SET status='revoked' WHERE id=$1 AND league_id=$2 RETURNING *",
          [batchId, actor.leagueId],
        )
      ).rows[0];
      guard(row, "BATCH_NOT_FOUND");
      await this.operatorReceipt(tx, actor, "publication.revoked", { batchId });
      return row;
    });
  }
  /** Read exact approved snapshots for a future publisher. Does not send or claim publication. */
  async approvedBatch(actor: Actor, batchId: string) {
    this.commissioner(actor);
    const row = (
      await this.db.query(
        "SELECT b.*,a.id AS approval_id,a.approved_by FROM franchise_publication_batches b JOIN franchise_publication_approvals a ON a.batch_id=b.id AND a.content_hash=b.content_hash WHERE b.id=$1 AND b.league_id=$2 AND b.status='approved'",
        [batchId, actor.leagueId],
      )
    ).rows[0];
    guard(
      row && fingerprint(row.items) === row.content_hash,
      "BATCH_NOT_APPROVED",
    );
    return row;
  }
  async reviewService(actor: Actor, input: unknown) {
    this.commissioner(actor);
    const request = ReviewServiceSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.leagueLock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "SELECT * FROM franchise_service_requests WHERE id=$1 AND league_id=$2 FOR UPDATE",
          [request.requestId, actor.leagueId],
        )
      ).rows[0];
      guard(row, "SERVICE_REQUEST_NOT_FOUND");
      if (row.status !== "requested") {
        guard(
          row.status === request.decision && row.review_note === request.note,
          "SERVICE_REVIEW_CONFLICT",
        );
        return row;
      }
      const updated = (
        await tx.query(
          "UPDATE franchise_service_requests SET status=$2,review_note=$3,reviewed_by=$4,reviewed_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [row.id, request.decision, request.note, actor.id],
        )
      ).rows[0];
      await this.operatorReceipt(tx, actor, "service.reviewed", {
        requestId: row.id,
        decision: request.decision,
        provisioned: false,
        chargedMicros: 0,
      });
      await new RuntimeStore(this.db).ingestEventTx(tx, {
        agentId: row.agent_id,
        causalId: "service-reviewed:" + row.id,
        payload: {
          kind: "service.reviewed",
          requestId: row.id,
          decision: request.decision,
          note: request.note,
          provisioned: false,
          chargedMicros: 0,
        },
      });
      return updated;
    });
  }
  private async operatorReceipt(
    tx: Tx,
    actor: Actor,
    type: string,
    result: unknown,
  ) {
    await tx.query(
      "INSERT INTO franchise_operator_receipts(id,league_id,actor_id,type,result) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), actor.leagueId, actor.id, type, JSON.stringify(result)],
    );
  }
  async snapshot(actor: Actor) {
    guard(actor.role === "owner" || actor.role === "commissioner", "FORBIDDEN");
    if (actor.role === "owner")
      guard(
        (
          await this.db.query(
            "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
            [actor.leagueId, actor.teamId, actor.id],
          )
        ).rowCount,
        "FRANCHISE_FORBIDDEN",
      );
    const team = actor.role === "owner" ? actor.teamId : null;
    const [brands, drafts, services, receipts] = await Promise.all([
      this.db.query(
        "SELECT * FROM franchise_brand_versions WHERE league_id=$1 AND ($2::text IS NULL OR team_id=$2) ORDER BY team_id,version DESC",
        [actor.leagueId, team],
      ),
      this.db.query(
        "SELECT * FROM franchise_draft_versions WHERE league_id=$1 AND ($2::text IS NULL OR team_id=$2) ORDER BY team_id,draft_id,version DESC",
        [actor.leagueId, team],
      ),
      this.db.query(
        "SELECT * FROM franchise_service_requests WHERE league_id=$1 AND ($2::text IS NULL OR team_id=$2) ORDER BY created_at DESC",
        [actor.leagueId, team],
      ),
      this.db.query(
        "SELECT * FROM franchise_receipts WHERE league_id=$1 AND ($2::text IS NULL OR actor_id=$2) ORDER BY created_at DESC",
        [actor.leagueId, actor.role === "owner" ? actor.id : null],
      ),
    ]);
    return {
      brands: brands.rows,
      drafts: drafts.rows,
      serviceRequests: services.rows,
      receipts: receipts.rows,
    };
  }
}
