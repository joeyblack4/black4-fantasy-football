import {
  GovernanceActionSchema,
  BuzzChannelActionSchema,
  BrandActionSchema,
  ServiceRequestActionSchema,
  PublicDraftActionSchema,
} from "../franchise/schema.js";
import { FootballActionSchema } from "./football-schema.js";
import { z } from "zod";
import {
  RuntimeError,
  RuntimeStore,
  type AgentDriver,
  type DriverResult,
  type Job,
} from "./index.js";
export const ScheduleSchema = z
  .object({
    causalId: z.string().min(1).max(200),
    dueAt: z.iso.datetime({ offset: true }),
    priority: z.enum(["normal", "background"]).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export const MessageSchema = z
  .object({
    causalId: z.string().min(1).max(200),
    recipientId: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
    conversationId: z.uuid().optional(),
    replyTo: z.uuid().optional(),
  })
  .strict();
export const StaffActionSchema = z
  .object({
    type: z.literal("remember"),
    key: z.string().min(1).max(100),
    content: z.string().min(1).max(8000),
  })
  .strict();
export const StaffDecisionSchema = z
  .object({
    actions: z.array(StaffActionSchema).max(10),
    summary: z.string().max(8000),
  })
  .strict();
export const StaffDriverResultSchema = StaffDecisionSchema.extend({
  costMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const ActionSchema = z.discriminatedUnion("type", [
  BuzzChannelActionSchema,
  FootballActionSchema,
  GovernanceActionSchema,
  BrandActionSchema,
  ServiceRequestActionSchema,
  PublicDraftActionSchema,
  z
    .object({
      type: z.literal("delegate"),
      causalId: z.string().min(1).max(200),
      role: z.string().min(1).max(80),
      task: z.string().min(1).max(12000),
    })
    .strict(),
  z
    .object({ type: z.literal("cancel"), causalId: z.string().min(1).max(200) })
    .strict(),
  ScheduleSchema.extend({ type: z.literal("schedule") }),
  MessageSchema.extend({ type: z.literal("message") }),
  StaffActionSchema,
]);
export const DriverResultSchema = z
  .object({
    actions: z.array(ActionSchema).max(10),
    costMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    summary: z.string().max(8000),
  })
  .strict();
export class KnownZeroCostError extends Error {}
/** A network timeout may be retried, but its previous reservation remains held. */
export class RetryableUnknownCostError extends Error {}
/** Provider responded with a known charge but its content failed validation. */
export class ObservedCostError extends Error {
  constructor(
    message: string,
    readonly costMicros: number,
    readonly generationId?: string,
  ) {
    super(message);
  }
}
export type RunResult =
  | { status: "idle" }
  | { status: "completed" | "failed" | "stale"; jobId: string; error?: string };

/** Executes one durable turn. The supervisor may loop this; multiple workers safely compete. */
export async function runOne(
  store: RuntimeStore,
  driver: AgentDriver,
  workerId: string,
  options: {
    leaseMs?: number;
    maxCostMicros?: number;
    heartbeat?: boolean;
    allowedAgentIds?: string[];
    onlyCanaryJobId?: string;
  } = {},
): Promise<RunResult> {
  const leaseMs = options.leaseMs ?? 30000;
  const job = await store.claim(
    workerId,
    leaseMs,
    driver.model,
    options.allowedAgentIds,
    options.onlyCanaryJobId,
  );
  if (!job) return { status: "idle" };
  let reservationId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lostLease = false;
  let heartbeatBusy = false;
  let invoked = false;
  let started = 0;
  let returned = false;
  let observedCostMicros: number | undefined;
  try {
    if (driver.model !== job.model)
      throw new KnownZeroCostError("MODEL_PIN_VIOLATION");
    if (!driver.synthetic) await store.requireLiveBinding(job.agentId);
    reservationId = await store.reserve(job, options.maxCostMicros ?? 0);
    if (options.heartbeat !== false)
      timer = setInterval(
        () => {
          if (heartbeatBusy) return;
          heartbeatBusy = true;
          void store
            .heartbeat(job, leaseMs)
            .catch(() => {
              lostLease = true;
            })
            .finally(() => {
              heartbeatBusy = false;
            });
        },
        Math.max(5, Math.floor(leaseMs / 3)),
      );
    invoked = true;
    started = performance.now();
    const raw = await driver.run(job);
    returned = true;
    await store.recordExecution(job, {
      driver: driver.name,
      synthetic: driver.synthetic,
      durationMs: performance.now() - started,
      outcome: "returned",
    });
    if (Number.isSafeInteger(raw?.costMicros) && raw.costMicros >= 0) {
      observedCostMicros = raw.costMicros;
      await store.observeCost(job, reservationId, raw.costMicros);
      if (raw.costMicros > (options.maxCostMicros ?? 0)) {
        await store.settleOverrun(job, reservationId, raw.costMicros);
        return {
          status: "failed",
          jobId: job.id,
          error: "COST_OVERRUN: observed spend recorded; agent frozen",
        };
      }
    }
    const result =
      job.kind === "staff"
        ? StaffDriverResultSchema.parse(raw)
        : DriverResultSchema.parse(raw);
    if (lostLease) throw new RuntimeError("STALE_CLAIM");
    await store.complete(job, {
      ...result,
      reservationId,
      driver: driver.name,
      synthetic: driver.synthetic,
    });
    return { status: "completed", jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (invoked && !returned)
      await store.recordExecution(job, {
        driver: driver.name,
        synthetic: driver.synthetic,
        durationMs: performance.now() - started,
        outcome: "threw",
      });
    if (error instanceof ObservedCostError && reservationId) {
      observedCostMicros = error.costMicros;
      await store.observeCost(
        job,
        reservationId,
        observedCostMicros,
        error.generationId,
      );
      if (observedCostMicros > (options.maxCostMicros ?? 0)) {
        try {
          await store.settleOverrun(job, reservationId, observedCostMicros);
        } catch (failure) {
          if (failure instanceof RuntimeError && failure.code === "STALE_CLAIM")
            return { status: "stale", jobId: job.id, error: message };
          throw failure;
        }
        return {
          status: "failed",
          jobId: job.id,
          error: "COST_OVERRUN: observed spend recorded; agent frozen",
        };
      }
    }
    if (error instanceof RuntimeError && error.code === "STALE_CLAIM")
      return { status: "stale", jobId: job.id, error: message };
    try {
      await store.fail(job, message, {
        retryable:
          error instanceof KnownZeroCostError ||
          error instanceof RetryableUnknownCostError,
        chargeKnownZero: !invoked || error instanceof KnownZeroCostError,
        reservationId,
        observedCostMicros,
      });
    } catch (failure) {
      if (failure instanceof RuntimeError && failure.code === "STALE_CLAIM")
        return { status: "stale", jobId: job.id, error: message };
      throw failure;
    }
    return { status: "failed", jobId: job.id, error: message };
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** Deterministic synthetic adapter, deliberately incapable of calling a language model. */
export class TestDriver implements AgentDriver {
  readonly name = "DETERMINISTIC_TEST_DRIVER";
  readonly synthetic = true;
  constructor(
    readonly model: string,
    private readonly respond: (
      job: Job,
    ) => DriverResult | Promise<DriverResult> = (job) => ({
      actions: [],
      costMicros: 0,
      summary: `Synthetic fixture handled ${job.kind}; no language model called.`,
    }),
  ) {}
  async run(job: Job) {
    return this.respond(job);
  }
}
