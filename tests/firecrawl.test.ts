import { RehearsalRuntime } from "../src/runtime/rehearsal.js";
import { it, expect } from "vitest";
import { bindHost } from "../src/league/host.js";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  FirecrawlClient,
  FirecrawlInputSchema,
} from "../src/research/firecrawl-client.js";
import {
  FirecrawlResearch,
  type FirecrawlBudget,
} from "../src/research/firecrawl.js";
import { createOwnerResearchTools } from "../src/research/index.js";
async function fixture(fetchImpl: typeof fetch, rehearsalCap?: number) {
  const f = await testDb(),
    store = new RuntimeStore(f.db);

  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES('synthetic-firecrawl','SYNTHETIC FIRECRAWL','{}')",
  );
  await f.db.query(
    "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES('synthetic-firecrawl','team','SYNTHETIC','owner','ai',0,0,100)",
  );
  await store.createAgent({
    id: "agent",
    model: "synthetic/model",
    budgetMicros: 1_000_000,
  });
  await f.db.query(
    "INSERT INTO runtime_bindings VALUES('agent','synthetic-firecrawl','team')",
  );
  if (rehearsalCap !== undefined) {
    const actor = {
      id: "commissioner",
      role: "commissioner" as const,
      leagueId: "synthetic-firecrawl",
    };
    await bindHost(f.db, actor, {
      leagueId: actor.leagueId,
      host: "mfl",
      expectedVersion: 0,
      idempotencyKey: "original",
      reason: "Synthetic original host binding",
      config: {
        season: 2026,
        leagueId: "62282",
        configRef: "synthetic-original",
      },
    });
    await f.db.query("UPDATE runtime_agents SET enabled=false");
    const rehearsal = new RehearsalRuntime(f.db, store);
    await rehearsal.arm(actor, {
      epoch: "paid-research-rehearsal",
      expectedHostVersion: 1,
      trialConfigRef: "synthetic-trial",
      capMicros: rehearsalCap,
      synthetic: true,
      operatorEvidenceRef: "SYNTHETIC no network test",
      reason: "Synthetic rehearsal research budget test",
    });
    await f.db.query("UPDATE runtime_agents SET enabled=true");
    await rehearsal.wakeOwner(actor, {
      epoch: "paid-research-rehearsal",
      agentId: "agent",
      causalId: "synthetic-paid-research",
      reason: "SYNTHETIC research budget test wake",
    });
  } else
    await store.ingestEvent({
      agentId: "agent",
      causalId: "synthetic-paid-research",
      payload: { synthetic: true },
    });
  const job = (await store.claim("synthetic-worker", 60000))!;
  await store.reserve(job, 100000);
  const verifiedAt = (
    await f.db.query("SELECT clock_timestamp() now")
  ).rows[0].now.toISOString();
  const budget: FirecrawlBudget = {
    keyRef: "B4_LEAGUE_FIRECRAWL_TEST",
    approvalReceiptId: "SYNTHETIC approval",
    costPerCreditMicros: 3800,
    reservationPerCreditMicros: 5000,
    maxCredits: { search: 5, scrape: 5 },
    maxCreditsPerFranchise: 100,
    verifiedAt,
    maxAgeHours: 24,
  };
  const client = new FirecrawlClient({
    apiKey: "SYNTHETIC_NOT_A_REAL_KEY",
    enabled: true,
    fetchImpl,
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const paid = new FirecrawlResearch(f.db, {
    client,
    enabled: true,
    synthetic: true,
    budget,
  });
  return { ...f, store, job, client, paid, budget };
}
const result = (credits: unknown = 2) =>
  new Response(
    JSON.stringify({
      success: true,
      id: "synthetic-request",
      creditsUsed: credits,
      data: {
        web: [
          {
            title: "SYNTHETIC source",
            url: "https://example.com/article",
            description:
              "Only synthetic public-source data, not an actual web search.",
          },
        ],
      },
    }),
    { status: 200 },
  );
it("direct search uses exact API, no model/agent options, attributes credit allocation independently of model hold", async () => {
  let calls = 0;
  const f = await fixture(async (url, init) => {
    calls++;
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "SYNTHETIC query",
      limit: 3,
      sources: ["web"],
      timeout: 15000,
      highlights: false,
    });
    return result();
  });
  try {
    const r = await f.paid.execute(f.job, {
      kind: "search",
      query: "SYNTHETIC query",
      operationKey: "search1",
    });
    expect(r).toMatchObject({
      status: "retrieved",
      creditsUsed: 2,
      synthetic: true,
      invoiceChargeKnown: false,
      billing: { status: "settled", reservedMicros: 25000, actualMicros: 7600 },
    });
    expect(
      (
        await f.paid.execute(f.job, {
          kind: "search",
          query: "SYNTHETIC query",
          operationKey: "search1",
        })
      ).replayed,
    ).toBe(true);
    expect(calls).toBe(1);
    const wallet = (
      await f.db.query(
        "SELECT spent_micros,reserved_micros FROM runtime_agents WHERE id='agent'",
      )
    ).rows[0];
    expect(wallet).toEqual({ spent_micros: "7600", reserved_micros: "100000" });
    const row = (await f.db.query("SELECT * FROM research_paid_operations"))
      .rows[0];
    expect(row).toMatchObject({
      league_id: "synthetic-firecrawl",
      agent_id: "agent",
      job_id: f.job.id,
      status: "completed",
      credits_used: "2",
    });
    expect(JSON.stringify(row)).not.toContain("SYNTHETIC_NOT_A_REAL_KEY");
    await expect(
      f.paid.execute(f.job, {
        kind: "search",
        query: "changed",
        operationKey: "search1",
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  } finally {
    await f.close();
  }
});
it.each(["timeout", "missing credits", "http failure", "malformed"])(
  "holds %s charge and refuses a fresh operation without repeating POST",
  async (mode) => {
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      if (mode === "timeout") throw Error("secret transport detail");
      if (mode === "missing credits") return result(null);
      if (mode === "malformed") return new Response("not-json");
      return new Response(
        JSON.stringify({ success: false, error: "private server detail" }),
        { status: 500 },
      );
    });
    try {
      const input = {
        kind: "search" as const,
        query: "SYNTHETIC",
        operationKey: "one",
      };
      const r = await f.paid.execute(f.job, input);
      expect(r.billing).toMatchObject({ status: "held", actualMicros: null });
      expect(JSON.stringify(r)).not.toContain("secret transport detail");
      expect((await f.paid.execute(f.job, input)).replayed).toBe(true);
      await expect(
        f.paid.execute(f.job, { ...input, operationKey: "two" }),
      ).rejects.toThrow("UNRESOLVED_OPERATION");
      expect(calls).toBe(1);
      expect(
        (
          await f.db.query(
            "SELECT reserved_micros FROM runtime_agents WHERE id='agent'",
          )
        ).rows[0].reserved_micros,
      ).toBe("125000");
    } finally {
      await f.close();
    }
  },
);
it("parallel same operation never dispatches twice", async () => {
  let calls = 0,
    release!: () => void,
    entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    calls++;
    entered();
    await hold;
    return result();
  });
  try {
    const input = {
      kind: "search" as const,
      query: "SYNTHETIC",
      operationKey: "parallel",
    };
    const first = f.paid.execute(f.job, input);
    await ready;
    const second = await f.paid.execute(f.job, input);
    expect(second).toMatchObject({
      replayed: true,
      billing: { status: "held" },
    });
    release();
    expect((await first).billing.status).toBe("settled");
    expect(calls).toBe(1);
  } finally {
    release();
    await f.close();
  }
});
it("stale or changed owner job, disabled paid tools, exhausted wallet and allowance fail before POST", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result();
  });
  try {
    await expect(
      f.paid.execute(
        { ...f.job, fence: f.job.fence + 1 },
        { kind: "search", query: "SYNTHETIC" },
      ),
    ).rejects.toThrow("AUTHORITY");
    await expect(
      f.paid.execute(
        { ...f.job, agentId: "other" },
        { kind: "search", query: "SYNTHETIC" },
      ),
    ).rejects.toThrow("AUTHORITY");
    await expect(
      new FirecrawlResearch(f.db, {
        client: f.client,
        budget: f.budget,
        enabled: false,
      }).execute(f.job, { kind: "search", query: "SYNTHETIC" }),
    ).rejects.toThrow("DISABLED");
    await f.db.query(
      "UPDATE runtime_agents SET budget_micros=110000 WHERE id='agent'",
    );
    await expect(
      f.paid.execute(f.job, { kind: "search", query: "SYNTHETIC" }),
    ).rejects.toThrow("BUDGET_EXHAUSTED");
    await f.db.query(
      "UPDATE runtime_agents SET budget_micros=1000000 WHERE id='agent'",
    );
    const small = new FirecrawlResearch(f.db, {
      client: f.client,
      budget: { ...f.budget, maxCreditsPerFranchise: 5 },
      enabled: true,
    });
    await small.execute(f.job, {
      kind: "search",
      query: "SYNTHETIC",
      operationKey: "allowance1",
    });
    await expect(
      small.execute(f.job, {
        kind: "search",
        query: "SYNTHETIC2",
        operationKey: "allowance2",
      }),
    ).rejects.toThrow("CREDIT_ALLOWANCE_EXHAUSTED");
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});
it("scrape is markdown-only, no proxy auto retry or PDF/LLM transforms; absent credits remain unknown", async () => {
  const f = await fixture(async (url, init) => {
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(JSON.parse(init?.body as string)).toEqual({
      url: "https://example.com/article",
      formats: ["markdown"],
      onlyMainContent: true,
      proxy: "basic",
      maxAge: 0,
      timeout: 15000,
      parsers: [],
      storeInCache: false,
      skipTlsVerification: false,
    });
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          markdown: "SYNTHETIC markdown",
          metadata: {
            sourceURL: "https://example.com/article",
            title: "Synthetic",
            statusCode: 200,
          },
        },
      }),
    );
  });
  try {
    const r = await f.paid.execute(f.job, {
      kind: "scrape",
      url: "https://example.com/article",
    });
    expect(r.status).toBe("retrieved");
    expect(r.billing.status).toBe("held");
    expect(r.creditsUsed).toBeNull();
    expect(
      FirecrawlInputSchema.safeParse({ kind: "agent", prompt: "other model" })
        .success,
    ).toBe(false);
    expect(
      FirecrawlInputSchema.safeParse({
        kind: "scrape",
        url: "https://example.com",
        formats: ["json"],
      }).success,
    ).toBe(false);
    const tools = createOwnerResearchTools(f.db, {
      firecrawl: f.paid,
      retrievalMode: "general-public",
    });
    expect(tools.map((t) => t.name)).toContain("research_search");
    expect(await tools[0]!.execute(f.job, {})).toMatchObject({
      search: { provider: "firecrawl", otherReasoningModel: false },
    });
  } finally {
    await f.close();
  }
});
it("defaults page retrieval to the public reader and requires explicit paid scraping", async () => {
  let paidCalls = 0,
    publicCalls = 0;
  const f = await fixture(async (url) => {
    paidCalls++;
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    return new Response(
      JSON.stringify({
        success: true,
        creditsUsed: 1,
        data: {
          markdown: "SYNTHETIC paid content",
          metadata: {
            sourceURL: "https://example.com/paid",
            title: "Synthetic",
          },
        },
      }),
    );
  });
  try {
    const tools = createOwnerResearchTools(f.db, {
      firecrawl: f.paid,
      retrievalMode: "general-public",
      transport: async () => {
        publicCalls++;
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><title>Synthetic public</title><main>SYNTHETIC public reading fixture.</main></html>",
        };
      },
    });
    const retrieve = tools.find((t) => t.name === "research_retrieve")!;
    await retrieve.execute(f.job, { url: "https://example.com/default" });
    await retrieve.execute(f.job, {
      url: "https://example.com/explicit-public",
      reader: "public",
    });
    expect(publicCalls).toBe(2);
    expect(paidCalls).toBe(0);
    expect(
      (await f.db.query("SELECT count(*) FROM research_paid_operations"))
        .rows[0].count,
    ).toBe("0");
    await retrieve.execute(f.job, {
      url: "https://example.com/paid",
      reader: "firecrawl",
    });
    expect(publicCalls).toBe(2);
    expect(paidCalls).toBe(1);
    expect(
      (await f.db.query("SELECT kind,status FROM research_paid_operations"))
        .rows,
    ).toEqual([{ kind: "scrape", status: "completed" }]);
    expect(retrieve.description).toContain("credit usage");
    expect(await tools[0]!.execute(f.job, {})).toMatchObject({
      publicReading: { defaultReader: "public" },
      search: {
        provider: "firecrawl",
        scrapeRequiresExplicitReader: "firecrawl",
      },
    });
  } finally {
    await f.close();
  }
});
it("blocked public target and private DNS are rejected before any provider POST", async () => {
  let calls = 0;
  const client = new FirecrawlClient({
    apiKey: "SYNTHETIC",
    enabled: true,
    fetchImpl: async () => {
      calls++;
      return result();
    },
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await expect(
    client.plan({ kind: "scrape", url: "https://example.com/" }),
  ).rejects.toThrow("NONPUBLIC");
  await expect(
    client.plan({ kind: "scrape", url: "https://localhost/" }),
  ).rejects.toThrow("URL_NOT_PERMITTED");
  expect(calls).toBe(0);
});

it("blocks research before POST when its reservation exceeds the rehearsal cap including existing model liability", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result();
  }, 120000);
  try {
    await expect(
      f.paid.execute(f.job, { kind: "search", query: "SYNTHETIC cap" }),
    ).rejects.toThrow("REHEARSAL_CAP_EXHAUSTED");
    expect(calls).toBe(0);
    expect(
      (await f.db.query("SELECT 1 FROM research_paid_operations")).rowCount,
    ).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT reserved_micros FROM runtime_agents WHERE id='agent'",
        )
      ).rows[0].reserved_micros,
    ).toBe("100000");
  } finally {
    await f.close();
  }
});
it("allows the exact rehearsal liability boundary, then counts settled research allocation on the next request", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result();
  }, 125000);
  try {
    const first = await f.paid.execute(f.job, {
      kind: "search",
      query: "SYNTHETIC boundary",
      operationKey: "first",
    });
    expect(first.billing.status).toBe("settled");
    await expect(
      f.paid.execute(f.job, {
        kind: "search",
        query: "SYNTHETIC next",
        operationKey: "next",
      }),
    ).rejects.toThrow("REHEARSAL_CAP_EXHAUSTED");
    expect(calls).toBe(1);
    expect(
      (await f.db.query("SELECT count(*)::int n FROM research_paid_operations"))
        .rows[0].n,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it("holds research when the rehearsal stops between claiming a job and dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result();
  }, 125000);
  try {
    await f.db.query("UPDATE runtime_rehearsals SET status='stopped'");
    await expect(
      f.paid.execute(f.job, { kind: "search", query: "SYNTHETIC stopped" }),
    ).rejects.toThrow("REHEARSAL_NOT_ARMED");
    expect(calls).toBe(0);
    expect(
      (await f.db.query("SELECT 1 FROM research_paid_operations")).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
it("refuses paid research when the same rehearsal already has an unresolved model charge, preserving its hold", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result();
  }, 200000);
  try {
    await f.db.query(
      "UPDATE runtime_reservations SET status='uncertain' WHERE job_id=$1",
      [f.job.id],
    );
    await expect(
      f.paid.execute(f.job, { kind: "search", query: "SYNTHETIC unresolved" }),
    ).rejects.toThrow("REHEARSAL_COST_UNRESOLVED");
    expect(calls).toBe(0);
    expect(
      (await f.db.query("SELECT 1 FROM research_paid_operations")).rowCount,
    ).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT reserved_micros FROM runtime_agents WHERE id='agent'",
        )
      ).rows[0].reserved_micros,
    ).toBe("100000");
  } finally {
    await f.close();
  }
});
