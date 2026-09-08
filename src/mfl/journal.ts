import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { MflJournal, MflJournalSession, MflReceipt } from "./contracts.js";
/** Existing append-only runtime_receipts; no model grants or raw upstream payloads. */
export class PgMflJournal implements MflJournal {
  constructor(private db: Db) {}
  async withLock<T>(
    scope: string,
    work: (session: MflJournalSession) => Promise<T>,
  ): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,7066))", [
        scope,
      ]);
      const append = async (type: string, details: Record<string, unknown>) => {
        const row = (
          await client.query(
            "INSERT INTO runtime_receipts(type,details) VALUES($1,$2) RETURNING created_at",
            [type, { ...details, scope }],
          )
        ).rows[0];
        return { ...details, at: row.created_at.toISOString() };
      };
      return await work({
        cached: async (key, age) => {
          const row = (
            await client.query(
              "SELECT details->'data' AS data FROM runtime_receipts WHERE type='mfl_read' AND details->>'scope'=$1 AND details->>'cacheKey'=$2 AND created_at <= clock_timestamp() AND created_at > clock_timestamp()-$3::int*interval '1 second' ORDER BY seq DESC LIMIT 1",
              [scope, key, age],
            )
          ).rows[0];
          return row?.data ?? null;
        },
        beforeRequest: async (interval) => {
          await client.query(
            "SELECT pg_sleep(GREATEST(0,$2::numeric/1000 - EXTRACT(EPOCH FROM clock_timestamp() - COALESCE((SELECT max(created_at) FROM runtime_receipts WHERE type='mfl_read' AND details->>'scope'=$1),clock_timestamp()-interval '1 hour'))))",
            [scope, interval],
          );
        },
        find: async (key) => {
          const row = (
            await client.query(
              "SELECT details,created_at FROM runtime_receipts WHERE type='mfl_operation' AND details->>'scope'=$1 AND details->>'idempotencyKey'=$2 ORDER BY seq DESC LIMIT 1",
              [scope, key],
            )
          ).rows[0];
          return row
            ? { ...row.details, at: row.created_at.toISOString() }
            : null;
        },
        unresolved: async () => {
          const rows = (
            await client.query(
              "SELECT * FROM (SELECT DISTINCT ON(details->>'idempotencyKey') details,created_at FROM runtime_receipts WHERE type='mfl_operation' AND details->>'scope'=$1 ORDER BY details->>'idempotencyKey',seq DESC) t WHERE details->>'state' IN ('prepared','submitted','unknown')",
              [scope],
            )
          ).rows;
          return rows.map((r) => ({
            ...r.details,
            at: r.created_at.toISOString(),
          }));
        },
        append: async (receipt) =>
          (await append("mfl_operation", receipt)) as MflReceipt,
        recordRead: async (data) => {
          const id = randomUUID(),
            row = await append("mfl_read", { ...data, id });
          return { id, at: row.at };
        },
      });
    } finally {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,7066))",
          [scope],
        );
      } finally {
        client.release();
      }
    }
  }
}
