import pg from "pg";
import { randomUUID } from "node:crypto";
import { createDb, migrate } from "../src/db.js";
export async function testDb() {
  const schema = "test_" + randomUUID().replaceAll("-", "");
  const admin = createDb();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://localhost/black4_football_dev",
    options: `-c search_path=${schema}`,
    max: 12,
  });
  await migrate(db);
  return {
    db,
    schema,
    async close() {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
