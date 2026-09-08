import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Db } from "../db.js";
import { hostBinding } from "../league/host.js";
import { MflAdapter } from "./index.js";
import { MflConfigSchema, MflError } from "./contracts.js";
import { PgMflJournal } from "./journal.js";

export const MflDeploymentSchema = z
  .object({
    configRef: z.string().min(1).max(160),
    config: MflConfigSchema,
    writesEnabled: z.boolean().default(false),
  })
  .strict();

/** Operator-supplied files only. Neither path nor credential is accepted from owner input. */
async function privateJson(path: string | undefined) {
  if (!path || !isAbsolute(path))
    throw new MflError("MFL_PRIVATE_FILE_REQUIRED");
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 100_000)
    throw new MflError("MFL_PRIVATE_FILE_PERMISSIONS");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new MflError("MFL_PRIVATE_FILE_INVALID");
  }
}

export async function loadMflAdapter(
  db: Db,
  leagueId: string,
): Promise<MflAdapter> {
  const selected = await hostBinding(db, leagueId);
  if (selected.host !== "mfl") throw new MflError("MFL_HOST_NOT_SELECTED");
  const deployment = MflDeploymentSchema.parse(
    await privateJson(process.env.FOOTBALL_MFL_CONFIG_FILE),
  );
  const { config } = deployment;
  if (
    deployment.configRef !== selected.config.configRef ||
    config.leagueId !== leagueId ||
    config.mflLeagueId !== selected.config.leagueId ||
    config.season !== selected.config.season
  )
    throw new MflError("MFL_DEPLOYMENT_BINDING_MISMATCH");
  if (config.mode !== "real")
    throw new MflError("MFL_REAL_DEPLOYMENT_REQUIRED");
  const owners = (
    await db.query("SELECT id,owner_id FROM league_teams WHERE league_id=$1", [
      leagueId,
    ])
  ).rows;
  if (
    owners.length !== config.franchises.length ||
    config.franchises.some(
      (f) => !owners.some((o) => o.id === f.teamId && o.owner_id === f.ownerId),
    )
  )
    throw new MflError("MFL_FRANCHISE_BINDING_CHANGED");
  return new MflAdapter(config, {
    journal: new PgMflJournal(db),
    writesEnabled: deployment.writesEnabled,
    getSessionCookie: async () => {
      const session = z
        .object({
          cookieName: z.literal("MFL_USER_ID"),
          cookieValue: z.string().min(1),
          leagueId: z.string(),
          season: z.number(),
          host: z.string(),
        })
        .strict()
        .parse(await privateJson(process.env.MFL_SESSION_FILE));
      if (
        session.leagueId !== config.mflLeagueId ||
        session.host !== config.host ||
        session.season !== config.season
      )
        throw new MflError("MFL_SESSION_BINDING_MISMATCH");
      return session.cookieValue;
    },
  });
}
