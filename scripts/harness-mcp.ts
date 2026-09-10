import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { safeSegment } from "../src/harnesses/catalog.js";
import {
  FranchiseObservations,
  ObservationSchema,
} from "../src/harnesses/protocol.js";
import { LeagueClient } from "../src/client.js";

const scope = {
  leagueId: safeSegment.parse(process.env.FOOTBALL_LEAGUE_ID),
  agentId: safeSegment.parse(process.env.FOOTBALL_AGENT_ID),
  teamId: safeSegment.parse(process.env.FOOTBALL_TEAM_ID),
};
const observations = new FranchiseObservations(
  new LeagueClient(
    process.env.FOOTBALL_API_TOKEN ?? "",
    process.env.FOOTBALL_API_URL,
  ),
  scope,
);
const server = new McpServer({
  name: "black4-franchise-observations",
  version: "1.0.0",
});
server.registerTool(
  "black4_observe",
  {
    description:
      "Read goal, league, own franchise jobs/messages/budget, host or football data through your fixed Black4 credential. This staging surface has no action or send tools.",
    inputSchema: { query: ObservationSchema },
  },
  async ({ query }) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await observations.read(query)),
          },
        ],
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Observation failed; state is UNKNOWN. Check the trusted API receipt before continuing.",
          },
        ],
      };
    }
  },
);
await server.connect(new StdioServerTransport());
