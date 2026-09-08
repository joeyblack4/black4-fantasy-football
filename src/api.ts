import { FranchiseExpenses, ExpenseError } from "./franchise/expenses.js";
import { XPublisher, XPublicationError } from "./publication/x-publisher.js";
import {
  PublicProjection,
  publicScope,
  publicScopeHash,
} from "./publication/projection.js";
import {
  FranchiseService,
  FranchiseActionSchema,
  FranchiseError,
} from "./franchise/index.js";
import { BuzzArchiveService, BuzzArchiveQuerySchema } from "./buzz/archive.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Db } from "./db.js";
import {
  ApiError,
  authenticate,
  requireCommissioner,
  requireLeague,
  type Principal,
} from "./auth.js";
import {
  LeagueService,
  leagueCommandSchema,
  LeagueError,
} from "./league/index.js";
import { RuntimeStore, RuntimeError } from "./runtime/index.js";
import { ScheduleSchema, MessageSchema } from "./runtime/worker.js";
import {
  GovernanceService,
  governanceCommandSchema,
} from "./governance/index.js";
import { ScoreboardService } from "./scoring/index.js";
import { DataDispatcher } from "./data/dispatcher.js";
import { hostBinding } from "./league/host.js";
import { loadMflAdapter } from "./mfl/service.js";
import { ManifestRegistry } from "./providers/manifests.js";
import {
  MflOwnerActionSchema,
  MflOwnerReadSchema,
  MflError,
} from "./mfl/contracts.js";

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new ApiError(415, "JSON_REQUIRED", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576)
      throw new ApiError(
        413,
        "BODY_TOO_LARGE",
        "Request exceeds one megabyte.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
export function createApiServer(
  db: Db,
  options: { loadMfl?: typeof loadMflAdapter } = {},
) {
  const mflLoader = options.loadMfl ?? loadMflAdapter;
  async function withMfl<T>(
    actor: Principal,
    work: (adapter: Awaited<ReturnType<typeof loadMflAdapter>>) => Promise<T>,
  ) {
    const lock = await db.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,7044))", [
        actor.leagueId,
      ]);
      return await work(await mflLoader(db, actor.leagueId));
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,7044))", [
        actor.leagueId,
      ]);
      lock.release();
    }
  }
  const league = new LeagueService(db),
    runtime = new RuntimeStore(db),
    governance = new GovernanceService(db),
    scoreboard = new ScoreboardService(db),
    dispatcher = new DataDispatcher(db),
    franchises = new FranchiseService(db),
    expenses = new FranchiseExpenses(db),
    buzzArchive = new BuzzArchiveService(db);
  async function binding(actor: Principal, agentId: string, ownerOnly = false) {
    const row = (
      await db.query(
        "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1 AND b.league_id=$2",
        [agentId, actor.leagueId],
      )
    ).rows[0];
    if (
      !row ||
      (actor.role === "owner" &&
        (row.team_id !== actor.teamId || row.owner_id !== actor.id)) ||
      (ownerOnly && actor.role !== "owner")
    )
      throw new ApiError(
        403,
        "AGENT_FORBIDDEN",
        "This credential does not control that franchise.",
      );
    return row;
  }
  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/health") {
        await db.query("SELECT 1");
        return reply(res, 200, {
          status: "ok",
          mode: "local-foundation",
          liveLeague: false,
        });
      }
      const staticFiles: Record<string, string> = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
        "/play": "play.html",
        "/play.js": "play.js",
        "/review": "review.html",
        "/review.js": "review.js",
      };
      if (req.method === "GET" && staticFiles[url.pathname]) {
        const path = staticFiles[url.pathname];
        const data = await readFile(
          new URL("../public/" + path, import.meta.url),
        );
        res.writeHead(200, {
          "content-type": path.endsWith(".html")
            ? "text/html; charset=utf-8"
            : path.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        });
        return res.end(data);
      }
      const actor = await authenticate(db, req.headers.authorization);
      if (req.method === "GET" && url.pathname === "/v1/football/models") {
        const registry = new ManifestRegistry(db);
        const manifests = (
          await db.query(
            "SELECT id,agent_id,version,status,document,activated_at FROM provider_manifests WHERE league_id=$1 AND status='active' ORDER BY agent_id",
            [actor.leagueId],
          )
        ).rows;
        return reply(res, 200, {
          leagueId: actor.leagueId,
          observedAt: new Date().toISOString(),
          models: await Promise.all(
            manifests.map(async (m) => ({
              agentId: m.agent_id,
              version: m.version,
              activatedAt: m.activated_at,
              developer: m.document.developer,
              model: m.document.model,
              canonicalModel: m.document.canonicalModel ?? null,
              servingEndpoint: m.document.providerSlug,
              quantization: m.document.quantization,
              openWeight: m.document.openWeight,
              license: m.document.license,
              harness: m.document.harnessId,
              harnessVersion: m.document.harnessVersion,
              buzzBridgeVersion: m.document.buzzBridgeVersion,
              modelRestriction: await registry.modelRestrictionEvidence(m.id),
              providerRestriction: await registry.providerRestrictionEvidence(
                m.id,
              ),
            })),
          ),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/football/status") {
        const selected = await hostBinding(db, actor.leagueId);
        return reply(res, 200, {
          host: selected.host,
          version: selected.version,
          leagueId: actor.leagueId,
          ...(selected.host === "mfl"
            ? {
                mflLeagueId: selected.config.leagueId,
                season: selected.config.season,
                skill: "mfl-owner",
                configurationIsNotRatification: true,
                publicScoreRedistribution: "not-cleared",
              }
            : {}),
        });
      }
      if (
        req.method === "POST" &&
        [
          "/v1/football/read",
          "/v1/football/commands",
          "/v1/football/reconcile",
        ].includes(url.pathname)
      ) {
        if (actor.role !== "owner" || !actor.teamId)
          throw new ApiError(
            403,
            "OWNER_REQUIRED",
            "Use the franchise owner's credential for football tools.",
          );
        if (url.pathname.endsWith("/read")) {
          const query = MflOwnerReadSchema.parse(await body(req));
          return reply(
            res,
            200,
            await withMfl(actor, (adapter) => adapter.read(actor, query)),
          );
        }
        if (url.pathname.endsWith("/reconcile")) {
          const input = z
            .object({ idempotencyKey: z.string().min(1).max(160) })
            .strict()
            .parse(await body(req));
          return reply(
            res,
            200,
            await withMfl(actor, (adapter) =>
              adapter.reconcile(actor, input.idempotencyKey),
            ),
          );
        }
        const input = z
          .object({
            idempotencyKey: z.string().min(1).max(160),
            action: MflOwnerActionSchema,
          })
          .strict()
          .parse(await body(req));
        return reply(
          res,
          200,
          await withMfl(actor, (adapter) =>
            adapter.execute(actor, input.idempotencyKey, input.action),
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/v1/me") {
        if (
          actor.role === "owner" &&
          !(
            await db.query(
              "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
              [actor.leagueId, actor.teamId, actor.id],
            )
          ).rowCount
        )
          throw new ApiError(
            403,
            "OWNER_CHANGED",
            "This credential no longer owns its franchise.",
          );
        const peerBindings = (
          await db.query(
            'SELECT team_id AS "teamId",agent_id AS "agentId" FROM runtime_bindings WHERE league_id=$1',
            [actor.leagueId],
          )
        ).rows;
        return reply(res, 200, {
          ...actor,
          agentId:
            peerBindings.find((b) => b.teamId === actor.teamId)?.agentId ??
            null,
          peerBindings,
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/publication/scope") {
        requireCommissioner(actor);
        return reply(res, 200, {
          scope: publicScope,
          scopeHash: publicScopeHash,
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/publication/release") {
        const input = z
          .object({
            scopeHash: z.string(),
            mode: z.enum(["live", "rehearsal"]),
          })
          .strict()
          .parse(await body(req));
        requireCommissioner(actor);
        await new PublicProjection(db).enable(actor, input);
        return reply(res, 200, { enabled: true, scopeHash: input.scopeHash });
      }
      if (req.method === "GET" && url.pathname === "/v1/expenses")
        return reply(res, 200, await expenses.snapshot(actor));
      const expenseAction = url.pathname.match(
        /^\/v1\/expenses\/(begin|settle|uncertain|cancel)$/,
      );
      if (req.method === "POST" && expenseAction) {
        requireCommissioner(actor);
        const input = await body(req);
        const result =
          expenseAction[1] === "begin"
            ? await expenses.beginExpense(actor, input)
            : expenseAction[1] === "settle"
              ? await expenses.settleExpense(actor, input)
              : expenseAction[1] === "uncertain"
                ? await expenses.markUncertain(actor, input)
                : await expenses.cancelExpense(actor, input);
        return reply(res, 200, result);
      }
      if (url.pathname === "/v1/publication/x" && req.method === "GET") {
        requireCommissioner(actor);
        return reply(
          res,
          200,
          await new XPublisher(db, { leagueId: actor.leagueId }).snapshot(
            actor,
          ),
        );
      }
      if (
        url.pathname === "/v1/publication/x/enqueue" &&
        req.method === "POST"
      ) {
        requireCommissioner(actor);
        // Scheduling has no credentials or network path. Only the separately enabled worker publishes.
        return reply(
          res,
          200,
          await new XPublisher(db, { leagueId: actor.leagueId }).enqueue(
            actor,
            await body(req),
          ),
        );
      }
      if (url.pathname === "/v1/publication/revoke" && req.method === "POST") {
        requireCommissioner(actor);
        const input = z
          .object({ batchId: z.uuid() })
          .strict()
          .parse(await body(req));
        return reply(
          res,
          200,
          await franchises.revokeBatch(actor, input.batchId),
        );
      }
      if (req.method === "GET" && url.pathname === "/v1/franchise")
        return reply(res, 200, await franchises.snapshot(actor));
      if (req.method === "POST" && url.pathname === "/v1/franchise/actions") {
        const input = z
          .object({
            agentId: z.string().min(1),
            idempotencyKey: z.string().min(1),
            action: FranchiseActionSchema,
          })
          .strict()
          .parse(await body(req));
        await binding(actor, input.agentId, true);
        if (input.action.type === "governance")
          throw new ApiError(
            400,
            "USE_GOVERNANCE_ROUTE",
            "Submit human governance through the governance route.",
          );
        if (input.action.type === "buzz_channel")
          throw new ApiError(
            400,
            "USE_BUZZ_CHANNEL_ROUTE",
            "Group messages use the authenticated Buzz delivery service.",
          );
        return reply(
          res,
          200,
          await franchises.execute(actor, { ...input, action: input.action }),
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/publication/prepare")
        return reply(
          res,
          200,
          await franchises.prepareBatch(actor, await body(req)),
        );
      if (req.method === "POST" && url.pathname === "/v1/publication/approve")
        return reply(
          res,
          200,
          await franchises.approveBatch(actor, await body(req)),
        );
      if (req.method === "POST" && url.pathname === "/v1/services/review")
        return reply(
          res,
          200,
          await franchises.reviewService(actor, await body(req)),
        );
      if (req.method === "GET" && url.pathname === "/v1/buzz/archive") {
        const input = BuzzArchiveQuerySchema.parse({
          leagueId: actor.leagueId,
          channelId: url.searchParams.get("channelId"),
          afterSequence: url.searchParams.get("afterSequence") ?? "0",
          limit: Number(url.searchParams.get("limit") ?? 100),
        });
        return reply(res, 200, await buzzArchive.query(actor, input));
      }
      if (req.method === "GET" && url.pathname === "/v1/providers") {
        requireCommissioner(actor);
        const manifests = (
          await db.query(
            "SELECT id,agent_id,version,status,document,activated_at FROM provider_manifests WHERE league_id=$1 ORDER BY agent_id,version",
            [actor.leagueId],
          )
        ).rows;
        const calls = (
          await db.query(
            "SELECT c.* FROM provider_calls c JOIN provider_manifests m ON m.id=c.manifest_id WHERE m.league_id=$1 ORDER BY c.started_at DESC LIMIT 200",
            [actor.leagueId],
          )
        ).rows;
        return reply(res, 200, { manifests, calls });
      }
      if (req.method === "POST" && url.pathname === "/v1/governance/commands") {
        const command = governanceCommandSchema.parse(await body(req));
        requireLeague(actor, command.leagueId);
        return reply(res, 200, await governance.execute(actor, command));
      }
      if (req.method === "GET" && url.pathname === "/v1/governance/meetings") {
        const rows = await governance.listMeetings(actor);
        return reply(res, 200, {
          meetings: await Promise.all(
            rows.map((r) => governance.snapshot(actor, r.id)),
          ),
        });
      }
      const meetingPath = url.pathname.match(
        /^\/v1\/governance\/meetings\/([^/]+)$/,
      );
      if (req.method === "GET" && meetingPath)
        return reply(
          res,
          200,
          await governance.snapshot(actor, decodeURIComponent(meetingPath[1])),
        );
      const scorePath = url.pathname.match(
        /^\/v1\/leagues\/([^/]+)\/scores\/(\d+)$/,
      );
      if (req.method === "GET" && scorePath) {
        const leagueId = decodeURIComponent(scorePath[1]);
        requireLeague(actor, leagueId);
        if ((await hostBinding(db, leagueId)).host === "mfl") {
          if (actor.role !== "owner")
            return reply(res, 200, {
              host: "mfl",
              scores: null,
              status: "USE_MFL_OWNER_TOOLS",
            });
          return reply(
            res,
            200,
            await withMfl(actor, (adapter) =>
              adapter.read(actor, {
                type: "scores",
                week: Number(scorePath[2]),
              }),
            ),
          );
        }
        return reply(
          res,
          200,
          await scoreboard.snapshot(leagueId, Number(scorePath[2])),
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/subscriptions") {
        const input = z
          .object({
            agentId: z.string().min(1),
            feedId: z.string().min(1),
            playerId: z.string().min(1),
            enabled: z.boolean().optional(),
          })
          .strict()
          .parse(await body(req));
        await binding(actor, input.agentId, true);
        return reply(res, 200, await dispatcher.subscribe(actor, input));
      }
      if (req.method === "POST" && url.pathname === "/v1/commands") {
        const command = leagueCommandSchema.parse(await body(req));
        requireLeague(actor, command.leagueId);
        return reply(res, 200, await league.execute(actor, command));
      }
      const statePath = url.pathname.match(/^\/v1\/leagues\/([^/]+)$/);
      if (req.method === "GET" && statePath) {
        const leagueId = decodeURIComponent(statePath[1]);
        requireLeague(actor, leagueId);
        const selected = await hostBinding(db, leagueId);
        if (selected.host === "mfl")
          return reply(res, 200, {
            host: "mfl",
            version: selected.version,
            leagueId,
            mflLeagueId: selected.config.leagueId,
            status: "USE_MFL_OWNER_TOOLS",
            customEngineAuthoritative: false,
          });
        return reply(res, 200, await league.snapshot(leagueId, actor));
      }
      const agentPath = url.pathname.match(
        /^\/v1\/agents\/([^/]+)(?:\/(appointments|messages))?$/,
      );
      if (agentPath) {
        const agentId = decodeURIComponent(agentPath[1]);
        await binding(actor, agentId, req.method === "POST");
        if (req.method === "GET" && !agentPath[2])
          return reply(res, 200, await runtime.agentSnapshot(agentId));
        if (req.method === "POST" && agentPath[2] === "appointments")
          return reply(
            res,
            200,
            await runtime.scheduleSelf(
              agentId,
              ScheduleSchema.parse(await body(req)),
            ),
          );
        if (req.method === "POST" && agentPath[2] === "messages") {
          const input = MessageSchema.parse(await body(req));
          const recipient = (
            await db.query(
              "SELECT 1 FROM runtime_bindings WHERE agent_id=$1 AND league_id=$2",
              [input.recipientId, actor.leagueId],
            )
          ).rowCount;
          if (!recipient)
            throw new ApiError(
              403,
              "PEER_FORBIDDEN",
              "Recipient is not in this league.",
            );
          return reply(res, 200, await runtime.sendMessage(agentId, input));
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/operations") {
        requireCommissioner(actor);
        const bindings = (
          await db.query(
            "SELECT agent_id FROM runtime_bindings WHERE league_id=$1",
            [actor.leagueId],
          )
        ).rows;
        const ids = new Set(bindings.map((x) => x.agent_id));
        const all = await runtime.snapshot();
        const value = {
          ...all,
          agents: all.agents.filter((x: any) => ids.has(x.id)),
          jobs: all.jobs.filter((x: any) => ids.has(x.agent_id)),
          messages: all.messages.filter(
            (x: any) => ids.has(x.sender_id) && ids.has(x.recipient_id),
          ),
          receipts: all.receipts.filter((x: any) => ids.has(x.agent_id)),
          reservations: all.reservations.filter((x: any) =>
            ids.has(x.agent_id),
          ),
        };
        return reply(res, 200, {
          mode: "local-foundation",
          liveModelCanaries: Number(
            (
              await db.query(
                `SELECT count(DISTINCT c.agent_id) AS n FROM provider_calls c JOIN provider_manifests m ON m.id=c.manifest_id WHERE m.league_id=$1 AND c.purpose='canary' AND c.status='verified' AND c.reconciliation_status='verified'`,
                [actor.leagueId],
              )
            ).rows[0].n,
          ),
          league:
            (await hostBinding(db, actor.leagueId)).host === "mfl"
              ? {
                  host: "mfl",
                  status: "USE_MFL_OWNER_TOOLS",
                  customEngineAuthoritative: false,
                }
              : await league.snapshot(actor.leagueId, actor),
          runtime: value,
        });
      }
      throw new ApiError(404, "NOT_FOUND", "Route does not exist.");
    } catch (error) {
      if (error instanceof MflError)
        return reply(res, error.code === "MFL_AUTH_REQUIRED" ? 503 : 409, {
          error: error.code,
        });
      if (error instanceof z.ZodError)
        return reply(res, 400, {
          error: "INVALID_REQUEST",
          details: error.issues.map((x) => ({
            path: x.path,
            message: x.message,
          })),
        });
      if (error instanceof ApiError)
        return reply(res, error.status, {
          error: error.code,
          message: error.message,
        });
      const code = (error as any)?.code;
      if (
        error instanceof LeagueError ||
        error instanceof RuntimeError ||
        error instanceof FranchiseError ||
        error instanceof ExpenseError ||
        error instanceof XPublicationError
      )
        return reply(
          res,
          String(code).includes("FORBIDDEN")
            ? 403
            : code === "NOT_FOUND"
              ? 404
              : 409,
          { error: code, message: error.message },
        );
      // Never echo SQL, credential material, or provider response bodies to a caller.
      console.error(
        "API request failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return reply(res, 500, {
        error: "INTERNAL_ERROR",
        message:
          "Request failed; no success receipt was returned. Retry only with the same idempotency key.",
      });
    }
  });
}
