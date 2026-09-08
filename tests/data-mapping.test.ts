import { describe, it, expect } from "vitest";
import {
  inspectNflPayload,
  assessNflMapperPlan,
  type NflMapperPlan,
} from "../src/data/mapping-evidence.js";
const rules = {
  version: "synthetic-receiver",
  milliPointsPerUnit: { receivingYards: 100, receptions: 500 },
};
const fixture = {
  data: {
    rows: [
      {
        id: "SYNTHETIC-PLAYER",
        game: "SYNTHETIC-GAME",
        revision: 1,
        source: "2026-09-07T00:00:00Z",
        state: "live",
        yards: 75,
        catches: 3,
        privateValue: "NEVER INCLUDE RAW VALUES",
      },
    ],
  },
};
const base = '$["data"]["rows"][*]';
function plan(hash: string): NflMapperPlan {
  return {
    provider: "rolling-insights",
    version: "synthetic-mapping-only",
    fixtureSha256: hash,
    playerId: { path: base + '["id"]', encoding: "string" },
    gameId: { path: base + '["game"]', encoding: "string" },
    revision: { path: base + '["revision"]', encoding: "number" },
    sourceAt: { path: base + '["source"]', encoding: "timestamp-string" },
    gameStatus: { path: base + '["state"]', encoding: "string" },
    stats: {
      receivingYards: { path: base + '["yards"]', encoding: "number" },
      receptions: { path: base + '["catches"]', encoding: "number" },
    },
  };
}
describe("NFL mapper planning requires observed evidence, never guessed vendor field names", () => {
  it("reports pending fixture/mapping requirements when no authenticated payload exists", () => {
    const status = assessNflMapperPlan(undefined, undefined, rules);
    expect(status.status).toBe("blocked");
    expect(status.liveReady).toBe(false);
    expect(status.blockers).toEqual([
      "AUTHENTICATED_NFL_FIXTURE_REQUIRED",
      "EXPLICIT_FIELD_MAPPING_REQUIRED",
    ]);
  });
  it("records structural paths and fingerprint without copying raw fixture values or claiming auth", () => {
    const evidence = inspectNflPayload(fixture);
    expect(evidence.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("NEVER INCLUDE RAW VALUES");
    expect(evidence.authentication).toBe("unverified");
    expect(evidence.commercialEntitlement).toBe("unverified");
    expect(
      evidence.fields.find((f) => f.path === base + '["source"]')!.formats,
    ).toContain("timestamp-string");
    const status = assessNflMapperPlan(
      evidence,
      plan(evidence.payloadSha256),
      rules,
    );
    expect(status.status).toBe("ready-for-mapper-review");
    expect(status.liveReady).toBe(false);
  });
  it("fails on unobserved paths, missing scoring fields, changed fixture fingerprints and wrong encodings", () => {
    const evidence = inspectNflPayload(fixture),
      mapping = plan(evidence.payloadSha256);
    expect(
      assessNflMapperPlan(
        evidence,
        { ...mapping, fixtureSha256: "0".repeat(64) },
        rules,
      ).blockers,
    ).toContain("FIXTURE_HASH_MISMATCH");
    expect(
      assessNflMapperPlan(evidence, { ...mapping, stats: {} }, rules).blockers,
    ).toContain("MISSING_MAPPING:stats.receptions");
    expect(
      assessNflMapperPlan(
        evidence,
        {
          ...mapping,
          sourceAt: {
            path: base + '["guessed_timestamp"]',
            encoding: "timestamp-string",
          },
        },
        rules,
      ).blockers,
    ).toContain("UNOBSERVED_PATH:sourceAt");
    expect(
      assessNflMapperPlan(
        evidence,
        { ...mapping, playerId: { path: base + '["id"]', encoding: "number" } },
        rules,
      ).blockers,
    ).toContain("UNVERIFIED_ENCODING:playerId");
  });
  it("treats null-only observations as unknown and bounds schema traversal", () => {
    const nullEvidence = inspectNflPayload({
      data: { rows: [{ ...fixture.data.rows[0], source: null }] },
    });
    expect(
      assessNflMapperPlan(nullEvidence, plan(nullEvidence.payloadSha256), rules)
        .blockers,
    ).toContain("UNVERIFIED_ENCODING:sourceAt");
    let deep: unknown = { end: 1 };
    for (let i = 0; i < 25; i++) deep = { nested: deep };
    expect(inspectNflPayload(deep).truncated).toBe(true);
  });
});
