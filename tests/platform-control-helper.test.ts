import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const relay = "wss://black4fantasysports.communities.buzz.xyz";
const config = JSON.parse(
  readFileSync(join(root, "config/platform-control-helper.json"), "utf8"),
);
const syntheticKey = "1".padStart(64, "0");
const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "fantasy-platform-helper-"));
  dirs.push(path);
  mkdirSync(join(path, "scripts/vendor"), { recursive: true });
  mkdirSync(join(path, "config"));
  copyFileSync(
    join(root, "scripts/platform-control.mjs"),
    join(path, "scripts/platform-control.mjs"),
  );
  const helper =
    "console.log(JSON.stringify({args:process.argv.slice(2),envNames:Object.keys(process.env)}));";
  writeFileSync(join(path, "scripts/vendor/channel-agent-helper.mjs"), helper);
  writeFileSync(
    join(path, "config/platform-control-helper.json"),
    JSON.stringify({
      ...config,
      sha256: createHash("sha256").update(helper).digest("hex"),
    }),
  );
  return path;
}
function run(
  path: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync(
    process.execPath,
    [join(path, "scripts/platform-control.mjs"), ...args],
    {
      env: { BUZZ_PRIVATE_KEY: syntheticKey, BUZZ_RELAY_URL: relay, ...env },
      encoding: "utf8",
    },
  );
}

describe("Fantasy Platform Control courier", () => {
  it("pins the exact upstream bundle", () => {
    const bytes = readFileSync(
      join(root, "scripts/vendor/channel-agent-helper.mjs"),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      config.sha256,
    );
    expect(run(root, ["--check"]).status).toBe(0);
  });
  it("requires an explicit channel and the Fantasy Buzz identity; rejects inherited fallback keys", () => {
    const path = fixture();
    for (const [args, env] of [
      [["discover"], {}],
      [
        ["discover", "--channel", "room"],
        { BUZZ_PRIVATE_KEY: "", NOSTR_PRIVATE_KEY: syntheticKey },
      ],
      [
        ["discover", "--channel", "room"],
        { BUZZ_RELAY_URL: "wss://customer.invalid" },
      ],
      [["discover", "--channel", "one", "--channel", "two"], {}],
    ] as [string[], Record<string, string>][]) {
      const result = run(path, args, env);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(syntheticKey);
    }
  });
  it("fixes origin/community, forwards operation flags as data and removes unrelated secrets", () => {
    const path = fixture();
    const result = run(
      path,
      [
        "--channel",
        "open-room",
        "--connector",
        "github",
        "--arguments",
        '{"note":"--url"}',
      ],
      {
        PLATFORM_CONTROL_URL: "https://customer.invalid",
        NOSTR_PRIVATE_KEY: "foreign-key",
        ANTHROPIC_API_KEY: "provider-key",
        OPERATOR_TOKEN: "operator-key",
      },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.args).toEqual([
      "--channel",
      "open-room",
      "--connector",
      "github",
      "--arguments",
      '{"note":"--url"}',
      "--url",
      config.baseUrl,
      "--community",
      config.communityId,
    ]);
    expect(payload.envNames).toContain("BUZZ_PRIVATE_KEY");
    expect(payload.envNames).not.toEqual(
      expect.arrayContaining(["OPERATOR_TOKEN"]),
    );
    for (const name of [
      "PLATFORM_CONTROL_URL",
      "NOSTR_PRIVATE_KEY",
      "ANTHROPIC_API_KEY",
      "OPERATOR_TOKEN",
    ])
      expect(payload.envNames).not.toContain(name);
    for (const flag of ["--url", "--community"]) {
      expect(
        run(path, ["discover", "--channel", "room", flag, "other"]).status,
      ).toBe(1);
    }
  });
  it("preserves current upstream subcommands and social idempotency flags", () => {
    const path = fixture();
    for (const args of [
      ["social", "list", "--channel", "room"],
      ["warehouse", "describe", "example_table", "--channel", "room"],
      [
        "--connector",
        "x",
        "--method",
        "POST",
        "--endpoint",
        "/2/tweets",
        "--body",
        '{"text":"draft"}',
        "--idempotency-key",
        "stable-content-id",
        "--channel",
        "room",
      ],
    ]) {
      const result = run(path, args);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).args).toEqual([
        ...args,
        "--url",
        config.baseUrl,
        "--community",
        config.communityId,
      ]);
    }
  });
  it("refuses a modified bundle before execution", () => {
    const path = fixture();
    writeFileSync(
      join(path, "scripts/vendor/channel-agent-helper.mjs"),
      "console.log('unreviewed')",
    );
    const result = run(path, ["discover", "--channel", "room"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("checksum mismatch");
  });
  it("signs discovery with the exact channel, canonical community, URL and body digest", () => {
    // Preload only in this synthetic subprocess; fetch is replaced so no request leaves the test.
    const preload =
      "globalThis.fetch = async (url,options) => ({ok:true,text:async()=>JSON.stringify({url,body:options.body,authorization:options.headers.authorization})});";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        join(root, "scripts/vendor/channel-agent-helper.mjs"),
        "discover",
        "--url",
        "https://synthetic.invalid",
        "--community",
        config.communityId,
        "--channel",
        "open-room",
      ],
      { env: { BUZZ_PRIVATE_KEY: syntheticKey }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const event = JSON.parse(
      Buffer.from(
        payload.authorization.replace(/^Nostr /, ""),
        "base64",
      ).toString(),
    );
    expect(JSON.parse(payload.body)).toEqual({
      communityId: config.communityId,
      channelId: "open-room",
    });
    expect(event.pubkey).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    expect(event.tags).toContainEqual([
      "u",
      "https://synthetic.invalid/api/v1/channel-capability/discover",
    ]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256").update(payload.body).digest("hex"),
    ]);
    expect(event.id).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
          ]),
        )
        .digest("hex"),
    );
    expect(event.sig).toMatch(/^[a-f0-9]{128}$/);
  });
});
