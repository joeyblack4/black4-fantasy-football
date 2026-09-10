import { randomUUID } from "node:crypto";
import { expandCalendarOccurrences } from "./calendar-occurrences.js";
import type { Principal } from "../auth.js";
import type { Db } from "../db.js";
import {
  MflConfigSchema,
  MflOwnerActionSchema,
  MflOwnerReadSchema,
  MflError,
  type MflConfig,
  type MflOwnerAction,
  type MflOwnerRead,
  type MflReceipt,
  type MflJournal,
  type MflJournalSession,
} from "./contracts.js";
import {
  envelope,
  liveDraftEnvelope,
  draftState,
  hash,
  list,
  csv,
} from "./codec.js";
import {
  settings,
  nflGames,
  calendarEvents,
  validateLineup,
  timestamp,
  text,
  SEASON_INTERFACE_VERSION,
} from "./season.js";
const READ_CACHE_SECONDS: Record<string, number> = {
  players: 86400,
  rosters: 15,
  weeklyResults: 15,
  league: 300,
  rules: 3600,
  calendar: 300,
  nflSchedule: 60,
  nflByeWeeks: 3600,
  schedule: 3600,
  leagueStandings: 60,
  transactions: 30,
  playoffBrackets: 300,
  playoffBracket: 60,
};
type Franchise = MflConfig["franchises"][number];
type Options = {
  writesEnabled?: boolean;
  /** Trusted operator/test setting; never supplied by an owner request. */
  enforceSeasonRules?: boolean;
  getSessionCookie: () => Promise<string>;
  journal: MflJournal;
  fetchImpl?: typeof fetch;
  /** Hold the draft pause lock through submission/readback; admit only new intents. */
  withDraftAdmission?: <T>(
    work: (admit: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
};
const same = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);
const safeKey = (v: string) => {
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(v))
    throw new MflError("MFL_IDEMPOTENCY_KEY_INVALID");
  return v;
};
export class MflAdapter {
  readonly config: MflConfig;
  readonly scope: string;
  private http: typeof fetch;
  private readSources: {
    source: string;
    observedAt: string;
    freshness: string;
    sourceUpdatedAt: null;
  }[] = [];
  constructor(
    config: unknown,
    private options: Options,
  ) {
    this.config = MflConfigSchema.parse(config);
    this.scope =
      "mfl:" +
      hash({
        leagueId: this.config.leagueId,
        mode: this.config.mode,
        season: this.config.season,
        host: this.config.host,
        league: this.config.mflLeagueId,
        franchises: [...this.config.franchises].sort((a, b) =>
          a.teamId.localeCompare(b.teamId),
        ),
      });
    if (this.config.mode === "real" && options.fetchImpl)
      throw new MflError("MFL_REAL_TRANSPORT_REQUIRED");
    if (this.config.mode === "synthetic" && !options.fetchImpl)
      throw new MflError("MFL_SYNTHETIC_TRANSPORT_REQUIRED");
    this.http = options.fetchImpl ?? fetch;
  }
  private bound(actor: Principal): Franchise {
    const f = this.config.franchises.find(
      (f) => f.teamId === actor.teamId && f.ownerId === actor.id,
    );
    if (actor.role !== "owner" || actor.leagueId !== this.config.leagueId || !f)
      throw new MflError("MFL_OWNER_BINDING_REQUIRED");
    return f;
  }
  private async call(
    s: MflJournalSession,
    command:
      | "export"
      | "import"
      | "live_draft"
      | "draftStatic"
      | "players"
      | "nflSchedule"
      | "nflByeWeeks",
    params: Record<string, string> = {},
  ) {
    const providerKey =
      "mfl-provider:" +
      (command === "players" ||
      command === "nflSchedule" ||
      command === "nflByeWeeks"
        ? "api.myfantasyleague.com"
        : this.config.host);
    const run = () => this.callOnce(s, command, params, providerKey);
    return s.withProviderLock ? s.withProviderLock(providerKey, run) : run();
  }
  private async callOnce(
    s: MflJournalSession,
    command:
      | "export"
      | "import"
      | "live_draft"
      | "draftStatic"
      | "players"
      | "nflSchedule"
      | "nflByeWeeks",
    params: Record<string, string> = {},
    providerKey: string,
  ) {
    const method =
      command === "import" || command === "live_draft" ? "POST" : "GET";
    const p = new URLSearchParams({
      ...params,
      L: this.config.mflLeagueId,
      JSON: "1",
    });
    const url =
      command === "players" ||
      command === "nflSchedule" ||
      command === "nflByeWeeks"
        ? `https://api.myfantasyleague.com/${this.config.season}/export?TYPE=${command}&JSON=1` +
          (command === "nflSchedule" ? "&W=" + params.W : "")
        : command === "draftStatic"
          ? `https://${this.config.host}/fflnetdynamic${this.config.season}/${this.config.mflLeagueId}_LEAGUE_draft_results.xml`
          : `https://${this.config.host}/${this.config.season}/${command}` +
            (method === "GET" ? "?" + p : "");
    const cooldown = (await s.cached(providerKey + ":cooldown", 86400)) as any;
    if (cooldown?.retryAt && Date.parse(cooldown.retryAt) > Date.now())
      throw new MflError("MFL_THROTTLED", {
        retryAt: cooldown.retryAt,
        provider: providerKey,
        source: "shared-provider-cooldown",
      });
    await s.beforeRequest(this.config.mode === "real" ? 1500 : 0, providerKey);
    await s.recordRead({
      kind: "transport_started",
      providerKey,
      method,
      command,
      parameters: params,
      requestHash: hash(method === "POST" ? p.toString() : url),
      synthetic: this.config.mode === "synthetic",
    });
    let session: string = "";
    try {
      if (
        command !== "players" &&
        command !== "nflSchedule" &&
        command !== "nflByeWeeks"
      )
        session = await this.options.getSessionCookie();
    } catch {
      throw new MflError("MFL_SESSION_UNAVAILABLE");
    }
    if (
      command !== "players" &&
      command !== "nflSchedule" &&
      command !== "nflByeWeeks" &&
      (!session || session.length > 4096 || /[\r\n;]/.test(session))
    )
      throw new MflError("MFL_SESSION_INVALID");
    if (method === "POST")
      await s.recordRead({
        cacheKey: "mfl-read-invalidation",
        data: { invalidatedAt: new Date().toISOString() },
        synthetic: this.config.mode === "synthetic",
      });
    let response: Response, raw: string;
    try {
      response = await this.http(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          ...(command === "players" ||
          command === "nflSchedule" ||
          command === "nflByeWeeks"
            ? {}
            : { Cookie: "MFL_USER_ID=" + encodeURIComponent(session) }),
          "User-Agent": this.config.userAgent,
          ...(method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(method === "POST" ? { body: p.toString() } : {}),
      });
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.length;
        if (size > 2000000) {
          await reader.cancel();
          throw Error();
        }
        parts.push(p.value);
      }
      raw = Buffer.concat(parts).toString("utf8");
    } catch {
      await s.recordRead({
        kind: "transport_unknown",
        method,
        command,
        synthetic: this.config.mode === "synthetic",
      });
      throw new MflError("MFL_TRANSPORT_UNKNOWN");
    }
    this.readSources.push({
      source: `mfl:${params.TYPE ?? command}`,
      observedAt: new Date().toISOString(),
      freshness: "fresh",
      sourceUpdatedAt: null,
    });
    const responseHash = hash(raw);
    await s.recordRead({
      kind: "transport_received",
      providerKey,
      retryAfter: response.headers.get("retry-after"),
      method,
      command,
      httpStatus: response.status,
      responseHash,
      synthetic: this.config.mode === "synthetic",
    });
    const throttle = async () => {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
      const date = retry && seconds === null ? Date.parse(retry) : NaN;
      const delay =
        seconds !== null
          ? Math.max(1000, Math.min(seconds * 1000, 86400000))
          : Number.isFinite(date)
            ? Math.max(1000, Math.min(date - Date.now(), 86400000))
            : 60000;
      const retryAt = new Date(Date.now() + delay).toISOString();
      await s.recordRead({
        cacheKey: providerKey + ":cooldown",
        providerKey,
        data: { retryAt },
        synthetic: this.config.mode === "synthetic",
      });
      throw new MflError("MFL_THROTTLED", {
        retryAt,
        provider: providerKey,
        retryAfter: retry,
        source: response.status === 429 ? "http-429" : "upstream-throttle",
      });
    };
    if (response.status === 429) await throttle();
    if (!response.ok)
      throw new MflError(
        response.status === 429
          ? "MFL_THROTTLED"
          : response.status === 401 || response.status === 403
            ? "MFL_AUTH_REQUIRED"
            : "MFL_HTTP_UNKNOWN",
      );
    if (command === "draftStatic")
      return { accepted: false, data: draftState(raw), responseHash };
    if (command === "live_draft") {
      try {
        const parsed = liveDraftEnvelope(raw);
        await s.recordRead({
          kind: "live_draft_response",
          command,
          httpStatus: response.status,
          responseHash,
          nativeStatus: parsed.nativeStatus,
          reasonCode: parsed.reasonCode,
          synthetic: this.config.mode === "synthetic",
        });
        return { ...parsed, responseHash };
      } catch (error) {
        await s.recordRead({
          kind: "live_draft_response",
          command,
          httpStatus: response.status,
          responseHash,
          nativeStatus: "UNKNOWN",
          reasonCode:
            error instanceof MflError
              ? error.code
              : "MFL_DRAFT_RESPONSE_INVALID",
          synthetic: this.config.mode === "synthetic",
        });
        throw error;
      }
    }
    const parsed = envelope(raw);
    if (parsed.errorMessage && session) {
      parsed.errorMessage = parsed.errorMessage
        .split(session)
        .join("[credential removed]")
        .split(encodeURIComponent(session))
        .join("[credential removed]");
    }
    if (parsed.errorCode === "MFL_THROTTLED") await throttle();
    return { ...parsed, responseHash };
  }
  private async exported(
    s: MflJournalSession,
    type: string,
    params: Record<string, string> = {},
  ) {
    const result = await this.call(s, "export", { TYPE: type, ...params });
    if (result.errorCode)
      throw new MflError(result.errorCode, {
        upstreamMessage:
          "errorMessage" in result ? result.errorMessage : undefined,
        source: "mfl",
        providerTextIsUntrusted: true,
      });
    return result.data;
  }
  private async publicExport(
    s: MflJournalSession,
    type: string,
    params: Record<string, string> = {},
    maxAge = READ_CACHE_SECONDS[type] ?? 30,
  ) {
    const cacheKey = `mfl-season:${type}:${hash(params)}`;
    const cached = (await s.cached(cacheKey, maxAge)) as any;
    const invalidation = (await s.cached(
      "mfl-read-invalidation",
      86400,
    )) as any;
    if (
      cached?.observedAt &&
      cached?.payload &&
      (!invalidation?.invalidatedAt ||
        Date.parse(cached.observedAt) >= Date.parse(invalidation.invalidatedAt))
    ) {
      this.readSources.push({
        source: `mfl:${type}`,
        observedAt: cached.observedAt,
        freshness: "cached",
        sourceUpdatedAt: null,
      });
      return cached.payload;
    }
    const payload =
      type === "nflSchedule" || type === "nflByeWeeks"
        ? (await this.call(s, type, params)).data
        : await this.exported(s, type, params);
    const observedAt = new Date().toISOString();
    await s.recordRead({
      cacheKey,
      data: { payload, observedAt },
      synthetic: this.config.mode === "synthetic",
    });
    if (
      type === "weeklyResults" &&
      !params.W &&
      /^\d+$/.test(payload?.weeklyResults?.week ?? "")
    )
      await s.recordRead({
        cacheKey: `mfl-season:weeklyResults:${hash({ W: String(payload.weeklyResults.week) })}`,
        data: { payload, observedAt },
        synthetic: this.config.mode === "synthetic",
      });
    return payload;
  }
  private async seasonSettings(s: MflJournalSession, fresh = false) {
    const value = settings(
      fresh
        ? await this.exported(s, "league")
        : await this.publicExport(s, "league"),
    );
    // Independent approved host readback; never presented as a fresh exported setting.
    const verified =
      this.config.mflLeagueId === "62282" && this.config.season === 2026;
    return {
      ...value,
      lineupLockPolicy: verified ? "individual-kickoff" : null,
      hideStarters: verified ? false : null,
      operatorReadback: verified
        ? {
            observedAt: "2026-09-08T21:38:22Z",
            source: "work/governance-transition/postapproval-cua-readback.json",
            fields: ["lineupLockPolicy", "hideStarters"],
            freshness: "historical-verified",
          }
        : null,
    };
  }
  private async allRosters(s: MflJournalSession) {
    const raw = await this.publicExport(s, "rosters"),
      catalog = await this.playerCatalog(s);
    return this.franchiseRows(raw, "rosters")
      .filter((r) => this.config.franchises.some((f) => f.franchiseId === r.id))
      .map((r) => {
        const f = this.config.franchises.find((f) => f.franchiseId === r.id)!;
        return {
          teamId: f.teamId,
          franchiseId: f.franchiseId,
          players: list(r.player).map((p: any) => ({
            ...catalog.find((c) => c.id === p.id),
            id: p.id,
            status: p.status ?? "UNKNOWN",
            ownerTeamId: f.teamId,
            ownerFranchiseId: f.franchiseId,
          })),
        };
      });
  }
  private async validate(
    s: MflJournalSession,
    f: Franchise,
    week: number,
    starters: string[],
    fresh = false,
  ) {
    const roster = await this.roster(s, f, !fresh),
      catalog = await this.playerCatalog(s),
      current = await this.lineup(s, f, week, !fresh),
      rules = await this.seasonSettings(s, fresh);
    const games = nflGames(
      fresh
        ? (await this.call(s, "nflSchedule", { W: String(week) })).data
        : await this.publicExport(s, "nflSchedule", { W: String(week) }),
      week,
    );
    const byes = await this.publicExport(s, "nflByeWeeks", {}, 3600);
    return validateLineup({
      starters,
      byeTeams: list(byes.nflByeWeeks?.team)
        .filter((t: any) => Number(t.bye_week) === week)
        .map((t: any) => t.id),
      roster: roster.players.map((p) => ({
        ...catalog.find((c) => c.id === p.id),
        ...p,
      })),
      currentStarters: current.starters,
      settings: rules,
      games,
      now: new Date().toISOString(),
      lockPolicyVerified: rules.lineupLockPolicy === "individual-kickoff",
    });
  }
  private franchiseRows(data: any, root: string): any[] {
    const body = data?.[root];
    if (!body || typeof body !== "object")
      throw new MflError("MFL_RESPONSE_SHAPE");
    const rows = [
      ...list(body.franchise),
      ...list(body.matchup).flatMap((m: any) => list(m.franchise)),
    ];
    if (rows.some((r) => !r || !/^\d{4}$/.test(r.id ?? "")))
      throw new MflError("MFL_RESPONSE_SHAPE");
    return rows;
  }
  private async roster(s: MflJournalSession, f: Franchise, cachedRead = false) {
    const data = cachedRead
      ? await this.publicExport(s, "rosters")
      : await this.exported(s, "rosters", {
          FRANCHISE: f.franchiseId,
        });
    const rows = this.franchiseRows(data, "rosters").filter(
      (r) => !cachedRead || r.id === f.franchiseId,
    );
    if (rows.length !== 1 || rows[0].id !== f.franchiseId)
      throw new MflError("MFL_EFFECTIVE_FRANCHISE_MISMATCH");
    return {
      teamId: f.teamId,
      franchiseId: f.franchiseId,
      players: list(rows[0].player).map((p: any) => {
        if (!/^\d{4,5}$/.test(p.id ?? ""))
          throw new MflError("MFL_RESPONSE_SHAPE");
        return {
          id: String(p.id),
          status: typeof p.status === "string" ? p.status : "UNKNOWN",
        };
      }),
    };
  }
  private async lineup(
    s: MflJournalSession,
    f: Franchise,
    week: number,
    cachedRead = false,
  ) {
    const data = cachedRead
      ? await this.publicExport(s, "weeklyResults", { W: String(week) })
      : await this.exported(s, "weeklyResults", { W: String(week) });
    const row = this.franchiseRows(data, "weeklyResults").find(
      (r) => r.id === f.franchiseId,
    );
    if (!row) throw new MflError("MFL_EFFECTIVE_FRANCHISE_MISMATCH");
    const starters =
      typeof row.starters === "string"
        ? csv(row.starters)
        : list(row.player)
            .filter((p: any) => p.status === "starter")
            .map((p: any) => p.id);
    if (starters.some((p) => !/^\d{4,5}$/.test(p)))
      throw new MflError("MFL_RESPONSE_SHAPE");
    return { teamId: f.teamId, franchiseId: f.franchiseId, week, starters };
  }
  private async bids(s: MflJournalSession, f: Franchise) {
    const data = await this.exported(s, "pendingWaivers", {
        FRANCHISE_ID: f.franchiseId,
      }),
      body = data?.pendingWaivers;
    if (!body || typeof body !== "object")
      throw new MflError("MFL_RESPONSE_SHAPE");
    if (body.franchise_id && body.franchise_id !== f.franchiseId)
      throw new MflError("MFL_EFFECTIVE_FRANCHISE_MISMATCH");
    return {
      teamId: f.teamId,
      franchiseId: f.franchiseId,
      identityEvidence: "targeted-request-no-echo" as const,
      rounds: list(body.blindBidWaiverRequest).map((r: any) => {
        if (!/^\d+$/.test(r.round ?? "") || typeof r.addsDrops !== "string")
          throw new MflError("MFL_RESPONSE_SHAPE");
        const bids = csv(r.addsDrops).map((v) => {
          const [addPlayerId, amount, drop] = v.split("_");
          if (
            !/^\d{4,5}$/.test(addPlayerId ?? "") ||
            !/^\d+(\.\d{1,2})?$/.test(amount ?? "") ||
            !/^\d{4,5}$/.test(drop ?? "")
          )
            throw new MflError("MFL_RESPONSE_SHAPE");
          return {
            addPlayerId: addPlayerId!,
            amount: amount!,
            ...(drop === "0000" ? {} : { dropPlayerId: drop! }),
          };
        });
        return { round: Number(r.round), bids };
      }),
    };
  }
  private async waiverRules(s: MflJournalSession) {
    const rules = await this.seasonSettings(s);
    const events = expandCalendarOccurrences(
      calendarEvents(await this.publicExport(s, "calendar")),
    )
      .filter((e) => e.type?.startsWith("WAIVER_"))
      .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
    const now = new Date().toISOString();
    const processingEvents = events.filter(
      (e) => e.type === "WAIVER_BBID" || e.type === "WAIVER",
    );
    const nextProcessingEvent =
      processingEvents.find((e) => e.startsAt && e.startsAt > now) ?? null;
    return {
      ...rules.waivers,
      roundMeaning: "claim-group-not-processing-date",
      roundParameterRequired:
        rules.waivers.conditional === "Yes"
          ? true
          : rules.waivers.conditional === "No"
            ? false
            : null,
      roundNote:
        "MFL requires ROUND for conditional blind bidding. It does not select a dated processing run. maxWaiverRounds is the host setting, not a count of upcoming dates. pendingBids lists submitted groups only, not all valid groups.",
      upcomingProcessingEvents: processingEvents
        .filter((e) => e.startsAt && e.startsAt > now)
        .slice(0, 8),
      calendarRead: {
        type: "calendar",
        week: "your-scoring-week",
        eventsScope: "season-calendar",
      },
      nextProcessingEvent,
      submissionOpensAt: null,
      submissionClosesAt: null,
      windowStatus: "not-exported",
      timingNote:
        "These are MFL calendar events, not confirmed processing or player eligibility. The API does not export a complete per-franchise acquisition window. A processing timestamp is not a guaranteed submission cutoff or unlock time.",
      observedWindowRestrictions: events.filter(
        (e) =>
          e.type === "WAIVER_NONE" &&
          e.startsAt &&
          e.startsAt <= now &&
          (!e.endsAt || e.endsAt > now),
      ),
      source: "mfl:league+calendar",
      checkedAt: now,
    };
  }
  private async validateBids(
    s: MflJournalSession,
    f: Franchise,
    request: Extract<MflOwnerRead, { type: "validateBids" }>,
  ) {
    const action = MflOwnerActionSchema.parse({
      ...request,
      type: "replaceBids",
    });
    const base = {
      submitted: false,
      upstreamAcceptance: null,
      checkedAt: new Date().toISOString(),
      scope: "existing-submission-preflight",
      note: "Runs the same local preflight as submission using current MFL reads. Passing does not prove MFL will accept or award bids; host windows and processing-time eligibility remain authoritative.",
    };
    try {
      await this.preflight(s, f, action);
      return {
        ...base,
        valid: true,
        issues: [],
        unknowns: ["upstream-acceptance", "processing-time-eligibility"],
      };
    } catch (error) {
      if (!(error instanceof MflError)) throw error;
      if (/THROTTLED|TRANSPORT|SESSION|AUTH|RESPONSE/.test(error.code))
        throw error;
      const unknown = /UNKNOWN|UNAVAILABLE/.test(error.code);
      return {
        ...base,
        valid: unknown ? null : false,
        issues: unknown ? [] : [{ code: error.code, ...error.details }],
        unknowns: unknown ? [error.code] : [],
        details: error.details,
      };
    }
  }
  private async trades(s: MflJournalSession, f: Franchise) {
    const data = await this.exported(s, "pendingTrades", {
        FRANCHISE_ID: f.franchiseId,
      }),
      body = data?.pendingTrades;
    if (!body || typeof body !== "object")
      throw new MflError("MFL_RESPONSE_SHAPE");
    return list(body.pendingTrade).map((t: any) => {
      if (
        !/^\d+$/.test(t.trade_id ?? "") ||
        ![t.offeringteam, t.offeredto].includes(f.franchiseId)
      )
        throw new MflError("MFL_PRIVATE_TRADE_SCOPE_MISMATCH");
      const from = this.config.franchises.find(
          (x) => x.franchiseId === t.offeringteam,
        ),
        to = this.config.franchises.find((x) => x.franchiseId === t.offeredto);
      if (!from || !to) throw new MflError("MFL_COUNTERPARTY_UNBOUND");
      return {
        tradeId: String(t.trade_id),
        offeringTeamId: from.teamId,
        offeredToTeamId: to.teamId,
        givePlayerIds: csv(t.will_give_up),
        receivePlayerIds: csv(t.will_receive),
        expiresAt: /^\d+$/.test(t.expires ?? "")
          ? new Date(Number(t.expires) * 1000).toISOString()
          : null,
      };
    });
  }
  private async requireNativeLiveDraft(s: MflJournalSession) {
    const raw = await this.exported(s, "league");
    if (
      raw?.league?.id !== this.config.mflLeagueId ||
      raw.league.draft_kind !== "live" ||
      raw.league.loadRosters !== "live_draft"
    )
      throw new MflError("MFL_NATIVE_LIVE_DRAFT_REQUIRED");
    return { draftKind: "live", loadRosters: "live_draft" };
  }
  /** Read-only native-mode gate for explicitly arming a live draft observer. */
  async assertNativeLiveDraftForCommissioner(actor: Principal) {
    if (
      actor.role !== "commissioner" ||
      actor.leagueId !== this.config.leagueId ||
      !actor.id
    )
      throw new MflError("MFL_COMMISSIONER_SCOPE_REQUIRED");
    return this.options.journal.withLock(this.scope, async (s) => {
      const data = await this.requireNativeLiveDraft(s);
      const receipt = await s.recordRead({
        leagueId: this.config.leagueId,
        actorId: actor.id,
        actorRole: "commissioner",
        request: { type: "nativeLiveDraftReadiness" },
        resultHash: hash(data),
        synthetic: this.config.mode === "synthetic",
      });
      return { ...receipt, data };
    });
  }
  /** Trusted league observer reads public draft state without recording a forged owner action. */
  async readDraftForCommissioner(actor: Principal) {
    if (
      actor.role !== "commissioner" ||
      actor.leagueId !== this.config.leagueId ||
      !actor.id
    )
      throw new MflError("MFL_COMMISSIONER_SCOPE_REQUIRED");
    return this.options.journal.withLock(this.scope, async (s) => {
      await this.requireNativeLiveDraft(s);
      const data = (await this.call(s, "draftStatic")).data;
      const receipt = await s.recordRead({
        leagueId: this.config.leagueId,
        actorId: actor.id,
        actorRole: "commissioner",
        request: { type: "draft" },
        resultHash: hash(data),
        synthetic: this.config.mode === "synthetic",
      });
      return {
        ...receipt,
        leagueId: this.config.leagueId,
        synthetic: this.config.mode === "synthetic",
        data,
      };
    });
  }
  async read(actor: Principal, input: unknown) {
    const f = this.bound(actor),
      request = MflOwnerReadSchema.parse(input);
    return this.options.journal.withLock(this.scope, async (s) => {
      this.readSources = [];
      let data: any;
      if (request.type === "capabilities") {
        data = {
          interfaceVersion: SEASON_INTERFACE_VERSION,
          readCacheSeconds: READ_CACHE_SECONDS,
          writePreflightAndReadback: "always-fresh",
          reads: [
            "playoffBrackets",
            "playoffBracket",
            "capabilities",
            "leagueSettings",
            "scoringRules",
            "teams",
            "roster",
            "rosters",
            "players",
            "lineup",
            "lineups",
            "validateLineup",
            "validateBids",
            "waiverRules",
            "availability",
            "calendar",
            "standings",
            "results",
            "scores",
            "transactions",
            "pendingBids",
            "pendingTrades",
            "budget",
            "draft",
            "rules",
          ],
          actions: [
            "lineup",
            "addDrop",
            "replaceBids",
            "proposeTrade",
            "respondTrade",
            "draft",
          ],
          writesEnabled: this.options.writesEnabled === true,
          serviceHealth: "this-authenticated-read-succeeded",
          upstreamHealth: "not-probed",
          rulebook: "docs/SEASON_RULES.md",
          operationsGuide: "docs/SEASON_OPERATIONS.md",
          legacyRulesMeaning: "scoring-only",
          privateReads: [
            "pendingBids",
            "pendingTrades",
            "budget",
            "validateBids",
          ],
          availabilityMeaning:
            "ownership-and-player-flags-not-guaranteed-acquisition",
          waiverRoundMeaning: "claim-group-not-processing-date",
          transactionWeekMeaning:
            "MFL-transaction-week-not-lineup-week; use days/since/until for time searches",
          playerStatusMeaning: "league-eligibility-not-health-or-depth-chart",
        };
      } else if (request.type === "leagueSettings") {
        const rules = await this.seasonSettings(s);
        const current = await this.publicExport(s, "weeklyResults");
        const week = Number(current.weeklyResults?.week);
        data = {
          ...rules,
          currentWeek:
            Number.isInteger(week) && week >= 1 && week <= 22 ? week : null,
        };
      } else if (request.type === "waiverRules") {
        data = await this.waiverRules(s);
      } else if (request.type === "validateBids") {
        data = await this.validateBids(s, f, request);
      } else if (request.type === "playoffBrackets") {
        const raw = await this.publicExport(s, "playoffBrackets");
        if (!raw.playoffBrackets) throw new MflError("MFL_RESPONSE_SHAPE");
        data = {
          brackets: list(raw.playoffBrackets.playoffBracket).map((b: any) => ({
            id: text(b.id),
            name: text(b.name),
            startWeek: text(b.startWeek),
            teamsInvolved: text(b.teamsInvolved),
            winnerTitle: text(b.bracketWinnerTitle),
          })),
        };
      } else if (request.type === "playoffBracket") {
        const raw = await this.publicExport(s, "playoffBracket", {
          BRACKET_ID: request.bracketId,
        });
        if (raw.playoffBracket?.bracket_id !== request.bracketId)
          throw new MflError("MFL_RESPONSE_SHAPE");
        const side = (s: any) => ({
          seed: text(s?.seed),
          franchiseId: text(s?.franchise_id),
          winnerOfGame: text(s?.winner_of_game),
          loserOfGame: text(s?.loser_of_game),
          score: text(s?.score),
        });
        data = {
          bracketId: request.bracketId,
          rounds: list(raw.playoffBracket.playoffRound).map((r: any) => ({
            week: text(r.week),
            games: list(r.playoffGame).map((g: any) => ({
              gameId: text(g.game_id),
              home: side(g.home),
              away: side(g.away),
            })),
          })),
          seedingStatus: "upstream-bracket-not-final-seeding",
        };
      } else if (request.type === "teams") {
        const raw = await this.publicExport(s, "league");
        data = {
          teams: list(raw.league?.franchises?.franchise)
            .filter((r: any) =>
              this.config.franchises.some((f) => f.franchiseId === r.id),
            )
            .map((r: any) => ({
              franchiseId: r.id,
              teamId: this.config.franchises.find(
                (f) => f.franchiseId === r.id,
              )!.teamId,
              name: text(r.name),
            })),
        };
      } else if (request.type === "validateLineup")
        data = await this.validate(s, f, request.week, request.starters);
      else if (request.type === "calendar") {
        const nfl = await this.publicExport(s, "nflSchedule", {
            W: String(request.week),
          }),
          cal = await this.publicExport(s, "calendar"),
          schedule = await this.publicExport(s, "schedule", {
            W: String(request.week),
          });
        const events = calendarEvents(cal);
        for (const e of events) {
          // Confirmed native calendar UI: TRADE start 11 means kickoff of Week 11, not epoch 11.
          if (
            e.type === "TRADE" &&
            e.startsAt === null &&
            /^([1-9]|1[0-9]|2[0-2])$/.test(e.rawStart ?? "")
          ) {
            const relativeWeek = Number(e.rawStart);
            const games = nflGames(
              await this.publicExport(s, "nflSchedule", {
                W: String(relativeWeek),
              }),
              relativeWeek,
            );
            const starts = games
              .map((g) => g.kickoffAt)
              .filter((v): v is string => !!v)
              .sort();
            if (starts.length) {
              e.startsAt = starts[0]!;
              e.timingStatus = "resolved-week-kickoff";
            }
          }
        }
        data = {
          week: request.week,
          scopes: {
            games: "requested-week",
            byeTeams: "requested-week",
            matchups: "requested-week",
            events: "season-calendar",
          },
          timezone: "UTC",
          games: nflGames(nfl, request.week),
          byeTeams: list(
            (await this.publicExport(s, "nflByeWeeks", {}, 3600)).nflByeWeeks
              ?.team,
          )
            .filter((t: any) => Number(t.bye_week) === request.week)
            .map((t: any) => t.id),
          events: expandCalendarOccurrences(events),
          matchups: list(schedule.schedule?.weeklySchedule).flatMap((w: any) =>
            list(w.matchup).map((m: any) => ({
              week: Number(w.week),
              teams: list(m.franchise).map((r: any) => ({
                franchiseId: r.id,
                teamId:
                  this.config.franchises.find((f) => f.franchiseId === r.id)
                    ?.teamId ?? null,
                isHome: r.isHome === "1",
              })),
            })),
          ),
          processingNote:
            "Scheduled times do not prove processing occurred; unresolved host values need operator inspection.",
        };
      } else if (request.type === "availability") {
        const raw = await this.publicExport(
            s,
            "playerRosterStatus",
            { P: request.playerIds.join(","), F: f.franchiseId },
            10,
          ),
          rosters = await this.allRosters(s),
          catalog = await this.playerCatalog(s),
          waiverRules = await this.waiverRules(s);
        data = {
          waiverRules: {
            type: waiverRules.type,
            windowStatus: waiverRules.windowStatus,
            nextProcessingEvent: waiverRules.nextProcessingEvent,
            timingNote: waiverRules.timingNote,
            detailsRead: { type: "waiverRules" },
          },
          availabilityMeaning:
            "ownership-and-player-flags-not-guaranteed-acquisition",
          lockMeaning:
            "upstreamStatus.locked is an acquisition flag returned only for free agents; it is not a lineup lock",
          lineupLockRead: {
            type: "validateLineup",
            required: ["week", "starters"],
            resultField: "locks",
          },
          players: request.playerIds.map((id) => {
            const owner = rosters.find((r) =>
              r.players.some((p: any) => p.id === id),
            );
            const state = list(raw.playerRosterStatuses?.playerStatus).find(
              (r: any) => r.id === id,
            );
            return {
              ...catalog.find((p) => p.id === id),
              id,
              ownerTeamId: owner?.teamId ?? null,
              ownerFranchiseId: owner?.franchiseId ?? null,
              availability: owner
                ? "rostered"
                : state?.error
                  ? "ineligible"
                  : state?.is_fa === "1" && state?.locked === "1"
                    ? "locked"
                    : state?.is_fa === "1" && state?.cant_add === "1"
                      ? "restricted"
                      : state?.is_fa === "1" &&
                          state?.locked !== "1" &&
                          state?.cant_add !== "1"
                        ? "unowned"
                        : "unknown",
              acquisition: {
                canAcquireNow:
                  owner ||
                  state?.error ||
                  state?.cant_add === "1" ||
                  waiverRules.observedWindowRestrictions.length
                    ? false
                    : null,
                fcfs: {
                  eligible:
                    owner ||
                    state?.error ||
                    state?.locked === "1" ||
                    state?.cant_add === "1" ||
                    waiverRules.observedWindowRestrictions.length
                      ? false
                      : null,
                  reason: owner
                    ? "already-rostered"
                    : state?.locked === "1"
                      ? "player-acquisition-lock"
                      : state?.cant_add === "1" || state?.error
                        ? "host-player-restriction"
                        : waiverRules.observedWindowRestrictions.length
                          ? "calendar-waivers-closed"
                          : "player-flags-do-not-prove-host-acquisition-window",
                },
                leagueMode: waiverRules.type,
                finalAuthority: "mfl-submission-and-readback",
              },
              upstreamStatus: {
                isFreeAgent:
                  state?.is_fa === "1"
                    ? true
                    : state?.roster_franchise
                      ? false
                      : null,
                locked: state?.is_fa === "1" ? state.locked === "1" : null,
                cannotAdd: state?.is_fa === "1" ? state.cant_add === "1" : null,
                error: text(state?.error),
              },
              nextEligibleAt: null,
              nextEligibleAtReason:
                "not-exported; next waiver processing does not guarantee eligibility",
            };
          }),
        };
      } else if (request.type === "standings") {
        const raw = await this.publicExport(s, "leagueStandings");
        data = {
          teams: this.franchiseRows(raw, "leagueStandings")
            .filter((r) =>
              this.config.franchises.some((f) => f.franchiseId === r.id),
            )
            .map((r) => ({
              franchiseId: r.id,
              teamId: this.config.franchises.find(
                (f) => f.franchiseId === r.id,
              )!.teamId,
              wins: text(r.h2hw),
              losses: text(r.h2hl),
              ties: text(r.h2ht),
              winningPercentage: text(r.h2hpct),
              pointsFor: text(r.pf),
              pointsAgainst: text(r.pa),
              allPlayPercentage: text(r.all_play_pct),
            })),
          order: "upstream-order-not-a-final-playoff-seed",
        };
      } else if (request.type === "transactions") {
        // Never request pending categories with the commissioner connection.
        const allowed = new Set([
          "WAIVER",
          "BBID_WAIVER",
          "FREE_AGENT",
          "TRADE",
          "IR",
          "TAXI",
          "AUCTION_WON",
        ]);
        const fetchLimit = Math.max(100, request.limit);
        const raw = await this.publicExport(s, "transactions", {
          ...(request.week ? { W: String(request.week) } : {}),
          TRANS_TYPE: "DEFAULT",
          COUNT: String(fetchLimit),
        });
        if (!raw.transactions || typeof raw.transactions !== "object")
          throw new MflError("MFL_RESPONSE_SHAPE");
        const rows = list(raw.transactions.transaction);
        const completed = rows.filter(
          (r: any) =>
            allowed.has(r.type) && !r.status?.toLowerCase().includes("pending"),
        );
        const checkedAt = new Date().toISOString();
        const cutoffs = [
          ...(request.since ? [Date.parse(request.since)] : []),
          ...(request.days
            ? [Date.parse(checkedAt) - request.days * 86400000]
            : []),
        ];
        const since = cutoffs.length ? Math.max(...cutoffs) : null;
        const until = request.until ? Date.parse(request.until) : null;
        const unknownTimestampCount = completed.filter(
          (r: any) => timestamp(r.timestamp) === null,
        ).length;
        const matching = completed
          .filter((r: any) => {
            if (since === null && until === null) return true;
            const at = timestamp(r.timestamp);
            return (
              at !== null &&
              (since === null || Date.parse(at) >= since) &&
              (until === null || Date.parse(at) < until)
            );
          })
          .sort((a: any, b: any) =>
            (timestamp(b.timestamp) ?? "").localeCompare(
              timestamp(a.timestamp) ?? "",
            ),
          );
        data = {
          transactions: matching.slice(0, request.limit).map((r: any) => ({
            type: r.type,
            franchiseId: text(r.franchise),
            timestamp: timestamp(r.timestamp),
            transaction: text(r.transaction),
            byCommissioner: r.by_commish === "1",
          })),
          limit: request.limit,
          coverage: "bounded-completed-transactions",
          filters: {
            mflTransactionWeek: request.week ?? null,
            days: request.days ?? null,
            sinceInclusive:
              since === null ? null : new Date(since).toISOString(),
            daysMeaning: "rolling-24-hour-days-at-checkedAt",
            untilExclusive: request.until ?? null,
          },
          checkedAt,
          weekMeaning:
            "MFL transaction week may differ from the current lineup/scoring week. Omit week and use days or since/until to check dated activity.",
          coverageDetails: {
            fetched: rows.length,
            fetchLimit,
            upstreamLimitReached: rows.length >= fetchLimit,
            matching: matching.length,
            responseTruncated: matching.length > request.limit,
            unknownTimestampCount,
            complete:
              rows.length < fetchLimit &&
              matching.length <= request.limit &&
              (!(request.since || request.until || request.days) ||
                unknownTimestampCount === 0),
            scope: "requested-filters-and-supported-completed-categories",
            providerCoverage:
              "MFL COUNT restricts the source to common transaction types; this is not an exhaustive league ledger",
          },
          emptyResultMeaning:
            "No matching completed transactions in this bounded result; does not prove a waiver run did not process.",
        };
      } else if (request.type === "lineups" || request.type === "results") {
        const rules = await this.seasonSettings(s);
        if (request.type === "lineups" && rules.hideStarters !== false)
          throw new MflError("MFL_LINEUP_VISIBILITY_UNKNOWN");
        const raw = await this.publicExport(s, "weeklyResults", {
            W: String(request.week),
          }),
          catalog = await this.playerCatalog(s);
        data = {
          week: request.week,
          teams: this.franchiseRows(raw, "weeklyResults")
            .filter((r) =>
              this.config.franchises.some((f) => f.franchiseId === r.id),
            )
            .map((r) => ({
              teamId: this.config.franchises.find(
                (f) => f.franchiseId === r.id,
              )!.teamId,
              franchiseId: r.id,
              ...(request.type === "lineups"
                ? {
                    starters:
                      typeof r.starters === "string"
                        ? csv(r.starters)
                        : list(r.player)
                            .filter((p: any) => p.status === "starter")
                            .map((p: any) => p.id),
                    players: list(r.player).map((p: any) => ({
                      ...catalog.find((c) => c.id === p.id),
                      id: p.id,
                      status: p.status ?? "UNKNOWN",
                    })),
                  }
                : {}),
              score: text(r.score),
              result: text(r.result),
            })),
        };
      } else if (request.type === "players") {
        const players = await this.playerCatalog(s);
        const ownership =
          request.unowned === undefined ? [] : await this.allRosters(s);
        const selected = players.filter(
          (p) =>
            (!request.position || p.position === request.position) &&
            (request.unowned === undefined ||
              request.unowned ===
                !ownership.some((r) =>
                  r.players.some((rp: any) => rp.id === p.id),
                )) &&
            (!request.playerIds || request.playerIds.includes(p.id)) &&
            (!request.nflTeam || p.nflTeam === request.nflTeam) &&
            (!request.search ||
              p.name.toLowerCase().includes(request.search.toLowerCase())),
        );
        data = {
          season: this.config.season,
          total: selected.length,
          players: selected.slice(
            request.offset,
            request.offset + request.limit,
          ),
          nextOffset:
            request.offset + request.limit < selected.length
              ? request.offset + request.limit
              : null,
        };
      } else if (request.type === "budget") {
        const raw = await this.exported(s, "league"),
          rows = list(raw?.league?.franchises?.franchise),
          own = rows.find((r: any) => r.id === f.franchiseId);
        if (!own) throw new MflError("MFL_EFFECTIVE_FRANCHISE_MISMATCH");
        const balance = own.bbidAvailableBalance;
        data = {
          teamId: f.teamId,
          franchiseId: f.franchiseId,
          unit: "FAAB",
          bbidAvailableBalance:
            typeof balance === "string" && /^-?\d+(\.\d+)?$/.test(balance)
              ? balance
              : null,
        };
      } else if (request.type === "roster") {
        const roster = await this.roster(s, f, true),
          catalog = await this.playerCatalog(s);
        data = {
          ...roster,
          players: roster.players.map((p) => ({
            ...catalog.find((c) => c.id === p.id),
            ...p,
            ownerTeamId: f.teamId,
            ownerFranchiseId: f.franchiseId,
          })),
        };
      } else if (request.type === "rosters") data = await this.allRosters(s);
      else if (request.type === "lineup") {
        data = await this.lineup(s, f, request.week, true);
        const catalog = await this.playerCatalog(s);
        data = {
          ...data,
          players: data.starters.map((id: string) => ({
            ...catalog.find((c) => c.id === id),
            id,
            status: "starter",
          })),
        };
      } else if (request.type === "pendingBids") data = await this.bids(s, f);
      else if (request.type === "pendingTrades") data = await this.trades(s, f);
      else if (request.type === "draft")
        data = (await this.call(s, "draftStatic")).data;
      else if (request.type === "rules" || request.type === "scoringRules") {
        try {
          const raw = await this.publicExport(s, "rules");
          if (!raw.rules) throw new MflError("MFL_RESPONSE_SHAPE");
          data = raw.rules;
        } catch (error) {
          if (
            !(error instanceof MflError) ||
            error.code !== "MFL_SCORING_RULES_NOT_CONFIGURED"
          )
            throw error;
          data = {
            status: "not-configured",
            code: "MFL_SCORING_RULES_NOT_CONFIGURED",
            scoringRules: null,
            operatorActionRequired: true,
            instruction:
              "The rules read tool is available and this authenticated read completed. MFL reports that no league scoring rules are configured. This receipt proves the native configuration gap, not approved or applied rules. Preserve existing owner proposals; await their ratification and verified commissioner application before treating native scoring as configured.",
          };
        }
      } else if (request.type === "scores") {
        const raw = await this.exported(s, "liveScoring", {
          W: String(request.week),
          DETAILS: "1",
        });
        data = {
          week: request.week,
          source: "mfl",
          sourceUpdatedAt: null,
          teams: this.franchiseRows(raw, "liveScoring")
            .filter((r) =>
              this.config.franchises.some((f) => f.franchiseId === r.id),
            )
            .map((r) => ({
              teamId: this.config.franchises.find(
                (f) => f.franchiseId === r.id,
              )!.teamId,
              franchiseId: r.id,
              score:
                typeof r.score === "string" &&
                r.score.trim() !== "" &&
                Number.isFinite(Number(r.score))
                  ? r.score
                  : null,
              gameSecondsRemaining: r.gameSecondsRemaining ?? null,
            })),
        };
      }
      const stamp = await s.recordRead({
        leagueId: this.config.leagueId,
        teamId: f.teamId,
        franchiseId: f.franchiseId,
        request,
        resultHash: hash(data),
        synthetic: this.config.mode === "synthetic",
      });
      return {
        ...stamp,
        leagueId: this.config.leagueId,
        teamId: f.teamId,
        synthetic: this.config.mode === "synthetic",
        data,
        metadata: {
          source: "mfl",
          retrievedAt: stamp.at,
          sourceUpdatedAt: null,
          sources: this.readSources,
        },
      };
    });
  }
  private async playerCatalog(s: MflJournalSession) {
    const cacheKey = "mfl-player-catalog-v2:" + this.config.season;
    const cache = (await s.cached(
      cacheKey,
      READ_CACHE_SECONDS.players!,
    )) as any;
    let players = cache?.players as any[] | null;
    if (players && cache.observedAt)
      this.readSources.push({
        source: "mfl:players",
        observedAt: cache.observedAt,
        freshness: "cached",
        sourceUpdatedAt: null,
      });
    if (!players) {
      const response = await this.call(s, "players");
      if (response.errorCode) throw new MflError(response.errorCode);
      if (!response.data?.players) throw new MflError("MFL_RESPONSE_SHAPE");
      players = list(response.data.players.player).map((p: any) => {
        if (
          !/^\d{4,5}$/.test(p.id ?? "") ||
          typeof p.name !== "string" ||
          typeof p.position !== "string"
        )
          throw new MflError("MFL_RESPONSE_SHAPE");
        return {
          id: p.id,
          name: p.name.slice(0, 200),
          position: p.position.slice(0, 10),
          nflTeam: typeof p.team === "string" ? p.team.slice(0, 10) : null,
        };
      });
      await s.recordRead({
        cacheKey,
        data: { players, observedAt: new Date().toISOString() },
        synthetic: this.config.mode === "synthetic",
      });
    }
    if (
      !Array.isArray(players) ||
      !players.length ||
      players.length > 100000 ||
      new Set(players.map((p) => p.id)).size !== players.length ||
      players.some(
        (p) =>
          !p ||
          typeof p.id !== "string" ||
          !/^\d{4,5}$/.test(p.id) ||
          typeof p.name !== "string" ||
          typeof p.position !== "string",
      )
    )
      throw new MflError("MFL_PLAYER_CATALOG_INVALID");
    return players;
  }
  private async requireUnlocked(s: MflJournalSession, playerIds: string[]) {
    if (!playerIds.length) return;
    const current = await this.exported(s, "weeklyResults");
    const week = Number(current.weeklyResults?.week);
    if (!Number.isInteger(week) || week < 1 || week > 22)
      throw new MflError("MFL_CURRENT_WEEK_UNKNOWN");
    const rules = await this.seasonSettings(s, true);
    if (rules.lineupLockPolicy !== "individual-kickoff")
      throw new MflError("MFL_LINEUP_LOCK_POLICY_UNKNOWN");
    const catalog = await this.playerCatalog(s),
      games = nflGames(
        (await this.call(s, "nflSchedule", { W: String(week) })).data,
        week,
      );
    const byes = await this.publicExport(s, "nflByeWeeks", {}, 3600);
    const byeTeams = list(byes.nflByeWeeks?.team)
      .filter((t: any) => Number(t.bye_week) === week)
      .map((t: any) => t.id);
    for (const id of playerIds) {
      const player = catalog.find((p) => p.id === id);
      const game = games.find((g) => g.teams.includes(player?.nflTeam));
      if (player?.nflTeam === "FA" || byeTeams.includes(player?.nflTeam))
        continue;
      if (!game?.kickoffAt)
        throw new MflError("MFL_PLAYER_LOCK_UNKNOWN", { playerIds: [id] });
      if (Date.parse(game.kickoffAt) <= Date.now())
        throw new MflError("MFL_PLAYER_LOCKED", {
          playerIds: [id],
          kickoffAt: game.kickoffAt,
        });
    }
  }
  private async requireWindow(
    s: MflJournalSession,
    type: "TRADE" | "WAIVER_NONE",
  ) {
    const raw = await this.exported(s, "calendar");
    for (const e of calendarEvents(raw).filter((e) => e.type === type)) {
      let starts = e.startsAt;
      if (
        !starts &&
        type === "TRADE" &&
        /^([1-9]|1[0-9]|2[0-2])$/.test(e.rawStart ?? "")
      ) {
        const week = Number(e.rawStart);
        const games = nflGames(
          (await this.call(s, "nflSchedule", { W: String(week) })).data,
          week,
        );
        starts =
          games
            .map((g) => g.kickoffAt)
            .filter((v): v is string => !!v)
            .sort()[0] ?? null;
      }
      if (!starts)
        throw new MflError("MFL_DEADLINE_UNKNOWN", {
          eventId: e.id,
          rawStart: e.rawStart,
        });
      if (
        Date.parse(starts) <= Date.now() &&
        (!e.endsAt || Date.parse(e.endsAt) > Date.now())
      )
        throw new MflError("MFL_TRANSACTION_WINDOW_CLOSED", {
          eventId: e.id,
          startsAt: starts,
          type,
        });
    }
  }
  private async checkTradeRosters(
    s: MflJournalSession,
    giveFranchise: Franchise,
    receiveFranchise: Franchise,
    give: string[],
    receive: string[],
    enforceKickoff = true,
  ) {
    const from = await this.roster(s, giveFranchise),
      to = await this.roster(s, receiveFranchise),
      rules = await this.seasonSettings(s, true);
    if (
      give.some((id) => !from.players.some((p) => p.id === id)) ||
      receive.some((id) => !to.players.some((p) => p.id === id))
    )
      throw new MflError("MFL_TRADE_OWNERSHIP_CHANGED");
    if (rules.rosterSize === null)
      throw new MflError("MFL_ROSTER_LIMIT_UNKNOWN");
    if (
      from.players.length - give.length + receive.length > rules.rosterSize ||
      to.players.length - receive.length + give.length > rules.rosterSize
    )
      throw new MflError("MFL_TRADE_INVALID_ROSTER", {
        rosterLimit: rules.rosterSize,
      });
    if (enforceKickoff) await this.requireUnlocked(s, [...give, ...receive]);
  }
  private async preflight(
    s: MflJournalSession,
    f: Franchise,
    a: MflOwnerAction,
  ): Promise<any> {
    if (a.type === "draft") {
      await this.requireNativeLiveDraft(s);
      const catalog = await this.playerCatalog(s);
      if (!catalog.some((p) => p.id === a.playerId))
        throw new MflError("MFL_PLAYER_NOT_IN_CATALOG");
      // Catalog membership is identity evidence only. Current draft state still decides availability.
      const d = (await this.call(s, "draftStatic")).data;
      if (
        d.paused ||
        d.stopped ||
        d.over ||
        d.round !== a.round ||
        d.pick !== a.pick ||
        d.franchiseId !== f.franchiseId ||
        d.picks.some((p: any) => p.playerId === a.playerId)
      )
        throw new MflError("MFL_DRAFT_TURN_CHANGED");
      return d;
    }
    if (
      a.type === "lineup" ||
      a.type === "addDrop" ||
      a.type === "replaceBids" ||
      a.type === "proposeTrade"
    ) {
      const r = await this.roster(s, f),
        owned = new Set(r.players.map((p) => p.id));
      const required =
        a.type === "lineup"
          ? a.starters
          : a.type === "addDrop"
            ? a.dropPlayerIds
            : a.type === "replaceBids"
              ? a.bids.flatMap((b) => (b.dropPlayerId ? [b.dropPlayerId] : []))
              : a.givePlayerIds;
      if (required.some((p) => !owned.has(p)))
        throw new MflError("MFL_PLAYER_NOT_OWNED", {
          playerIds: required.filter((p) => !owned.has(p)),
        });
      if (
        a.type === "lineup" &&
        (this.options.enforceSeasonRules ?? this.config.mode === "real")
      ) {
        const validation = await this.validate(s, f, a.week, a.starters, true);
        if (validation.valid === false)
          throw new MflError(
            "MFL_LINEUP_" + validation.issues[0]!.code,
            validation,
          );
        if (validation.valid === null)
          throw new MflError("MFL_LINEUP_VALIDATION_UNKNOWN", validation);
      }
      if (
        a.type === "addDrop" &&
        (this.options.enforceSeasonRules ?? this.config.mode === "real")
      ) {
        const rules = await this.seasonSettings(s, true);
        if (
          rules.rosterSize !== null &&
          r.players.length - a.dropPlayerIds.length + (a.addPlayerId ? 1 : 0) >
            rules.rosterSize
        )
          throw new MflError("MFL_ROSTER_LIMIT");
        if (a.addPlayerId) {
          const all = this.franchiseRows(
            await this.exported(s, "rosters"),
            "rosters",
          );
          if (
            all.some((row) =>
              list(row.player).some((p: any) => p.id === a.addPlayerId),
            )
          )
            throw new MflError("MFL_PLAYER_ALREADY_ROSTERED");
          const raw = await this.exported(s, "playerRosterStatus", {
            P: a.addPlayerId,
          });
          const state = list(raw.playerRosterStatuses?.playerStatus).find(
            (p: any) => p.id === a.addPlayerId,
          );
          if (
            !state ||
            (state.is_fa !== "1" && !state.roster_franchise && !state.error)
          )
            throw new MflError("MFL_AVAILABILITY_UNKNOWN");
          if (state?.locked === "1") throw new MflError("MFL_PLAYER_LOCKED");
          if (state?.cant_add === "1" || state?.error)
            throw new MflError("MFL_PLAYER_INELIGIBLE");
        }
      }
      if (this.options.enforceSeasonRules ?? this.config.mode === "real") {
        if (a.type === "addDrop") {
          await this.requireWindow(s, "WAIVER_NONE");
          await this.requireUnlocked(s, a.dropPlayerIds);
        }
        if (a.type === "replaceBids") {
          const rules = await this.seasonSettings(s, true);
          if (rules.waivers.conditional === "Yes") {
            if (rules.waivers.maxWaiverRounds === null)
              throw new MflError("MFL_WAIVER_ROUNDS_UNKNOWN");
            if (a.round > rules.waivers.maxWaiverRounds)
              throw new MflError("MFL_WAIVER_ROUND_INVALID", {
                maxWaiverRounds: rules.waivers.maxWaiverRounds,
              });
          }
        }
        if (a.type === "replaceBids" && a.bids.length) {
          await this.requireWindow(s, "WAIVER_NONE");
          const raw = await this.exported(s, "league"),
            own = list(raw.league?.franchises?.franchise).find(
              (r: any) => r.id === f.franchiseId,
            );
          const balance = Number(own?.bbidAvailableBalance),
            increment = Number(raw.league?.bbidIncrement);
          if (
            !own ||
            !Number.isFinite(balance) ||
            !Number.isFinite(increment) ||
            increment <= 0
          )
            throw new MflError("MFL_BID_RULES_UNKNOWN");
          if (
            a.bids.some(
              (b) =>
                Number(b.amount) > balance ||
                Number(b.amount) % increment !== 0,
            )
          )
            throw new MflError("MFL_BID_BUDGET_REJECTED", {
              availableBalance: balance,
              increment,
            });
        }
        if (a.type === "proposeTrade") await this.requireWindow(s, "TRADE");
      }
      if (a.type === "proposeTrade") {
        const peer = this.config.franchises.find(
          (p) => p.teamId === a.counterpartyTeamId,
        );
        if (!peer || peer.teamId === f.teamId)
          throw new MflError("MFL_COUNTERPARTY_UNBOUND");
        const theirs = await this.roster(s, peer);
        if (
          a.receivePlayerIds.some(
            (id) => !theirs.players.some((p) => p.id === id),
          )
        )
          throw new MflError("MFL_COUNTERPARTY_PLAYER_NOT_OWNED");
        if (this.options.enforceSeasonRules ?? this.config.mode === "real")
          await this.checkTradeRosters(
            s,
            f,
            peer,
            a.givePlayerIds,
            a.receivePlayerIds,
            false,
          );
        return {
          roster: r,
          counterparty: theirs,
          trades: await this.trades(s, f),
        };
      }
      if (a.type === "replaceBids") {
        const bids = await this.bids(s, f);
        if (!a.bids.length && !bids.rounds.some((x) => x.round === a.round))
          throw new MflError("MFL_BID_ROUND_NOT_PENDING", {
            round: a.round,
            explanation:
              "MFL returned no pending group for this round. No cancellation was submitted; pendingBids lists submitted groups, not dated waiver runs.",
          });
        return { roster: r, bids };
      }
      return a.type === "lineup"
        ? { roster: r, lineup: await this.lineup(s, f, a.week) }
        : r;
    }
    const trades = await this.trades(s, f),
      t = trades.find((t) => t.tradeId === a.tradeId);
    if (!t) throw new MflError("MFL_TRADE_NOT_PENDING");
    if (
      a.response === "revoke"
        ? t.offeringTeamId !== f.teamId
        : t.offeredToTeamId !== f.teamId
    )
      throw new MflError("MFL_TRADE_RESPONSE_FORBIDDEN");
    if (
      [...t.givePlayerIds, ...t.receivePlayerIds].some(
        (p) => !/^\d{4,5}$/.test(p),
      )
    )
      throw new MflError("MFL_TRADE_ASSET_UNSUPPORTED");
    if (
      a.response === "accept" &&
      (this.options.enforceSeasonRules ?? this.config.mode === "real")
    ) {
      await this.requireWindow(s, "TRADE");
      if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now())
        throw new MflError("MFL_TRADE_EXPIRED");
      const from = this.config.franchises.find(
          (f) => f.teamId === t.offeringTeamId,
        )!,
        to = this.config.franchises.find(
          (f) => f.teamId === t.offeredToTeamId,
        )!;
      await this.checkTradeRosters(
        s,
        from,
        to,
        t.givePlayerIds,
        t.receivePlayerIds,
      );
    }
    return { trade: t };
  }
  private params(
    f: Franchise,
    a: MflOwnerAction,
  ): { command: "import" | "live_draft"; params: Record<string, string> } {
    const base = { FRANCHISE_ID: f.franchiseId };
    if (a.type === "draft")
      return {
        command: "live_draft",
        params: {
          CMD: "DRAFT",
          FRANCHISE_PICK: f.franchiseId,
          PLAYER_PICK: a.playerId,
          ROUND: String(a.round).padStart(2, "0"),
          PICK: String(a.pick).padStart(2, "0"),
        },
      };
    if (a.type === "lineup")
      return {
        command: "import",
        params: {
          ...base,
          TYPE: "lineup",
          W: String(a.week),
          STARTERS: a.starters.join(","),
        },
      };
    if (a.type === "addDrop")
      return {
        command: "import",
        params: {
          ...base,
          TYPE: "fcfsWaiver",
          ...(a.addPlayerId ? { ADD: a.addPlayerId } : {}),
          DROP: a.dropPlayerIds.join(","),
        },
      };
    if (a.type === "replaceBids")
      return {
        command: "import",
        params: {
          ...base,
          TYPE: "blindBidWaiverRequest",
          ROUND: String(a.round),
          REPLACE: "1",
          PICKS: a.bids
            .map(
              (b) => `${b.addPlayerId}_${b.amount}_${b.dropPlayerId ?? "0000"}`,
            )
            .join(","),
        },
      };
    if (a.type === "proposeTrade")
      return {
        command: "import",
        params: {
          ...base,
          TYPE: "tradeProposal",
          OFFEREDTO: this.config.franchises.find(
            (p) => p.teamId === a.counterpartyTeamId,
          )!.franchiseId,
          WILL_GIVE_UP: a.givePlayerIds.join(","),
          WILL_RECEIVE: a.receivePlayerIds.join(","),
          ...(a.expiresAt
            ? { EXPIRES: String(Math.floor(Date.parse(a.expiresAt) / 1000)) }
            : {}),
        },
      };
    return {
      command: "import",
      params: {
        ...base,
        TYPE: "tradeResponse",
        TRADE_ID: a.tradeId,
        RESPONSE: a.response,
      },
    };
  }
  private async verify(
    s: MflJournalSession,
    f: Franchise,
    r: MflReceipt,
  ): Promise<unknown | null> {
    const a = r.action,
      b: any = r.before;
    if (a.type === "draft") {
      const d = (await this.call(s, "draftStatic")).data;
      const p = d.picks.find(
        (p: any) => p.round === a.round && p.pick === a.pick,
      );
      return p?.franchiseId === f.franchiseId && p.playerId === a.playerId
        ? { pick: p }
        : null;
    }
    if (a.type === "lineup") {
      const result = await this.lineup(s, f, a.week);
      return same(result.starters, a.starters) ? result : null;
    }
    if (a.type === "addDrop") {
      const result = await this.roster(s, f);
      return (!a.addPlayerId ||
        result.players.some((p) => p.id === a.addPlayerId)) &&
        a.dropPlayerIds.every((id) => !result.players.some((p) => p.id === id))
        ? result
        : null;
    }
    if (a.type === "replaceBids") {
      const result = await this.bids(s, f);
      const observed = result.rounds.find((x) => x.round === a.round);
      if (!observed) {
        // MFL omits cleared rounds. A missing round alone does not prove a clear.
        const previouslyObserved = b?.bids?.rounds?.some(
          (x: any) => x.round === a.round && x.bids.length > 0,
        );
        return a.bids.length === 0 &&
          r.upstreamAccepted === true &&
          previouslyObserved
          ? {
              ...result,
              verificationEvidence:
                "accepted-clear-of-previously-observed-round",
              clearedRound: a.round,
            }
          : null;
      }
      const current = observed.bids;
      const normalize = (b: any[]) =>
        b.map(
          (x) =>
            `${x.addPlayerId}_${Number(x.amount).toFixed(2)}_${x.dropPlayerId ?? "0000"}`,
        );
      return JSON.stringify(normalize(current)) ===
        JSON.stringify(normalize(a.bids))
        ? result
        : null;
    }
    if (a.type === "proposeTrade") {
      if (r.upstreamAccepted !== true) return null; // Similar pending offers cannot prove identity after lost acceptance.
      const current = await this.trades(s, f),
        ids = new Set((b?.trades ?? []).map((t: any) => t.tradeId));
      const found = current.filter(
        (t) =>
          !ids.has(t.tradeId) &&
          t.offeringTeamId === f.teamId &&
          t.offeredToTeamId === a.counterpartyTeamId &&
          same(t.givePlayerIds, a.givePlayerIds) &&
          same(t.receivePlayerIds, a.receivePlayerIds),
      );
      return found.length === 1 ? found[0] : null;
    }
    const current = await this.trades(s, f);
    if (current.some((t) => t.tradeId === a.tradeId)) return null;
    if (a.response !== "accept")
      return r.upstreamAccepted
        ? { tradeId: a.tradeId, response: a.response, pending: false }
        : null;
    const t = b?.trade;
    if (!t) return null;
    const from = this.config.franchises.find(
        (f) => f.teamId === t.offeringTeamId,
      )!,
      to = this.config.franchises.find((f) => f.teamId === t.offeredToTeamId)!;
    const fr = await this.roster(s, from),
      tr = await this.roster(s, to);
    return t.givePlayerIds.every(
      (id: string) =>
        tr.players.some((p) => p.id === id) &&
        !fr.players.some((p) => p.id === id),
    ) &&
      t.receivePlayerIds.every(
        (id: string) =>
          fr.players.some((p) => p.id === id) &&
          !tr.players.some((p) => p.id === id),
      )
      ? { tradeId: a.tradeId, response: "accept", rosters: [fr, tr] }
      : null;
  }
  private async unchangedAfterRejection(
    s: MflJournalSession,
    f: Franchise,
    r: MflReceipt,
  ): Promise<boolean> {
    const a = r.action,
      b: any = r.before;
    if (a.type === "draft") {
      const current = (await this.call(s, "draftStatic")).data;
      return hash(current) === hash(b);
    }
    if (a.type === "lineup")
      return same(
        (await this.lineup(s, f, a.week)).starters,
        b.lineup.starters,
      );
    if (a.type === "addDrop") return hash(await this.roster(s, f)) === hash(b);
    if (a.type === "replaceBids")
      return hash(await this.bids(s, f)) === hash(b.bids);
    if (a.type === "proposeTrade")
      return hash(await this.trades(s, f)) === hash(b.trades);
    const found = (await this.trades(s, f)).find(
      (t) => t.tradeId === a.tradeId,
    );
    return !!found && hash(found) === hash(b.trade);
  }
  async execute(
    actor: Principal,
    idempotencyKey: string,
    input: unknown,
  ): Promise<MflReceipt> {
    if (this.options.writesEnabled !== true)
      throw new MflError("MFL_WRITES_DISABLED");
    const f = this.bound(actor),
      key = safeKey(idempotencyKey),
      action = MflOwnerActionSchema.parse(input),
      actionHash = hash({
        scope: this.scope,
        actor: actor.id,
        team: f.teamId,
        action,
      });
    const run = (admit?: () => Promise<void>) =>
      this.options.journal.withLock(this.scope, async (s) => {
        const existing = await s.find(key);
        if (existing) {
          if (
            existing.actionHash !== actionHash ||
            existing.teamId !== f.teamId ||
            existing.actorId !== actor.id
          )
            throw new MflError("MFL_IDEMPOTENCY_CONFLICT");
          return { ...existing, replayed: true };
        }
        if (action.type === "draft") await admit?.();
        const affectedTeamIds =
          action.type === "draft"
            ? this.config.franchises.map((f) => f.teamId)
            : [
                f.teamId,
                ...(action.type === "proposeTrade"
                  ? [action.counterpartyTeamId]
                  : []),
              ];
        const pending = await s.unresolved();
        if (
          pending.some((p) =>
            p.affectedTeamIds.some((t) => affectedTeamIds.includes(t)),
          )
        )
          throw new MflError("MFL_UNRESOLVED_OPERATION_HOLD");
        let receipt = await s.append({
          id: randomUUID(),
          idempotencyKey: key,
          scope: this.scope,
          leagueId: this.config.leagueId,
          teamId: f.teamId,
          franchiseId: f.franchiseId,
          actorId: actor.id,
          action,
          actionHash,
          state: "prepared",
          synthetic: this.config.mode === "synthetic",
          affectedTeamIds,
        });
        let before: any;
        try {
          before = await this.preflight(s, f, action);
        } catch (e) {
          return s.append({
            ...receipt,
            state: "rejected",
            reason: e instanceof MflError ? e.code : "MFL_PREFLIGHT_FAILED",
            ...(e instanceof MflError && e.details
              ? { details: e.details }
              : {}),
          });
        }
        if (action.type === "respondTrade")
          receipt.affectedTeamIds = [
            before.trade.offeringTeamId,
            before.trade.offeredToTeamId,
          ];
        if (
          pending.some((p) =>
            p.affectedTeamIds.some((t) => receipt.affectedTeamIds.includes(t)),
          )
        )
          return s.append({
            ...receipt,
            before,
            state: "rejected",
            reason: "MFL_UNRESOLVED_OPERATION_HOLD",
          });
        receipt = await s.append({ ...receipt, before, state: "submitted" });
        try {
          const request = this.params(f, action),
            response = await this.call(s, request.command, request.params);
          if (response.errorCode) {
            receipt = await s.append({
              ...receipt,
              state: "unknown",
              reason: response.errorCode,
              details: {
                upstreamMessage:
                  "errorMessage" in response
                    ? response.errorMessage
                    : undefined,
                source: "mfl",
                providerTextIsUntrusted: true,
              },
              responseHash: response.responseHash,
              upstreamAccepted: false,
              upstreamRejected: true,
            });
            const unchanged = await this.unchangedAfterRejection(s, f, receipt);
            return s.append({
              ...receipt,
              state: unchanged ? "rejected" : "unknown",
              reason: unchanged
                ? response.errorCode
                : "MFL_REJECTION_STATE_CONFLICT",
            });
          }
          receipt = await s.append({
            ...receipt,
            state: "unknown",
            upstreamAccepted: response.accepted,
            responseHash: response.responseHash,
            reason: "MFL_READBACK_REQUIRED",
          });
          const result = await this.verify(s, f, receipt);
          return s.append({
            ...receipt,
            state: result ? "verified" : "unknown",
            reason: result ? undefined : "MFL_READBACK_UNCONFIRMED",
            ...(result ? { result } : {}),
          });
        } catch (e) {
          return s.append({
            ...receipt,
            state: "unknown",
            reason:
              e instanceof MflError ? e.code : "MFL_WRITE_OR_READBACK_UNKNOWN",
            ...(e instanceof MflError && e.details
              ? { details: e.details }
              : {}),
          });
        }
      });
    return action.type === "draft" && this.options.withDraftAdmission
      ? this.options.withDraftAdmission(run)
      : run();
  }
  async lookup(actor: Principal, idempotencyKey: string) {
    const f = this.bound(actor),
      key = safeKey(idempotencyKey);
    return this.options.journal.withLock(this.scope, async (s) => {
      const r = await s.find(key);
      if (r && (r.teamId !== f.teamId || r.actorId !== actor.id))
        throw new MflError("MFL_RECEIPT_FORBIDDEN");
      return r;
    });
  }
  async reconcile(
    actor: Principal,
    idempotencyKey: string,
  ): Promise<MflReceipt> {
    const f = this.bound(actor),
      key = safeKey(idempotencyKey);
    return this.options.journal.withLock(this.scope, async (s) => {
      const r = await s.find(key);
      if (!r || r.teamId !== f.teamId || r.actorId !== actor.id)
        throw new MflError("MFL_RECEIPT_FORBIDDEN");
      if (r.state === "verified" || r.state === "rejected")
        return { ...r, replayed: true };
      if (r.state === "prepared")
        return s.append({
          ...r,
          state: "rejected",
          reason: "MFL_NOT_DISPATCHED",
        });
      try {
        if (r.upstreamRejected === true) {
          const unchanged = await this.unchangedAfterRejection(s, f, r);
          return s.append({
            ...r,
            state: unchanged ? "rejected" : "unknown",
            reason: unchanged
              ? "MFL_APPLICATION_REJECTED"
              : "MFL_REJECTION_STATE_CONFLICT",
          });
        }
        const result = await this.verify(s, f, r);
        return result
          ? s.append({ ...r, state: "verified", reason: undefined, result })
          : s.append({
              ...r,
              state: "unknown",
              reason: "MFL_READBACK_UNCONFIRMED",
            });
      } catch (e) {
        return s.append({
          ...r,
          state: "unknown",
          reason: e instanceof MflError ? e.code : "MFL_RECONCILIATION_UNKNOWN",
        });
      }
    });
  }
  async verifyReceipt(
    tx: Pick<Db, "query">,
    actor: Principal,
    key: string,
    receiptId: string,
  ): Promise<MflReceipt> {
    const f = this.bound(actor);
    safeKey(key);
    const row = (
      await tx.query(
        "SELECT details,created_at FROM runtime_receipts WHERE type='mfl_operation' AND details->>'scope'=$1 AND details->>'idempotencyKey'=$2 ORDER BY seq DESC LIMIT 1",
        [this.scope, key],
      )
    ).rows[0];
    const r = row?.details;
    if (
      !r ||
      r.id !== receiptId ||
      r.teamId !== f.teamId ||
      r.actorId !== actor.id ||
      r.leagueId !== actor.leagueId
    )
      throw new MflError("MFL_RECEIPT_FORBIDDEN");
    return { ...r, at: row.created_at.toISOString() };
  }
}
