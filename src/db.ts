import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export function createDb(
  url = process.env.DATABASE_URL ??
    "postgresql://localhost/black4_football_dev",
): Db {
  return new pg.Pool({ connectionString: url, max: 12 });
}
export async function transaction<T>(
  db: Db,
  work: (client: Tx) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(db: Db): Promise<void> {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(78441221)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const exists = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (exists.rowCount) continue;
      await client.query(await readFile(dir + name, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name,
      ]);
    }
  });
}
