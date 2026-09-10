import { resolve } from "node:path";
import { RuntimeConfigSchema, type RuntimeConfig } from "./catalog.js";
import { NativeDecisionSchema, CANARY_OUTPUT_SCHEMA } from "./protocol.js";

const decisionSchema = JSON.stringify(CANARY_OUTPUT_SCHEMA);

/** Source-informed native CLI argument plans. These are not shell strings and
 * never spawn processes. Read-only canaries must precede full-workspace admission.
 * A process supervisor must supply isolated state, egress and billable identity.
 */
export function nativeCanaryPlan(input: RuntimeConfig, directory: string) {
  const config = RuntimeConfigSchema.parse(input);
  if (!config.providerModel || !config.harnessVersion)
    throw Error("HARNESS_MODEL_AND_VERSION_PIN_REQUIRED");
  const workspace = resolve(directory);
  const model = config.providerModel;
  let executable: string,
    args: string[],
    inputMode: "prompt-stdin" | "prompt-file-key-stdin";
  switch (config.harnessId) {
    case "codex":
      executable = "codex";
      args = [
        "exec",
        "--json",
        "--model",
        model,
        "--cd",
        workspace,
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--output-schema",
        resolve(workspace, "canary.schema.json"),
        "-",
      ];
      inputMode = "prompt-stdin";
      break;
    case "claude-code":
      executable = "claude";
      args = [
        "--print",
        "--model",
        model,
        "--output-format",
        "json",
        "--json-schema",
        decisionSchema,
        "--restricted",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ];
      inputMode = "prompt-stdin";
      break;
    case "muse-code":
      executable = "muse";
      args = [
        "exec",
        "--json",
        "--provider",
        "meta",
        "--model",
        model,
        "--workspace",
        workspace,
        "--prompt-file",
        resolve(workspace, "canary-prompt.txt"),
        "--api-key-stdin",
        "--no-foreign-personal-context",
        "--disable-shell",
        "--disable-write",
        "--disable-web-tools",
        "--approval-judge",
        "off",
        "--max-model-steps",
        "1",
      ];
      inputMode = "prompt-file-key-stdin";
      break;
    default:
      throw Error(
        "HARNESS_LAUNCH_ADAPTER_NOT_IMPLEMENTED: " + config.harnessId,
      );
  }
  return {
    executable,
    args,
    cwd: workspace,
    inputMode,
    credentialRef: config.credentialRef,
    nativeVersion: config.harnessVersion,
    providerModel: model,
    launchable: false as const,
    productionActions: false as const,
    pending: [
      "verify installed binary version and argument contract",
      "verified native model mapping",
      "isolated process and state",
      "hard spend broker",
      "scoped credential",
    ],
  };
}

/** Native event decoding does not pretend a CLI usage estimate is a settled charge. */
export function parseCodexOutput(output: string) {
  if (Buffer.byteLength(output) > 4_194_304)
    throw Error("HARNESS_OUTPUT_TOO_LARGE");
  const events = output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  if (events.some((event) => ["turn.failed", "error"].includes(event.type)))
    throw Error("HARNESS_TURN_FAILED");
  const completed = events.filter((event) => event.type === "turn.completed");
  const final = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "agent_message",
    )
    .at(-1);
  if (
    completed.length !== 1 ||
    events.at(-1) !== completed[0] ||
    !final ||
    typeof final.item.text !== "string"
  )
    throw Error("HARNESS_INCOMPLETE_OUTPUT");
  return {
    decision: NativeDecisionSchema.parse(JSON.parse(final.item.text)),
    reportedUsage: completed[0].usage ?? null,
    charge: { state: "unknown" as const },
  };
}

export function parseClaudeOutput(output: string) {
  if (Buffer.byteLength(output) > 4_194_304)
    throw Error("HARNESS_OUTPUT_TOO_LARGE");
  const event = JSON.parse(output);
  if (
    event.type !== "result" ||
    event.is_error !== false ||
    event.subtype !== "success"
  )
    throw Error("HARNESS_TURN_FAILED");
  return {
    decision: NativeDecisionSchema.parse(
      event.structured_output ?? JSON.parse(event.result),
    ),
    reportedUsage: event.usage ?? null,
    reportedCostUsd: event.total_cost_usd ?? null,
    charge: { state: "unknown" as const },
  };
}
