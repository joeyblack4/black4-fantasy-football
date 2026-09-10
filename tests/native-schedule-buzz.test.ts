import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFileSync: mocks.execFileSync,
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
}));
import {
  nativeBuzzScheduleTransport,
  nativeScheduleMessage,
  scheduleBuzzCli,
} from "../src/runtime/native-schedule-buzz.js";

const eventId = "a".repeat(64);
const config = {
  leagueId: "league",
  relayUrl: "wss://league.invalid",
  notifierPubkey: "trusted-notifier",
  appDataDirectory: "/synthetic/app",
  executable: "/synthetic/buzz",
  owners: {
    team: {
      agentId: "b4-owner",
      pubkey: "owner-key",
      channelId: "private-team-channel",
      queueChannelId: "private-team-queue",
    },
  },
};
const input = {
  leagueId: "league",
  teamId: "team",
  occurrenceId: "occurrence-123",
  deliveryLane: 0 as const,
  prompt: "Private owner plan\n$(do-not-execute) `literal`",
  scheduledFor: "2026-09-09T12:00:00Z",
  missedThrough: "2026-09-09T12:02:00Z",
};
function childResult(result: unknown, exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    end: vi.fn(() =>
      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          "SECRET_KEY and PRIVATE_PLAN in upstream diagnostics",
        );
        child.stdout.emit(
          "data",
          typeof result === "string" ? result : JSON.stringify(result),
        );
        child.emit("close", exitCode);
      }),
    ),
  };
  mocks.spawn.mockReturnValueOnce(child);
  return child;
}
function privateChannelMetadata(channelId: string) {
  childResult({ channel_id: channelId, name: channelId });
  childResult([
    {
      channel_id: channelId,
      name: channelId,
      channel_type: "stream",
      visibility: "private",
      archived: false,
    },
  ]);
}
function runningOwner() {
  mocks.readFile.mockImplementation(async (path: string) =>
    path.endsWith("managed-agents.json")
      ? JSON.stringify([
          {
            pubkey: config.owners.team.pubkey,
            agent_args: [config.owners.team.agentId],
            parallelism: 1,
          },
        ])
      : JSON.stringify({
          key: { pubkey: config.owners.team.pubkey, relayUrl: config.relayUrl },
          pid: 42,
          startedAt: new Date("Wed Sep 9 12:00:00 2026").toISOString(),
        }),
  );
  mocks.readdir.mockResolvedValue(["pid.json"]);
  mocks.execFileSync.mockReturnValue(
    "Wed Sep 9 12:00:00 2026 /synthetic/buzz-acp",
  );
}
function privateChannelReady(channelId: string) {
  privateChannelMetadata(channelId);
  childResult([
    { pubkey: config.notifierPubkey },
    { pubkey: config.owners.team.pubkey },
  ]);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("Buzz schedule delivery boundary", () => {
  it("delivers only to the bound private channel with task through stdin and credential through env", async () => {
    const child = childResult({ accepted: true, event_id: eventId });
    const environment = { BUZZ_PRIVATE_KEY: "SECRET_KEY" };
    const transport = nativeBuzzScheduleTransport(config, environment);
    expect(await transport.send(input)).toEqual({ eventId });
    expect(mocks.spawn).toHaveBeenCalledWith(
      config.executable,
      [
        "messages",
        "send",
        "--channel",
        "private-team-channel",
        "--content",
        "-",
        "--mention",
        "owner-key",
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    const args = JSON.stringify(mocks.spawn.mock.calls[0]?.[1]);
    expect(args).not.toMatch(/SECRET_KEY|Private owner plan/);
    expect(child.stdin.end).toHaveBeenCalledWith(nativeScheduleMessage(input));
    const text = child.stdin.end.mock.calls[0]?.[0];
    expect(text).toContain("[league-appointment:occurrence-123]");
    expect(text).toContain(input.prompt);
    expect(text).toContain('"state":"started"');
    expect(text).toContain('"state":"completed"');
    expect(text).toContain("not commissioner football advice");
  });
  it("rejects another league or unbound franchise before invoking Buzz", async () => {
    const transport = nativeBuzzScheduleTransport(config, {});
    await expect(
      transport.send({ ...input, leagueId: "other" }),
    ).rejects.toThrow("SCHEDULE_DELIVERY_BINDING_MISMATCH");
    await expect(
      transport.reconcile({ ...input, teamId: "other" }),
    ).rejects.toThrow("SCHEDULE_DELIVERY_BINDING_MISMATCH");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("returns a redacted uncertain error for failed sends even if diagnostics contain private text", async () => {
    childResult({ message: "SECRET_KEY PRIVATE_PLAN" }, 1);
    await expect(
      nativeBuzzScheduleTransport(config, {}).send(input),
    ).rejects.toThrow(/^BUZZ_OUTCOME_UNCERTAIN$/);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("does not treat a success-shaped response without positive acceptance as delivery", async () => {
    childResult({ accepted: false, event_id: eventId });
    await expect(
      nativeBuzzScheduleTransport(config, {}).send(input),
    ).rejects.toThrow(/^BUZZ_OUTCOME_UNCERTAIN$/);
  });
  it("reconciles only the exact occurrence from the trusted notifier without sending again", async () => {
    childResult({
      messages: [
        {
          id: "b".repeat(64),
          pubkey: "spoof",
          content: "[league-appointment:occurrence-123]",
        },
        {
          id: eventId,
          pubkey: "trusted-notifier",
          content: "[league-appointment:occurrence-123]",
        },
      ],
    });
    expect(
      await nativeBuzzScheduleTransport(config, {}).reconcile(input),
    ).toEqual({ status: "found", eventId });
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
      "messages",
      "get",
      "--channel",
      "private-team-channel",
      "--limit",
      "100",
    ]);
  });
  it("keeps bounded absence and duplicate matching receipts uncertain, preventing blind replay", async () => {
    const transport = nativeBuzzScheduleTransport(config, {});
    childResult({ messages: [] });
    expect(await transport.reconcile(input)).toEqual({ status: "unknown" });
    childResult({
      messages: [eventId, "b".repeat(64)].map((id) => ({
        id,
        pubkey: "trusted-notifier",
        content: "[league-appointment:occurrence-123]",
      })),
    });
    expect(await transport.reconcile(input)).toEqual({ status: "unknown" });
    expect(mocks.spawn.mock.calls.every((call) => call[1][1] === "get")).toBe(
      true,
    );
  });
  it("kills a timed-out CLI once and reports uncertainty without exposing its buffered content", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn();
    mocks.spawn.mockReturnValueOnce(child);
    const result = scheduleBuzzCli(
      config.executable,
      { BUZZ_PRIVATE_KEY: "SECRET_KEY" },
      ["messages", "send"],
      "PRIVATE_PLAN",
    );
    const rejected = expect(result).rejects.toThrow(/^BUZZ_OUTCOME_UNCERTAIN$/);
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
  it("does not restart an owner whose PID evidence is absent", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([{ pubkey: "owner-key", agent_args: ["b4-owner"] }]),
    );
    mocks.readdir.mockResolvedValue([]);
    expect(
      await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
    ).toMatchObject({ status: "stopped" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
  it("rejects a reused PID whose current process is not the recorded Buzz runtime", async () => {
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("managed-agents.json")
        ? JSON.stringify([{ pubkey: "owner-key", agent_args: ["b4-owner"] }])
        : JSON.stringify({
            key: { pubkey: "owner-key", relayUrl: config.relayUrl },
            pid: 42,
            startedAt: "2026-09-09T12:00:00Z",
          }),
    );
    mocks.readdir.mockResolvedValue(["pid.json"]);
    mocks.execFileSync.mockReturnValue(
      "Wed Sep 9 12:00:00 2026 /bin/unrelated-process",
    );
    expect(
      await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
    ).toMatchObject({ status: "stopped" });
  });
});
it("sends and reconciles lane one in its persisted second inbox", async () => {
  const sender = nativeBuzzScheduleTransport(config, {});
  childResult({ accepted: true, event_id: eventId });
  await sender.send({ ...input, deliveryLane: 1 });
  expect(mocks.spawn.mock.calls[0]?.[1]).toContain("private-team-queue");
  childResult({
    messages: [
      {
        id: eventId,
        pubkey: config.notifierPubkey,
        content: `[league-appointment:${input.occurrenceId}]`,
      },
    ],
  });
  await sender.reconcile({ ...input, deliveryLane: 1 });
  expect(mocks.spawn.mock.calls[1]?.[1]).toContain("private-team-queue");
});
it("refuses duplicated inboxes, multiple native slots, and changed inbox membership", async () => {
  const duplicated = {
    ...config,
    owners: {
      team: {
        ...config.owners.team,
        queueChannelId: config.owners.team.channelId,
      },
    },
  };
  await expect(
    nativeBuzzScheduleTransport(duplicated, {}).send(input),
  ).rejects.toThrow("TWO_DISTINCT_PRIVATE_CHANNELS");
  expect(mocks.spawn).not.toHaveBeenCalled();
  let parallelism = 2;
  mocks.readFile.mockImplementation(async (path: string) =>
    path.endsWith("managed-agents.json")
      ? JSON.stringify([
          {
            pubkey: config.owners.team.pubkey,
            agent_args: [config.owners.team.agentId],
            parallelism,
          },
        ])
      : JSON.stringify({
          key: { pubkey: config.owners.team.pubkey, relayUrl: config.relayUrl },
          pid: 42,
          startedAt: new Date("Wed Sep 9 12:00:00 2026").toISOString(),
        }),
  );
  mocks.readdir.mockResolvedValue(["pid.json"]);
  mocks.execFileSync.mockReturnValue(
    "Wed Sep 9 12:00:00 2026 /synthetic/buzz-acp",
  );
  expect(
    await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
  ).toMatchObject({ status: "unavailable" });
  expect(mocks.spawn).not.toHaveBeenCalled();
  parallelism = 1;
  privateChannelMetadata(config.owners.team.channelId);
  childResult([
    { pubkey: config.owners.team.pubkey },
    { pubkey: config.notifierPubkey },
  ]);
  privateChannelMetadata(config.owners.team.queueChannelId);
  childResult([
    { pubkey: config.owners.team.pubkey },
    { pubkey: config.notifierPubkey },
    { pubkey: "unexpected-third-member" },
  ]);
  expect(
    await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
  ).toMatchObject({ status: "unavailable" });
  expect(
    mocks.spawn.mock.calls.every((call) => call[1][0] === "channels"),
  ).toBe(true);
});
it.each([
  { label: "missing owner", payload: [{ pubkey: config.notifierPubkey }] },
  {
    label: "wrong owner",
    payload: [{ pubkey: config.notifierPubkey }, { pubkey: "other-owner" }],
  },
  {
    label: "unreadable response",
    payload: { error: "private membership unavailable" },
  },
])(
  "blocks $label on the second inbox without sending private task text",
  async ({ payload }) => {
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("managed-agents.json")
        ? JSON.stringify([
            {
              pubkey: config.owners.team.pubkey,
              agent_args: [config.owners.team.agentId],
              parallelism: 1,
            },
          ])
        : JSON.stringify({
            key: {
              pubkey: config.owners.team.pubkey,
              relayUrl: config.relayUrl,
            },
            pid: 42,
            startedAt: new Date("Wed Sep 9 12:00:00 2026").toISOString(),
          }),
    );
    mocks.readdir.mockResolvedValue(["pid.json"]);
    mocks.execFileSync.mockReturnValue(
      "Wed Sep 9 12:00:00 2026 /synthetic/buzz-acp",
    );
    privateChannelReady(config.owners.team.channelId);
    privateChannelMetadata(config.owners.team.queueChannelId);
    childResult(payload);
    expect(
      await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
    ).toMatchObject({ status: "unavailable" });
    expect(mocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ["channels", "get", "--channel", config.owners.team.channelId],
      [
        "channels",
        "search",
        "--query",
        config.owners.team.channelId,
        "--exact",
        "--include-archived",
      ],
      ["channels", "members", "--channel", config.owners.team.channelId],
      ["channels", "get", "--channel", config.owners.team.queueChannelId],
      [
        "channels",
        "search",
        "--query",
        config.owners.team.queueChannelId,
        "--exact",
        "--include-archived",
      ],
      ["channels", "members", "--channel", config.owners.team.queueChannelId],
    ]);
    expect(
      mocks.spawn.mock.calls.every((call) => call[1][0] === "channels"),
    ).toBe(true);
  },
);
const invalidChannelMetadata = [
  {
    label: "DM despite otherwise valid private membership",
    metadata: { channel_type: "dm", visibility: "private", archived: false },
  },
  {
    label: "public stream",
    metadata: { channel_type: "stream", visibility: "public", archived: false },
  },
  {
    label: "unknown type",
    metadata: { channel_type: null, visibility: "private", archived: false },
  },
  {
    label: "unknown visibility",
    metadata: { channel_type: "stream", visibility: null, archived: false },
  },
  {
    label: "unknown archive status",
    metadata: { channel_type: "stream", visibility: "private" },
  },
  {
    label: "archived stream",
    metadata: { channel_type: "stream", visibility: "private", archived: true },
  },
];
for (const deliveryLane of [0, 1] as const) {
  it.each(invalidChannelMetadata)(
    `refuses $label on lane${deliveryLane} before sending anything`,
    async ({ metadata }) => {
      runningOwner();
      if (deliveryLane === 1) privateChannelReady(config.owners.team.channelId);
      const channelId =
        deliveryLane === 0
          ? config.owners.team.channelId
          : config.owners.team.queueChannelId;
      childResult({ channel_id: channelId, name: "Inbox" });
      childResult([{ channel_id: channelId, name: "Inbox", ...metadata }]);
      const result = await nativeBuzzScheduleTransport(config, {}).inspectOwner(
        input,
      );
      expect(result).toMatchObject({ status: "unavailable" });
      expect(result.reason).toContain("private stream");
      expect(
        mocks.spawn.mock.calls.every((call) => call[1][0] === "channels"),
      ).toBe(true);
    },
  );
}
it("requires the metadata record for the exact channel ID, not another private stream with the same name", async () => {
  runningOwner();
  childResult({ channel_id: config.owners.team.channelId, name: "Same name" });
  childResult([
    {
      channel_id: "other-channel",
      name: "Same name",
      channel_type: "stream",
      visibility: "private",
      archived: false,
    },
  ]);
  expect(
    await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
  ).toMatchObject({ status: "unavailable" });
});
it("accepts only two active private streams with their exact two exclusive members", async () => {
  runningOwner();
  privateChannelReady(config.owners.team.channelId);
  privateChannelReady(config.owners.team.queueChannelId);
  expect(
    await nativeBuzzScheduleTransport(config, {}).inspectOwner(input),
  ).toMatchObject({ status: "ready" });
  expect(mocks.spawn).toHaveBeenCalledTimes(6);
  expect(
    mocks.spawn.mock.calls.every((call) => call[1][0] === "channels"),
  ).toBe(true);
});
