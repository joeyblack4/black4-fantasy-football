import { z } from "zod";

export const HarnessIdSchema = z.enum([
  "codex",
  "claude-code",
  "gemini-cli",
  "grok-build",
  "muse-code",
  "deepseek-harness",
  "qwen-code",
  "mistral-vibe",
  "kimi-code",
  "zcode",
  "opencode",
  "goose",
  "ogx",
  "minimax-code",
]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;
export const DeveloperSchema = z.enum([
  "OpenAI",
  "Anthropic",
  "Google",
  "xAI",
  "Meta",
  "DeepSeek",
  "Qwen",
  "Mistral",
  "Moonshot/Kimi",
  "Z.ai",
  "MiniMax",
]);
export type Developer = z.infer<typeof DeveloperSchema>;

/** Research-backed preferences, NOT a claim of installed or authenticated access. */
export const companyHarnesses: Record<
  Developer,
  {
    primary: HarnessId;
    relationship: "first-party" | "officially-supported-external";
    /** Null when native auth is configured or passed via stdin, not a proven env binding. */
    credentialVariable: string | null;
    source: string;
  }
> = {
  MiniMax: {
    primary: "minimax-code",
    relationship: "first-party",
    credentialVariable: "MCODE_PROVIDER_API_KEY",
    source: "https://agent.minimax.io/docs/cli/features",
  },
  OpenAI: {
    primary: "codex",
    relationship: "first-party",
    credentialVariable: "CODEX_API_KEY",
    source: "https://developers.openai.com/codex/noninteractive/",
  },
  Anthropic: {
    primary: "claude-code",
    relationship: "first-party",
    credentialVariable: "ANTHROPIC_API_KEY",
    source: "https://code.claude.com/docs/en/headless",
  },
  Google: {
    primary: "gemini-cli",
    relationship: "first-party",
    credentialVariable: "GEMINI_API_KEY",
    source: "https://geminicli.com/docs/get-started/authentication/",
  },
  xAI: {
    primary: "grok-build",
    relationship: "first-party",
    credentialVariable: "XAI_API_KEY",
    source: "https://docs.x.ai/build/cli/headless-scripting",
  },
  Meta: {
    primary: "muse-code",
    relationship: "first-party",
    credentialVariable: null,
    source: "https://github.com/meta-models/muse-code-sdk",
  },
  DeepSeek: {
    primary: "deepseek-harness",
    relationship: "first-party",
    credentialVariable: "DEEPSEEK_API_KEY",
    source: "https://github.com/deepseek-ai/deepseek-harness",
  },
  Qwen: {
    primary: "qwen-code",
    relationship: "first-party",
    credentialVariable: "DASHSCOPE_API_KEY",
    source:
      "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
  },
  Mistral: {
    primary: "mistral-vibe",
    relationship: "first-party",
    credentialVariable: "MISTRAL_API_KEY",
    source: "https://docs.mistral.ai/vibe/code/cli/api-keys-profiles",
  },
  "Moonshot/Kimi": {
    primary: "kimi-code",
    relationship: "first-party",
    credentialVariable: null,
    source: "https://moonshotai.github.io/kimi-code/en/configuration/providers",
  },
  "Z.ai": {
    primary: "zcode",
    relationship: "first-party",
    credentialVariable: null,
    source: "https://zcode.z.ai/en",
  },
};

/** Joey's Buzz-first lineup. Keep company-native research separate from the
 * competition's selected harness; an exception is not a vendor endorsement.
 */
export const LEAGUE_HARNESS_PROFILE = "buzz-compatible-v3";
export function leagueHarnessSelection(developer: Developer): {
  harnessId: HarnessId;
  exceptionReason: string | null;
} {
  if (developer === "DeepSeek")
    return {
      harnessId: "goose",
      exceptionReason:
        "Joey requested the final simplest Buzz-compatible lineup on September 8, 2026. Retain the assigned DeepSeek model on Goose; defer DeepSeek Harness because its developer preview explicitly anticipates breaking compatibility changes. Exact model access remains unverified.",
    };
  if (developer === "Z.ai")
    return {
      harnessId: "opencode",
      exceptionReason:
        "Joey approved GLM + OpenCode to diversify open-source harnesses within the shared Buzz ACP interface on September 8, 2026. Preserve the assigned GLM model; native ZCode integration is deferred. Exact model access remains unverified.",
    };
  if (developer === "Meta")
    return {
      harnessId: "goose",
      exceptionReason:
        "Joey authorized Buzz-compatible model + Goose franchises on September 8, 2026. Retain the assigned Meta model; avoid a custom Muse MSP bridge and evaluate Goose cognition. Exact model access remains unverified.",
    };
  return {
    harnessId: companyHarnesses[developer].primary,
    exceptionReason: null,
  };
}

export const safeSegment = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
export const RuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    leagueId: safeSegment,
    agentId: safeSegment,
    teamId: safeSegment,
    developer: DeveloperSchema,
    /** Existing competition identity; never derive a native model by splitting this string. */
    assignedModel: z.string().min(1).max(200),
    canonicalModel: z.string().min(1).max(200),
    harnessId: HarnessIdSchema,
    harnessVersion: z.string().min(1).max(100).nullable(),
    /** Exact provider-native identifier, separately verified before any invocation. */
    providerModel: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
      .nullable(),
    credentialRef: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    status: z.literal("staged"),
    productionActions: z.literal(false),
    exceptionReason: z.string().min(20).max(2000).nullable(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      companyHarnesses[config.developer].primary !== config.harnessId &&
      !config.exceptionReason
    )
      context.addIssue({
        code: "custom",
        message:
          "Non-primary harness requires a documented company-specific exception",
      });
  });
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function setupBlockers(config: RuntimeConfig): string[] {
  return [
    ...(!config.harnessVersion ? ["PINNED_HARNESS_VERSION_REQUIRED"] : []),
    ...(!config.providerModel ? ["EXACT_NATIVE_MODEL_MAPPING_REQUIRED"] : []),
    ...(config.harnessId === "zcode"
      ? ["ZCODE_SUPPORTED_HEADLESS_CONTRACT_REQUIRED"]
      : []),
    "FRANCHISE_SCOPED_AUTH_NOT_VERIFIED",
    "EXTERNAL_WORKSPACE_AND_EGRESS_ISOLATION_NOT_VERIFIED",
    "HARD_SPEND_ENFORCEMENT_AND_PROVIDER_RECONCILIATION_REQUIRED",
    "NATIVE_IDENTITY_TOOL_AND_RECOVERY_CANARY_REQUIRED",
    "PRODUCTION_ACTIONS_HELD",
  ];
}
