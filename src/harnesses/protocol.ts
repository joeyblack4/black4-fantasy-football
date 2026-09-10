import { z } from "zod";
import type { LeagueClient } from "../client.js";
import { MflOwnerReadSchema } from "../mfl/contracts.js";
import { ActionSchema } from "../runtime/worker.js";
import type { Job } from "../runtime/index.js";
import type { RuntimeConfig } from "./catalog.js";

export const PROTOCOL_VERSION = "black4-franchise/1" as const;
/** Strict native structured-output schema for the no-action connectivity canary.
 * Keep the richer action union out of this first provider compatibility check.
 */
export const CANARY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: { type: "array", items: { type: "string" }, maxItems: 0 },
    summary: { type: "string" },
  },
  required: ["actions", "summary"],
} as const;
/** Cognition never declares its own charge or authenticated actor. */
export const NativeDecisionSchema = z
  .object({
    actions: z.array(ActionSchema).max(10),
    summary: z.string().max(8000),
  })
  .strict();
export type NativeDecision = z.infer<typeof NativeDecisionSchema>;

export function eventEnvelope(config: RuntimeConfig, job: Job) {
  if (job.agentId !== config.agentId || job.model !== config.assignedModel)
    throw Error("HARNESS_EVENT_BINDING_MISMATCH");
  return structuredClone({
    protocol: PROTOCOL_VERSION,
    franchise: {
      leagueId: config.leagueId,
      agentId: config.agentId,
      teamId: config.teamId,
    },
    event: {
      id: job.id,
      causalId: job.causalId,
      kind: job.kind,
      payload: job.payload,
      dueAt: job.dueAt.toISOString(),
      sourceOccurredAt: job.sourceOccurredAt?.toISOString() ?? null,
      ...(job.role ? { role: job.role, task: job.task } : {}),
    },
    state: {
      memory: job.memory,
      messages: job.recentMessages,
      commitments: job.commitments,
    },
    authority: {
      productionActions: false,
      billing: "Black4 trusted supervisor",
      status: "staged",
    },
  });
}

export const ObservationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goal") }).strict(),
  z.object({ type: z.literal("league") }).strict(),
  z.object({ type: z.literal("franchise") }).strict(),
  z.object({ type: z.literal("host") }).strict(),
  z.object({ type: z.literal("football"), query: MflOwnerReadSchema }).strict(),
]);

/** No arbitrary URLs, actor fields or mutating operations in the staging MCP surface.
 * The API still verifies ownership against the token; local scope is not authority.
 */
export class FranchiseObservations {
  private bindingCheck?: Promise<void>;
  private readonly scope: Pick<
    RuntimeConfig,
    "leagueId" | "agentId" | "teamId"
  >;
  constructor(
    private client: Pick<LeagueClient, "request">,
    scope: Pick<RuntimeConfig, "leagueId" | "agentId" | "teamId">,
  ) {
    this.scope = Object.freeze({
      leagueId: scope.leagueId,
      agentId: scope.agentId,
      teamId: scope.teamId,
    });
  }
  private async verifyBinding() {
    this.bindingCheck ??= (async () => {
      // The API derives identity from the token. Never trust a configured actor.
      const identity = await this.client.request("GET", "/v1/me");
      if (
        identity?.role !== "owner" ||
        identity.leagueId !== this.scope.leagueId ||
        identity.agentId !== this.scope.agentId ||
        identity.teamId !== this.scope.teamId
      )
        throw Error("HARNESS_CREDENTIAL_SCOPE_MISMATCH");
    })();
    await this.bindingCheck;
  }
  async read(input: unknown): Promise<unknown> {
    const query = ObservationSchema.parse(input);
    await this.verifyBinding();
    switch (query.type) {
      case "goal":
        return {
          goal: "Win the league and operate your franchise within its approved rules and wallet.",
          protocol: PROTOCOL_VERSION,
          productionActions: false,
          note: "Rules, budget and receipts come from the control plane; runtime setup does not activate an owner.",
        };
      case "league":
        return this.client.request(
          "GET",
          "/v1/leagues/" + encodeURIComponent(this.scope.leagueId),
        );
      case "franchise":
        return this.client.request(
          "GET",
          "/v1/agents/" + encodeURIComponent(this.scope.agentId),
        );
      case "host":
        return this.client.request("GET", "/v1/football/status");
      case "football":
        return this.client.request("POST", "/v1/football/read", query.query);
    }
  }
}
