import { randomUUID } from "node:crypto";
import twitterText from "twitter-text";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { FranchiseService, fingerprint } from "../franchise/service.js";
import { RuntimeStore } from "../runtime/index.js";

/** Primary contracts verified 2026-09-07:
 * https://docs.x.com/x-api/users/get-my-user
 * https://docs.x.com/x-api/posts/create-post
 * https://docs.x.com/fundamentals/counting-characters
 * OAuth2 user context requires tweet.read, tweet.write, users.read.
 * No app-only token, Premium limit, media, replies, or inferred API price.
 */
export const EnqueueXSchema = z
  .object({ batchId: z.uuid(), dueAt: z.iso.datetime({ offset: true }) })
  .strict();
export class XPublicationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new XPublicationError(code);
}
export type XResponse = { status: number; body: unknown };
export type XTransport = (input: {
  method: "GET" | "POST";
  path: "/2/users/me" | "/2/tweets";
  token: string;
  body?: { text: string };
}) => Promise<XResponse>;
export type XPublisherOptions = {
  leagueId: string;
  userAccessToken?: string;
  enabled?: boolean;
  transport?: XTransport;
};

/** Fixed origin, bounded timeout/body and no redirects; response bodies never enter logs. */
export const xTransport: XTransport = async (input) => {
  const response = await fetch("https://api.x.com" + input.path, {
    method: input.method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: "Bearer " + input.token,
      "content-type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const reader = response.body?.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("X_RESPONSE_TOO_LARGE");
      }
      parts.push(value);
    }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

/** Official parser applies the standard 280 weighted-character contract. The
 * approved body is never normalized, trimmed, truncated, or rewritten here. */
export function validateXText(text: string): void {
  check(
    text.trim().length > 0 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text),
    "INVALID_X_TEXT",
  );
  const parsed = twitterText.parseTweet(text);
  check(parsed.weightedLength <= 280, "X_TEXT_TOO_LONG");
  check(parsed.valid, "INVALID_X_TEXT");
}

type Item = {
  teamId: string;
  draftId: string;
  title: string;
  body: string;
  channel: "x";
  version: number;
  contentHash: string;
};
const ItemSchema = z
  .object({
    teamId: z.string(),
    draftId: z.string(),
    title: z.string(),
    body: z.string(),
    channel: z.literal("x"),
    version: z.number().int().positive(),
    contentHash: z.string(),
  })
  .strict();

export class XPublisher {
  constructor(
    readonly db: Db,
    readonly options: XPublisherOptions,
  ) {}
  private scope(actor: Actor, role: "commissioner" | "system") {
    check(
      actor.role === role && actor.leagueId === this.options.leagueId,
      "FORBIDDEN",
    );
  }
  private async lock(tx: Tx) {
    // Same lock order as franchise draft creation, approval and revocation.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7131))", [
      this.options.leagueId,
    ]);
  }
  private async approved(
    tx: Tx,
    batchId: string,
    expected?: { approval_id: string; content_hash: string },
  ) {
    const b = (
      await tx.query(
        `SELECT b.*,a.id approval_id FROM franchise_publication_batches b
      JOIN franchise_publication_approvals a ON a.batch_id=b.id AND a.content_hash=b.content_hash
      WHERE b.id=$1 AND b.league_id=$2 AND b.status='approved' FOR UPDATE OF b`,
        [batchId, this.options.leagueId],
      )
    ).rows[0];
    check(b && fingerprint(b.items) === b.content_hash, "BATCH_NOT_APPROVED");
    if (expected)
      check(
        b.approval_id === expected.approval_id &&
          b.content_hash === expected.content_hash,
        "BATCH_CHANGED",
      );
    const parsed = z.array(ItemSchema).min(1).max(100).safeParse(b.items);
    check(parsed.success, "X_TEXT_ONLY_BATCH_REQUIRED");
    const items: Item[] = parsed.data;
    for (const item of items) {
      validateXText(item.body);
      const latest = (
        await tx.query(
          `SELECT * FROM franchise_draft_versions WHERE league_id=$1 AND team_id=$2 AND draft_id=$3 ORDER BY version DESC LIMIT 1`,
          [this.options.leagueId, item.teamId, item.draftId],
        )
      ).rows[0];
      const { version, contentHash, ...content } = item;
      check(
        latest &&
          latest.version === version &&
          latest.content_hash === contentHash &&
          fingerprint(content) === contentHash &&
          latest.body === item.body,
        "DRAFT_VERSION_CHANGED",
      );
    }
    return { ...b, items };
  }
  async enqueue(actor: Actor, input: unknown) {
    this.scope(actor, "commissioner");
    const request = EnqueueXSchema.parse(input);
    // Establish the existing franchise approval contract, then revalidate under its lock.
    await new FranchiseService(this.db).approvedBatch(actor, request.batchId);
    return transaction(this.db, async (tx) => {
      await this.lock(tx);
      const b = await this.approved(tx, request.batchId);
      const old = (
        await tx.query(
          "SELECT * FROM x_publication_schedules WHERE batch_id=$1",
          [b.id],
        )
      ).rows[0];
      if (old) {
        check(
          new Date(old.due_at).getTime() === new Date(request.dueAt).getTime(),
          "SCHEDULE_CONFLICT",
        );
        return { ...old, replayed: true };
      }
      const schedule = (
        await tx.query(
          `INSERT INTO x_publication_schedules(id,league_id,batch_id,approval_id,content_hash,due_at,scheduled_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            randomUUID(),
            actor.leagueId,
            b.id,
            b.approval_id,
            b.content_hash,
            request.dueAt,
            actor.id,
          ],
        )
      ).rows[0];
      for (const [index, item] of b.items.entries())
        await tx.query(
          `INSERT INTO x_publication_items
        (id,schedule_id,league_id,item_index,team_id,draft_id,draft_version,content_hash,text_body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            schedule.id,
            actor.leagueId,
            index,
            item.teamId,
            item.draftId,
            item.version,
            item.contentHash,
            item.body,
          ],
        );
      return { ...schedule, replayed: false };
    });
  }
  async snapshot(actor: Actor) {
    this.scope(actor, "commissioner");
    return (
      await this.db.query(
        `SELECT s.batch_id,s.due_at,i.* FROM x_publication_items i JOIN x_publication_schedules s ON s.id=i.schedule_id WHERE i.league_id=$1 ORDER BY s.created_at,i.item_index`,
        [actor.leagueId],
      )
    ).rows;
  }
  private async finish(
    item: any,
    status: string,
    details: {
      code?: string;
      httpStatus?: number;
      userId?: string;
      tweetId?: string;
    } = {},
  ) {
    const row = (
      await this.db.query(
        `UPDATE x_publication_items SET status=$3,finished_at=clock_timestamp(),error_code=$4,response_status=$5,
      user_id=COALESCE($6,user_id),tweet_id=$7,receipt=jsonb_build_object('publicationId',id,'status',$3::text,'errorCode',$4::text,
      'tweetId',$7::text,'userId',COALESCE($6,user_id),'sendStartedAt',send_started_at,'completedAt',clock_timestamp(),
      'billingStatus','unknown','costMicros',NULL,'contentHash',content_hash)
      WHERE id=$1 AND attempt_id=$2 AND status IN ('checking','sending') RETURNING *`,
        [
          item.id,
          item.attempt_id,
          status,
          details.code ?? null,
          details.httpStatus ?? null,
          details.userId ?? null,
          details.tweetId ?? null,
        ],
      )
    ).rows[0];
    return (
      row ??
      (
        await this.db.query("SELECT * FROM x_publication_items WHERE id=$1", [
          item.id,
        ])
      ).rows[0]
    );
  }
  /** Durable result precedes notification. Failed delivery is retried with a stable causal ID. */
  async deliverReceipts(actor: Actor) {
    this.scope(actor, "system");
    const rows = (
      await this.db.query(
        `SELECT id FROM x_publication_items WHERE league_id=$1 AND receipt IS NOT NULL AND wake_delivered_at IS NULL ORDER BY finished_at LIMIT 50`,
        [actor.leagueId],
      )
    ).rows;
    let delivered = 0;
    for (const row of rows)
      await transaction(this.db, async (tx) => {
        const item = (
          await tx.query(
            "SELECT * FROM x_publication_items WHERE id=$1 FOR UPDATE",
            [row.id],
          )
        ).rows[0];
        if (item.wake_delivered_at) return;
        const binding = (
          await tx.query(
            "SELECT agent_id FROM runtime_bindings WHERE league_id=$1 AND team_id=$2",
            [item.league_id, item.team_id],
          )
        ).rows[0];
        if (!binding) return;
        await new RuntimeStore(this.db).ingestEventTx(tx, {
          agentId: binding.agent_id,
          causalId: "x-publication:" + item.id,
          payload: { kind: "publication.x_result", ...item.receipt },
        });
        await tx.query(
          "UPDATE x_publication_items SET wake_delivered_at=clock_timestamp() WHERE id=$1",
          [item.id],
        );
        delivered++;
      });
    return { delivered };
  }
  /** A stalled claim is never retried. An interrupted POST requires manual reconciliation. */
  async recover(actor: Actor) {
    this.scope(actor, "system");
    const rows = (
      await this.db.query(
        `SELECT * FROM x_publication_items WHERE league_id=$1 AND status IN ('checking','sending') AND claimed_at<clock_timestamp()-interval '2 minutes'`,
        [actor.leagueId],
      )
    ).rows;
    for (const row of rows)
      await this.finish(
        row,
        row.status === "sending" ? "uncertain" : "rejected",
        {
          code:
            row.status === "sending"
              ? "POST_OUTCOME_UNKNOWN"
              : "CHECK_INTERRUPTED",
        },
      );
    return { recovered: rows.length };
  }
  async tick(actor: Actor) {
    this.scope(actor, "system");
    if (!this.options.enabled || !this.options.userAccessToken)
      return {
        status: "disabled",
        reason: "X_PUBLISHING_NOT_CONFIGURED",
        billingStatus: "unknown",
      };
    await this.recover(actor);
    const item = await transaction(this.db, async (tx) => {
      const row = (
        await tx.query(
          `SELECT i.*,s.batch_id,s.approval_id,s.content_hash batch_hash FROM x_publication_items i
        JOIN x_publication_schedules s ON s.id=i.schedule_id WHERE i.league_id=$1 AND i.status='pending' AND s.due_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM x_publication_items earlier WHERE earlier.schedule_id=i.schedule_id AND earlier.item_index<i.item_index AND earlier.status<>'published')
        ORDER BY s.due_at,i.item_index FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
          [actor.leagueId],
        )
      ).rows[0];
      if (!row) return null;
      const attemptId = randomUUID();
      await tx.query(
        `UPDATE x_publication_items SET status='checking',attempt_id=$2,claimed_at=clock_timestamp() WHERE id=$1`,
        [row.id, attemptId],
      );
      return { ...row, attempt_id: attemptId };
    });
    if (!item) {
      await this.deliverReceipts(actor);
      return { status: "idle" };
    }
    // Even the account lookup requires an approval that is still valid now.
    try {
      await transaction(this.db, async (tx) => {
        await this.lock(tx);
        await this.approved(tx, item.batch_id, {
          approval_id: item.approval_id,
          content_hash: item.batch_hash,
        });
      });
    } catch (error) {
      await this.finish(item, "cancelled", {
        code:
          error instanceof XPublicationError
            ? error.code
            : "APPROVAL_CHECK_FAILED",
      });
      return { status: "cancelled", publicationId: item.id };
    }
    const transport = this.options.transport ?? xTransport,
      token = this.options.userAccessToken;
    let me: XResponse;
    try {
      me = await transport({ method: "GET", path: "/2/users/me", token });
    } catch {
      const result = await this.finish(item, "rejected", {
        code: "ACCOUNT_CHECK_FAILED",
      });
      return { status: result.status, publicationId: item.id };
    }
    const identity = z
      .object({
        data: z.object({ id: z.string().regex(/^\d+$/), username: z.string() }),
      })
      .safeParse(me.body);
    if (
      me.status !== 200 ||
      !identity.success ||
      identity.data.data.username.toLowerCase() !== "black4fantasy"
    ) {
      await this.finish(item, "rejected", {
        code: "X_ACCOUNT_MISMATCH_OR_UNVERIFIED",
        httpStatus: me.status,
      });
      return { status: "rejected", publicationId: item.id };
    }
    const userId = identity.data.data.id;
    // Commit sending before the external mutation: crashes from this point retain uncertainty.
    await this.db.query(
      `UPDATE x_publication_items SET status='sending',user_id=$3 WHERE id=$1 AND attempt_id=$2 AND status='checking'`,
      [item.id, item.attempt_id, userId],
    );
    let result: any;
    try {
      result = await transaction(this.db, async (tx) => {
        await this.lock(tx);
        const current = (
          await tx.query(
            "SELECT * FROM x_publication_items WHERE id=$1 FOR UPDATE",
            [item.id],
          )
        ).rows[0];
        check(
          current.status === "sending" &&
            current.attempt_id === item.attempt_id,
          "ATTEMPT_NO_LONGER_ACTIVE",
        );
        const batch = await this.approved(tx, item.batch_id, {
          approval_id: item.approval_id,
          content_hash: item.batch_hash,
        });
        const approvedItem = batch.items[current.item_index];
        check(
          approvedItem &&
            approvedItem.body === current.text_body &&
            current.text_body === item.text_body &&
            approvedItem.contentHash === current.content_hash &&
            approvedItem.version === current.draft_version,
          "SCHEDULE_ITEM_CHANGED",
        );
        const account = (
          await tx.query(
            "SELECT * FROM x_publication_accounts WHERE league_id=$1 FOR UPDATE",
            [actor.leagueId],
          )
        ).rows[0];
        check(!account || account.user_id === userId, "X_ACCOUNT_ID_CHANGED");
        if (!account)
          await tx.query(
            `INSERT INTO x_publication_accounts(league_id,user_id,username) VALUES($1,$2,'black4fantasy')`,
            [actor.leagueId, userId],
          );
        await tx.query(
          `UPDATE x_publication_items SET send_started_at=clock_timestamp() WHERE id=$1`,
          [item.id],
        );
        // Franchise lock prevents approved content or revocation changing while this bounded POST is in flight.
        // No redirect or retry; even a successful HTTP response without a usable ID is uncertain.
        let response: XResponse;
        try {
          response = await transport({
            method: "POST",
            path: "/2/tweets",
            token,
            body: { text: item.text_body },
          });
        } catch {
          return { status: "uncertain", code: "POST_OUTCOME_UNKNOWN" };
        }
        const tweet = z
          .object({ data: z.object({ id: z.string().regex(/^\d+$/) }) })
          .safeParse(response.body);
        if (response.status >= 200 && response.status < 300 && tweet.success)
          return {
            status: "published",
            tweetId: tweet.data.data.id,
            httpStatus: response.status,
          };
        if (response.status >= 400 && response.status < 500)
          return {
            status: "rejected",
            code: "X_POST_REJECTED",
            httpStatus: response.status,
          };
        return {
          status: "uncertain",
          code: "POST_OUTCOME_UNKNOWN",
          httpStatus: response.status,
        };
      });
    } catch (error) {
      result = {
        status: error instanceof XPublicationError ? "cancelled" : "uncertain",
        code:
          error instanceof XPublicationError
            ? error.code
            : "POST_OUTCOME_UNKNOWN",
      };
    }
    const finished = await this.finish(item, result.status, {
      ...result,
      userId,
    });
    // Notification failures must never cause publication to retry or lose its known tweet ID.
    try {
      await this.deliverReceipts(actor);
    } catch {
      /* Durable wake pending for next tick. */
    }
    return {
      status: finished.status,
      publicationId: item.id,
      receipt: finished.receipt,
    };
  }
}
