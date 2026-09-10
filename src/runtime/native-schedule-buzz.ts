import { spawn, execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { NativeScheduleTransport } from "./native-schedules.js";

export type NativeBuzzScheduleConfig = {
  leagueId: string;
  relayUrl: string;
  notifierPubkey: string;
  appDataDirectory: string;
  executable: string;
  owners: Record<
    string,
    {
      agentId: string;
      pubkey: string;
      channelId: string;
      queueChannelId: string;
    }
  >;
};
/** CLI process wrapper: secrets stay in env; private task text goes through stdin. */
export function scheduleBuzzCli(
  executable: string,
  environment: NodeJS.ProcessEnv,
  args: string[],
  content?: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      ended = false;
    const finish = (error?: Error, result?: unknown) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(Error("BUZZ_OUTCOME_UNCERTAIN"));
    }, 30000);
    child.on("error", () => finish(Error("BUZZ_PROCESS_UNAVAILABLE")));
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 4_000_000) {
        child.kill("SIGTERM");
        finish(Error("BUZZ_RESPONSE_TOO_LARGE"));
      }
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (code !== 0) return finish(Error("BUZZ_OUTCOME_UNCERTAIN"));
      try {
        finish(undefined, JSON.parse(output));
      } catch {
        finish(Error("BUZZ_RESPONSE_INVALID"));
      }
    });
    child.stdin.end(content);
  });
}
export function nativeScheduleMessage(input: {
  occurrenceId: string;
  prompt: string;
  scheduledFor: string;
  missedThrough: string;
}) {
  const ack = (state: string) =>
    JSON.stringify({
      operation: "acknowledge",
      idempotencyKey: `${input.occurrenceId}:${state}`,
      occurrenceId: input.occurrenceId,
      state,
    });
  return `League infrastructure: your own scheduled appointment is due. [league-appointment:${input.occurrenceId}]
Scheduled for: ${input.scheduledFor}. Dispatch observation: ${input.missedThrough}. If late, evaluate the current situation yourself.
This is a private delivery of the task you scheduled, not commissioner football advice. The occurrence ID remains the same across transport recovery. Inspect ./black4 schedules if this appears repeated; do not repeat an already-completed task.
Record that you started with ./black4 schedule-command '${ack("started")}'. When the task is finished, make your final tool action ./black4 schedule-command '${ack("completed")}', or acknowledge state failed if it could not be performed. These are your acknowledgements, not an infrastructure claim that your football decisions were correct.
Your scheduled task follows:
${input.prompt}`;
}
export function nativeBuzzScheduleTransport(
  config: NativeBuzzScheduleConfig,
  environment: NodeJS.ProcessEnv,
): NativeScheduleTransport {
  const bound = (leagueId: string, teamId: string) => {
    if (leagueId !== config.leagueId || !Object.hasOwn(config.owners, teamId))
      throw Error("SCHEDULE_DELIVERY_BINDING_MISMATCH");
    const owner = config.owners[teamId]!;
    if (!owner.queueChannelId || owner.queueChannelId === owner.channelId)
      throw Error("SCHEDULE_TWO_DISTINCT_PRIVATE_CHANNELS_REQUIRED");
    return owner;
  };
  const laneChannel = (
    owner: NativeBuzzScheduleConfig["owners"][string],
    lane: 0 | 1,
  ) => {
    if (lane !== 0 && lane !== 1) throw Error("SCHEDULE_DELIVERY_LANE_INVALID");
    return lane === 0 ? owner.channelId : owner.queueChannelId;
  };
  const cli = (args: string[], content?: string) =>
    scheduleBuzzCli(config.executable, environment, args, content);
  return {
    async inspectOwner({ leagueId, teamId }) {
      const owner = bound(leagueId, teamId);
      try {
        const managed = JSON.parse(
          await readFile(
            join(config.appDataDirectory, "agents/managed-agents.json"),
            "utf8",
          ),
        );
        const rows = managed.filter(
          (row: any) =>
            row.pubkey === owner.pubkey &&
            row.agent_args?.includes(owner.agentId),
        );
        if (rows.length !== 1)
          return {
            status: "unavailable",
            reason: "Native Buzz configuration is missing or ambiguous",
          };
        const pidDirectory = join(config.appDataDirectory, "agents/agent-pids");
        const receipts = await Promise.all(
          (await readdir(pidDirectory)).map(async (name) => {
            try {
              return JSON.parse(
                await readFile(join(pidDirectory, name), "utf8"),
              );
            } catch {
              return null;
            }
          }),
        );
        const matching = receipts.filter(
          (row) =>
            row?.key?.pubkey === owner.pubkey &&
            row.key.relayUrl === config.relayUrl,
        );
        const running = matching.filter((row) => {
          if (!Number.isSafeInteger(row.pid) || row.pid <= 0) return false;
          try {
            const line = execFileSync(
              "/bin/ps",
              ["-p", String(row.pid), "-o", "lstart=,comm="],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            ).trim();
            const match = line.match(
              /^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/,
            );
            return (
              match &&
              /(?:^|\/)buzz-acp$/.test(match[2]!) &&
              Math.abs(Date.parse(match[1]!) - Date.parse(row.startedAt)) <
                15000
            );
          } catch {
            return false;
          }
        });
        if (running.length !== 1)
          return {
            status: running.length === 0 ? "stopped" : "unavailable",
            reason:
              "Exactly one Buzz-managed native process is required; infrastructure does not override stopped owners",
          };
        if (rows[0].parallelism !== 1)
          return {
            status: "unavailable",
            reason:
              "Alternating appointment inboxes require the verified one-slot native Buzz pool",
          };
        for (const channelId of [owner.channelId, owner.queueChannelId]) {
          // The CLI get projection omits type/visibility. Resolve the current
          // name by ID, then inspect its richer search metadata by that same ID.
          // Membership alone does not make a DM eligible for native delivery.
          const channel = await cli([
            "channels",
            "get",
            "--channel",
            channelId,
          ]);
          if (
            channel?.channel_id !== channelId ||
            typeof channel.name !== "string" ||
            !channel.name.trim()
          )
            return {
              status: "unavailable",
              reason: "Appointment inbox metadata is unavailable",
            };
          const candidates = await cli([
            "channels",
            "search",
            "--query",
            channel.name,
            "--exact",
            "--include-archived",
          ]);
          const metadata = Array.isArray(candidates)
            ? candidates.filter((row: any) => row.channel_id === channelId)
            : [];
          if (
            metadata.length !== 1 ||
            metadata[0].channel_type !== "stream" ||
            metadata[0].visibility !== "private" ||
            metadata[0].archived !== false
          )
            return {
              status: "unavailable",
              reason:
                "Appointment inbox must be a verified active private stream; DMs and unknown channel types cannot deliver native work",
            };
          const members = await cli([
            "channels",
            "members",
            "--channel",
            channelId,
          ]);
          if (
            !Array.isArray(members) ||
            members.length !== 2 ||
            new Set(members.map((row: any) => row.pubkey)).size !== 2 ||
            !members.every((row: any) =>
              [owner.pubkey, config.notifierPubkey].includes(row.pubkey),
            )
          )
            return {
              status: "unavailable",
              reason:
                "Appointment inbox membership differs from its private owner and infrastructure binding",
            };
        }
        // This means the transport can queue, not that the model is idle. A separate
        // alternating private channel queues behind the finishing turn in the one-slot Buzz pool.
        // Owner acknowledgements release work; they do not pretend the final native
        // response already ended. Switching inbox avoids steering that response.
        return {
          status: "ready",
          reason:
            "Buzz-managed process present; native queue handles active work. Model execution is confirmed separately.",
        };
      } catch {
        return {
          status: "unavailable",
          reason: "Native process evidence unavailable",
        };
      }
    },
    async send(input) {
      const owner = bound(input.leagueId, input.teamId);
      const result = await cli(
        [
          "messages",
          "send",
          "--channel",
          laneChannel(owner, input.deliveryLane),
          "--content",
          "-",
          "--mention",
          owner.pubkey,
        ],
        nativeScheduleMessage(input),
      );
      const eventId = result.event_id ?? result.eventId ?? result.id;
      if (result.accepted !== true || !/^[a-f0-9]{64}$/.test(eventId ?? ""))
        throw Error("BUZZ_OUTCOME_UNCERTAIN");
      return { eventId };
    },
    async reconcile(input) {
      const owner = bound(input.leagueId, input.teamId);
      try {
        const result = await cli([
          "messages",
          "get",
          "--channel",
          laneChannel(owner, input.deliveryLane),
          "--limit",
          "100",
        ]);
        const rows = Array.isArray(result)
          ? result
          : (result.messages ?? result.events);
        if (!Array.isArray(rows)) return { status: "unknown" };
        const matches = rows.filter(
          (row: any) =>
            row.pubkey === config.notifierPubkey &&
            row.content?.includes(`[league-appointment:${input.occurrenceId}]`),
        );
        if (matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].id))
          return { status: "found", eventId: matches[0].id };
        // A bounded relay read cannot prove absence; never blindly mint another event.
        return { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
  };
}
