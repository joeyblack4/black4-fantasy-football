import { createDb, migrate } from "../src/db.js";
const db = createDb();
try {
  await migrate(db);
  console.log("Migrations applied.");
} finally {
  await db.end();
}
