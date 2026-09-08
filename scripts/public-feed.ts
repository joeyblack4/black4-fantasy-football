import { createDb } from "../src/db.js";
import { createPublicServer } from "../src/publication/projection.js";
if (
  !process.env.FOOTBALL_LEAGUE_ID ||
  !process.env.FOOTBALL_PUBLIC_DATABASE_URL
)
  throw Error(
    "A league and SELECT-only public database credential are required.",
  );
const db = createDb(process.env.FOOTBALL_PUBLIC_DATABASE_URL);
const server = createPublicServer(db, process.env.FOOTBALL_LEAGUE_ID);
server.listen(Number(process.env.FOOTBALL_PUBLIC_PORT ?? 4316), "127.0.0.1");
for (const s of ["SIGINT", "SIGTERM"])
  process.once(s, () => {
    server.close();
    void db.end();
  });
