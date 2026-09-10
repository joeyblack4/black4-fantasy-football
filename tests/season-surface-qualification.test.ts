import { describe, it, expect } from "vitest";
// @ts-expect-error The operator audit is an executable JavaScript module.
import { auditOwner } from "../scripts/qualify-season-surface.mjs";

describe("season infrastructure read qualification", () => {
  const config = {
    token: "PRIVATE_TOKEN",
    baseUrl: "http://127.0.0.1:4315",
    leagueId: "league",
    teamId: "team",
  };
  it("uses only reads and reports access without exposing private payloads or claiming execution", async () => {
    const calls: Array<{ path: string; method: string; input: unknown }> = [];
    const fetcher = async (url: URL, init: RequestInit) => {
      const input = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname, method: init.method!, input });
      const value =
        url.pathname === "/v1/me"
          ? {
              role: "owner",
              agentId: "b4-openai",
              teamId: "team",
              leagueId: "league",
            }
          : url.pathname === "/v1/owner/schedules"
            ? {
                schedules: [{ prompt: "PRIVATE_STRATEGY" }],
                occurrences: [{ state: "completed" }],
              }
            : {
                id: "receipt",
                teamId: "team",
                leagueId: "league",
                data: {
                  interfaceVersion: "2026-09-09.1",
                  valid: false,
                  submitted: false,
                  privateBid: "PRIVATE_BID",
                },
              };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const row = await auditOwner("b4-openai", config, fetcher);
    expect(row.identity.status).toBe("verified");
    expect(
      calls.every(
        (call) =>
          call.method === "GET" ||
          (call.path === "/v1/football/read" && call.method === "POST"),
      ),
    ).toBe(true);
    expect(
      row.checks.find(
        (check: { capability: string }) =>
          check.capability === "validateLineup",
      ),
    ).toMatchObject({ submitted: false, emptyLineupRejected: true });
    expect(row.nativeExecution).toBe("not_tested");
    expect(
      row.checks.find(
        (check: { capability: string }) => check.capability === "schedules",
      ).executionVerified,
    ).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(
      /PRIVATE_TOKEN|PRIVATE_STRATEGY|PRIVATE_BID/,
    );
  });
  it("stops on a mismatched owner binding before any football or scheduler read", async () => {
    let count = 0;
    const row = await auditOwner("b4-openai", config, async () => {
      count++;
      return new Response(
        JSON.stringify({
          role: "commissioner",
          agentId: "b4-openai",
          teamId: "team",
          leagueId: "league",
        }),
      );
    });
    expect(count).toBe(1);
    expect(row.identity.errorCode).toBe("OWNER_BINDING_MISMATCH");
    expect(row.checks).toEqual([]);
  });
  it("keeps failed reads unknown or failed and omits untrusted server error messages", async () => {
    const row = await auditOwner(
      "b4-openai",
      config,
      async () =>
        new Response(
          JSON.stringify({ error: "UNAVAILABLE", message: "PRIVATE_TOKEN" }),
          { status: 503 },
        ),
    );
    expect(row.identity).toMatchObject({
      status: "failed",
      httpStatus: 503,
      errorCode: "UNAVAILABLE",
    });
    expect(JSON.stringify(row)).not.toContain("PRIVATE_TOKEN");
  });
});
