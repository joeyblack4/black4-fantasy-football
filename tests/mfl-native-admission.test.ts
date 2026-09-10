import { afterEach, beforeEach, expect, it } from "vitest";
import { testDb } from "./helpers.js";
import { withNativeDraftAdmission } from "../src/mfl/service.js";
let f: Awaited<ReturnType<typeof testDb>>;
beforeEach(async () => {
  f = await testDb();
});
afterEach(async () => {
  await f.close();
});
it("holds the same league7044 pause lock through submission and releases it on failure", async () => {
  const league = "admission-lock-test";
  await expect(
    withNativeDraftAdmission(f.db, league, 1, "scope", async (admit) => {
      await admit(); // No native observer retains the legacy path.
      const locked = await f.db.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,7044)) AS acquired",
        [league],
      );
      expect(locked.rows[0].acquired).toBe(false);
      throw Error("simulated submission failure");
    }),
  ).rejects.toThrow("simulated submission failure");
  const released = await f.db.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,7044)) AS acquired",
    [league],
  );
  expect(released.rows[0].acquired).toBe(true);
});

it("requires a fresh active native observation and rejects a changed host", async () => {
  const identity = {
    season: 2026,
    leagueId: "62282",
    configRef: "test-config",
  };
  const row: any = {
    delivery_mode: "native-buzz",
    status: "held",
    host_version: 2,
    host_identity: identity,
    adapter_scope: "scope",
    last_state: { paused: false, stopped: false, over: false },
    last_observed_at: new Date(),
  };
  const fake = {
    connect: async () => ({
      release() {},
      query: async (sql: string) => ({
        rows: sql.includes("runtime_mfl_draft_observers")
          ? [row]
          : sql.includes("league_host_bindings")
            ? [{ host: "mfl", version: 2, config: identity }]
            : [],
      }),
    }),
  } as unknown as Parameters<typeof withNativeDraftAdmission>[0];
  const attempt = () =>
    withNativeDraftAdmission(fake, "test-league", 2, "scope", (admit) =>
      admit(),
    );
  await expect(attempt()).rejects.toThrow("MFL_NATIVE_DRAFT_PAUSED");
  row.status = "active";
  row.last_observed_at = null;
  await expect(attempt()).rejects.toThrow("MFL_NATIVE_DRAFT_NOT_READY");
  row.last_observed_at = new Date();
  row.last_state.paused = true;
  await expect(attempt()).rejects.toThrow("MFL_NATIVE_DRAFT_NOT_READY");
  row.last_state.paused = false;
  await expect(attempt()).resolves.toBeUndefined();
  row.host_version = 1;
  await expect(attempt()).rejects.toThrow("MFL_NATIVE_DRAFT_HOST_CHANGED");
});

it("reuses the API caller's held league lock without acquiring a second connection lock", async () => {
  const lock = await f.db.connect(),
    league = "api-lock-reuse";
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,7044))", [
      league,
    ]);
    await withNativeDraftAdmission(
      f.db,
      league,
      1,
      "scope",
      async (admit) => {
        await admit();
        const competing = await f.db.query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,7044)) AS acquired",
          [league],
        );
        expect(competing.rows[0].acquired).toBe(false);
      },
      lock,
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,7044))", [
      league,
    ]);
    lock.release();
  }
});
