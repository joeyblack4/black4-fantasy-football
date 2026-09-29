import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Franchise-local native state; never reuse the retired Goose PAYG key. */
export function prepareMuseEnvironment(root, state, model, env) {
  const runtime = JSON.parse(
    readFileSync(join(root, "config/muse-runtime.json"), "utf8"),
  );
  for (const [key, directory] of [
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_DATA_HOME", "data"],
    ["XDG_STATE_HOME", "state"],
  ]) {
    env[key] = join(state, "muse", directory);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  const config = join(env.XDG_CONFIG_HOME, "muse");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const file = join(config, "settings.json");
  const settings = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  writeFileSync(
    file,
    JSON.stringify(
      { schema_version: 1, ...settings, provider: "meta", model },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  env.MUSE_AUTH_PATH = join(config, "auth.json");
  env.MUSE_CODE_EXECUTABLE = join(root, "scripts/muse-native");
  env.B4_MUSE_BINARY = join(root, runtime.binary);
  env.MUSE_CODE_ACP_BACKEND = runtime.backend;
  env.MUSE_CODE_ACP_ALLOW_YOLO = "1";
  for (const key of [
    "META_API_KEY",
    "META_MODEL_API_KEY",
    "MUSE_CODE_ACP_GATEWAY_URL",
    "MUSE_CODE_ACP_GATEWAY_KEY",
  ])
    delete env[key];
}
