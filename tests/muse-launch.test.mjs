import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareMuseEnvironment } from "../scripts/muse-environment.mjs";

test("Muse keeps native memory and settings while excluding PAYG credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-isolation-"));
  try {
    mkdirSync(join(dir, "config"));
    writeFileSync(
      join(dir, "config/muse-runtime.json"),
      JSON.stringify({ binary: "native/muse", backend: "exec" }),
    );
    const state = join(dir, "owner");
    const env = {
      META_API_KEY: "unrelated-key",
      META_MODEL_API_KEY: "retired-key",
      MUSE_CODE_ACP_GATEWAY_KEY: "gateway-key",
      MUSE_AUTH_PATH: "/other-owner/auth.json",
    };
    prepareMuseEnvironment(dir, state, "muse-spark-1.3", env);
    const settings = join(env.XDG_CONFIG_HOME, "muse/settings.json");
    const auth = env.MUSE_AUTH_PATH;
    writeFileSync(auth, "franchise-auth-fixture");
    writeFileSync(
      join(env.XDG_DATA_HOME, "memory.txt"),
      "existing native memory",
    );
    writeFileSync(
      settings,
      JSON.stringify({
        model: "old-default",
        theme: "custom",
        mcp_servers: { own: { transport: "stdio" } },
      }),
    );
    prepareMuseEnvironment(dir, state, "muse-spark-1.3", env);
    assert.equal(env.META_API_KEY, undefined);
    assert.equal(env.META_MODEL_API_KEY, undefined);
    assert.equal(env.MUSE_CODE_ACP_GATEWAY_KEY, undefined);
    assert.equal(readFileSync(auth, "utf8"), "franchise-auth-fixture");
    assert.equal(
      readFileSync(join(env.XDG_DATA_HOME, "memory.txt"), "utf8"),
      "existing native memory",
    );
    assert.deepEqual(JSON.parse(readFileSync(settings)), {
      schema_version: 1,
      model: "muse-spark-1.3",
      theme: "custom",
      mcp_servers: { own: { transport: "stdio" } },
      provider: "meta",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native launcher preserves argument boundaries and only changes execution posture", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-launch-"));
  try {
    const fake = join(dir, "fake-muse");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const launch = (args) =>
      spawnSync(resolve("scripts/muse-native"), args, {
        env: { ...process.env, B4_MUSE_BINARY: fake },
        encoding: "utf8",
      });
    const prompt = "One literal prompt; $(do-not-execute) with spaces";
    assert.equal(
      launch(["exec", "--session-id", "same-session", prompt]).stdout,
      [
        "exec",
        "--yolo",
        "--no-foreign-personal-context",
        "--session-id",
        "same-session",
        prompt,
        "",
      ].join("\n"),
    );
    assert.equal(launch(["login"]).stdout, "login\n");
    assert.equal(
      launch(["export", "--session", "same-session"]).stdout,
      "export\n--session\nsame-session\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
