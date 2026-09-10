import { z } from "zod";

export const OwnerMemoryReadbackSchema = z
  .object({
    key: z.literal("owner/memory-probe"),
    value: z.string().min(1),
    sourceVersion: z.number().int().positive(),
    usedFor: z.string().min(10).max(2000).optional(),
  })
  .strict();

/** Exact JSON only: never strip prefixes, unwrap code fences, or guess intent. */
export function validateStructuredOwnerMemory(key: string, content: string) {
  if (key !== "owner_capability_needs_v1" && key !== "owner/memory-readback")
    return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OWNER_STAGE_STRUCTURED_MEMORY_JSON_REQUIRED");
  }
  if (key === "owner_capability_needs_v1") {
    if (!parsed || typeof parsed !== "object")
      throw new Error("OWNER_STAGE_CAPABILITY_NEEDS_JSON_REQUIRED");
    return { kind: "capability-needs" as const, needs: parsed };
  }
  return {
    kind: "readback" as const,
    proof: OwnerMemoryReadbackSchema.parse(parsed),
  };
}
