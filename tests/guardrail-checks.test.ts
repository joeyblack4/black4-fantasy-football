import { beforeEach, afterEach, it, expect, vi } from "vitest";
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
let f: Awaited<ReturnType<typeof testDb>>, id: string, fixtureNow: string;
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
    verifiedAt: fixtureNow,
  },
});
beforeEach(async () => {
  f = await testDb();
  fixtureNow = (
    await f.db.query("SELECT clock_timestamp() AS now")
  ).rows[0].now.toISOString();
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
  vi.restoreAllMocks();
  await f.close();
});
function transport(
  post: (body: any) => Promise<Response> = async () =>
    Response.json(
      { error: { code: 403, message: "Forbidden" } },
      { status: 403 },
    ),
  keyChanges: Record<string, unknown> = {},
  guardChanges: Record<string, unknown> = {},
  endpoints: unknown[] = [
    { tag: doc.providerSlug, status: 0, supported_parameters: ["max_tokens"] },
  ],
) {
  const calls: { path: string; method: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "POST") {
      expect(
        Number(
          (
            await f.db.query(
              "SELECT reserved_micros FROM runtime_agents WHERE id='g'",
            )
          ).rows[0].reserved_micros,
        ),
      ).toBeGreaterThanOrEqual(100000);
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
      ).toBeGreaterThanOrEqual(1);
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
    if (path.endsWith("/endpoints"))
      return Response.json({ data: { id: doc.model, endpoints } });
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
          ...guardChanges,
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

const specificError = () =>
  Response.json(
    {
      error: {
        code: 403,
        message: "Synthetic fixture: model restriction.",
        metadata: {
          error_type: "synthetic_model_allowlist_restriction",
          authorization: "Bearer " + secret,
          debug: secret,
        },
      },
      choices: [],
    },
    { status: 403, headers: { "x-request-id": "synthetic-request-123" } },
  );
async function reviewFixture(post = async () => specificError()) {
  const t = transport(post);
  await t.checker.inspect(actor, id, secrets);
  const probe = await t.checker.probe(actor, id, secret, spec());
  const capture = (
    await f.db.query("SELECT * FROM provider_guardrail_artifacts WHERE id=$1", [
      probe.captureId,
    ])
  ).rows[0];
  const review = {
    captureId: probe.captureId,
    kind: "wrong_model",
    responseBytesHash: capture.body.responseBytesHash,
    expectedSignature: {
      httpStatus: 403,
      discriminatorPath: ["metadata", "error_type"],
      discriminatorValue: "synthetic_model_allowlist_restriction",
      reason: "model_allowlist",
      documentationUrl: "https://openrouter.ai/docs/synthetic-test-only",
      documentationQuote:
        "SYNTHETIC TEST ONLY: synthetic_model_allowlist_restriction indicates the model allowlist restriction.",
    },
  };
  return { ...t, probe, capture, review };
}
// This explicitly simulates an independently verified zero billing receipt inside the isolated synthetic test DB.
async function syntheticZeroCost(reservationId: string) {
  await f.db.query(
    "UPDATE runtime_reservations SET status='settled',actual_micros=0 WHERE id=$1",
    [reservationId],
  );
  await f.db.query("UPDATE runtime_agents SET reserved_micros=0 WHERE id='g'");
}
it("captures bounded redacted error evidence before reconciliation without storing model output or credentials", async () => {
  const t = await reviewFixture();
  const rows = (
    await f.db.query("SELECT body FROM provider_guardrail_artifacts")
  ).rows;
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(JSON.stringify(rows)).not.toContain(management);
  expect(t.capture.body.error.metadata.authorization).toBe("[REDACTED]");
  expect(t.capture.body.error.metadata.debug).toBe("[REDACTED]");
  expect(t.capture.body.requestBody.model).toBe("synthetic/wrong");
  expect(t.capture.body.responseRequestId).toBe("synthetic-request-123");
  expect(t.capture.body.inspectionArtifactIds).toHaveLength(2);
  expect(rows.filter((r) => r.body.responseBytesHash)).toHaveLength(2);
});
it("never equates a specific restriction signature with zero billing", async () => {
  const t = await reviewFixture(),
    count = t.calls.length;
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "ZERO_COST_RECONCILIATION",
  );
  expect(t.calls).toHaveLength(count);
  expect(
    (await f.db.query("SELECT status FROM runtime_reservations")).rows[0]
      .status,
  ).toBe("uncertain");
});
it("reviews exact recorded synthetic evidence without network, preserves replay and rejects changed adjudication", async () => {
  const t = await reviewFixture();
  await syntheticZeroCost(t.probe.reservationId);
  const count = t.calls.length;
  expect(await t.checker.adjudicate(actor, id, t.review)).toMatchObject({
    passed: true,
    replayed: false,
  });
  expect(await t.checker.adjudicate(actor, id, t.review)).toMatchObject({
    passed: true,
    replayed: true,
  });
  await expect(
    t.checker.adjudicate(actor, id, {
      ...t.review,
      expectedSignature: {
        ...t.review.expectedSignature,
        documentationQuote:
          t.review.expectedSignature.documentationQuote +
          " Additional synthetic sentence.",
      },
    }),
  ).rejects.toThrow("ADJUDICATION_CONFLICT");
  expect(t.calls).toHaveLength(count);
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "GUARDRAIL_CANARIES_REQUIRED",
  );
});
it("rejects wrong kind, tampered response hash, generic or mismatched signature and nonoperator reviews", async () => {
  const t = await reviewFixture();
  await syntheticZeroCost(t.probe.reservationId);
  await expect(
    t.checker.adjudicate({ ...actor, role: "owner" }, id, t.review),
  ).rejects.toThrow("OPERATOR");
  await expect(
    t.checker.adjudicate(actor, id, { ...t.review, kind: "wrong_provider" }),
  ).rejects.toThrow("BINDING_MISMATCH");
  await expect(
    t.checker.adjudicate(actor, id, {
      ...t.review,
      responseBytesHash: "0".repeat(64),
    }),
  ).rejects.toThrow("REJECTION_CAPTURE");
  await expect(
    t.checker.adjudicate(actor, id, {
      ...t.review,
      expectedSignature: {
        ...t.review.expectedSignature,
        discriminatorValue: "forbidden",
      },
    }),
  ).rejects.toThrow("GENERIC_REJECTION");
  await expect(
    t.checker.adjudicate(actor, id, {
      ...t.review,
      expectedSignature: {
        ...t.review.expectedSignature,
        reason: "provider_allowlist",
      },
    }),
  ).rejects.toThrow("KIND_MISMATCH");
  await f.db.query(
    "UPDATE provider_guardrail_artifacts SET body=jsonb_set(body,'{hasChoices}','true') WHERE id=$1",
    [t.probe.captureId],
  );
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "TAMPERED",
  );
});
it("rejects expired evidence and settled nonzero negative probe cost", async () => {
  const t = await reviewFixture();
  await f.db.query(
    "UPDATE runtime_reservations SET status='settled',actual_micros=1 WHERE id=$1",
    [t.probe.reservationId],
  );
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "ZERO_COST_RECONCILIATION",
  );
  await f.db.query(
    "UPDATE provider_guardrail_artifacts SET observed_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
    [t.probe.captureId],
  );
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "STALE",
  );
});
it("retains oversized response uncertainty and disallows adjudication without a complete body", async () => {
  const t = await reviewFixture(
    async () =>
      new Response(JSON.stringify({ error: { message: "x".repeat(40000) } }), {
        status: 403,
      }),
  );
  expect(t.capture.body.responseComplete).toBe(false);
  expect(t.capture.body.responseBytesHash).toBeNull();
  await expect(
    t.checker.adjudicate(actor, id, {
      ...t.review,
      responseBytesHash: "0".repeat(64),
    }),
  ).rejects.toThrow("REJECTION_CAPTURE");
});
it("accepts canonical guardrail assignment while refusing an equivalent canonical model as a negative control", async () => {
  const canonicalModel = "synthetic/model-20260903";
  id = (
    await new ManifestRegistry(f.db).stage(
      actor,
      { ...doc, canonicalModel },
      secret,
    )
  ).id;
  const t = transport(undefined, {}, { allowed_models: [canonicalModel] });
  expect(
    (await t.checker.inspect(actor, id, secrets)).assignment,
  ).toMatchObject({ passed: true });
  await expect(
    t.checker.probe(actor, id, secret, { ...spec(), model: canonicalModel }),
  ).rejects.toThrow("SINGLE_VARIABLE");
  expect(t.calls.every((c) => c.method === "GET")).toBe(true);
  const aliasOnly = transport();
  expect(
    (await aliasOnly.checker.inspect(actor, id, secrets)).assignment,
  ).toMatchObject({ passed: false });
});
it.each(["Quota exceeded", "Provider unavailable", "Authentication required"])(
  "does not accept a claimed guardrail discriminator with conflicting reason %s",
  async (message) => {
    const t = await reviewFixture(async () =>
      Response.json(
        {
          error: {
            code: 403,
            message,
            metadata: { error_type: "synthetic_model_allowlist_restriction" },
          },
        },
        { status: 403 },
      ),
    );
    await syntheticZeroCost(t.probe.reservationId);
    await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
      "CONFLICTING_REJECTION",
    );
  },
);
it("rejects error responses that also carry a positive generation or model choice", async () => {
  const t = await reviewFixture(async () =>
    Response.json(
      {
        id: "synthetic-generation",
        choices: [
          { message: { content: "MUST NEVER PERSIST THIS MODEL OUTPUT" } },
        ],
        error: {
          metadata: { error_type: "synthetic_model_allowlist_restriction" },
        },
      },
      { status: 403 },
    ),
  );
  expect(
    JSON.stringify(
      (await f.db.query("SELECT body FROM provider_guardrail_artifacts")).rows,
    ),
  ).not.toContain("MUST NEVER PERSIST");
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "REJECTION_CAPTURE",
  );
});
it.each([-7, 7])(
  "uses database evidence age despite host Date.now offset of %s days",
  async (days) => {
    const t = await reviewFixture();
    await syntheticZeroCost(t.probe.reservationId);
    const hostNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(hostNow + days * 86400000);
    expect(await t.checker.adjudicate(actor, id, t.review)).toMatchObject({
      passed: true,
      replayed: false,
    });
  },
);
it("rejects future database evidence without accepting a clock-skew tolerance", async () => {
  const t = await reviewFixture();
  await syntheticZeroCost(t.probe.reservationId);
  await f.db.query(
    "UPDATE provider_guardrail_artifacts SET observed_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
    [t.probe.captureId],
  );
  await expect(t.checker.adjudicate(actor, id, t.review)).rejects.toThrow(
    "EVIDENCE_STALE",
  );
});
it("uses the database clock to reject future inspection receipts before dispatch", async () => {
  const t = transport();
  await t.checker.inspect(actor, id, secrets);
  await f.db.query(
    "UPDATE provider_guardrail_checks SET created_at=clock_timestamp()+interval '1 minute' WHERE check_kind='assignment'",
  );
  await expect(t.checker.probe(actor, id, secret, spec())).rejects.toThrow(
    "FRESH_ASSIGNMENT",
  );
  expect(t.calls.every((c) => c.method === "GET")).toBe(true);
});

function empiricalResponse(
  kind: "wrong_model" | "wrong_provider",
  patch: Record<string, unknown> = {},
) {
  return Response.json(
    {
      error: {
        code: 404,
        message: "0 endpoints out of 1 requested match guardrail restrictions.",
        metadata: {
          failed_routing_step: "Filter by Guardrails",
          input_endpoint_count: 1,
          ineligibility_reasons: [
            {
              reason:
                kind === "wrong_model"
                  ? "model-ignored-by-guardrail"
                  : "provider-not-allowed-by-guardrail",
              endpoint_count: 1,
            },
          ],
          ...patch,
        },
      },
    },
    { status: 404 },
  );
}
function empiricalReview(capture: any) {
  return {
    captureId: capture.id,
    kind: capture.body.kind,
    responseBytesHash: capture.body.responseBytesHash,
    empiricalRouting: {
      basis: "authenticated_single_endpoint_guardrail_filter",
      reason:
        capture.body.kind === "wrong_model"
          ? "model-ignored-by-guardrail"
          : "provider-not-allowed-by-guardrail",
      documentationUrl:
        "https://openrouter.ai/docs/guides/features/guardrails/overview",
      documentationScope:
        "General allowlist behavior only; exact routing diagnostics are empirical authenticated evidence, not documented error codes.",
    },
  };
}
it.each(["wrong_model", "wrong_provider"] as const)(
  "empirical %s rejection can pass with full uncertain funds held and no zero-cost invention",
  async (kind) => {
    const t = transport(async () => empiricalResponse(kind));
    await t.checker.inspect(actor, id, secrets);
    const probe = await t.checker.probe(actor, id, secret, {
      ...spec(),
      kind,
      ...(kind === "wrong_provider"
        ? { model: doc.model, providerSlug: "other-provider" }
        : {}),
    });
    const capture = (
      await f.db.query(
        "SELECT * FROM provider_guardrail_artifacts WHERE id=$1",
        [probe.captureId],
      )
    ).rows[0];
    const before = (
      await f.db.query(
        "SELECT status,amount_micros,actual_micros FROM runtime_reservations WHERE id=$1",
        [probe.reservationId],
      )
    ).rows[0];
    const count = t.calls.length;
    const result = await t.checker.adjudicate(
      actor,
      id,
      empiricalReview(capture),
    );
    expect(result.passed).toBe(true);
    expect(t.calls.length).toBe(count);
    expect(
      (
        await f.db.query(
          "SELECT status,amount_micros,actual_micros FROM runtime_reservations WHERE id=$1",
          [probe.reservationId],
        )
      ).rows[0],
    ).toEqual(before);
    expect(before.status).toBe("uncertain");
    expect(before.actual_micros).toBeNull();
    const adjudicated = (
      await f.db.query(
        "SELECT body FROM provider_guardrail_artifacts WHERE id=$1",
        [result.artifactId],
      )
    ).rows[0].body;
    expect(adjudicated).toMatchObject({
      restrictionVerified: true,
      chargeProtected: true,
      costKnownZero: false,
      budgetProtection: "full_uncertain_reservation_held",
      evidenceBasis: "empirical_authenticated_routing",
    });
    expect(
      (await t.checker.adjudicate(actor, id, empiricalReview(capture)))
        .replayed,
    ).toBe(true);
    await f.db.query(
      "UPDATE runtime_agents SET reserved_micros=0 WHERE id='g'",
    );
    await expect(
      t.checker.adjudicate(actor, id, empiricalReview(capture)),
    ).rejects.toThrow("CHARGE_NOT_PROTECTED");
  },
);
it.each([
  { failed_routing_step: "Filter by Provider Availability" },
  { input_endpoint_count: 2 },
  {
    ineligibility_reasons: [
      { reason: "model-ignored-by-guardrail", endpoint_count: 1 },
      { reason: "provider-unavailable", endpoint_count: 1 },
    ],
  },
  {
    ineligibility_reasons: [
      { reason: "insufficient-budget", endpoint_count: 1 },
    ],
  },
  {
    ineligibility_reasons: [
      { reason: "provider-not-allowed-by-guardrail", endpoint_count: 1 },
    ],
  },
  {
    ineligibility_reasons: [
      { reason: "model-ignored-by-guardrail", endpoint_count: 0 },
    ],
  },
  { ineligibility_reasons: undefined },
])(
  "empirical routing evidence fails closed for ambiguous or wrong rejection %#",
  async (patch) => {
    const t = await reviewFixture(async () =>
      empiricalResponse("wrong_model", patch),
    );
    await expect(
      t.checker.adjudicate(actor, id, empiricalReview(t.capture)),
    ).rejects.toThrow("EMPIRICAL_ROUTING_NOT_PROOF");
  },
);
it("released uncertain funds and positive observed charges cannot support empirical adjudication", async () => {
  const t = await reviewFixture(async () => empiricalResponse("wrong_model"));
  await f.db.query(
    "UPDATE runtime_reservations SET status='released' WHERE id=$1",
    [t.probe.reservationId],
  );
  await expect(
    t.checker.adjudicate(actor, id, empiricalReview(t.capture)),
  ).rejects.toThrow("CHARGE_NOT_PROTECTED");
  await f.db.query(
    "UPDATE runtime_reservations SET status='uncertain',observed_micros=1 WHERE id=$1",
    [t.probe.reservationId],
  );
  await expect(
    t.checker.adjudicate(actor, id, empiricalReview(t.capture)),
  ).rejects.toThrow("CHARGE_NOT_PROTECTED");
});
it("activation rechecks the live wallet hold instead of trusting adjudication booleans", async () => {
  const t = await reviewFixture(async () => empiricalResponse("wrong_model"));
  const a = await t.checker.adjudicate(actor, id, empiricalReview(t.capture));
  // Isolated synthetic DB only: exercise the real activation evidence branch. The deliberately
  // mismatched fourth check ensures this test cannot activate a model or fabricate its other probe.
  await f.db.query("UPDATE provider_guardrail_artifacts SET synthetic=false");
  await f.db.query("UPDATE provider_guardrail_checks SET synthetic=false");
  await new ManifestRegistry(f.db).recordGuardrailCheck(actor, id, {
    kind: "wrong_provider",
    passed: true,
    synthetic: false,
    evidence: { artifactId: a.artifactId },
  });
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "MANIFEST_GUARDRAIL_EVIDENCE_INVALID",
  );
  await f.db.query("UPDATE runtime_agents SET reserved_micros=0 WHERE id='g'");
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "MANIFEST_GUARDRAIL_CHARGE_UNPROTECTED",
  );
  expect((await new ManifestRegistry(f.db).get(id)).status).toBe("staged");
});

it("single-serving branch assurance states its live-denial limitation and rechecks driver proof during activation", async () => {
  const t = await reviewFixture(async () => empiricalResponse("wrong_model"));
  await t.checker.adjudicate(actor, id, empiricalReview(t.capture));
  const posts = t.calls.filter((c) => c.method === "POST").length;
  const a = await t.checker.certifySingleServingFamily(actor, id, secrets);
  expect(a).toMatchObject({
    gateSatisfied: true,
    liveProbePassed: false,
    activeTags: [doc.providerSlug],
  });
  expect(t.calls.filter((c) => c.method === "POST").length).toBe(posts);
  expect(
    await new ManifestRegistry(f.db).providerRestrictionEvidence(id),
  ).toMatchObject({
    status: "policy_and_local_pin_only",
    liveProbePassed: false,
  });
  // Isolated test only: exercise production activation validation; no positive inference receipt
  // exists, so even complete control evidence cannot activate this synthetic model.
  await f.db.query("UPDATE provider_guardrail_artifacts SET synthetic=false");
  await f.db.query("UPDATE provider_guardrail_checks SET synthetic=false");
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "MANIFEST_INFERENCE_CANARY_REQUIRED",
  );
  const row = (
    await f.db.query(
      "SELECT body FROM provider_guardrail_artifacts WHERE id=$1",
      [a.artifactId],
    )
  ).rows[0];
  row.body.localProof.driverHash = "f".repeat(64);
  const { evidenceHash } =
    await import("../src/providers/guardrail-evidence.js");
  await f.db.query(
    "UPDATE provider_guardrail_artifacts SET body=$2,body_hash=$3 WHERE id=$1",
    [a.artifactId, row.body, evidenceHash(row.body)],
  );
  await expect(new ManifestRegistry(f.db).activate(actor, id)).rejects.toThrow(
    "MANIFEST_SINGLE_PROVIDER_ASSURANCE_INVALID",
  );
});
it.each(
  [
    [
      {
        tag: doc.providerSlug,
        status: 0,
        supported_parameters: ["max_tokens"],
      },
      {
        tag: "another-provider",
        status: 0,
        supported_parameters: ["max_tokens"],
      },
    ],
    [
      {
        tag: doc.providerSlug,
        status: 0,
        supported_parameters: ["max_tokens"],
      },
      {
        tag: doc.providerSlug + "/other-tier",
        status: 0,
        supported_parameters: ["max_tokens"],
      },
    ],
    [
      {
        tag: doc.providerSlug,
        status: 1,
        supported_parameters: ["max_tokens"],
      },
    ],
  ].map((endpoints) => ({ endpoints })),
)(
  "catalog assurance cannot stand in for a callable independent provider test %#",
  async ({ endpoints }) => {
    const t = transport(undefined, {}, {}, endpoints);
    await expect(
      t.checker.certifySingleServingFamily(actor, id, secrets),
    ).rejects.toThrow("INDEPENDENT_PROVIDER_CONTROL_EXISTS");
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  },
);
it("reviewed training-policy-confounded control gets one new attempt and preserves earlier held charge", async () => {
  let n = 0;
  const t = await reviewFixture(async () =>
    ++n === 1
      ? empiricalResponse("wrong_model", {
          ineligibility_reasons: [
            { reason: "model-ignored-by-guardrail", endpoint_count: 1 },
            {
              reason: "paid-model-training-violation-by-account",
              endpoint_count: 1,
            },
          ],
        })
      : empiricalResponse("wrong_model"),
  );
  const revision = {
    ...spec(),
    model: "synthetic/other-control",
    controlRevision: {
      priorCaptureId: t.capture.id,
      reason: "operator-reviewed-control-confounded-by-account-training-policy",
    },
  };
  const second = await t.checker.probe(actor, id, secret, revision);
  expect(second.captureId).not.toBe(t.capture.id);
  expect(n).toBe(2);
  expect((await t.checker.probe(actor, id, secret, revision)).replayed).toBe(
    true,
  );
  expect(n).toBe(2);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM runtime_reservations WHERE status='uncertain'",
      )
    ).rows[0].n,
  ).toBe(2);
  const next = {
    ...revision,
    model: "synthetic/third-control",
    controlRevision: {
      ...revision.controlRevision,
      priorCaptureId: second.captureId,
    },
  };
  await expect(t.checker.probe(actor, id, secret, next)).rejects.toThrow(
    "CONTROL_REVISION_INVALID",
  );
});
it("a generic failed capture cannot authorize a revised paid probe", async () => {
  const t = await reviewFixture();
  await expect(
    t.checker.probe(actor, id, secret, {
      ...spec(),
      model: "synthetic/other-control",
      controlRevision: {
        priorCaptureId: t.capture.id,
        reason:
          "operator-reviewed-control-confounded-by-account-training-policy",
      },
    }),
  ).rejects.toThrow("CONTROL_REVISION_INVALID");
});
it("Kimi policy/local exception requires explicit acceptance, real-canary linkage and a bounded empty alternate search", async () => {
  const { MODEL_CONTROL_GAP_LIMITATION } =
    await import("../src/providers/guardrail-evidence.js");
  const { RuntimeStore } = await import("../src/runtime/index.js");
  const { randomUUID } = await import("node:crypto");
  const d = {
    ...doc,
    developer: "Moonshot/Kimi" as const,
    model: "moonshotai/kimi-k3",
    canonicalModel: "moonshotai/kimi-k3-20260715",
    providerSlug: "moonshotai/mxfp4",
  };
  const m = await new ManifestRegistry(f.db).stage(actor, d, secret);
  let alternateCallable = false,
    posts = 0;
  const checker = new GuardrailChecker(f.db, {
    synthetic: true,
    fetchImpl: async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        throw Error("No paid requests allowed in this fixture");
      }
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/key" || path.startsWith("/api/v1/keys/"))
        return Response.json({
          data: {
            hash: d.upstreamKeyHash,
            disabled: false,
            is_management_key: false,
            limit: 40,
            limit_remaining: 39,
            limit_reset: null,
            include_byok_in_limit: true,
          },
        });
      if (path.endsWith("/assignments/keys"))
        return Response.json({
          data: [{ key_hash: d.upstreamKeyHash, guardrail_id: d.guardrailId }],
          total_count: 1,
        });
      if (path.startsWith("/api/v1/guardrails/"))
        return Response.json({
          data: {
            id: d.guardrailId,
            allowed_models: [d.canonicalModel],
            allowed_providers: [d.providerSlug],
          },
        });
      if (path === "/api/v1/models")
        return Response.json({
          data: [
            { id: d.model, canonical_slug: d.canonicalModel },
            {
              id: "moonshotai/kimi-k2.6",
              canonical_slug: "moonshotai/kimi-k2.6",
            },
          ],
        });
      if (path.endsWith("/endpoints"))
        return Response.json({
          data: {
            id: "moonshotai/kimi-k2.6",
            endpoints: [
              {
                tag: alternateCallable ? d.providerSlug : "moonshotai/other",
                status: 0,
                supported_parameters: ["max_tokens"],
              },
            ],
          },
        });
      throw Error("Unexpected synthetic public endpoint");
    },
  });
  await expect(
    checker.certifyKimiModelControlGap(actor, m.id, secrets, "unaccepted"),
  ).rejects.toThrow("OPERATOR_ACCEPTANCE_REQUIRED");
  await expect(
    checker.certifyKimiModelControlGap(
      actor,
      m.id,
      secrets,
      MODEL_CONTROL_GAP_LIMITATION,
    ),
  ).rejects.toThrow("POSITIVE_MODEL_TOOL_CANARY_REQUIRED");
  // Explicit synthetic positive/tool fixture, isolated DB; cannot be confused with real evidence.
  const jobId = await new ManifestRegistry(f.db).createCanaryJob(m.id);
  const job = (await new RuntimeStore(f.db).claim(
    "fixture-canary",
    30000,
    undefined,
    ["g"],
    jobId,
  ))!;
  const callId = randomUUID();
  await f.db.query(
    "INSERT INTO provider_calls(id,manifest_id,agent_id,job_id,fence,staff_role,purpose,requested_model,requested_provider,reported_model,reported_provider,status,reconciliation_status,cost_micros,generation_id) VALUES($1,$2,'g',$3,$4,'owner','canary',$5,$6,$7,$8,'verified','verified',1,'SYNTHETIC')",
    [
      callId,
      m.id,
      jobId,
      job.fence,
      d.model,
      d.providerSlug,
      d.canonicalModel,
      d.reportedProviderNames[0],
    ],
  );
  await f.db.query(
    "INSERT INTO runtime_receipts(type,agent_id,details) VALUES('provider_diagnostic','g',$1)",
    [{ kind: "canary_read_tool", tool: "research_sources", executed: true }],
  );
  await f.db.query(
    "UPDATE provider_calls SET completed_at=clock_timestamp() WHERE id=$1",
    [callId],
  );
  await f.db.query("UPDATE runtime_jobs SET status='completed' WHERE id=$1", [
    jobId,
  ]);
  const result = await checker.certifyKimiModelControlGap(
    actor,
    m.id,
    secrets,
    MODEL_CONTROL_GAP_LIMITATION,
  );
  expect(result).toMatchObject({
    liveModelRejectionTested: false,
    modelsChecked: 1,
    positiveCallId: callId,
  });
  expect(
    await new ManifestRegistry(f.db).modelRestrictionEvidence(m.id),
  ).toMatchObject({
    liveModelRejectionTested: false,
    status: "operator_accepted_policy_and_local_pin_only",
  });
  alternateCallable = true;
  await expect(
    checker.certifyKimiModelControlGap(
      actor,
      m.id,
      secrets,
      MODEL_CONTROL_GAP_LIMITATION,
    ),
  ).rejects.toThrow("ALTERNATE_MODEL_CONTROL_EXISTS");
  expect(posts).toBe(0);
});
it("reviewed accepted ancestor selector permits one distinct control while preserving its charge", async () => {
  const original = doc.providerSlug;
  try {
    doc.providerSlug = original + "/zdr";
    id = (await new ManifestRegistry(f.db).stage(actor, doc, secret)).id;
    let posts = 0;
    const t = transport(async () =>
      ++posts === 1
        ? Response.json({
            id: "synthetic-accepted-ancestor",
            model: doc.model,
            usage: { cost: 0.00058 },
            choices: [{ message: { content: "synthetic" } }],
          })
        : empiricalResponse("wrong_provider"),
    );
    await t.checker.inspect(actor, id, secrets);
    const first = await t.checker.probe(actor, id, secret, {
      ...spec(),
      kind: "wrong_provider",
      model: doc.model,
      providerSlug: original,
    });
    // Explicitly simulate the production unknown-billing state for this synthetic ancestor receipt.
    await f.db.query(
      "UPDATE runtime_reservations SET status='uncertain',actual_micros=NULL,observed_micros=580 WHERE id=$1",
      [first.reservationId],
    );
    await f.db.query(
      "UPDATE runtime_agents SET reserved_micros=100000 WHERE id='g'",
    );
    const revision = {
      ...spec(),
      kind: "wrong_provider",
      model: doc.model,
      providerSlug: "independent-synthetic",
      controlRevision: {
        priorCaptureId: first.captureId,
        reason: "operator-reviewed-ancestor-provider-selector-overlap",
      },
    };
    const next = await t.checker.probe(actor, id, secret, revision);
    expect(posts).toBe(2);
    expect(next.captureId).not.toBe(first.captureId);
    const held = (
      await f.db.query(
        "SELECT status,observed_micros,actual_micros FROM runtime_reservations WHERE id=$1",
        [first.reservationId],
      )
    ).rows[0];
    expect(held).toEqual({
      status: "uncertain",
      observed_micros: "580",
      actual_micros: null,
    });
    expect((await t.checker.probe(actor, id, secret, revision)).replayed).toBe(
      true,
    );
    expect(posts).toBe(2);
  } finally {
    doc.providerSlug = original;
  }
});
