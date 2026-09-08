import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  StatsService,
  scoreStats,
  halfPprRules,
  StatsSchema,
} from "../src/data/index.js";
import {
  syntheticReceiver,
  syntheticCompleteStats,
} from "../src/data/fixtures.js";
import { RollingInsightsClient } from "../src/data/rolling-insights.js";
import { testDb } from "./helpers.js";
describe("deterministic scoring", () => {
  it("scores complete cumulative stats and recomputes a downward correction", () => {
    expect(scoreStats(syntheticReceiver.stats, halfPprRules).milliPoints).toBe(
      17500,
    );
    expect(
      scoreStats(
        { ...syntheticReceiver.stats, receivingYards: 75 },
        halfPprRules,
      ).milliPoints,
    ).toBe(16500);
  });
  it("never substitutes zero for missing data", () => {
    expect(
      scoreStats({ receivingYards: 85 }, halfPprRules).milliPoints,
    ).toBeNull();
    expect(
      scoreStats({ ...syntheticCompleteStats, receptions: null }, halfPprRules)
        .missing,
    ).toContain("receptions");
    expect(
      scoreStats({ ...syntheticCompleteStats, rushingYards: -3 }, halfPprRules)
        .milliPoints,
    ).toBe(-300);
    expect(() => StatsSchema.parse({ receptions: -1 })).toThrow();
  });
  it("supports explicit defense tiers and rejects ambiguous rules", () => {
    const rules = {
      version: "test",
      milliPointsPerUnit: { defenseSacks: 1000 },
      defensePointsAllowed: [
        { max: 0, milliPoints: 10000 },
        { max: 6, milliPoints: 7000 },
        { max: null, milliPoints: 0 },
      ],
    };
    expect(
      scoreStats({ defenseSacks: 3, defensePointsAllowed: 6 }, rules)
        .milliPoints,
    ).toBe(10000);
    expect(() =>
      scoreStats(
        {},
        { ...rules, defensePointsAllowed: [{ max: 7, milliPoints: 0 }] },
      ),
    ).toThrow();
  });
});
describe("durable stats stream", () => {
  let harness: Awaited<ReturnType<typeof testDb>>;
  let service: StatsService;
  beforeAll(async () => {
    harness = await testDb();
    service = new StatsService(harness.db);
  });
  afterAll(async () => harness?.close());
  it("serializes duplicate delivery and prevents revision reuse with changed content", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.ingest(syntheticReceiver)),
    );
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    await expect(
      service.ingest({
        ...syntheticReceiver,
        stats: { ...syntheticReceiver.stats, receptions: 7 },
      }),
    ).rejects.toThrow("conflict");
  });
  it("persists unknown source time without presenting it as fresh or zero", async () => {
    const snapshot = {
      ...syntheticReceiver,
      playerId: "SYNTHETIC-UNKNOWN-TIME",
      sourceAt: null,
    };
    await service.ingest(snapshot);
    const latest = await new StatsService(harness.db).latest(
      snapshot.feedId,
      snapshot.gameId,
      snapshot.playerId,
    );
    expect(latest.availability).toBe("unknown");
    expect(latest.snapshot).not.toBeNull();
    expect(latest.snapshot.source_at).toBeNull();
    expect(latest.snapshot.observed_at).toBeTruthy();
  });
  it("retains correction history and never rolls the latest state backwards", async () => {
    await service.ingest({
      ...syntheticReceiver,
      revision: 3,
      stats: { ...syntheticReceiver.stats, receivingYards: 75 },
    });
    expect(
      (await service.ingest({ ...syntheticReceiver, revision: 2 })).status,
    ).toBe("superseded");
    const latest = await service.latest(
      syntheticReceiver.feedId,
      syntheticReceiver.gameId,
      syntheticReceiver.playerId,
    );
    expect(latest.snapshot.stats.receivingYards).toBe(75);
    expect(latest.availability).toBe("stale");
    expect(
      (await service.latest("missing", "missing", "missing")).availability,
    ).toBe("unknown");
    expect(
      (
        await harness.db.query(
          "SELECT * FROM data_stat_snapshots WHERE player_id=$1",
          [syntheticReceiver.playerId],
        )
      ).rowCount,
    ).toBe(3);
    expect(
      (
        await harness.db.query(
          "SELECT e.* FROM data_events e JOIN data_stat_snapshots s ON s.id=e.snapshot_id WHERE s.player_id=$1",
          [syntheticReceiver.playerId],
        )
      ).rowCount,
    ).toBe(2);
    await expect(
      service.ingest({ ...syntheticReceiver, revision: 4, synthetic: false }),
    ).rejects.toThrow("mix");
  });
});
describe("Rolling Insights documented request boundary (fake transport)", () => {
  it("builds documented NFL v1 request, requires no-cache and blocks redirects", async () => {
    let captured: URL | undefined;
    let init: RequestInit | undefined;
    const client = new RollingInsightsClient(
      "FAKE_TEST_SECRET",
      async (input, options) => {
        captured = new URL(String(input));
        init = options;
        return new Response(JSON.stringify({ data: { NFL: [] } }), {
          status: 200,
        });
      },
    );
    expect(await client.getNfl("live", "2026-09-09")).toEqual({
      data: { NFL: [] },
    });
    expect(captured!.pathname).toBe("/api/v1/live/2026-09-09/NFL");
    expect(captured!.searchParams.get("RSC_token")).toBe("FAKE_TEST_SECRET");
    expect(init!.redirect).toBe("error");
    expect(init!.headers).toMatchObject({ Pragma: "no-cache" });
  });
  it("redacts transport errors and does not accept non-JSON as data", async () => {
    const client = new RollingInsightsClient("FAKE_TEST_SECRET", async () => {
      throw new Error("URL?RSC_token=FAKE_TEST_SECRET");
    });
    await expect(client.getNfl("injuries")).rejects.toThrow("details redacted");
    const invalid = new RollingInsightsClient(
      "FAKE_TEST_SECRET",
      async () => new Response("not JSON"),
    );
    await expect(invalid.getNfl("injuries")).rejects.toThrow(
      "documented JSON wrapper",
    );
  });
});
