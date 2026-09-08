import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Principal } from "../auth.js";
import { getFootballHost } from "../league/host.js";
import { loadMflAdapter } from "../mfl/service.js";
import { MflError } from "../mfl/contracts.js";
import { tagRehearsalWake } from "./rehearsal.js";
import { RuntimeError, type RuntimeStore } from "./index.js";
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? "[" + v.map(stable).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, value]) => JSON.stringify(k) + ":" + stable(value))
          .join(",") +
        "}"
      : JSON.stringify(v);
const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const DraftObserverConfigSchema = z
  .object({
    epoch: id,
    expectedHostVersion: z.number().int().positive(),
    synthetic: z.boolean().default(false),
  })
  .strict();
const DraftStateSchema = z
  .object({
    round: z.number().int().positive().nullable(),
    pick: z.number().int().positive().nullable(),
    franchiseId: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    status: z.string().max(100).nullable(),
    paused: z.boolean(),
    stopped: z.boolean(),
    over: z.boolean(),
    sourceTimestamp: z.string().max(20).regex(/^\d+$/).nullable(),
    picks: z
      .array(
        z
          .object({
            round: z.number().int().positive(),
            pick: z.number().int().positive(),
            franchiseId: z.string().regex(/^\d{4}$/),
            playerId: z
              .string()
              .regex(/^\d{4,5}$/)
              .nullable(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
function check(v: unknown, code: string): asserts v {
  if (!v) throw new RuntimeError(code);
}
function authorize(actor: Principal) {
  check(
    actor.role === "commissioner" && actor.leagueId,
    "DRAFT_OBSERVER_COMMISSIONER_REQUIRED",
  );
}
async function bindings(tx: Pick<Db, "query">, leagueId: string) {
  return (
    await tx.query(
      "SELECT b.agent_id,b.team_id,t.owner_id,t.kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.league_id=$1 ORDER BY b.team_id",
      [leagueId],
    )
  ).rows;
}
async function lock(tx: Tx, leagueId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
    leagueId,
  ]);
}
/** Trusted polling only: no method in this service executes a draft pick or calls a model. */
export class MflDraftObserver {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
    readonly loader = loadMflAdapter,
  ) {}
  async configure(actor: Principal, input: unknown) {
    authorize(actor);
    const config = DraftObserverConfigSchema.parse(input),
      adapter = await this.loader(this.db, actor.leagueId);
    check(
      (adapter.config.mode === "synthetic") === config.synthetic,
      "DRAFT_OBSERVER_MODE_MISMATCH",
    );
    await adapter.assertNativeLiveDraftForCommissioner(actor);
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const host = await getFootballHost(tx, actor.leagueId);
      check(
        host.kind === "mfl" && host.version === config.expectedHostVersion,
        "DRAFT_OBSERVER_HOST_CHANGED",
      );
      const owners = await bindings(tx, actor.leagueId);
      check(
        owners.length === adapter.config.franchises.length &&
          adapter.config.franchises.every((f) =>
            owners.some(
              (o) => o.team_id === f.teamId && o.owner_id === f.ownerId,
            ),
          ),
        "DRAFT_OBSERVER_BINDING_MISMATCH",
      );
      const bindingHash = hash(owners),
        old = (
          await tx.query(
            "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
            [actor.leagueId],
          )
        ).rows[0];
      if (old?.epoch === config.epoch) {
        check(
          old.host_version === host.version &&
            hash(old.host_identity) === hash(host.identity) &&
            old.adapter_scope === adapter.scope &&
            old.binding_hash === bindingHash,
          "DRAFT_OBSERVER_CONFIG_CONFLICT",
        );
        return old;
      }
      check(
        !old || (!old.live && old.status === "held"),
        "DRAFT_OBSERVER_REARM_REQUIRES_HOLD",
      );
      const row = (
        await tx.query(
          `INSERT INTO runtime_mfl_draft_observers(league_id,epoch,host_version,host_identity,adapter_scope,binding_hash,synthetic,configured_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(league_id) DO UPDATE SET epoch=EXCLUDED.epoch,host_version=EXCLUDED.host_version,host_identity=EXCLUDED.host_identity,adapter_scope=EXCLUDED.adapter_scope,binding_hash=EXCLUDED.binding_hash,synthetic=EXCLUDED.synthetic,configured_by=EXCLUDED.configured_by,status='active',fence=runtime_mfl_draft_observers.fence+1,lease_until=NULL,last_state=NULL,last_hash=NULL,resume_number=0,last_source_timestamp=NULL,last_observed_at=NULL,hold_reason=NULL,configured_at=clock_timestamp() RETURNING *`,
          [
            actor.leagueId,
            config.epoch,
            host.version,
            host.identity,
            adapter.scope,
            bindingHash,
            config.synthetic,
            actor.id,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('mfl.draft_observer_configured',$1)",
        [
          {
            leagueId: actor.leagueId,
            epoch: config.epoch,
            hostVersion: host.version,
            synthetic: config.synthetic,
            actorId: actor.id,
          },
        ],
      );
      return row;
    });
  }
  private async hold(tx: Tx, leagueId: string, reason: string) {
    await tx.query(
      "UPDATE runtime_mfl_draft_observers SET status='held',hold_reason=$2,lease_until=NULL WHERE league_id=$1",
      [leagueId, reason],
    );
    await tx.query(
      "INSERT INTO runtime_receipts(type,details) VALUES('mfl.draft_observer_held',$1)",
      [{ leagueId, reason, automaticPick: false }],
    );
    return { status: "held" as const, reason };
  }
  async poll(actor: Principal) {
    authorize(actor);
    const claim = await transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
          [actor.leagueId],
        )
      ).rows[0];
      check(row, "DRAFT_OBSERVER_NOT_CONFIGURED");
      if (row.status === "held")
        return { status: "held" as const, reason: row.hold_reason };
      if (row.live) return { status: "busy" as const };
      const host = await getFootballHost(tx, actor.leagueId);
      if (
        host.kind !== "mfl" ||
        host.version !== row.host_version ||
        hash(host.identity) !== hash(row.host_identity) ||
        hash(await bindings(tx, actor.leagueId)) !== row.binding_hash
      )
        return this.hold(tx, actor.leagueId, "DRAFT_OBSERVER_IDENTITY_CHANGED");
      return {
        status: "claimed" as const,
        row: (
          await tx.query(
            "UPDATE runtime_mfl_draft_observers SET fence=fence+1,lease_until=clock_timestamp()+interval '180 seconds' WHERE league_id=$1 RETURNING *",
            [actor.leagueId],
          )
        ).rows[0],
      };
    });
    if (claim.status !== "claimed") return claim;
    try {
      const adapter = await this.loader(this.db, actor.leagueId);
      check(
        adapter.scope === claim.row.adapter_scope,
        "DRAFT_OBSERVER_ADAPTER_CHANGED",
      );
      const observation = await adapter.readDraftForCommissioner(actor),
        state = DraftStateSchema.parse(observation.data);
      check(
        observation.leagueId === actor.leagueId &&
          observation.synthetic === claim.row.synthetic,
        "DRAFT_OBSERVER_RECEIPT_SCOPE",
      );
      return await transaction(this.db, async (tx) => {
        await lock(tx, actor.leagueId);
        const row = (
          await tx.query(
            "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
            [actor.leagueId],
          )
        ).rows[0];
        if (
          !row ||
          row.fence !== claim.row.fence ||
          !row.live ||
          row.status !== "active"
        )
          return { status: "stale" as const };
        const host = await getFootballHost(tx, actor.leagueId),
          owners = await bindings(tx, actor.leagueId);
        if (
          host.kind !== "mfl" ||
          host.version !== row.host_version ||
          hash(host.identity) !== hash(row.host_identity) ||
          hash(owners) !== row.binding_hash
        )
          return this.hold(
            tx,
            actor.leagueId,
            "DRAFT_OBSERVER_IDENTITY_CHANGED",
          );
        const previous = row.last_state
          ? DraftStateSchema.parse(row.last_state)
          : null;
        if (previous) {
          const historyChanged = previous.picks
            .filter((p) => p.playerId)
            .some(
              (p) =>
                !state.picks.some(
                  (n) =>
                    n.round === p.round &&
                    n.pick === p.pick &&
                    n.franchiseId === p.franchiseId &&
                    n.playerId === p.playerId,
                ),
            );
          const regressed =
            previous.round &&
            previous.pick &&
            state.round &&
            state.pick &&
            (state.round < previous.round ||
              (state.round === previous.round && state.pick < previous.pick));
          const older =
            state.sourceTimestamp &&
            row.last_source_timestamp &&
            BigInt(state.sourceTimestamp) < BigInt(row.last_source_timestamp);
          if (historyChanged || regressed || older)
            return this.hold(
              tx,
              actor.leagueId,
              "MFL_DRAFT_RESET_OR_CORRECTION_REQUIRES_REVIEW",
            );
        }
        const active =
          !state.paused &&
          !state.stopped &&
          !state.over &&
          state.round !== null &&
          state.pick !== null &&
          state.franchiseId !== null;
        const resume =
          Number(row.resume_number) +
          (previous && (previous.paused || previous.stopped) && active ? 1 : 0);
        const { sourceTimestamp: _, ...content } = state,
          stateHash = hash(content),
          changed = row.last_hash !== stateHash;
        let jobId: string | undefined;
        if (active) {
          const mapped = adapter.config.franchises.find(
              (f) => f.franchiseId === state.franchiseId,
            ),
            owner = owners.find(
              (o) =>
                o.team_id === mapped?.teamId && o.owner_id === mapped?.ownerId,
            );
          if (!owner)
            return this.hold(
              tx,
              actor.leagueId,
              "MFL_DRAFT_FRANCHISE_UNMAPPED",
            );
          const completedSlot = state.picks.find(
            (p) =>
              p.round === state.round && p.pick === state.pick && p.playerId,
          );
          if (completedSlot)
            return this.hold(
              tx,
              actor.leagueId,
              "MFL_DRAFT_CURRENT_PICK_ALREADY_FILLED",
            );
          const causalId =
            "mfl-draft-turn:" +
            hash([
              row.epoch,
              row.host_version,
              state.round,
              state.pick,
              state.franchiseId,
              resume,
            ]);
          const existing = (
            await tx.query(
              "SELECT id FROM runtime_jobs WHERE agent_id=$1 AND causal_id=$2",
              [owner.agent_id, causalId],
            )
          ).rows[0];
          if (!existing) {
            const job = await this.runtime.ingestEventTx(tx, {
              agentId: owner.agent_id,
              causalId,
              priority: "urgent",
              payload: {
                kind: "mfl.draft.turn",
                host: "mfl",
                hostVersion: row.host_version,
                observerEpoch: row.epoch,
                synthetic: row.synthetic,
                observationReceiptId: observation.id,
                observedAt: observation.at,
                teamId: owner.team_id,
                draft: state,
                instruction:
                  "MFL reports your draft turn. Read fresh mfl_read draft/players and your own saved local queue. Decide and issue an exact permitted football mfl draft action if still your turn. This observation is not a pick authorization or a completed pick; native preflight is authoritative.",
              },
            });
            if (owner.kind === "ai")
              await tagRehearsalWake(tx, {
                jobId: job.id,
                leagueId: actor.leagueId,
                hostVersion: row.host_version,
                source: "draft-observer",
              });
            jobId = job.id;
          }
        }
        await tx.query(
          "UPDATE runtime_mfl_draft_observers SET last_state=$2,last_hash=$3,last_source_timestamp=COALESCE($4,last_source_timestamp),resume_number=$5,last_observed_at=clock_timestamp(),lease_until=NULL WHERE league_id=$1",
          [actor.leagueId, state, stateHash, state.sourceTimestamp, resume],
        );
        if (changed || jobId)
          await tx.query(
            "INSERT INTO runtime_receipts(type,details) VALUES('mfl.draft_observed',$1)",
            [
              {
                leagueId: actor.leagueId,
                epoch: row.epoch,
                hostVersion: row.host_version,
                observationReceiptId: observation.id,
                changed,
                jobId: jobId ?? null,
                paused: state.paused,
                stopped: state.stopped,
                over: state.over,
                synthetic: row.synthetic,
                automaticPick: false,
              },
            ],
          );
        return {
          status: jobId
            ? ("woken" as const)
            : changed
              ? ("observed" as const)
              : ("unchanged" as const),
          ...(jobId ? { jobId } : {}),
          paused: state.paused,
          stopped: state.stopped,
          over: state.over,
        };
      });
    } catch (error) {
      if (
        (error instanceof RuntimeError || error instanceof MflError) &&
        [
          "MFL_NATIVE_LIVE_DRAFT_REQUIRED",
          "DRAFT_OBSERVER_ADAPTER_CHANGED",
          "DRAFT_OBSERVER_RECEIPT_SCOPE",
        ].includes(error.code)
      )
        return transaction(this.db, async (tx) => {
          await lock(tx, actor.leagueId);
          const current = (
            await tx.query(
              "SELECT fence,status FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
              [actor.leagueId],
            )
          ).rows[0];
          if (
            current?.fence !== claim.row.fence ||
            current?.status !== "active"
          )
            return { status: "stale" as const };
          return this.hold(tx, actor.leagueId, error.code);
        });
      await this.db.query(
        "UPDATE runtime_mfl_draft_observers SET lease_until=NULL WHERE league_id=$1 AND fence=$2",
        [actor.leagueId, claim.row.fence],
      );
      throw error;
    }
  }
}
