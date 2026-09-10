import { it, expect } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
async function fixture(
  work: (
    run: (
      args: string[],
      stdin?: string,
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>,
    calls: any[],
  ) => Promise<void>,
) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ synthetic: true, state: "verified" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const run = (args: string[], stdin = "") =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", ...args],
          {
            env: {
              ...process.env,
              FOOTBALL_API_TOKEN: "synthetic-owner-token",
              FOOTBALL_API_URL: `http://127.0.0.1:${address.port}`,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin);
      },
    );
  try {
    await work(run, calls);
  } finally {
    await new Promise<void>((r, e) => server.close((x) => (x ? e(x) : r())));
  }
}
it("routes inline read, stdin command, and reconciliation to the same authenticated football API", async () =>
  fixture(async (run, calls) => {
    expect((await run(["football-host"])).code).toBe(0);
    expect((await run(["mfl-read", '{"type":"draft"}'])).code).toBe(0);
    const intent = {
      idempotencyKey: "synthetic-draft-1",
      action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
    };
    const reply = await run(["mfl-command", "-"], JSON.stringify(intent));
    expect(reply.code).toBe(0);
    expect(reply.stdout).toContain("verified");
    expect(reply.stdout + reply.stderr).not.toContain("synthetic-owner-token");
    expect(
      (await run(["mfl-reconcile", '{"idempotencyKey":"synthetic-draft-1"}']))
        .code,
    ).toBe(0);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/v1/football/status"],
      ["POST", "/v1/football/read"],
      ["POST", "/v1/football/commands"],
      ["POST", "/v1/football/reconcile"],
    ]);
    expect(calls[2].body).toEqual(intent);
    expect(calls[3].body).toEqual({ idempotencyKey: intent.idempotencyKey });
    expect(
      calls.every((c) => c.authorization === "Bearer synthetic-owner-token"),
    ).toBe(true);
  }));
it("rejects invalid actions, empty keys and caller-supplied authority before network access", async () =>
  fixture(async (run, calls) => {
    for (const [mode, value] of [
      ["mfl-read", { type: "privateCommissionerDump" }],
      [
        "mfl-command",
        {
          idempotencyKey: "",
          action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
        },
      ],
      [
        "mfl-command",
        {
          idempotencyKey: "x",
          action: { type: "draft", round: 0, pick: 1, playerId: "12345" },
        },
      ],
      ["mfl-reconcile", { idempotencyKey: "x", actorId: "commissioner" }],
    ] as const) {
      expect((await run([mode, JSON.stringify(value)])).code).toBe(1);
    }
    expect(calls).toEqual([]);
  }));
