import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import {
  ManifestRegistry,
  keyFingerprint,
  type ManifestDocument,
} from "../src/providers/manifests.js";
import {
  GuardrailChecker,
  classifyNegativeProbe,
} from "../src/providers/guardrail-checks.js";
let f: Awaited<ReturnType<typeof testDb>>, id: string;
const actor = {
  id: "operator",
  role: "commissioner" as const,
  leagueId: "guardrail-test",
};
const secret = "synthetic-franchise-key",
  management = "synthetic-management-key";
const doc: ManifestDocument = {
  leagueId: actor.leagueId,
  agentId: "g",
  developer: "OpenAI",
  model: "synthetic/model",
  providerSlug: "synthetic-provider",
  reportedProviderNames: ["Synthetic"],
  quantization: null,
  modelVersion: null,
  openWeight: null,
  license: null,
  keyRef: "B4_LEAGUE_G",
  upstreamKeyHash: "provider-key-hash",
  guardrailId: "guard-id",
  harnessId: "black4-owner-loop",
  buzzBridgeVersion: "synthetic",
  harnessVersion: "synthetic",
  toolPermissions: [],
  walletId: "g",
};
const journal = ["key_saved", "restricted_key_ready_for_negative_tests"].map(
  (phase) => ({
    phase,
    keyHash: doc.upstreamKeyHash,
    keyFingerprint: keyFingerprint(secret),
    guardrailId: doc.guardrailId,
    assignmentVerified: true,
  }),
);
const secrets = {
  apiKey: secret,
  managementKey: management,
  provisioningJournal: journal,
};
const spec = () => ({
  kind: "wrong_model",
  model: "synthetic/wrong",
  providerSlug: doc.providerSlug,
  reservationMicros: 100000,
  tariff: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    verifiedAt: new Date().toISOString(),
  },
});
beforeEach(async () => {
  f = await testDb();
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Synthetic guardrail fixture','{}')",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,'team','Synthetic','owner','ai',0,0,100)",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO runtime_agents(id,model,budget_micros) VALUES('g','unactivated/model',600000000)",
  );
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES('g',$1,'team')",
    [actor.leagueId],
  );
  id = (await new ManifestRegistry(f.db).stage(actor, doc, secret)).id;
});
afterEach(async () => {
  await f.close();
});
function transport(
  post: (body: any) => Promise<Response> = async () =>
    Response.json(
      { error: { code: 403, message: "Forbidden" } },
      { status: 403 },
    ),
  keyChanges: Record<string, unknown> = {},
) {
  const calls: { path: string; method: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "POST") {
      expect(
        (
          await f.db.query(
            "SELECT reserved_micros FROM runtime_agents WHERE id='g'",
          )
        ).rows[0].reserved_micros,
      ).toBe("100000");
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int n FROM runtime_reservations WHERE status='reserved'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int n FROM provider_guardrail_checks WHERE evidence->>'result'='prepared_cost_uncertain'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer " + secret,
      );
      return post(JSON.parse(String(init?.body)));
    }
    const key = {
      hash: doc.upstreamKeyHash,
      disabled: false,
      is_management_key: false,
      limit: 40,
      limit_remaining: 39,
      limit_reset: null,
      include_byok_in_limit: true,
      ...keyChanges,
    };
    if (path === "/api/v1/key" || path.startsWith("/api/v1/keys/"))
      return Response.json({ data: key });
    if (path.endsWith("/assignments/keys"))
      return Response.json({
        data: [
          { key_hash: doc.upstreamKeyHash, guardrail_id: doc.guardrailId },
        ],
        total_count: 1,
      });
    if (path.startsWith("/api/v1/guardrails/"))
      return Response.json({
        data: {
          id: doc.guardrailId,
          allowed_models: [doc.model],
          allowed_providers: [doc.providerSlug],
        },
      });
    if (path === "/api/v1/generation")
      return Response.json({
        data: {
          id: u.searchParams.get("id"),
          model: "synthetic/wrong",
          provider_name: "Synthetic",
          total_cost: 0.002,
        },
      });
    throw Error("Unexpected synthetic request");
  };
  return {
    calls,
    checker: new GuardrailChecker(f.db, { synthetic: true, fetchImpl }),
  };
}
it("requires operator, exact manifest secret and trusted same-response key/hash provenance", async () => {
  const { checker, calls } = transport();
  await expect(
    checker.inspect({ ...actor, role: "owner" }, id, secrets),
  ).rejects.toThrow("OPERATOR");
  await expect(
    checker.inspect(actor, id, { ...secrets, apiKey: "wrong" }),
  ).rejects.toThrow("STAGED_KEY");
  expect(calls).toHaveLength(0);
  const missing = (await checker.inspect(actor, id, {
    ...secrets,
    provisioningJournal: [],
  })) as any;
  expect(missing.assignment.passed).toBe(false);
  expect(missing.keyLimit.passed).toBe(false);
  const good = (await checker.inspect(actor, id, secrets)) as any;
  expect(good.assignment.passed).toBe(true);
  expect(good.keyLimit.passed).toBe(true);
  const checks = (
    await f.db.query("SELECT evidence,synthetic FROM provider_guardrail_checks")
  ).rows;
  expect(checks.every((c) => c.synthetic)).toBe(true);
  expect(JSON.stringify(checks)).not.toContain(secret);
  expect(JSON.stringify(checks)).not.toContain(management);
});
it.each([401, 402, 403, 404, 429, 500, 503])(
  "does not treat HTTP %s as guardrail proof",
  (status) => {
    expect(
      classifyNegativeProbe(status, {
        error: { code: status, message: "Model blocked by guardrails" },
      }).passed,
    ).toBe(false);
  },
);
it("requires finite lifetime cap including BYOK and refuses paid probes when key budget check fails", async () => {
  const { checker, calls } = transport(undefined, { limit_reset: "monthly" });
  const result = (await checker.inspect(actor, id, secrets)) as any;
  expect(result.keyLimit.passed).toBe(false);
  await expect(checker.probe(actor, id, secret, spec())).rejects.toThrow(
    "FRESH_ASSIGNMENT",
  );
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
it("holds uncertain charge after generic rejection and never retries the same probe", async () => {
  const { checker, calls } = transport();
  await checker.inspect(actor, id, secrets);
  const first = await checker.probe(actor, id, secret, spec());
  expect(first.passed).toBe(false);
  const replay = await checker.probe(actor, id, secret, spec());
  expect(replay.replayed).toBe(true);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(
    (await f.db.query("SELECT status FROM runtime_reservations")).rows[0]
      .status,
  ).toBe("uncertain");
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_messages")).rows[0]
      .n,
  ).toBe(0);
});
it("serializes concurrent same-kind probes so only one request can spend", async () => {
  const { checker, calls } = transport();
  await checker.inspect(actor, id, secrets);
  const results = await Promise.all([
    checker.probe(actor, id, secret, spec()),
    checker.probe(actor, id, secret, spec()),
  ]);
  expect(results.filter((r) => r.replayed)).toHaveLength(1);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_reservations"))
      .rows[0].n,
  ).toBe(1);
});
it("settles an accidentally accepted negative probe from generation cost, records failure, and executes no football action", async () => {
  const { checker } = transport(async (body) => {
    expect(body.model).toBe("synthetic/wrong");
    expect(body.provider).toEqual({
      only: [doc.providerSlug],
      allow_fallbacks: false,
    });
    expect(body.tools).toBeUndefined();
    return Response.json({
      id: "negative-gen",
      model: body.model,
      usage: { cost: 0.002 },
      choices: [{ message: { content: "OK" } }],
    });
  });
  await checker.inspect(actor, id, secrets);
  const result = await checker.probe(actor, id, secret, spec());
  expect(result.result).toBe("unexpected_acceptance");
  expect(result.passed).toBe(false);
  expect(
    (
      await f.db.query(
        "SELECT spent_micros,reserved_micros FROM runtime_agents WHERE id='g'",
      )
    ).rows[0],
  ).toEqual({ spent_micros: "2000", reserved_micros: "0" });
  expect(
    (await f.db.query("SELECT status FROM provider_calls")).rows[0].status,
  ).not.toBe("verified");
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "GUARDRAIL_CANARIES_REQUIRED",
  );
});
it("preserves timeout uncertainty and scopes wrong-provider probe to the assigned model", async () => {
  const { checker, calls } = transport(async () => {
    throw Error("synthetic timeout");
  });
  await checker.inspect(actor, id, secrets);
  await expect(
    checker.probe(actor, id, secret, { ...spec(), kind: "wrong_provider" }),
  ).rejects.toThrow("SINGLE_VARIABLE");
  const result = await checker.probe(actor, id, secret, {
    ...spec(),
    kind: "wrong_provider",
    model: doc.model,
    providerSlug: "other-provider",
  });
  expect(result.result).toBe("transport_uncertain");
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(
    (await f.db.query("SELECT status FROM runtime_reservations")).rows[0]
      .status,
  ).toBe("uncertain");
});
