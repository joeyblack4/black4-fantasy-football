import { spawn } from "node:child_process";
import type { NativeDraftSender } from "./native-draft-notifications.js";
/** Native Buzz CLI transport. It sends a league notification, never chooses a pick or invokes cognition. */
export function nativeDraftBuzzSender(options: {
  executable: string;
  environment: NodeJS.ProcessEnv;
}): NativeDraftSender {
  return (input) =>
    new Promise((resolve, reject) => {
      const args = [
        "--format",
        "json",
        "messages",
        "send",
        "--channel",
        input.channelId,
        "--content",
        "-",
        ...(input.recipientPubkey ? ["--mention", input.recipientPubkey] : []),
      ];
      const child = spawn(options.executable, args, {
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("Buzz notification timed out; outcome uncertain"));
      }, 30000);
      const finish = (error?: Error, eventId?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve({ eventId: eventId! });
      };
      child.on("error", () =>
        finish(new Error("Buzz notification could not start")),
      );
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 1024 * 1024) {
          child.kill("SIGTERM");
          finish(new Error("Buzz response too large"));
        }
      });
      child.stderr.on("data", () => {}); // Never expose authentication/environment details.
      child.on("close", (code) => {
        if (code !== 0)
          return finish(
            new Error("Buzz notification did not confirm delivery"),
          );
        try {
          const result = JSON.parse(output),
            eventId =
              result.id ??
              result.event_id ??
              result.eventId ??
              result.event?.id ??
              result.data?.id;
          if (result.accepted !== true || !/^[a-f0-9]{64}$/.test(eventId ?? ""))
            throw Error();
          finish(undefined, eventId);
        } catch {
          finish(new Error("Buzz notification lacked signed event receipt"));
        }
      });
      child.stdin.end(input.content);
    });
}
