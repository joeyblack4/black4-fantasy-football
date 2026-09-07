import pg from "pg";
import { RuntimeStore } from "../src/runtime/index.js";
const schema = process.env.RUNTIME_TEST_SCHEMA;
if (!schema || !/^test_[a-f0-9]+$/.test(schema))
  throw new Error("Isolated schema required");
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://joey@localhost/black4_football_dev",
  options: `-c search_path=${schema}`,
});
const store = new RuntimeStore(db);
const claim = await store.claim("OS_PROCESS_TO_KILL", 500);
if (!claim) throw new Error("No job to claim");
const reservationId = await store.reserve(claim, 100);
process.stdout.write(JSON.stringify({ claim, reservationId }) + "\n");
setInterval(() => {}, 1000); // Parent deliberately SIGKILLs after a committed claim and reservation.
