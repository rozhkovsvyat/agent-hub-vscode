import { randomUUID } from "node:crypto";
import net from "node:net";
import { JsonlFrameReader } from "./claudePermissionJsonl";

export { JsonlFrameReader } from "./claudePermissionJsonl";

type JsonRpcId = string | number | null;
type JsonRpc = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};
export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny" };
const TOOL_NAME = "request";
const MAX_FRAME_BYTES = 64 * 1024;
function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function resultFrame(
  id: JsonRpcId | undefined,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function errorFrame(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export class PermissionPipeClient {
  private socket?: net.Socket;
  private readonly frames = new JsonlFrameReader(MAX_FRAME_BYTES);
  private connecting?: Promise<boolean>;
  private readonly pending = new Map<
    string,
    { resolve: (result: PermissionResult) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private readonly connection: {
      pipeName: string;
      token: string;
      sessionId: string;
    },
  ) {}
  async request(args: {
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
    timeoutMs?: number;
  }): Promise<PermissionResult> {
    if (!(await this.connect())) return { behavior: "deny" };
    const wireRequestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(wireRequestId);
          resolve({ behavior: "deny" });
        },
        args.timeoutMs ?? 5 * 60_000,
      );
      this.pending.set(wireRequestId, { resolve, timer });
      this.socket!.write(
        `${JSON.stringify({ type: "permission", wireRequestId, tool_name: args.toolName, input: args.input, ...(args.toolUseId ? { tool_use_id: args.toolUseId } : {}) })}\n`,
      );
    });
  }
  async connect(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return true;
    if (this.connecting) return this.connecting;
    const attempt = new Promise<boolean>((resolve) => {
      const socket = net.createConnection(this.connection.pipeName);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (!ok) socket.destroy();
        resolve(ok);
      };
      socket.once("error", () => {
        this.failAll();
        finish(false);
      });
      socket.once("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.failAll();
        finish(false);
      });
      socket.once("connect", () =>
        socket.write(
          `${JSON.stringify({ type: "auth", token: this.connection.token, sessionId: this.connection.sessionId })}\n`,
        ),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const incoming of this.frames.push(chunk)) {
          // A corrupt response must not poison unrelated requests. The owner
          // of the discarded response remains fail-closed through its timer.
          if (incoming.type === "oversize") continue;
          const { line } = incoming;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line) as Record<string, unknown>;
          } catch {
            this.failAll();
            socket.destroy();
            return;
          }
          if (!settled) {
            if (frame.type !== "authenticated") {
              socket.destroy();
              return finish(false);
            }
            this.socket = socket;
            finish(true);
            continue;
          }
          if (
            frame.type !== "permissionResult" ||
            typeof frame.wireRequestId !== "string"
          )
            continue;
          const pending = this.pending.get(frame.wireRequestId);
          if (!pending) continue;
          this.pending.delete(frame.wireRequestId);
          clearTimeout(pending.timer);
          pending.resolve(
            frame.behavior === "allow" &&
              frame.updatedInput &&
              typeof frame.updatedInput === "object" &&
              !Array.isArray(frame.updatedInput)
              ? {
                  behavior: "allow",
                  updatedInput: frame.updatedInput as Record<string, unknown>,
                }
              : { behavior: "deny" },
          );
        }
      });
    });
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = undefined;
    }
  }
  dispose(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.failAll();
  }
  private failAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny" });
    }
    this.pending.clear();
  }
}

let sharedClient: PermissionPipeClient | undefined;
function environmentClient(): PermissionPipeClient | undefined {
  if (sharedClient) return sharedClient;
  const pipeName = process.env.CUKII_PERMISSION_PIPE,
    token = process.env.CUKII_PERMISSION_TOKEN,
    sessionId = process.env.CUKII_PERMISSION_SESSION;
  if (!pipeName || !token || !sessionId) return undefined;
  return (sharedClient = new PermissionPipeClient({
    pipeName,
    token,
    sessionId,
  }));
}
export function resetPermissionPipeClientForTests(): void {
  sharedClient?.dispose();
  sharedClient = undefined;
}
export async function requestPermissionOverPipe(args: {
  pipeName: string;
  token: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  timeoutMs?: number;
}): Promise<PermissionResult> {
  const client = new PermissionPipeClient(args);
  try {
    return await client.request(args);
  } finally {
    client.dispose();
  }
}
function toolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      "Ask the Cukii user to approve or deny a Claude tool invocation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool_name", "input"],
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
    },
  };
}
function parseRequest(value: unknown): {
  request?: JsonRpc;
  error?: Record<string, unknown>;
  notification?: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: errorFrame(undefined, -32600, "Invalid Request") };
  const raw = value as Record<string, unknown>;
  const rawId = raw.id;
  const idValid =
    rawId === undefined ||
    rawId === null ||
    typeof rawId === "string" ||
    (typeof rawId === "number" && Number.isFinite(rawId));
  if (
    raw.jsonrpc !== "2.0" ||
    typeof raw.method !== "string" ||
    !raw.method ||
    !idValid ||
    (raw.params !== undefined &&
      (!raw.params ||
        typeof raw.params !== "object" ||
        Array.isArray(raw.params)))
  )
    return {
      error: errorFrame(
        idValid ? (rawId as JsonRpcId) : undefined,
        -32600,
        "Invalid Request",
      ),
    };
  return { request: raw as JsonRpc, notification: raw.id === undefined };
}
export async function mcpResponseForMessage(
  value: unknown,
): Promise<Record<string, unknown> | undefined> {
  const parsed = parseRequest(value);
  if (parsed.error) return parsed.error;
  const message = parsed.request!;
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "initialize")
    return parsed.notification
      ? undefined
      : resultFrame(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cukii_permission", version: "1.0.0" },
        });
  if (message.method === "tools/list")
    return parsed.notification
      ? undefined
      : resultFrame(message.id, { tools: [toolDefinition()] });
  if (message.method !== "tools/call")
    return parsed.notification
      ? undefined
      : errorFrame(message.id, -32601, "Method not found");
  const name = message.params?.name,
    args = message.params?.arguments;
  if (
    name !== TOOL_NAME ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return parsed.notification
      ? undefined
      : errorFrame(message.id, -32602, "Invalid permission request");
  const fields = args as Record<string, unknown>;
  const toolName = fields.tool_name,
    input = fields.input,
    toolUseId = fields.tool_use_id;
  if (
    typeof toolName !== "string" ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (toolUseId !== undefined && typeof toolUseId !== "string")
  )
    return parsed.notification
      ? undefined
      : errorFrame(message.id, -32602, "Invalid permission request");
  const decision = await (environmentClient()?.request({
    toolName,
    input: input as Record<string, unknown>,
    ...(typeof toolUseId === "string" ? { toolUseId } : {}),
  }) ?? Promise.resolve({ behavior: "deny" as const }));
  return parsed.notification
    ? undefined
    : resultFrame(message.id, {
        content: [{ type: "text", text: JSON.stringify(decision) }],
      });
}
export async function handleMcpMessage(message: unknown): Promise<void> {
  const response = await mcpResponseForMessage(message);
  if (response) write(response);
}
export function startMcpStdio(): void {
  const frames = new JsonlFrameReader(MAX_FRAME_BYTES);
  process.stdin.on("data", (chunk: Buffer) => {
    for (const incoming of frames.push(chunk)) {
      if (incoming.type === "oversize") {
        write(errorFrame(undefined, -32700, "Parse error"));
        continue;
      }
      const { line } = incoming;
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        write(errorFrame(undefined, -32700, "Parse error"));
        continue;
      }
      void handleMcpMessage(parsed).catch(() =>
        write(
          errorFrame(
            (parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>).id
              : undefined) as JsonRpcId | undefined,
            -32603,
            "Internal error",
          ),
        ),
      );
    }
  });
  process.stdin.once("close", () => resetPermissionPipeClientForTests());
}
if (require.main === module) startMcpStdio();
