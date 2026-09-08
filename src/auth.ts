import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export type Principal = {
  id: string;
  role: "owner" | "commissioner" | "system";
  leagueId: string;
  teamId?: string;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function issueCredential(db: Db, actor: Principal) {
  const token = "b4ff_" + randomBytes(32).toString("base64url");
  const id = randomUUID();
  await db.query(
    "INSERT INTO api_credentials(id,token_hash,actor_id,role,league_id,team_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      digest(token),
      actor.id,
      actor.role,
      actor.leagueId,
      actor.teamId ?? null,
    ],
  );
  return { id, token, actor };
}

export async function authenticate(
  db: Db,
  authorization: string | undefined,
): Promise<Principal> {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 256)
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "A league credential is required.",
    );
  const result = await db.query(
    "SELECT actor_id,role,league_id,team_id FROM api_credentials WHERE token_hash=$1 AND revoked_at IS NULL",
    [digest(authorization.slice(7))],
  );
  const row = result.rows[0];
  if (!row)
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "Credential is invalid or revoked.",
    );
  return {
    id: row.actor_id,
    role: row.role,
    leagueId: row.league_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
  };
}

export function requireLeague(actor: Principal, leagueId: string) {
  if (actor.leagueId !== leagueId)
    throw new ApiError(
      403,
      "LEAGUE_FORBIDDEN",
      "Credential does not belong to this league.",
    );
}
export function requireAgent(actor: Principal, agentId: string) {
  if (actor.role !== "owner" || actor.teamId !== agentId)
    throw new ApiError(
      403,
      "AGENT_FORBIDDEN",
      "Owner credential does not control this franchise.",
    );
}
export function requireCommissioner(actor: Principal) {
  if (actor.role !== "commissioner")
    throw new ApiError(
      403,
      "COMMISSIONER_REQUIRED",
      "Commissioner access is required.",
    );
}
