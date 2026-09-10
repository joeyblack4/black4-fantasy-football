import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "api";
const flags = new Set(process.argv.slice(3));
const knownFlags = new Set([
  "--allow-paid-inference",
  "--allow-buzz-reads",
  "--allow-buzz-sends",
  "--allow-public-publishing",
  "--allow-billing-reconciliation",
  "--once",
  "--repeat",
  "--print-plan",
  "--keep-awake",
]);
if ([...flags].some((flag) => !knownFlags.has(flag)))
  throw new Error(
    "Unsupported supervisor flag; arbitrary child arguments are not allowed",
  );
const services = {
  api: { script: "src/server.ts", args: [], once: false },
  clock: { script: "scripts/league-clock.ts", args: [], once: true },
  synthetic: { script: "scripts/worker.ts", args: ["--synthetic"], once: true },
  live: {
    script: "scripts/live-worker.ts",
    args: ["--live"],
    once: true,
    permission: "--allow-paid-inference",
  },
  conversation: {
    script: "scripts/live-worker.ts",
    args: ["--live", "--conversation"],
    once: true,
    permission: "--allow-paid-inference",
  },
  "buzz-conversation-listener": {
    script: "scripts/buzz-conversation-listener.ts",
    args: ["--execute"],
    once: true,
    permission: "--allow-buzz-reads",
  },
  "buzz-listener": {
    script: "scripts/buzz-listener.ts",
    args: ["--execute-listener"],
    once: true,
    permission: "--allow-buzz-reads",
  },
  "buzz-managed-listener": {
    script: "scripts/buzz-managed-listener.ts",
    args: ["--execute"],
    once: true,
    permission: "--allow-buzz-reads",
  },
  "buzz-outbound": {
    script: "scripts/buzz-outbound.ts",
    args: ["--execute-outbound"],
    once: true,
    permission: "--allow-buzz-sends",
  },
  "public-projector": {
    script: "scripts/public-projector.ts",
    args: [],
    once: true,
  },
  "public-feed": { script: "scripts/public-feed.ts", args: [], once: false },
  "billing-reconcile": {
    script: "scripts/reconcile-billing.ts",
    args: ["--apply-metadata-reconciliation"],
    once: true,
    permission: "--allow-billing-reconciliation",
    oneShot: true,
  },
  "x-publisher": {
    script: "scripts/x-publisher.ts",
    args: [],
    once: true,
    permission: "--allow-public-publishing",
  },
};
if (!Object.hasOwn(services, mode)) throw new Error("Unknown service mode");
const service = services[mode];
const configPath = process.env.FOOTBALL_SUPERVISOR_CONFIG;
const config = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
if (
  !config ||
  typeof config !== "object" ||
  Array.isArray(config) ||
  Object.keys(config).some(
    (k) =>
      ![
        "environment",
        "secretFiles",
        "serviceConfig",
        "repeatIntervalMs",
      ].includes(k),
  )
)
  throw new Error("Invalid supervisor config structure");
const publicKeys = new Set([
  "HOST",
  "PORT",
  "DATABASE_URL_FILE",
  "FOOTBALL_LEAGUE_ID",
  "FOOTBALL_MANIFEST_ID",
  "FOOTBALL_TARIFF_FILE",
  "FOOTBALL_TURN_RESERVATION_MICROS",
  "FOOTBALL_MAX_OUTPUT_TOKENS",
  "FOOTBALL_REASONING_EFFORT",
  "FOOTBALL_HARNESS_PATCH_RECEIPT",
  "FOOTBALL_CONVERSATION_SESSION_ID",
  "FOOTBALL_CONVERSATION_LISTENER_AGENT_ID",
  "FOOTBALL_FIRECRAWL_CONFIG_FILE",
  "FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED",
  "FOOTBALL_MFL_CONFIG_FILE",
  "MFL_SESSION_FILE",
  "FOOTBALL_PUBLIC_PORT",
  "FOOTBALL_X_PUBLISHING_ENABLED",
  "B4_LEAGUE_BUZZ_EXECUTABLE",
]);
// Pass ordinary OS settings plus reviewed service settings. Do not inherit customer credentials, NODE_OPTIONS or management keys.
const env = {};
for (const key of [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "SYSTEMROOT",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  ...publicKeys,
])
  if (process.env[key] !== undefined) env[key] = process.env[key];
if (
  config.environment &&
  (typeof config.environment !== "object" || Array.isArray(config.environment))
)
  throw new Error("environment must be an object");
for (const [key, value] of Object.entries(config.environment ?? {})) {
  if (!publicKeys.has(key) || typeof value !== "string")
    throw new Error(
      "Only reviewed non-secret environment settings are allowed",
    );
  env[key] = value;
}
if (
  config.secretFiles &&
  (typeof config.secretFiles !== "object" || Array.isArray(config.secretFiles))
)
  throw new Error("secretFiles must be an object");
const secretFiles = config.secretFiles ?? {};
for (const [key, file] of Object.entries(secretFiles)) {
  if (
    !/^(B4_LEAGUE_[A-Z0-9_]+|DATABASE_URL|FOOTBALL_PUBLIC_DATABASE_URL|FOOTBALL_X_USER_ACCESS_TOKEN)$/.test(
      key,
    ) ||
    key.includes("MANAGEMENT") ||
    typeof file !== "string" ||
    !isAbsolute(file)
  )
    throw new Error(
      "Only dedicated secret keys and absolute raw secret-file paths are allowed",
    );
}
if (mode === "public-feed") {
  if (
    Object.keys(secretFiles).some(
      (key) => key !== "FOOTBALL_PUBLIC_DATABASE_URL",
    )
  )
    throw new Error(
      "Public feed accepts only its SELECT-only public database secret",
    );
  delete env.DATABASE_URL_FILE;
} else if (Object.hasOwn(secretFiles, "FOOTBALL_PUBLIC_DATABASE_URL"))
  throw new Error(
    "Public database credential is reserved for public-feed mode",
  );
if (
  mode !== "x-publisher" &&
  Object.hasOwn(secretFiles, "FOOTBALL_X_USER_ACCESS_TOKEN")
)
  throw new Error("X token is reserved for x-publisher mode");
if (secretFiles.DATABASE_URL) delete env.DATABASE_URL_FILE;
const serviceSecretKeys =
  mode === "public-feed"
    ? ["FOOTBALL_PUBLIC_DATABASE_URL"]
    : mode === "x-publisher"
      ? ["DATABASE_URL", "FOOTBALL_X_USER_ACCESS_TOKEN"]
      : ["DATABASE_URL"];
if (
  !["live", "conversation", "billing-reconcile", "buzz-listener"].includes(
    mode,
  ) &&
  Object.keys(secretFiles).some((key) => !serviceSecretKeys.includes(key))
)
  throw new Error("Secret reference is outside this service scope");
const args = [service.script, ...service.args];
if (mode === "buzz-listener") {
  if (
    typeof config.serviceConfig !== "string" ||
    !isAbsolute(config.serviceConfig)
  )
    throw new Error("buzz-listener requires an absolute serviceConfig path");
  args.push("--config", config.serviceConfig);
} else if (config.serviceConfig !== undefined)
  throw new Error("serviceConfig is only used by buzz-listener");
if (
  [
    "buzz-outbound",
    "buzz-managed-listener",
    "buzz-conversation-listener",
  ].includes(mode)
) {
  if (
    !env.FOOTBALL_LEAGUE_ID ||
    !env.B4_LEAGUE_BUZZ_EXECUTABLE ||
    !isAbsolute(env.B4_LEAGUE_BUZZ_EXECUTABLE)
  )
    throw new Error(
      "buzz-outbound requires a league and absolute Buzz executable",
    );
  args.push("--league", env.FOOTBALL_LEAGUE_ID);
}
if (["conversation", "buzz-conversation-listener"].includes(mode)) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      env.FOOTBALL_CONVERSATION_SESSION_ID ?? "",
    )
  )
    throw new Error("Explicit conversation session UUID required");
  if (
    mode === "conversation" &&
    env.FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED !== "true"
  )
    throw new Error("Conversation requires its scoped Buzz reply transport");
  if (mode === "buzz-conversation-listener") {
    if (
      !/^b4-[a-z0-9-]{1,100}$/.test(
        env.FOOTBALL_CONVERSATION_LISTENER_AGENT_ID ?? "",
      )
    )
      throw new Error("Exact managed conversation listener identity required");
    args.push(
      "--session",
      env.FOOTBALL_CONVERSATION_SESSION_ID,
      "--agent",
      env.FOOTBALL_CONVERSATION_LISTENER_AGENT_ID,
    );
  }
} else if (
  env.FOOTBALL_CONVERSATION_SESSION_ID ||
  env.FOOTBALL_CONVERSATION_LISTENER_AGENT_ID
)
  throw new Error(
    "Conversation settings require a dedicated conversation service",
  );
if (!["api", "synthetic"].includes(mode) && !env.FOOTBALL_LEAGUE_ID)
  throw new Error("Explicit league binding required");
if (
  ["live", "conversation", "billing-reconcile"].includes(mode) &&
  !env.FOOTBALL_MANIFEST_ID
)
  throw new Error("Exact manifest ID required");
if (mode === "public-feed" && !secretFiles.FOOTBALL_PUBLIC_DATABASE_URL)
  throw new Error("SELECT-only public DB secret file required");
if (
  mode !== "public-feed" &&
  !secretFiles.DATABASE_URL &&
  !env.DATABASE_URL_FILE
)
  throw new Error(
    "Explicit private database secret file required; no development fallback",
  );
if (flags.has("--once") && !service.once)
  throw new Error("This server mode does not support --once");
if (flags.has("--repeat") && !service.oneShot)
  throw new Error("--repeat only applies to billing-reconcile");
if (flags.has("--repeat") && flags.has("--once"))
  throw new Error("--repeat and --once are mutually exclusive");
if (config.repeatIntervalMs !== undefined && !flags.has("--repeat"))
  throw new Error("repeatIntervalMs requires explicit --repeat");
const repeat = flags.has("--repeat");
const interval = config.repeatIntervalMs;
if (
  repeat &&
  (!Number.isSafeInteger(interval) || interval < 60000 || interval > 86400000)
)
  throw new Error(
    "Billing repeat interval must be explicit and between one minute and one day",
  );
if (flags.has("--once") && !service.oneShot) args.push("--once");
const oneShot = flags.has("--once") || (service.oneShot && !repeat);
const buzzSendPermissionMissing =
  ["live", "conversation"].includes(mode) &&
  env.FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED === "true" &&
  !flags.has("--allow-buzz-sends");
const permissionMissing =
  (service.permission && !flags.has(service.permission)) ||
  buzzSendPermissionMissing;
if (flags.has("--print-plan")) {
  console.log(
    JSON.stringify(
      {
        mode,
        child: [process.execPath, "--import", "tsx", ...args],
        restartPolicy: repeat
          ? { type: "explicit-periodic", intervalMs: interval }
          : oneShot
            ? { type: "one-shot-no-retry" }
            : { type: "continuous-exit-restart", maximumDelayMs: 60000 },
        requiredFlag: service.permission ?? null,
        buzzSendFlagRequired:
          ["live", "conversation"].includes(mode) &&
          env.FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED === "true",
        requiredFlagPresent: !permissionMissing,
        environmentKeys: Object.keys(env).sort(),
        secretReferences: Object.keys(secretFiles).sort(),
        secretValuesRead: false,
        started: false,
        configurationCallable: "not verified",
        xBatchApprovalStillRequired: mode === "x-publisher",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (buzzSendPermissionMissing)
  throw new Error(
    "Native league channel sends require explicit --allow-buzz-sends",
  );
if (permissionMissing)
  throw new Error(`Service requires explicit ${service.permission}`);
if (
  mode === "x-publisher" &&
  (env.FOOTBALL_X_PUBLISHING_ENABLED !== "true" ||
    !secretFiles.FOOTBALL_X_USER_ACCESS_TOKEN)
)
  throw new Error(
    "X requires both explicit enabled setting and its scoped OAuth2 user secret; exact batch approval is still enforced downstream",
  );
if (mode === "buzz-listener") {
  const listener = JSON.parse(await readFile(config.serviceConfig, "utf8"));
  if (listener.leagueId !== env.FOOTBALL_LEAGUE_ID)
    throw new Error(
      "Listener service config league differs from supervisor scope",
    );
  const keys = [
    "DATABASE_URL",
    listener.keyEnvironmentVariable,
    listener.authTagEnvironmentVariable,
  ].filter(Boolean);
  if (
    !secretFiles[listener.keyEnvironmentVariable] ||
    (listener.authTagEnvironmentVariable &&
      !secretFiles[listener.authTagEnvironmentVariable]) ||
    Object.keys(secretFiles).some((key) => !keys.includes(key))
  )
    throw new Error(
      "Listener requires only its exact configured signing/auth secret references",
    );
}
for (const [key, file] of Object.entries(secretFiles))
  env[key] = (await readFile(file, "utf8")).trim();
if (env.DATABASE_URL_FILE)
  env.DATABASE_URL = (
    await readFile(resolve(env.DATABASE_URL_FILE), "utf8")
  ).trim();
let stopping = false,
  child,
  timer,
  attempt = 0,
  caffeine;
if (process.platform === "darwin" && flags.has("--keep-awake")) {
  // Existing scoped idle-sleep assertion only. No global setting or lid-sleep change.
  caffeine = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
    stdio: "ignore",
  });
}
function start() {
  if (stopping) return;
  const started = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  child.once("error", () => {
    console.error("Supervisor child could not start");
  });
  child.once("close", (code, signal) => {
    if (stopping) return;
    if (oneShot) {
      caffeine?.kill("SIGTERM");
      process.exitCode = code ?? 1;
      return;
    }
    attempt = Date.now() - started > 60000 ? 0 : attempt + 1;
    const delay = repeat
      ? interval
      : Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
    console.error(
      JSON.stringify({
        type: repeat ? "supervisor.next_billing_run" : "supervisor.restart",
        mode,
        exitCode: code,
        signal,
        delayMs: delay,
      }),
    );
    timer = setTimeout(start, delay);
  });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    child?.kill(signal);
    caffeine?.kill("SIGTERM");
    const forced = setTimeout(() => child?.kill("SIGKILL"), 200000);
    forced.unref();
  });
start();
