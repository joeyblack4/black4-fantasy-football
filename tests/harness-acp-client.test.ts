import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  type AcpClientOptions,
  type AcpObject,
} from "../src/harnesses/acp-client.js";

function peer(
  options: AcpClientOptions = {},
  handle?: (frame: AcpObject) => void,
) {
  const readable = new PassThrough();
  const sent: AcpObject[] = [];
  const close = vi.fn(() => {
    readable.end();
  });
  const client = new AcpClient(
    {
      readable,
      close,
      write: (line) => {
        const frame = JSON.parse(line) as AcpObject;
        sent.push(frame);
        handle?.(frame);
      },
    },
    options,
  );
  const emit = (frame: AcpObject) =>
    readable.write(JSON.stringify(frame) + "\n");
  const reply = (id: unknown, result: AcpObject) =>
    emit({ jsonrpc: "2.0", id, result });
  return { client, sent, readable, close, emit, reply };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const config = (current = "native-lead") => ({
  configOptions: [
    {
      id: "lead",
      category: "model",
      currentValue: current,
      options: [{ value: "native-lead" }, { value: "other" }],
    },
  ],
});
async function ready(p: ReturnType<typeof peer>) {
  const init = p.client.initialize();
  await tick();
  p.reply(p.sent.at(-1)!.id, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
    },
  });
  await init;
  const session = p.client.newSession({
    cwd: "/synthetic/franchise",
    requiredModel: "native-lead",
  });
  await tick();
  p.reply(p.sent.at(-1)!.id, { sessionId: "s1", ...config() });
  await session;
}

describe("thin native ACP client (synthetic peers only)", () => {
  it("negotiates capabilities, keeps the native lead visible, streams updates and tolerates duplicate responses", async () => {
    const updates = vi.fn();
    const p = peer({ onUpdate: updates });
    await ready(p);
    expect(p.client.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true },
    });
    const result = p.client.prompt(
      "s1",
      "Research freely in this synthetic workspace",
    );
    await tick();
    const id = p.sent.at(-1)!.id;
    p.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call", title: "native research" },
      },
    });
    p.reply(id, { stopReason: "end_turn", usage: { inputTokens: 7 } });
    p.reply(id, { stopReason: "end_turn" });
    expect(await result).toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 7 },
    });
    expect(updates).toHaveBeenCalledOnce();
    const next = p.client.prompt("s1", "Continue");
    await tick();
    p.reply(p.sent.at(-1)!.id, { stopReason: "end_turn" });
    await next;
    p.client.close();
  });

  it("applies supported lead selection and refuses a silently unchanged model", async () => {
    const p = peer();
    await ready(p);
    const selected = p.client.newSession({
      cwd: "/synthetic",
      requiredModel: "native-lead",
    });
    await tick();
    p.reply(p.sent.at(-1)!.id, { sessionId: "s2", ...config("other") });
    await tick();
    expect(p.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "s2", configId: "lead", value: "native-lead" },
    });
    p.reply(p.sent.at(-1)!.id, config());
    expect((await selected).modelId).toBe("native-lead");
    const wrong = p.client.newSession({
      cwd: "/synthetic",
      requiredModel: "native-lead",
    });
    const rejected = expect(wrong).rejects.toMatchObject({
      code: "MODEL_UNCONFIRMED",
    });
    await tick();
    p.reply(p.sent.at(-1)!.id, { sessionId: "s3", ...config("other") });
    await tick();
    p.reply(p.sent.at(-1)!.id, config("other"));
    await rejected;
    await expect(
      p.client.prompt("s3", "must not prompt"),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    p.client.close();
  });

  it("surfaces unavailable models without a fallback cognition call", async () => {
    const p = peer();
    await ready(p);
    const session = p.client.newSession({
      cwd: "/synthetic",
      requiredModel: "unavailable",
    });
    const rejected = expect(session).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
    await tick();
    p.reply(p.sent.at(-1)!.id, { sessionId: "s2", ...config() });
    await rejected;
    expect(p.sent.some((f) => f.method === "session/prompt")).toBe(false);
    p.client.close();
  });

  it.each([undefined, "deny"] as const)(
    "makes native permission behavior explicit: %s",
    async (permissionPolicy) => {
      const p = peer({ permissionPolicy });
      await ready(p);
      const prompt = p.client.prompt("s1", "Use native tools");
      await tick();
      const promptId = p.sent.at(-1)!.id;
      p.emit({
        jsonrpc: "2.0",
        id: "native-permission",
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { title: "native tool" },
          options: [
            { kind: "allow_once", optionId: "yes" },
            { kind: "reject_once", optionId: "no" },
          ],
        },
      });
      await tick();
      expect(p.sent.at(-1)).toMatchObject({
        id: "native-permission",
        result: {
          outcome: {
            outcome: "selected",
            optionId: permissionPolicy === "deny" ? "no" : "yes",
          },
        },
      });
      p.reply(promptId, { stopReason: "end_turn" });
      await prompt;
      p.client.close();
    },
  );

  it("cancels a prompt and pending permission, ignoring a late handler and late prompt response", async () => {
    let finish!: (option: string) => void;
    let signal: AbortSignal | undefined;
    const p = peer({
      onPermission: (_request, receivedSignal) => {
        signal = receivedSignal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    await ready(p);
    const abort = new AbortController();
    const prompt = p.client.prompt("s1", "Wait for native operation", {
      signal: abort.signal,
    });
    const rejected = expect(prompt).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await tick();
    const promptId = p.sent.at(-1)!.id;
    p.emit({
      jsonrpc: "2.0",
      id: 999,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        options: [{ kind: "allow_once", optionId: "yes" }],
      },
    });
    await tick();
    abort.abort();
    await rejected;
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(p.sent).toContainEqual({
      jsonrpc: "2.0",
      id: 999,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(p.sent.at(-1)).toMatchObject({
      method: "session/cancel",
      params: { sessionId: "s1" },
    });
    finish("yes");
    p.reply(promptId, { stopReason: "cancelled" });
    await tick();
    expect(p.sent.filter((f) => f.id === 999)).toHaveLength(1);
    p.client.close();
  });

  it("rejects unknown peer requests instead of hanging native tools", async () => {
    const p = peer();
    await ready(p);
    p.emit({
      jsonrpc: "2.0",
      id: "fs",
      method: "fs/read_text_file",
      params: {},
    });
    await tick();
    expect(p.sent.at(-1)).toMatchObject({ id: "fs", error: { code: -32601 } });
    p.client.close();
  });

  it("bounds frames even across chunks and closes a disconnected or malformed peer", async () => {
    for (const mode of ["oversize", "invalid", "eof"] as const) {
      const p = peer({ maxFrameBytes: 512 });
      const init = p.client.initialize();
      const expected = expect(init).rejects.toMatchObject({
        code:
          mode === "oversize"
            ? "FRAME_TOO_LARGE"
            : mode === "invalid"
              ? "INVALID_FRAME"
              : "DISCONNECTED",
      });
      await tick();
      if (mode === "oversize") {
        p.readable.write("x".repeat(300));
        p.readable.write("x".repeat(300));
      } else if (mode === "invalid") p.readable.write("not-json\n");
      else p.readable.end();
      await expected;
      expect(p.close).toHaveBeenCalledOnce();
    }
  });

  it("times out silent requests and pending permission handlers without approving them", async () => {
    const silent = peer({ timeoutMs: 15 });
    await expect(silent.client.initialize()).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(silent.close).toHaveBeenCalledOnce();
    const p = peer({
      timeoutMs: 100,
      onPermission: () => new Promise(() => {}),
    });
    await ready(p);
    const prompt = p.client.prompt("s1", "synthetic timeout");
    const rejected = expect(prompt).rejects.toMatchObject({ code: "TIMEOUT" });
    await tick();
    p.emit({
      jsonrpc: "2.0",
      id: "waiting",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        options: [{ kind: "allow_once", optionId: "yes" }],
      },
    });
    await rejected;
    expect(
      p.sent.some(
        (f) => f.id === "waiting" && JSON.stringify(f).includes("selected"),
      ),
    ).toBe(false);
  });
});
