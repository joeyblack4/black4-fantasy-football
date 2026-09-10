import type { AgentDriver, Job, DriverResult } from "../runtime/index.js";
import { KnownZeroCostError, ObservedCostError } from "../runtime/worker.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./catalog.js";
import { configDigest } from "./workspaces.js";
import { eventEnvelope, NativeDecisionSchema } from "./protocol.js";

/** Implemented by the trusted, isolated supervisor, never supplied by model output. */
export interface HarnessTransport {
  readonly synthetic: boolean;
  execute(input: {
    config: RuntimeConfig;
    event: ReturnType<typeof eventEnvelope>;
    signal?: AbortSignal;
  }): Promise<{
    decision: unknown;
    charge:
      | { state: "verified"; costMicros: number; evidenceId: string }
      | { state: "unknown" };
  }>;
}

/** Initial integration intentionally admits synthetic transports only. Paid execution
 * requires an independently verified meter/isolation/identity admission implementation.
 * There is no generic model loop, tool-repair loop, or OpenRouter fallback here.
 */
export class NativeHarnessDriver implements AgentDriver {
  readonly name: string;
  readonly synthetic: boolean;
  readonly model: string;
  readonly harnessId: string;
  readonly configDigest: string;
  private readonly config: RuntimeConfig;
  constructor(
    config: RuntimeConfig,
    private readonly transport: HarnessTransport,
  ) {
    this.config = Object.freeze(RuntimeConfigSchema.parse(config));
    this.name = "native-harness:" + config.harnessId;
    this.harnessId = config.harnessId;
    this.configDigest = configDigest(this.config);
    this.synthetic = transport.synthetic;
    this.model = config.assignedModel;
  }
  async run(
    job: Job,
    context?: { signal: AbortSignal },
  ): Promise<DriverResult> {
    if (!this.synthetic)
      throw new KnownZeroCostError(
        "NATIVE_HARNESS_LIVE_ADMISSION_NOT_IMPLEMENTED",
      );
    let envelope: ReturnType<typeof eventEnvelope>;
    try {
      envelope = eventEnvelope(this.config, job);
    } catch {
      throw new KnownZeroCostError("HARNESS_EVENT_BINDING_MISMATCH");
    }
    const result = await this.transport.execute({
      config: this.config,
      event: envelope,
      signal: context?.signal,
    });
    if (
      result.charge.state !== "verified" ||
      !result.charge.evidenceId ||
      !Number.isSafeInteger(result.charge.costMicros) ||
      result.charge.costMicros < 0
    )
      throw Error("HARNESS_COST_UNKNOWN");
    const decision = NativeDecisionSchema.safeParse(result.decision);
    if (!decision.success)
      throw new ObservedCostError(
        "HARNESS_INVALID_DECISION",
        result.charge.costMicros,
        result.charge.evidenceId,
      );
    // Preparation can exercise private memory and appointments with synthetic jobs.
    // All external actions are held even if a transport attempts to return one.
    if (
      decision.data.actions.some(
        (a) => !["remember", "schedule", "cancel"].includes(a.type),
      )
    )
      throw new ObservedCostError(
        "HARNESS_EXTERNAL_ACTIONS_HELD",
        result.charge.costMicros,
        result.charge.evidenceId,
      );
    return {
      ...decision.data,
      costMicros: result.charge.costMicros,
      costEvidenceId: result.charge.evidenceId,
    };
  }
}
