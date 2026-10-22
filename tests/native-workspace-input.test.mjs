import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { nativeWorkspaceInput } from "../scripts/native-workspace-input.mjs";

async function translate(chunks, workspace) {
  const input = Readable.from(chunks).pipe(nativeWorkspaceInput(workspace));
  let output = "";
  for await (const chunk of input) output += chunk;
  return output;
}

test("fragmented ACP session requests use the franchise instead of Buzz's shared cwd", async () => {
  const workspace = "/franchises/Meta Mesh/workspace";
  const requests = ["new", "load", "resume", "fork", "list"].map(
    (operation, id) => ({
      jsonrpc: "2.0",
      id,
      method: `session/${operation}`,
      params: {
        cwd: "/shared/.buzz",
        sessionId: "retain-session",
        mcpServers: [],
      },
    }),
  );
  const wire =
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  const output = await translate(
    [wire.slice(0, 11), wire.slice(11, 137), wire.slice(137)],
    workspace,
  );
  assert.deepEqual(
    output.trim().split("\n").map(JSON.parse),
    requests.map((request) => ({
      ...request,
      params: { ...request.params, cwd: workspace },
    })),
  );
});

test("native prompts, cancellation, tool responses and unknown protocol messages pass through unchanged", async () => {
  const lines = [
    '{ "id":1, "method":"session/prompt", "params":{"sessionId":"kept","prompt":[{"type":"text","text":"Héllo 世界"}]}}',
    '{"method":"session/cancel","params":{"sessionId":"kept"}}',
    '{"id":2,"result":{"cwd":"tool output is not session authority"}}',
    "invalid input remains native validation responsibility",
  ].join("\n");
  assert.equal(await translate([lines], "/owner/workspace"), lines);
  const bytes = Buffer.from(lines);
  assert.equal(
    await translate(
      Array.from(bytes, (byte) => Buffer.from([byte])),
      "/owner/workspace",
    ),
    lines,
  );
});
