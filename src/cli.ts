import { readFile } from "node:fs/promises";
import { LeagueClient, LeagueClientError } from "./client.js";
import { z } from "zod";
import { MflOwnerActionSchema, MflOwnerReadSchema } from "./mfl/contracts.js";
import { nativeScheduleCommandSchema } from "./runtime/native-schedules.js";
const [action, arg, ...rest] = process.argv.slice(2);
if (!action || action === "help") {
  console.log(
    "Black4 league CLI\n  me\n  state LEAGUE_ID\n  operations\n  schedules [ID]\n  schedule-command JSON_OR_FILE\n  schedule-health (commissioner)\n  football-host\n  mfl-read JSON_OR_FILE\n  mfl-command JSON_OR_FILE\n  mfl-reconcile JSON_OR_FILE\n  agent AGENT_ID\n  command FILE.json\n  schedule AGENT_ID FILE.json\n  message AGENT_ID FILE.json\nSet FOOTBALL_API_TOKEN and optionally FOOTBALL_API_URL. Use - as file for stdin.",
  );
} else {
  try {
    const client = new LeagueClient(
      process.env.FOOTBALL_API_TOKEN ?? "",
      process.env.FOOTBALL_API_URL,
    );
    const input = async (file: string | undefined) => {
      if (!file) throw new Error("JSON file is required.");
      if (file !== "-") return JSON.parse(await readFile(file, "utf8"));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 1048576) throw new Error("Input exceeds one megabyte.");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    const mflInput = async () => {
      if (arg?.trimStart().startsWith("{")) return JSON.parse(arg);
      return input(arg);
    };
    const key = z.string().min(1).max(160);
    const id = () => {
      if (!arg) throw new Error("ID is required.");
      return encodeURIComponent(arg);
    };
    let result: unknown;
    switch (action) {
      case "season-health":
        result = await client.request("GET", "/v1/operations/season");
        break;
      case "schedules":
        result = await client.request(
          "GET",
          "/v1/owner/schedules" + (arg ? "?id=" + encodeURIComponent(arg) : ""),
        );
        break;
      case "schedule-command":
        result = await client.request(
          "POST",
          "/v1/owner/schedules",
          nativeScheduleCommandSchema.parse(await mflInput()),
        );
        break;
      case "schedule-health":
        result = await client.request("GET", "/v1/operations/schedules");
        break;
      case "me":
        result = await client.request("GET", "/v1/me");
        break;
      case "state":
        result = await client.request("GET", "/v1/leagues/" + id());
        break;
      case "football-host":
        result = await client.request("GET", "/v1/football/status");
        break;
      case "mfl-read":
        result = await client.request(
          "POST",
          "/v1/football/read",
          MflOwnerReadSchema.parse(await mflInput()),
        );
        break;
      case "mfl-command":
        result = await client.request(
          "POST",
          "/v1/football/commands",
          z
            .object({ idempotencyKey: key, action: MflOwnerActionSchema })
            .strict()
            .parse(await mflInput()),
        );
        break;
      case "mfl-reconcile":
        result = await client.request(
          "POST",
          "/v1/football/reconcile",
          z
            .object({ idempotencyKey: key })
            .strict()
            .parse(await mflInput()),
        );
        break;
      case "operations":
        result = await client.request("GET", "/v1/operations");
        break;
      case "agent":
        result = await client.request("GET", "/v1/agents/" + id());
        break;
      case "command":
        result = await client.request("POST", "/v1/commands", await input(arg));
        break;
      case "schedule":
        result = await client.request(
          "POST",
          "/v1/agents/" + id() + "/appointments",
          await input(rest[0]),
        );
        break;
      case "message":
        result = await client.request(
          "POST",
          "/v1/agents/" + id() + "/messages",
          await input(rest[0]),
        );
        break;
      default:
        throw new Error("Unknown command. Run npm run cli -- help.");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      error instanceof LeagueClientError
        ? JSON.stringify({
            status: error.status,
            error: error.code,
            message: error.message,
            details: error.details,
          })
        : error instanceof Error
          ? error.message
          : String(error),
    );
    process.exitCode = 1;
  }
}
