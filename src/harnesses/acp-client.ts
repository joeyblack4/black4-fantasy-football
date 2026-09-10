/** Thin ACP transport. The caller owns process isolation, credentials and spending. */
export interface AcpTransport {
  readable: AsyncIterable<string | Uint8Array>;
  write(frame: string): void | Promise<void>;
  close?(): void | Promise<void>;
}
export type AcpObject = Record<string, unknown>;
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name?: string }>;
}
export interface AcpClientOptions {
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  onUpdate?: (params: AcpObject) => void;
  /** Native-friendly in the caller's sandbox; no tool allowlists or approval broker. */
  permissionPolicy?: "allow-once" | "deny";
  onPermission?: (
    request: AcpPermissionRequest,
    signal: AbortSignal,
  ) => string | null | Promise<string | null>;
}
export class AcpClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpClientError";
  }
}
type Pending = {
  resolve: (value: AcpObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
};
type Permission = { controller: AbortController; sessionId: string };
const object = (v: unknown): v is AcpObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const error = (code: string) => new AcpClientError(code, `ACP ${code}`);

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private permissions = new Map<string, Permission>();
  private seenPermissionIds = new Set<string>();
  private sessions = new Set<string>();
  private activePrompts = new Set<string>();
  private failure?: Error;
  private initialized = false;
  private initializing = false;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly timeout: number;
  private readonly frameLimit: number;
  private readonly pendingLimit: number;
  private capabilities: AcpObject = {};

  constructor(
    private transport: AcpTransport,
    private options: AcpClientOptions = {},
  ) {
    this.timeout = options.timeoutMs ?? 60_000;
    this.frameLimit = options.maxFrameBytes ?? 4 * 1024 * 1024;
    this.pendingLimit = options.maxPendingRequests ?? 32;
    for (const n of [this.timeout, this.frameLimit, this.pendingLimit]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw error("INVALID_LIMIT");
    }
    void this.read();
  }

  get agentCapabilities(): AcpObject {
    return structuredClone(this.capabilities);
  }

  async initialize(): Promise<AcpObject> {
    if (this.initialized || this.initializing)
      throw error("ALREADY_INITIALIZED");
    this.initializing = true;
    try {
      const result = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "black4-league", version: "1" },
      });
      if (result.protocolVersion !== 1) throw error("UNSUPPORTED_PROTOCOL");
      this.capabilities = object(result.agentCapabilities)
        ? structuredClone(result.agentCapabilities)
        : {};
      this.initialized = true;
      return result;
    } finally {
      this.initializing = false;
    }
  }

  async newSession(input: {
    cwd: string;
    mcpServers?: unknown[];
    requiredModel?: string;
  }): Promise<{
    sessionId: string;
    modelId: string | null;
    configuration: AcpObject;
  }> {
    if (!this.initialized) throw error("NOT_INITIALIZED");
    const result = await this.request("session/new", {
      cwd: input.cwd,
      mcpServers: input.mcpServers ?? [],
    });
    if (typeof result.sessionId !== "string" || !result.sessionId)
      throw error("INVALID_SESSION");
    const sessionId = result.sessionId;
    let configuration = result;
    if (input.requiredModel && currentModel(result) !== input.requiredModel) {
      const selection = modelSelection(result, input.requiredModel);
      if (!selection) throw error("MODEL_UNAVAILABLE");
      configuration = await this.request(selection.method, {
        sessionId,
        ...selection.params,
      });
      if (currentModel(configuration) !== input.requiredModel)
        throw error("MODEL_UNCONFIRMED");
    }
    this.sessions.add(sessionId);
    return { sessionId, modelId: currentModel(configuration), configuration };
  }

  async prompt(
    sessionId: string,
    text: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AcpObject> {
    if (!this.sessions.has(sessionId)) throw error("UNKNOWN_SESSION");
    if (this.activePrompts.has(sessionId)) throw error("PROMPT_IN_PROGRESS");
    if (options.signal?.aborted) throw error("CANCELLED");
    this.activePrompts.add(sessionId);
    const abort = () => {
      void this.cancel(sessionId).catch(() => undefined);
    };
    try {
      const result = this.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        sessionId,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      return await result;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.activePrompts.delete(sessionId);
      this.clearPermissions(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.clearPermissions(sessionId);
    for (const [id, item] of this.pending) {
      if (item.sessionId === sessionId) {
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.reject(error("CANCELLED"));
      }
    }
    await this.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });
  }

  close(): void {
    this.fail(error("CLOSED"));
  }

  private request(
    method: string,
    params: AcpObject,
    sessionId?: string,
  ): Promise<AcpObject> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.pendingLimit)
      return Promise.reject(error("TOO_MANY_REQUESTS"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(error("TIMEOUT")), this.timeout);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((e: Error) =>
        this.fail(e),
      );
    });
  }

  private send(frame: AcpObject): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const encoded = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(encoded) > this.frameLimit)
      return Promise.reject(error("FRAME_TOO_LARGE"));
    const write = this.writeTail.then(async () => {
      if (this.failure) throw this.failure;
      // Bound a hung write independently from the peer's response timer.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve(this.transport.write(encoded)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(error("WRITE_TIMEOUT")),
              this.timeout,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.writeTail = write.catch((e: Error) => this.fail(e));
    return write;
  }

  private async read(): Promise<void> {
    let buffered = Buffer.alloc(0);
    try {
      for await (const chunk of this.transport.readable) {
        if (this.failure) return;
        const bytes = Buffer.from(chunk);
        let start = 0;
        for (let end = 0; end <= bytes.length; end++) {
          if (end !== bytes.length && bytes[end] !== 10) continue;
          const piece = bytes.subarray(start, end);
          if (buffered.length + piece.length > this.frameLimit)
            throw error("FRAME_TOO_LARGE");
          buffered = Buffer.concat([buffered, piece]);
          if (end < bytes.length) {
            if (buffered.length && buffered.toString("utf8").trim())
              this.receive(JSON.parse(buffered.toString("utf8")));
            buffered = Buffer.alloc(0);
          }
          start = end + 1;
        }
      }
      if (!this.failure)
        throw error(buffered.length ? "TRUNCATED_FRAME" : "DISCONNECTED");
    } catch (e) {
      this.fail(e instanceof AcpClientError ? e : error("INVALID_FRAME"));
    }
  }

  private receive(frame: unknown): void {
    if (!object(frame) || frame.jsonrpc !== "2.0") throw error("INVALID_FRAME");
    if (typeof frame.method === "string") {
      const params = object(frame.params) ? frame.params : {};
      if (frame.id !== undefined) {
        if (typeof frame.id !== "number" && typeof frame.id !== "string")
          throw error("INVALID_ID");
        if (frame.method === "session/request_permission")
          this.permission(frame.id, params);
        else
          void this.send({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "Method not supported" },
          }).catch((e: Error) => this.fail(e));
      } else if (frame.method === "session/update") {
        // Native servers can stream initialization updates before session/new
        // returns its id. Preserve those events without inventing session state.
        if (typeof params.sessionId !== "string")
          throw error("UNKNOWN_SESSION_UPDATE");
        this.options.onUpdate?.(structuredClone(params));
      }
      return;
    }
    if (!Number.isSafeInteger(frame.id)) throw error("INVALID_RESPONSE_ID");
    const id = frame.id as number;
    const item = this.pending.get(id);
    // Ignore already completed/cancelled responses; never apply them twice.
    if (!item) {
      if (id > 0 && id < this.nextId) return;
      throw error("UNKNOWN_RESPONSE");
    }
    if ((frame.error !== undefined) === (frame.result !== undefined))
      throw error("INVALID_RESPONSE");
    this.pending.delete(id);
    clearTimeout(item.timer);
    if (frame.error !== undefined) item.reject(error("REMOTE_ERROR"));
    else if (!object(frame.result)) item.reject(error("INVALID_RESULT"));
    else item.resolve(frame.result);
  }

  private permission(id: string | number, params: AcpObject): void {
    const key = `${typeof id}:${id}`;
    if (this.seenPermissionIds.has(key)) throw error("DUPLICATE_PERMISSION");
    if (
      this.seenPermissionIds.size >= 4096 ||
      this.permissions.size >= this.pendingLimit
    )
      throw error("TOO_MANY_PERMISSIONS");
    if (
      typeof params.sessionId !== "string" ||
      !this.activePrompts.has(params.sessionId)
    )
      throw error("UNEXPECTED_PERMISSION");
    if (
      !Array.isArray(params.options) ||
      !params.options.every(
        (o) =>
          object(o) &&
          typeof o.optionId === "string" &&
          typeof o.kind === "string",
      )
    )
      throw error("INVALID_PERMISSION");
    this.seenPermissionIds.add(key);
    const request = structuredClone(params) as unknown as AcpPermissionRequest;
    const controller = new AbortController();
    this.permissions.set(key, { controller, sessionId: request.sessionId });
    const timer = setTimeout(
      () => this.respondPermission(key, id, null),
      this.timeout,
    );
    const defaultKind =
      this.options.permissionPolicy === "deny" ? "reject_once" : "allow_once";
    void Promise.resolve()
      .then(() =>
        this.options.onPermission
          ? this.options.onPermission(request, controller.signal)
          : (request.options.find((o) => o.kind === defaultKind)?.optionId ??
            null),
      )
      .then((selected) => {
        if (
          selected !== null &&
          !request.options.some((o) => o.optionId === selected)
        )
          throw error("INVALID_PERMISSION_CHOICE");
        this.respondPermission(key, id, selected);
      })
      .catch(() => this.respondPermission(key, id, null))
      .finally(() => clearTimeout(timer));
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  }

  private respondPermission(
    key: string,
    id: string | number,
    selected: string | null,
  ): void {
    const pending = this.permissions.get(key);
    if (!pending) return;
    this.permissions.delete(key);
    pending.controller.abort();
    void this.send({
      jsonrpc: "2.0",
      id,
      result: {
        outcome:
          selected === null
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: selected },
      },
    }).catch((e: Error) => this.fail(e));
  }

  private clearPermissions(sessionId: string): void {
    for (const [key, item] of this.permissions) {
      if (item.sessionId === sessionId) {
        const [kind, ...parts] = key.split(":");
        const value = parts.join(":");
        this.respondPermission(
          key,
          kind === "number" ? Number(value) : value,
          null,
        );
      }
    }
  }

  private fail(reason: Error): void {
    if (this.failure) return;
    this.failure = reason;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(reason);
    }
    this.pending.clear();
    for (const item of this.permissions.values()) item.controller.abort();
    this.permissions.clear();
    try {
      void Promise.resolve(this.transport.close?.()).catch(() => undefined);
    } catch {
      /* already closed */
    }
  }
}

function modelOption(result: AcpObject): AcpObject | undefined {
  return Array.isArray(result.configOptions)
    ? (result.configOptions.find((o) => object(o) && o.category === "model") as
        AcpObject | undefined)
    : undefined;
}
function currentModel(result: AcpObject): string | null {
  const current = modelOption(result)?.currentValue;
  if (typeof current === "string") return current;
  return object(result.models) &&
    typeof result.models.currentModelId === "string"
    ? result.models.currentModelId
    : null;
}
function modelSelection(
  result: AcpObject,
  required: string,
): { method: string; params: AcpObject } | null {
  const option = modelOption(result);
  const contains = (list: unknown): boolean =>
    Array.isArray(list) &&
    list.some(
      (v) => object(v) && (v.value === required || contains(v.options)),
    );
  if (option && typeof option.id === "string" && contains(option.options))
    return {
      method: "session/set_config_option",
      params: { configId: option.id, value: required },
    };
  if (
    object(result.models) &&
    Array.isArray(result.models.availableModels) &&
    result.models.availableModels.some(
      (v) => object(v) && v.modelId === required,
    )
  )
    return { method: "session/set_model", params: { modelId: required } };
  return null;
}
