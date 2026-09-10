import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { transaction, type Db } from "../db.js";
import type { Principal } from "../auth.js";
import { ScoreboardService } from "../scoring/index.js";
import { fingerprint } from "../franchise/service.js";
import { hostBinding } from "../league/host.js";
export const publicScope = {
  version: "2026-09-07.v2",
  fields: [
    "league name/status",
    "committed draft picks",
    "rosters",
    "lineups",
    "ratified constitution",
    "active model disclosures",
    "harness name/version and Buzz bridge version",
    "fantasy scores with source mode and availability",
    "aggregate inference cost",
    "approved website content",
  ],
  excluded: [
    "secrets",
    "private queues",
    "unapproved brands/transcripts",
    "raw licensed stats",
    "owner credentials",
  ],
};
export const publicScopeHash = createHash("sha256")
  .update(JSON.stringify(publicScope))
  .digest("hex");
export class PublicProjection {
  constructor(private db: Db) {}
  async enable(
    actor: Principal,
    input: { scopeHash: string; mode: "live" | "rehearsal" },
  ) {
    if (
      actor.role !== "commissioner" ||
      input.scopeHash !== publicScopeHash ||
      !["live", "rehearsal"].includes(input.mode)
    )
      throw Error("PUBLIC_RELEASE_NOT_APPROVED");
    await this.db.query(
      `INSERT INTO public_league_releases(league_id,mode,approved_by,scope_hash,enabled) VALUES($1,$2,$3,$4,true)
    ON CONFLICT(league_id) DO UPDATE SET enabled=true,mode=$2,approved_by=$3,approved_at=clock_timestamp(),scope_hash=$4`,
      [actor.leagueId, input.mode, actor.id, input.scopeHash],
    );
  }
  async refresh(leagueId: string) {
    const release = (
      await this.db.query(
        "SELECT *,extract(epoch FROM approved_at)::text AS approval_version FROM public_league_releases WHERE league_id=$1 AND enabled",
        [leagueId],
      )
    ).rows[0];
    if (!release) return { status: "not-released" };
    // This projection consumes the custom engine. Never relabel its local fixtures as MFL results.
    if ((await hostBinding(this.db, leagueId)).host === "mfl")
      throw Error("MFL_PUBLIC_PROJECTION_NOT_ENABLED");
    if (release.scope_hash !== publicScopeHash)
      throw Error("PUBLIC_SCOPE_CHANGED_REAPPROVAL_REQUIRED");
    let scores: unknown = null;
    const l = (
      await this.db.query(
        "SELECT name,status,current_week,constitution_version,constitution_rules_hash,rules,ratified_scoring_rules,draft_paused_at FROM leagues WHERE id=$1",
        [leagueId],
      )
    ).rows[0];
    if (!l) throw Error("LEAGUE_UNAVAILABLE");
    try {
      const s = await new ScoreboardService(this.db).snapshot(
        leagueId,
        l.current_week,
      );
      scores = s.teams.map((t) => ({
        team: t.name,
        points: t.milliPoints === null ? null : t.milliPoints / 1000,
        status: t.status,
        sourceMode: t.synthetic,
      }));
      if (
        release.mode === "live" &&
        s.teams.some((t) => ["synthetic", "mixed"].includes(t.synthetic))
      )
        throw Error("SYNTHETIC_SCORING_IN_LIVE_RELEASE");
    } catch (e) {
      if (
        e instanceof Error &&
        e.message === "SYNTHETIC_SCORING_IN_LIVE_RELEASE"
      )
        throw e;
      scores = null;
    }
    return transaction(this.db, async (tx) => {
      const picks = (
        await tx.query(
          `SELECT p.pick_index AS index,t.name AS team,pl.name AS player,array_to_string(pl.positions,', ') AS position
      FROM league_draft_picks p JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id JOIN league_players pl ON pl.league_id=p.league_id AND pl.id=p.player_id
      WHERE p.league_id=$1 ORDER BY p.pick_index`,
          [leagueId],
        )
      ).rows;
      const rosters = (
        await tx.query(
          `SELECT t.id AS "teamId",t.name AS team,p.id AS "playerId",p.name AS player,p.positions
      FROM league_rosters r JOIN league_teams t ON t.league_id=r.league_id AND t.id=r.team_id JOIN league_players p ON p.league_id=r.league_id AND p.id=r.player_id WHERE r.league_id=$1 ORDER BY t.id,p.name`,
          [leagueId],
        )
      ).rows;
      if (
        release.mode === "live" &&
        (picks.some((p) => /synthetic/i.test(p.player)) ||
          rosters.some((r) => /^SYNTHETIC-/.test(r.playerId)))
      )
        throw Error("SYNTHETIC_PLAYERS_IN_LIVE_RELEASE");
      const lineups = (
        await tx.query(
          'SELECT team_id AS "teamId",week,slot_id AS slot,player_id AS "playerId" FROM league_lineups WHERE league_id=$1 AND week=$2',
          [leagueId, l.current_week],
        )
      ).rows;
      const models = (
        await tx.query(
          `SELECT m.agent_id AS franchise,m.version,m.document->>'developer' AS developer,m.document->>'model' AS model,
      m.document->>'providerSlug' AS provider,m.document->>'harnessId' AS harness,m.document->>'harnessVersion' AS "harnessVersion",m.document->>'buzzBridgeVersion' AS "buzzBridgeVersion",m.document->'openWeight' AS "openWeight",m.document->'license' AS license,m.activated_at AS "activatedAt"
      FROM provider_manifests m WHERE league_id=$1 AND status='active' ORDER BY agent_id`,
          [leagueId],
        )
      ).rows;
      const costs = (
        await tx.query(
          `SELECT COALESCE(sum(c.cost_micros),0)::text AS "observedMicros",count(*) FILTER(WHERE c.cost_micros IS NULL)::int AS unresolved
      FROM provider_calls c JOIN provider_manifests m ON m.id=c.manifest_id WHERE m.league_id=$1`,
          [leagueId],
        )
      ).rows[0];
      const approved = (
        await tx.query(
          `SELECT b.id,b.items,b.content_hash FROM franchise_publication_batches b JOIN franchise_publication_approvals a ON a.batch_id=b.id AND a.content_hash=b.content_hash
      WHERE b.league_id=$1 AND b.status='approved' ORDER BY b.created_at`,
          [leagueId],
        )
      ).rows;
      for (const batch of approved) {
        if (
          !Array.isArray(batch.items) ||
          fingerprint(batch.items) !== batch.content_hash
        )
          throw Error("PUBLIC_BATCH_INTEGRITY_FAILURE");
      }
      // Approval items contain fixed draft snapshots; only website text is projected, never arbitrary HTML.
      const excerpts = approved.flatMap((b) =>
        b.items
          .filter((i: any) => i.channel === "website")
          .map((i: any) => ({
            batchId: b.id,
            contentHash: b.content_hash,
            title: i.title,
            body: i.body,
            teamId: i.teamId,
          })),
      );
      const document = {
        generatedAt: new Date().toISOString(),
        scopeHash: publicScopeHash,
        releaseApprovalVersion: release.approval_version,
        mode: release.mode,
        league: {
          name: l.name,
          status: l.draft_paused_at ? "paused" : l.status,
          week: l.current_week,
        },
        picks,
        rosters,
        lineups,
        models,
        costs,
        scores,
        constitution: l.constitution_version
          ? {
              version: l.constitution_version,
              hash: l.constitution_rules_hash,
              rules: l.rules,
              scoring: l.ratified_scoring_rules,
            }
          : null,
        excerpts,
      };
      await tx.query(
        `INSERT INTO public_league_snapshots(league_id,document) VALUES($1,$2) ON CONFLICT(league_id) DO UPDATE SET document=$2,generated_at=clock_timestamp()`,
        [leagueId, document],
      );
      return { status: "projected", generatedAt: document.generatedAt };
    });
  }
}
/** Separate read surface. Its DB role needs SELECT only on sanitized snapshot/release tables. */
export function createPublicServer(
  db: Db,
  leagueId: string,
  allowedOrigin = "https://black4.ai",
) {
  return createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("access-control-allow-origin", allowedOrigin);
    if (req.method !== "GET" || req.url !== "/league.json") {
      res.writeHead(404);
      return res.end('{"error":"NOT_FOUND"}');
    }
    try {
      const row = (
        await db.query(
          `SELECT s.document,s.generated_at FROM public_league_snapshots s JOIN public_league_releases r ON r.league_id=s.league_id AND r.enabled WHERE s.league_id=$1
            AND r.scope_hash=$2 AND s.document->>'scopeHash'=$2
            AND s.document->>'mode'=r.mode
            AND s.document->>'releaseApprovalVersion'=extract(epoch FROM r.approved_at)::text`,
          [leagueId, publicScopeHash],
        )
      ).rows[0];
      if (!row || Date.now() - new Date(row.generated_at).getTime() > 45000) {
        res.writeHead(503);
        return res.end('{"error":"LIVE_DATA_UNAVAILABLE"}');
      }
      res.end(JSON.stringify(row.document));
    } catch {
      res.writeHead(503);
      res.end('{"error":"LIVE_DATA_UNAVAILABLE"}');
    }
  });
}
