import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { guard, fingerprint } from "./service.js";

export const FOOTBALL_COMMUNITY =
  "wss://black4fantasysports.communities.buzz.xyz";
// Application cap, not a claim about Buzz's undocumented maximum. Never truncate an owner's name.
export const MAX_FRANCHISE_DISPLAY_NAME = 200;
const safeName = z
  .string()
  .min(1)
  .max(MAX_FRANCHISE_DISPLAY_NAME)
  .refine(
    (v) => v === v.trim() && !/[\p{Cc}\p{Cf}]/u.test(v),
    "Unsafe display name",
  );
export function franchiseDisplayName(teamName: string, model: string) {
  safeName.parse(teamName);
  safeName.parse(model);
  return safeName.parse(`${teamName} - ${model}`);
}
const reconcileSchema = z
  .object({ teamId: z.string().min(1).max(120), channelId: z.uuid() })
  .strict();
const handoffSchema = z
  .object({
    receiptId: z.uuid(),
    observedPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    currentManagedName: safeName,
    profileReference: z.string().min(1).max(1000),
  })
  .strict();
const observationSchema = z
  .object({
    receiptId: z.uuid(),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    profileName: safeName,
    managedName: safeName,
    profileEventId: z.string().regex(/^[a-f0-9]{64}$/),
    managedReadbackReference: z.string().min(1).max(1000),
  })
  .strict();

/** Trusted operator only. No network, signer, shell execution, public release or MFL writes. */
export class FranchiseNames {
  constructor(readonly db: Db) {}
  private authorize(actor: Actor) {
    guard(actor.role === "commissioner", "FORBIDDEN");
  }
  private async lock(tx: Tx, leagueId: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
      leagueId,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7131))", [
      leagueId,
    ]);
  }
  private async binding(
    tx: Tx,
    leagueId: string,
    teamId: string,
    channelId: string,
  ) {
    const b = (
      await tx.query(
        `SELECT t.owner_id,t.name,b.agent_id,a.model,m.pubkey,m.owner_pubkey_hint,m.provenance
      FROM league_teams t JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id
      JOIN runtime_agents a ON a.id=b.agent_id AND a.kind='ai'
      JOIN buzz_managed_identities m ON m.league_id=t.league_id AND m.team_id=t.id AND m.agent_id=b.agent_id AND m.owner_id=t.owner_id
      JOIN buzz_league_bindings l ON l.league_id=t.league_id AND l.mode='real' AND l.community_url=$3 AND m.community_url=l.community_url
      JOIN buzz_participants p ON p.league_id=t.league_id AND p.agent_id=b.agent_id AND p.pubkey=m.pubkey AND p.owner_id=t.owner_id AND p.team_id=t.id AND p.kind='agent' AND p.owner_pubkey=m.owner_pubkey_hint
      JOIN buzz_conversations c ON c.league_id=t.league_id AND c.channel_id=$4 AND c.kind='private-channel' AND c.member_pubkeys ? m.pubkey
      WHERE t.league_id=$1 AND t.id=$2 AND t.kind='ai'`,
        [leagueId, teamId, FOOTBALL_COMMUNITY, channelId],
      )
    ).rows[0];
    guard(
      b &&
        /^[a-f0-9]{64}$/.test(b.pubkey) &&
        /^[a-f0-9]{64}$/.test(b.owner_pubkey_hint),
      "NAME_BINDING_FORBIDDEN",
    );
    return b;
  }
  async reconcile(actor: Actor, input: unknown) {
    this.authorize(actor);
    const command = reconcileSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.lock(tx, actor.leagueId);
      const b = await this.binding(
        tx,
        actor.leagueId,
        command.teamId,
        command.channelId,
      );
      const brand = (
        await tx.query(
          `SELECT v.*,r.agent_id,r.actor_id FROM franchise_brand_versions v JOIN franchise_receipts r ON r.id=v.receipt_id AND r.type='brand' WHERE v.league_id=$1 AND v.team_id=$2 ORDER BY v.version DESC LIMIT 1`,
          [actor.leagueId, command.teamId],
        )
      ).rows[0];
      guard(brand, "OWNER_BRAND_REQUIRED");
      guard(
        brand.agent_id === b.agent_id &&
          brand.actor_id === b.owner_id &&
          fingerprint(brand.payload) === brand.content_hash,
        "OWNER_BRAND_PROVENANCE_INVALID",
      );
      // The exact saved brand must originate in a completed real owner turn, not a direct call or canary.
      const source = (
        await tx.query(
          `SELECT o.action FROM runtime_franchise_outbox o
        JOIN runtime_jobs j ON j.id=o.job_id AND j.agent_id=o.agent_id AND j.status='completed' AND j.execution_mode='owner'
        JOIN provider_calls c ON c.job_id=j.id AND c.agent_id=j.agent_id AND c.purpose='owner' AND c.status='verified' AND c.generation_id IS NOT NULL
        JOIN provider_manifests m ON m.id=c.manifest_id AND m.activated_at<=o.created_at
        WHERE o.league_id=$1 AND o.team_id=$2 AND o.agent_id=$3 AND o.owner_id=$4 AND o.status='delivered'
        AND o.service_receipt->>'receiptId'=$5 AND o.action->>'type'='brand' LIMIT 1`,
          [
            actor.leagueId,
            command.teamId,
            b.agent_id,
            b.owner_id,
            brand.receipt_id,
          ],
        )
      ).rows[0];
      guard(source, "REAL_OWNER_BRAND_RECEIPT_REQUIRED");
      const { type, causalId, ...sourceBrand } = source.action;
      guard(
        fingerprint(sourceBrand) === brand.content_hash,
        "OWNER_BRAND_PROVENANCE_INVALID",
      );
      const manifest = (
        await tx.query(
          `SELECT id,version,document FROM provider_manifests WHERE agent_id=$1 AND league_id=$2 AND status='active' AND activated_at IS NOT NULL`,
          [b.agent_id, actor.leagueId],
        )
      ).rows[0];
      guard(
        manifest &&
          manifest.document.model === b.model &&
          manifest.document.agentId === b.agent_id &&
          manifest.document.leagueId === actor.leagueId,
        "ACTIVE_MODEL_REQUIRED",
      );
      // No independent friendly-label input: exact assigned catalog slug is the supported fallback.
      const desiredName = franchiseDisplayName(
        brand.payload.name,
        manifest.document.canonicalModel ?? manifest.document.model,
      );
      const old = (
        await tx.query(
          `SELECT * FROM franchise_name_receipts WHERE league_id=$1 AND team_id=$2 AND brand_receipt_id=$3 AND manifest_id=$4`,
          [actor.leagueId, command.teamId, brand.receipt_id, manifest.id],
        )
      ).rows[0];
      if (old) {
        guard(b.name === desiredName, "LOCAL_NAME_DRIFT");
        guard(
          old.pubkey === b.pubkey &&
            old.channel_id === command.channelId &&
            old.desired_name === desiredName,
          "NAME_SOURCE_CHANGED",
        );
        return {
          receipt: old,
          replayed: true,
          buzzStatus: "operator-readback-required",
        };
      }
      const receipt = (
        await tx.query(
          `INSERT INTO franchise_name_receipts(id,league_id,team_id,agent_id,brand_receipt_id,brand_version,manifest_id,manifest_version,pubkey,channel_id,desired_name,previous_local_name,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            randomUUID(),
            actor.leagueId,
            command.teamId,
            b.agent_id,
            brand.receipt_id,
            brand.version,
            manifest.id,
            manifest.version,
            b.pubkey,
            command.channelId,
            desiredName,
            b.name,
            actor.id,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE league_teams SET name=$3 WHERE league_id=$1 AND id=$2",
        [actor.leagueId, command.teamId, desiredName],
      );
      return {
        receipt,
        replayed: false,
        buzzStatus: "operator-readback-required",
      };
    });
  }
  private async current(tx: Tx, actor: Actor, id: string) {
    const r = (
      await tx.query(
        "SELECT * FROM franchise_name_receipts WHERE id=$1 AND league_id=$2",
        [id, actor.leagueId],
      )
    ).rows[0];
    guard(r, "NAME_RECEIPT_FORBIDDEN");
    const b = await this.binding(tx, actor.leagueId, r.team_id, r.channel_id);
    const valid = (
      await tx.query(
        `SELECT 1 FROM provider_manifests m WHERE m.id=$1 AND m.agent_id=$2 AND m.status='active' AND m.document->>'model'=$5 AND EXISTS(SELECT 1 FROM franchise_brand_versions v WHERE v.receipt_id=$3 AND v.version=(SELECT max(version) FROM franchise_brand_versions WHERE league_id=$4 AND team_id=$6))`,
        [
          r.manifest_id,
          b.agent_id,
          r.brand_receipt_id,
          actor.leagueId,
          b.model,
          r.team_id,
        ],
      )
    ).rowCount;
    guard(valid && r.pubkey === b.pubkey, "NAME_RECEIPT_SUPERSEDED");
    return r;
  }
  async prepareBuzzHandoff(actor: Actor, input: unknown) {
    this.authorize(actor);
    const c = handoffSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.lock(tx, actor.leagueId);
      const r = await this.current(tx, actor, c.receiptId);
      guard(c.observedPubkey === r.pubkey, "NAME_PUBKEY_MISMATCH");
      const result = {
        executable: "/Users/joey/.local/bin/buzz",
        args: [
          "agents",
          "draft-update",
          "--channel",
          r.channel_id,
          "--agent-name",
          c.currentManagedName,
          "--display-name",
          r.desired_name,
        ],
        shell: false,
        requiredOwnerSigner: true,
        expectedPubkey: r.pubkey,
        communityUrl: FOOTBALL_COMMUNITY,
        requiresDesktopSave: true,
        externalWritePerformed: false,
        profileReference: c.profileReference,
      };
      const id = randomUUID();
      await tx.query(
        `INSERT INTO franchise_name_observations(id,name_receipt_id,actor_id,kind,evidence) VALUES($1,$2,$3,'operator-handoff',$4)`,
        [id, r.id, actor.id, result],
      );
      return { receiptId: id, ...result };
    });
  }
  async attestBuzzReadback(actor: Actor, input: unknown) {
    this.authorize(actor);
    const c = observationSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await this.lock(tx, actor.leagueId);
      const r = await this.current(tx, actor, c.receiptId);
      guard(
        c.pubkey === r.pubkey &&
          c.profileName === r.desired_name &&
          c.managedName === r.desired_name,
        "NAME_READBACK_MISMATCH",
      );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO franchise_name_observations(id,name_receipt_id,actor_id,kind,evidence) VALUES($1,$2,$3,'operator-attested-buzz-readback',$4)`,
        [id, r.id, actor.id, c],
      );
      return {
        receiptId: id,
        status: "operator-attested-buzz-readback",
        automatedVerification: false,
      };
    });
  }
}
