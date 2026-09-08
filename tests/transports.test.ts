import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testDb } from "./helpers.js";
import { LeagueService } from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { issueCredential } from "../src/auth.js";
import { createApiServer } from "../src/api.js";

async function fixture() {
  const f = await testDb(),
    leagueId = "transport-fixture",
    service = new LeagueService(f.db),
    runtime = new RuntimeStore(f.db);
  const admin = { id: "admin", role: "commissioner" as const, leagueId };
  const teams = Array.from({ length: 12 }, (_, i) => ({
    id: "t" + i,
    ownerId: "o" + i,
    name: "Synthetic " + i,
    kind: i < 10 ? "ai" : "human",
  }));
  await service.execute(admin, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC transport fixture",
    rules: {
      rosterSize: 2,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "FLEX", positions: ["RB"] }],
    },
    teams,
  });
  const adminToken = await issueCredential(f.db, admin),
    owner = await issueCredential(f.db, {
      id: "o0",
      role: "owner",
      leagueId,
      teamId: "t0",
    }),
    peer = await issueCredential(f.db, {
      id: "o1",
      role: "owner",
      leagueId,
      teamId: "t1",
    });
  for (const id of ["t0", "t1"]) {
    await runtime.createAgent({
      id,
      model: "synthetic/test",
      budgetMicros: 1000000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$1)",
      [id, leagueId],
    );
  }
  const server = createApiServer(f.db);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const request = async (path: string, token?: string, input?: unknown) => {
    const res = await fetch(base + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    ...f,
    leagueId,
    adminToken,
    owner,
    peer,
    server,
    base,
    request,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await f.close();
    },
  };
}
describe("actual HTTP/CLI/MCP authority boundaries", () => {
  it("rejects unauthenticated access, forged authority, stale owner identity and cross-team private reads", async () => {
    const f = await fixture();
    try {
      expect((await f.request("/v1/operations")).status).toBe(401);
      expect((await f.request("/v1/operations", f.owner.token)).status).toBe(
        403,
      );
      expect((await f.request("/v1/agents/t1", f.owner.token)).status).toBe(
        403,
      );
      const forged = await f.request("/v1/commands", f.owner.token, {
        type: "importPlayers",
        leagueId: f.leagueId,
        idempotencyKey: "bad",
        players: [{ id: "p", name: "Synthetic", positions: ["RB"] }],
        actor: { id: "admin", role: "commissioner" },
      });
      expect(forged.status).toBe(400);
      await f.db.query(
        "UPDATE league_teams SET owner_id='new-owner' WHERE league_id=$1 AND id='t0'",
        [f.leagueId],
      );
      expect((await f.request("/v1/agents/t0", f.owner.token)).status).toBe(
        403,
      );
    } finally {
      await f.close();
    }
  });
  it("sends one message across duplicate HTTP retries and keeps appointments private", async () => {
    const f = await fixture();
    try {
      const message = {
        recipientId: "t1",
        causalId: "one-logical-message",
        body: "Synthetic transport test",
      };
      const responses = await Promise.all([
        f.request("/v1/agents/t0/messages", f.owner.token, message),
        f.request("/v1/agents/t0/messages", f.owner.token, message),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(responses[0].body.id).toBe(responses[1].body.id);
      expect(
        (
          await f.request("/v1/agents/t0/messages", f.owner.token, {
            ...message,
            body: "Changed",
          })
        ).status,
      ).toBe(409);
      expect(
        (await f.request("/v1/agents/t1", f.peer.token)).body.messages,
      ).toHaveLength(1);
      expect(
        (
          await f.request("/v1/agents/t1/appointments", f.owner.token, {
            causalId: "x",
            dueAt: new Date().toISOString(),
            payload: {},
          })
        ).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
  it("CLI stdin and MCP use the same HTTP authorization and receipts", async () => {
    const f = await fixture();
    try {
      const env = {
        ...process.env,
        FOOTBALL_API_TOKEN: f.adminToken.token,
        FOOTBALL_API_URL: f.base,
      };
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "command", "-"],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.stdin.end(
        JSON.stringify({
          type: "importPlayers",
          leagueId: f.leagueId,
          idempotencyKey: "cli-import",
          players: [
            {
              id: "synthetic-player",
              name: "Synthetic player",
              positions: ["RB"],
            },
          ],
        }),
      );
      const [code] = await once(child, "exit");
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out).result.imported).toBe(1);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/mcp.ts"],
        env: {
          PATH: process.env.PATH ?? "",
          FOOTBALL_API_TOKEN: f.owner.token,
          FOOTBALL_API_URL: f.base,
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "synthetic-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((t) => t.name === "schedule_self")).toBe(true);
        const denied = await client.callTool({
          name: "franchise_state",
          arguments: { agentId: "t1" },
        });
        expect(denied.isError).toBe(true);
        const success = await client.callTool({
          name: "schedule_self",
          arguments: {
            agentId: "t0",
            appointment: {
              causalId: "mcp-appointment",
              dueAt: new Date(Date.now() + 60000).toISOString(),
              payload: { purpose: "Synthetic future review" },
            },
          },
        });
        expect(success.isError).not.toBe(true);
        expect(
          Number(
            (
              await f.db.query(
                "SELECT count(*) FROM runtime_jobs WHERE causal_id='mcp-appointment'",
              )
            ).rows[0].count,
          ),
        ).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      await f.close();
    }
  }, 20000);
});
