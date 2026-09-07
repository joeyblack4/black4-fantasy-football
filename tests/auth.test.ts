import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticate,
  issueCredential,
  requireAgent,
  requireCommissioner,
  requireLeague,
} from "../src/auth.js";
import { testDb } from "./helpers.js";
describe("credential boundaries", () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    ctx = await testDb();
  });
  afterEach(async () => {
    await ctx.close();
  });
  it("authenticates hash-only credentials and immediately rejects revocation", async () => {
    const credential = await issueCredential(ctx.db, {
      id: "human-1",
      role: "owner",
      leagueId: "league-1",
      teamId: "team-1",
    });
    const actor = await authenticate(ctx.db, "Bearer " + credential.token);
    expect(actor.teamId).toBe("team-1");
    const stored = (
      await ctx.db.query("SELECT token_hash FROM api_credentials")
    ).rows[0].token_hash;
    expect(stored).not.toContain(credential.token);
    await ctx.db.query(
      "UPDATE api_credentials SET revoked_at=now() WHERE id=$1",
      [credential.id],
    );
    await expect(
      authenticate(ctx.db, "Bearer " + credential.token),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects missing/guessed identity and limits owner to its franchise/league", async () => {
    await expect(authenticate(ctx.db, undefined)).rejects.toMatchObject({
      status: 401,
    });
    await expect(authenticate(ctx.db, "Bearer team-1")).rejects.toMatchObject({
      status: 401,
    });
    const actor = {
      id: "human-1",
      role: "owner" as const,
      leagueId: "league-1",
      teamId: "team-1",
    };
    expect(() => requireAgent(actor, "team-2")).toThrow();
    expect(() => requireLeague(actor, "league-2")).toThrow();
    expect(() => requireCommissioner(actor)).toThrow();
    expect(() => requireAgent(actor, "team-1")).not.toThrow();
  });
});
