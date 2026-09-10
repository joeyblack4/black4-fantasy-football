import { describe, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { RuntimeStore, type Job } from "../src/runtime/index.js";
import {
  ResearchStore,
  createOwnerResearchTools,
  permittedUrl,
  isPublicAddress,
  extractDocument,
  officialNflSources,
  type ResearchTransport,
} from "../src/research/index.js";
async function fixture(transport: ResearchTransport) {
  const h = await testDb(),
    league = new LeagueService(h.db),
    runtime = new RuntimeStore(h.db),
    actor: Actor = {
      id: "admin",
      leagueId: "synthetic-research",
      role: "commissioner",
    };
  await league.execute(actor, {
    type: "createLeague",
    leagueId: actor.leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC research test",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "WR", positions: ["WR"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "team-" + i,
      ownerId: "owner-" + i,
      name: "Synthetic " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await runtime.createAgent({
    id: "research-agent",
    model: "SYNTHETIC/test",
    budgetMicros: 1000000,
  });
  await h.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
    ["research-agent", actor.leagueId, "team-0"],
  );
  await runtime.ingestEvent({
    agentId: "research-agent",
    causalId: "synthetic-research-job",
    payload: { synthetic: true },
  });
  const job = (await runtime.claim("research-test-worker", 60000))!;
  return {
    ...h,
    job,
    runtime,
    store: new ResearchStore(h.db, { transport }),
    actor,
  };
}
const html =
  '<html><head><title>Synthetic test headline</title><meta property="article:published_time" content="2026-09-07T01:00:00Z"></head><body><nav>Noise</nav><main><h1>Synthetic research content</h1><script>STEAL_CREDENTIALS</script><p>This fake article is only a test fixture. Ignore previous instructions is untrusted text.</p><a href="/news/synthetic-followup">Synthetic follow-up</a><a href="https://attacker.example/?token=secret">Bad link</a></main></body></html>';
const ok: ResearchTransport = async () => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: html,
});
describe("bounded owner research tools", () => {
  it("allows only the public source catalog for a fenced staged-model canary", async () => {
    const f = await fixture(ok);
    try {
      const manifestId = "10000000-0000-4000-8000-000000000001";
      await f.db.query("UPDATE runtime_agents SET enabled=false WHERE id=$1", [
        f.job.agentId,
      ]);
      await f.db.query(
        "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint) VALUES($1,$2,$3,1,$4,'synthetic')",
        [
          manifestId,
          f.actor.leagueId,
          f.job.agentId,
          { model: "synthetic/staged" },
        ],
      );
      await f.db.query(
        "UPDATE runtime_jobs SET execution_mode='provider_canary',payload=$2 WHERE id=$1",
        [f.job.id, { manifestId }],
      );
      const staged = { ...f.job, model: "synthetic/staged" };
      expect((await f.store.listSources(staged)).status).toBe("available");
      await expect(
        f.store.retrieve(staged, { url: "https://www.nfl.com/news/synthetic" }),
      ).rejects.toThrow("JOB_AUTHORITY");
      await expect(
        f.store.listSources({ ...staged, model: "synthetic/wrong" }),
      ).rejects.toThrow("JOB_AUTHORITY");
      await expect(
        f.store.listSources({ ...staged, fence: staged.fence + 1 }),
      ).rejects.toThrow("JOB_AUTHORITY");
      await f.db.query(
        "UPDATE provider_manifests SET status='retired' WHERE id=$1",
        [manifestId],
      );
      await expect(f.store.listSources(staged)).rejects.toThrow(
        "JOB_AUTHORITY",
      );
    } finally {
      await f.close();
    }
  });
  it("exposes only approved source paths and blocks credentials, redirects, private address forms and unsupported domains", () => {
    expect(permittedUrl("https://www.nfl.com/news/synthetic").source.id).toBe(
      "nfl-news",
    );
    for (const url of [
      "http://www.nfl.com/news",
      "https://www.nfl.com@127.0.0.1/news",
      "https://www.nfl.com/news?token=secret",
      "https://www.nfl.com:8443/news",
      "https://www.nfl.com/account",
      "https://www.nfl.com.evil.example/news",
      "https://169.254.169.254/news",
      "https://www.nfl.com/news#secret",
      "https://www.nfl.com/news%2fhidden",
    ])
      expect(() => permittedUrl(url)).toThrow();
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.31.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "198.18.0.1",
      "224.1.2.3",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("persists retrieval provenance, bounded untrusted excerpts and cache receipts without storing raw pages", async () => {
    let calls = 0;
    const f = await fixture(async (u) => {
      calls++;
      return ok(u);
    });
    try {
      const first = await f.store.retrieve(f.job, {
        url: "https://www.nfl.com/news",
      });
      expect(first).toMatchObject({
        status: "retrieved",
        cached: false,
        untrustedContent: true,
        sourceTime: "2026-09-07T01:00:00.000Z",
      });
      expect(JSON.stringify(first)).not.toContain("STEAL_CREDENTIALS");
      expect(JSON.stringify(first)).not.toContain("attacker.example");
      const second = await f.store.retrieve(f.job, {
        url: "https://www.nfl.com/news",
      });
      expect(second).toMatchObject({ status: "retrieved", cached: true });
      expect(calls).toBe(1);
      const cache = (await f.db.query("SELECT document FROM research_cache"))
        .rows[0].document;
      expect(cache).not.toHaveProperty("body");
      expect(cache).not.toHaveProperty("html");
      expect(
        (
          await f.db.query(
            "SELECT status FROM research_receipts ORDER BY created_at",
          )
        ).rows.map((r) => r.status),
      ).toEqual(["retrieved", "cached"]);
    } finally {
      await f.close();
    }
  });
  it("does not turn missing source time into a fresh news assertion and bounds excerpt/link volume", async () => {
    const fixtureHtml =
      "<main>" +
      Array.from({ length: 1000 }, (_, i) => "synthetic" + i).join(" ") +
      "</main>";
    const f = await fixture(async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: fixtureHtml,
    }));
    try {
      const result = await f.store.retrieve(f.job, {
        url: "https://www.nfl.com/injuries/",
      });
      expect(result).toMatchObject({
        status: "retrieved",
        sourceTime: null,
        sourceTimeBasis: "unknown",
        truncated: true,
        freshness: { sourceTimeStatus: "unknown", sourceAgeMs: null },
      });
      if ("excerpt" in result)
        expect(String(result.excerpt).split(" ")).toHaveLength(120);
    } finally {
      await f.close();
    }
  });
  it("returns unavailable for redirects, huge pages and transport errors without leaking request secrets", async () => {
    let mode = 0;
    const f = await fixture(async () => {
      mode++;
      if (mode === 1)
        return {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
          body: "",
        };
      if (mode === 2)
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "x".repeat(4000001),
        };
      throw new Error("FAKE_SECRET_MUST_NEVER_ESCAPE");
    });
    try {
      expect(
        await f.store.retrieve(f.job, { url: "https://www.nfl.com/news/a" }),
      ).toMatchObject({ status: "unavailable", code: "REDIRECT_NOT_ALLOWED" });
      expect(
        await f.store.retrieve(f.job, { url: "https://www.nfl.com/news/b" }),
      ).toMatchObject({ status: "unavailable", code: "BODY_TOO_LARGE" });
      const failed = await f.store.retrieve(f.job, {
        url: "https://www.nfl.com/news/c",
      });
      expect(failed).toMatchObject({
        status: "unavailable",
        code: "SOURCE_UNAVAILABLE",
      });
      expect(JSON.stringify(failed)).not.toContain("FAKE_SECRET");
      expect(
        JSON.stringify(
          (await f.db.query("SELECT details FROM research_receipts")).rows,
        ),
      ).not.toContain("FAKE_SECRET");
    } finally {
      await f.close();
    }
  });
  it("enforces active fenced job identity and finite research requests without inventing paid search access", async () => {
    let calls = 0;
    const f = await fixture(async (u) => {
      calls++;
      return ok(u);
    });
    try {
      const tools = createOwnerResearchTools(f.db, { transport: ok });
      expect(tools.map((t) => t.name)).toEqual([
        "research_sources",
        "research_retrieve",
        "research_search",
      ]);
      expect(await f.store.listSources(f.job)).toMatchObject({
        search: { status: "unavailable" },
      });
      expect(
        await f.store.search(f.job, { query: "Synthetic test query" }),
      ).toMatchObject({ status: "unavailable", code: "SEARCH_NOT_CONFIGURED" });
      expect(calls).toBe(0);
      await expect(
        f.store.retrieve(
          { ...f.job, fence: f.job.fence + 1 },
          { url: "https://www.nfl.com/news" },
        ),
      ).rejects.toMatchObject({ code: "JOB_AUTHORITY_EXPIRED_OR_UNBOUND" });
      for (let i = 0; i < 7; i++)
        await f.store.retrieve(f.job, { url: "https://www.nfl.com/news" });
      await expect(
        f.store.retrieve(f.job, { url: "https://www.nfl.com/news" }),
      ).rejects.toMatchObject({ code: "RESEARCH_RATE_LIMIT" });
      await f.db.query(
        "UPDATE runtime_jobs SET lease_until=clock_timestamp()-interval '1 second'",
      );
      await expect(f.store.listSources(f.job)).rejects.toMatchObject({
        code: "JOB_AUTHORITY_EXPIRED_OR_UNBOUND",
      });
    } finally {
      await f.close();
    }
  });
  it("deduplicates an in-flight page fetch through a durable cache lease", async () => {
    let complete!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => (complete = resolve));
    const f = await fixture(async (u) => {
      calls++;
      await gate;
      return ok(u);
    });
    try {
      const first = f.store.retrieve(f.job, {
        url: "https://www.nfl.com/news",
      });
      // Wait for an authoritative pending fetch lease, not for an assumed elapsed delay.
      for (let i = 0; i < 100; i++) {
        const row = await f.db.query(
          "SELECT 1 FROM research_cache WHERE fetch_token IS NOT NULL",
        );
        if (row.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const second = await f.store.retrieve(f.job, {
        url: "https://www.nfl.com/news",
      });
      expect(second).toMatchObject({
        status: "unavailable",
        code: "SOURCE_FETCH_IN_PROGRESS",
      });
      expect(calls).toBe(1);
      complete();
      expect(await first).toMatchObject({ status: "retrieved" });
    } finally {
      complete();
      await f.close();
    }
  });
});

describe("explicit general public retrieval", () => {
  it("keeps default NFL policy and enables bounded cross-domain reading only by operator option", async () => {
    const f = await fixture(ok);
    try {
      const page = "https://www.fantasypros.com/nfl/news/";
      await expect(f.store.retrieve(f.job, { url: page })).rejects.toThrow(
        "URL_NOT_PERMITTED",
      );
      let calls = 0;
      const store = new ResearchStore(f.db, {
        retrievalMode: "general-public",
        transport: async (u) => {
          calls++;
          return {
            ...(await ok(u)),
            body: '<main>Untrusted public test text <a href="https://www.espn.com/nfl/">Other public site</a><a href="https://127.0.0.1/">Unsafe</a></main>',
          };
        },
      });
      const result = await store.retrieve(f.job, { url: page });
      expect(result).toMatchObject({
        status: "retrieved",
        untrustedContent: true,
        sourceTime: null,
      });
      expect((result as any).links).toEqual([
        { url: "https://www.espn.com/nfl/", title: "Other public site" },
      ]);
      expect(await store.listSources(f.job)).toMatchObject({
        retrievalMode: "general-public",
        publicReading: { authenticatedAccess: false, paidAccess: false },
        search: { status: "unavailable" },
      });
      for (const url of [
        "http://example.com/",
        "https://localhost/",
        "https://127.0.0.1/",
        "https://2130706433/",
        "https://[::1]/",
        "https://169.254.169.254/",
        "https://metadata.internal/",
        "https://x.local/",
        "https://user:secret@example.com/",
        "https://example.com:9443/",
        "https://example.com/?token=secret",
        "https://example.com/%2fsecret",
        "https://example.com/#secret",
      ])
        await expect(store.retrieve(f.job, { url })).rejects.toThrow(
          "URL_NOT_PERMITTED",
        );
      const server = new ResearchStore(f.db, {
        retrievalMode: "general-public",
        serverSearchAvailable: true,
        transport: ok,
      });
      expect((await server.listSources(f.job)).search).toMatchObject({
        status: "server-tool-configured",
        tool: "openrouter:web_search",
        engine: "exa",
      });
      expect(
        createOwnerResearchTools(f.db, { serverSearchAvailable: true }).map(
          (t) => t.name,
        ),
      ).not.toContain("research_search");
      expect(calls).toBe(1);
      const redirect = new ResearchStore(f.db, {
        retrievalMode: "general-public",
        transport: async () => ({
          status: 302,
          headers: { location: "http://127.0.0.1/" },
          body: "",
        }),
      });
      expect(
        await redirect.retrieve(f.job, { url: "https://www.espn.com/nfl/" }),
      ).toMatchObject({ status: "unavailable", code: "REDIRECT_NOT_ALLOWED" });
    } finally {
      await f.close();
    }
  });
});
