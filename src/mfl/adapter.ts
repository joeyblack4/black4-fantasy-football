import { randomUUID } from "node:crypto";
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
import { envelope, draftState, hash, list, csv } from "./codec.js";
type Franchise = MflConfig["franchises"][number];
type Options = {
  writesEnabled?: boolean;
  getSessionCookie: () => Promise<string>;
  journal: MflJournal;
  fetchImpl?: typeof fetch;
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
    command: "export" | "import" | "live_draft" | "draftStatic" | "players",
    params: Record<string, string> = {},
  ) {
    const method =
      command === "import" || command === "live_draft" ? "POST" : "GET";
    const p = new URLSearchParams({
      ...params,
      L: this.config.mflLeagueId,
      JSON: "1",
    });
    const url =
      command === "players"
        ? `https://api.myfantasyleague.com/${this.config.season}/export?TYPE=players&JSON=1`
        : command === "draftStatic"
          ? `https://${this.config.host}/fflnetdynamic${this.config.season}/${this.config.mflLeagueId}_LEAGUE_draft_results.xml`
          : `https://${this.config.host}/${this.config.season}/${command}` +
            (method === "GET" ? "?" + p : "");
    await s.beforeRequest(this.config.mode === "real" ? 1100 : 0);
    await s.recordRead({
      kind: "transport_started",
      method,
      command,
      parameters: params,
      requestHash: hash(method === "POST" ? p.toString() : url),
      synthetic: this.config.mode === "synthetic",
    });
    let session: string = "";
    try {
      if (command !== "players")
        session = await this.options.getSessionCookie();
    } catch {
      throw new MflError("MFL_SESSION_UNAVAILABLE");
    }
    if (
      command !== "players" &&
      (!session || session.length > 4096 || /[\r\n;]/.test(session))
    )
      throw new MflError("MFL_SESSION_INVALID");
    let response: Response, raw: string;
    try {
      response = await this.http(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          ...(command === "players"
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
    const responseHash = hash(raw);
    await s.recordRead({
      kind: "transport_received",
      method,
      command,
      httpStatus: response.status,
      responseHash,
      synthetic: this.config.mode === "synthetic",
    });
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
    return { ...envelope(raw), responseHash };
  }
  private async exported(
    s: MflJournalSession,
    type: string,
    params: Record<string, string> = {},
  ) {
    const result = await this.call(s, "export", { TYPE: type, ...params });
    if (result.errorCode) throw new MflError(result.errorCode);
    return result.data;
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
  private async roster(s: MflJournalSession, f: Franchise) {
    const data = await this.exported(s, "rosters", {
      FRANCHISE: f.franchiseId,
    });
    const rows = this.franchiseRows(data, "rosters");
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
  private async lineup(s: MflJournalSession, f: Franchise, week: number) {
    const data = await this.exported(s, "weeklyResults", { W: String(week) });
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
      let data: any;
      if (request.type === "players") {
        const cacheKey = "mfl-player-catalog:" + this.config.season;
        let players = (await s.cached(cacheKey, 86400)) as any[] | null;
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
            data: players,
            synthetic: this.config.mode === "synthetic",
          });
        }
        const selected = players.filter(
          (p) =>
            (!request.position || p.position === request.position) &&
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
      } else if (request.type === "roster") data = await this.roster(s, f);
      else if (request.type === "rosters") {
        const raw = await this.exported(s, "rosters");
        data = this.franchiseRows(raw, "rosters")
          .filter((r) =>
            this.config.franchises.some((f) => f.franchiseId === r.id),
          )
          .map((r) => ({
            teamId: this.config.franchises.find((f) => f.franchiseId === r.id)!
              .teamId,
            franchiseId: r.id,
            players: list(r.player).map((p: any) => ({
              id: p.id,
              status: p.status ?? "UNKNOWN",
            })),
          }));
      } else if (request.type === "lineup")
        data = await this.lineup(s, f, request.week);
      else if (request.type === "pendingBids") data = await this.bids(s, f);
      else if (request.type === "pendingTrades") data = await this.trades(s, f);
      else if (request.type === "draft")
        data = (await this.call(s, "draftStatic")).data;
      else if (request.type === "rules") {
        try {
          const raw = await this.exported(s, "rules");
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
      } else {
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
      };
    });
  }
  private async preflight(
    s: MflJournalSession,
    f: Franchise,
    a: MflOwnerAction,
  ): Promise<any> {
    if (a.type === "draft") {
      await this.requireNativeLiveDraft(s);
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
        throw new MflError("MFL_PLAYER_NOT_OWNED");
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
        return {
          roster: r,
          counterparty: theirs,
          trades: await this.trades(s, f),
        };
      }
      return a.type === "replaceBids"
        ? { roster: r, bids: await this.bids(s, f) }
        : a.type === "lineup"
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
      const current =
        result.rounds.find((x) => x.round === a.round)?.bids ?? [];
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
    return this.options.journal.withLock(this.scope, async (s) => {
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
        });
      }
    });
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
