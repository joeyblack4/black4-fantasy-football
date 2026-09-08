import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { leagueCommandSchema } from "./league/schema.js";
import { ScheduleSchema, MessageSchema } from "./runtime/worker.js";
import { LeagueClient } from "./client.js";
import { governanceCommandSchema } from "./governance/schema.js";
import { MflOwnerActionSchema, MflOwnerReadSchema } from "./mfl/contracts.js";
const client = new LeagueClient(
  process.env.FOOTBALL_API_TOKEN ?? "",
  process.env.FOOTBALL_API_URL,
);
const server = new McpServer({
  name: "black4-fantasy-football",
  version: "0.1.0",
});
async function call(method: string, path: string, input?: unknown) {
  try {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await client.request(method, path, input)),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Tool failed",
        },
      ],
    };
  }
}
server.registerTool("football_host", {
  description: "Read your league's selected football host and version. Host selection is not proof that rules are ratified.",
  inputSchema: {},
}, () => call("GET", "/v1/football/status"));
server.registerTool("mfl_read", {
  description: "Read MFL rules, rosters, draft state, own pending bids/trades or scores through your fixed franchise binding. No credential or actor inputs.",
  inputSchema: {query:MflOwnerReadSchema},
}, ({query}) => call("POST", "/v1/football/read", query));
server.registerTool("mfl_command", {
  description: "Submit an MFL action for your franchise. Keep one idempotencyKey for the intent. Only verified receipts establish success; unknown results must be reconciled without a new key or blind resend.",
  inputSchema: {idempotencyKey:z.string().min(1).max(160),action:MflOwnerActionSchema},
}, (input) => call("POST", "/v1/football/commands", input));
server.registerTool("mfl_reconcile", {
  description: "Read back an uncertain MFL action under its original key. This never resubmits the external write.",
  inputSchema: {idempotencyKey:z.string().min(1).max(160)},
}, (input) => call("POST", "/v1/football/reconcile", input));
server.registerTool(
  "league_state",
  {
    description:
      "Read league state with the credential holder's private visibility. No actor identity may be supplied.",
    inputSchema: { leagueId: z.string() },
  },
  ({ leagueId }) => call("GET", "/v1/leagues/" + encodeURIComponent(leagueId)),
);
server.registerTool(
  "league_command",
  {
    description:
      "Execute a football action. Use stable unique idempotencyKey and reuse it on uncertain retry. The server derives authority from the franchise credential.",
    inputSchema: { command: leagueCommandSchema },
  },
  ({ command }) => call("POST", "/v1/commands", command),
);
server.registerTool(
  "franchise_state",
  {
    description: "Read your durable jobs, messages and budget.",
    inputSchema: { agentId: z.string() },
  },
  ({ agentId }) => call("GET", "/v1/agents/" + encodeURIComponent(agentId)),
);
server.registerTool(
  "schedule_self",
  {
    description:
      "Persist your next appointment. A worker will wake you when due; no human prompt needed.",
    inputSchema: { agentId: z.string(), appointment: ScheduleSchema },
  },
  ({ agentId, appointment }) =>
    call(
      "POST",
      "/v1/agents/" + encodeURIComponent(agentId) + "/appointments",
      appointment,
    ),
);
server.registerTool(
  "message_owner",
  {
    description:
      "Send another league owner a message and durably wake their inbox. Respect conversation limits. Same causalId replays one message.",
    inputSchema: { agentId: z.string(), message: MessageSchema },
  },
  ({ agentId, message }) =>
    call(
      "POST",
      "/v1/agents/" + encodeURIComponent(agentId) + "/messages",
      message,
    ),
);
server.registerTool(
  "governance_command",
  {
    description:
      "Submit your constitution proposal or vote. Commissioner opens meetings and prepares ratification. Identity and quorum are enforced server-side.",
    inputSchema: { command: governanceCommandSchema },
  },
  ({ command }) => call("POST", "/v1/governance/commands", command),
);
server.registerTool(
  "governance_meeting",
  {
    description:
      "Read a meeting with sealed proposal visibility enforced by the server.",
    inputSchema: { meetingId: z.string() },
  },
  ({ meetingId }) =>
    call("GET", "/v1/governance/meetings/" + encodeURIComponent(meetingId)),
);
server.registerTool(
  "league_scores",
  {
    description:
      "Read starter-only fantasy scores with source freshness, missing fields and correction provenance.",
    inputSchema: {
      leagueId: z.string(),
      week: z.number().int().min(1).max(18),
    },
  },
  ({ leagueId, week }) =>
    call(
      "GET",
      "/v1/leagues/" + encodeURIComponent(leagueId) + "/scores/" + week,
    ),
);
server.registerTool(
  "watch_player",
  {
    description:
      "Opt into material recorded stat-change events for a player. These wakeups consume inference budget when processed; choose deliberately. Disabling stops future delivery.",
    inputSchema: {
      agentId: z.string(),
      feedId: z.string(),
      playerId: z.string(),
      enabled: z.boolean(),
    },
  },
  (input) => call("POST", "/v1/subscriptions", input),
);
await server.connect(new StdioServerTransport());
