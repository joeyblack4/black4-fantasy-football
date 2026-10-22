import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// ACP's client cwd overrides the subprocess cwd. Buzz Desktop can supply its
// shared nest here; only session workspace fields belong to this connection.
const workspaceMethods = new Set([
  "session/new",
  "session/load",
  "session/resume",
  "session/fork",
  "session/list",
]);

export function nativeWorkspaceInput(workspace) {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const frame = (line) => {
    try {
      const message = JSON.parse(line);
      if (workspaceMethods.has(message.method) && message.params) {
        message.params.cwd = workspace;
        return JSON.stringify(message);
      }
    } catch {
      // Leave protocol validation to the native harness.
    }
    return line;
  };
  return new Transform({
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        this.push(frame(pending.slice(0, end)) + "\n");
        pending = pending.slice(end + 1);
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) this.push(frame(pending));
      callback();
    },
  });
}
