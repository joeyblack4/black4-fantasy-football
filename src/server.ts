import { createDb, migrate } from "./db.js";
import { createApiServer } from "./api.js";
const db = createDb();
await migrate(db);
const server = createApiServer(db);
const port = Number(process.env.PORT ?? 4312),
  host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () =>
  console.log(
    `Black4 local workbench: http://${host}:${port} (not a live league)`,
  ),
);
async function close() {
  server.close();
  await db.end();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
