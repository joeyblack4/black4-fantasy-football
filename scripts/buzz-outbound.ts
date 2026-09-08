#!/usr/bin/env -S npx tsx
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import {
  BuzzRuntimeOutbound,
  managedOutboundTransport,
} from "../src/buzz/runtime-outbound.js";
import { LEAGUE_COMMUNITY } from "../src/buzz/managed-acp.js";
const args = process.argv.slice(2);
async function main() {
  if (
    !args.includes("--execute-outbound") &&
    !args.includes("--cutover") &&
    !args.includes("--reconcile")
  ) {
    console.log(
      JSON.stringify({
        mode: "mock",
        networkCalls: 0,
        modelCalls: 0,
        description:
          "No dispatch. Configure managed identities and explicit polling cutover, then use --execute-outbound --league <id>.",
      }),
    );
    return;
  }
  const leagueId = args[args.indexOf("--league") + 1];
  if (!args.includes("--league") || !leagueId || !process.env.DATABASE_URL)
    throw new Error(
      "Explicit league, database and absolute Buzz executable required",
    );
  const db = createDb();
  const binding = (
    await db.query(
      "SELECT community_url,mode FROM buzz_league_bindings WHERE league_id=$1",
      [leagueId],
    )
  ).rows[0];
  if (binding?.mode !== "real" || binding.community_url !== LEAGUE_COMMUNITY) {
    await db.end();
    throw new Error("Exact live league binding required");
  }
  if (args.includes("--cutover") || args.includes("--reconcile")) {
    try {
      const actor = await authenticate(
        db,
        process.env.B4_LEAGUE_COMMISSIONER_TOKEN
          ? `Bearer ${process.env.B4_LEAGUE_COMMISSIONER_TOKEN}`
          : undefined,
      );
      const service = new BuzzRuntimeOutbound(db);
      if (args.includes("--cutover")) {
        const agentId = args[args.indexOf("--agent") + 1],
          receiptId = args[args.indexOf("--receipt") + 1];
        if (
          !args.includes("--agent") ||
          !args.includes("--receipt") ||
          !agentId ||
          !receiptId
        )
          throw new Error("Agent and onboarding receipt required");
        console.log(
          JSON.stringify(
            await service.cutoverToPolling(actor, {
              leagueId,
              agentId,
              receiptId,
            }),
          ),
        );
      } else {
        const messageId = args[args.indexOf("--message") + 1];
        if (!args.includes("--message") || !messageId)
          throw new Error("Runtime message ID required");
        console.log(
          JSON.stringify(
            await service.reconcile(actor, { leagueId, messageId }),
          ),
        );
      }
    } finally {
      await db.end();
    }
    return;
  }
  if (!process.env.B4_LEAGUE_BUZZ_EXECUTABLE?.startsWith("/")) {
    await db.end();
    throw new Error("Absolute Buzz executable required");
  }
  const service = new BuzzRuntimeOutbound(
    db,
    managedOutboundTransport(db, {
      executable: process.env.B4_LEAGUE_BUZZ_EXECUTABLE,
      allowExternalSends: true,
    }),
  );
  let stopped = false,
    wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    do {
      try {
        const result = await service.dispatchOne(leagueId);
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            status: result.status,
            runtimeMessageId:
              "runtime_message_id" in result
                ? result.runtime_message_id
                : undefined,
          }),
        );
      } catch {
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            status: "error",
            message: "Buzz outbound failed; inspect scoped private receipts",
          }),
        );
      }
      if (stopped || args.includes("--once")) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, 2000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } while (!stopped);
  } finally {
    await db.end();
  }
}
main().catch(() => {
  console.error(
    "Buzz outbound refused startup; verify exact league bindings and managed credentials.",
  );
  process.exitCode = 1;
});
