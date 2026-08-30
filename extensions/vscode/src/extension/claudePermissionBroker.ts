import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { CukiiPermissionMode } from "core/protocol/ideWebview";
import { JsonlFrameReader } from "./claudePermissionJsonl";
import {
  CUKII_PERMISSION_SCRATCH_ROOT,
  createCukiiScratchDirectory,
  removeCukiiScratchDirectory,
} from "./bridgeScratch";

export type ClaudePermissionDecision = "allow" | "deny";
export type ClaudePermissionRequest = {
  runId: string;
  requestId: string;
  sessionId: string;
  inputFingerprint: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
};
export type ClaudePermissionBrokerOptions = {
  panelId: string;
  sessionId: string;
  mode: Exclude<CukiiPermissionMode, "bypass">;
  onRequest: (request: ClaudePermissionRequest) => Promise<void> | void;
  timeoutMs?: number;
  workerPath?: string;
  /** Test seam; production always uses the owner-only platform implementation. */
  restrictDirectory?: (directory: string) => void;
};
type Pending = ClaudePermissionRequest & {
  resolve: (decision: ClaudePermissionDecision) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
};
type WireFrame = Record<string, unknown>;
const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function stableInput(value: Record<string, unknown>): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, nested]) => [key, sort(nested)]),
          )
        : item;
  return JSON.stringify(sort(value));
}
export function permissionInputFingerprint(
  input: Record<string, unknown>,
): string {
  return createHash("sha256").update(stableInput(input)).digest("hex");
}
function writeFrame(socket: net.Socket, frame: WireFrame): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}
function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function restrictPrivateDirectory(directory: string): void {
  fs.chmodSync(directory, 0o700);
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user)
    throw new Error(
      "Cannot create private MCP directory: USERNAME is unavailable.",
    );
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "icacls.exe")
    : "icacls.exe";
  const result = spawnSync(
    executable,
    [directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`],
    { shell: false, windowsHide: true, encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new Error("Cannot create owner-only MCP directory ACL.");
}

export class ClaudePermissionBroker {
  readonly runId = randomUUID();
  readonly token = randomBytes(32).toString("hex");
  readonly pipeName = `\\\\.\\pipe\\cukii-permission-${randomUUID()}`;
  readonly configDirectory = createCukiiScratchDirectory(
    CUKII_PERMISSION_SCRATCH_ROOT,
    "claude-permission",
  );
  readonly configPath = path.join(this.configDirectory, "mcp.json");
  private readonly pending = new Map<string, Pending>();
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;
  private disposed = false;
  private authenticationConsumed = false;
  private authenticatedSocket?: net.Socket;
  constructor(private readonly options: ClaudePermissionBrokerOptions) {}

  async start(): Promise<void> {
    if (this.server || this.disposed)
      throw new Error("Permission broker cannot be started twice.");
    try {
      (this.options.restrictDirectory ?? restrictPrivateDirectory)(
        this.configDirectory,
      );
      const workerPath =
        this.options.workerPath ??
        path.join(__dirname, "claudePermissionMcpWorker.js");
      const config = {
        mcpServers: {
          cukii_permission: {
            command: process.execPath,
            args: [workerPath],
            env: {
              CUKII_PERMISSION_PIPE: this.pipeName,
              CUKII_PERMISSION_TOKEN: this.token,
              CUKII_PERMISSION_SESSION: this.options.sessionId,
            },
          },
        },
      };
      const temporary = path.join(
        this.configDirectory,
        `.mcp-${randomUUID()}.tmp`,
      );
      fs.writeFileSync(temporary, JSON.stringify(config), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, this.configPath);
      this.server = net.createServer((socket) => this.handleSocket(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.pipeName, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      await this.cleanupResources();
      throw error;
    }
  }
  claudeArgs(): string[] {
    return [
      "--mcp-config",
      this.configPath,
      "--strict-mcp-config",
      "--allowed-tools",
      "mcp__cukii_permission__request",
      "--permission-prompt-tool",
      "mcp__cukii_permission__request",
    ];
  }
  respond(response: {
    runId: string;
    requestId: string;
    sessionId: string;
    inputFingerprint: string;
    decision: ClaudePermissionDecision;
  }): boolean {
    if (
      this.disposed ||
      response.runId !== this.runId ||
      response.sessionId !== this.options.sessionId
    )
      return false;
    const pending = this.pending.get(response.requestId);
    if (
      !pending ||
      pending.settled ||
      pending.inputFingerprint !== response.inputFingerprint
    )
      return false;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolve(response.decision);
    return true;
  }
  denyAll(): void {
    for (const request of this.pending.values())
      if (!request.settled) {
        request.settled = true;
        clearTimeout(request.timer);
        request.resolve("deny");
      }
    this.pending.clear();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.denyAll();
    await this.cleanupResources();
  }
  private async cleanupResources(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.authenticatedSocket = undefined;
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    removeCukiiScratchDirectory(
      this.configDirectory,
      CUKII_PERMISSION_SCRATCH_ROOT,
    );
  }
  private handleSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    let authenticated = false;
    const frames = new JsonlFrameReader(MAX_FRAME_BYTES);
    socket.on("data", (chunk: Buffer) => {
      for (const incoming of frames.push(chunk)) {
        if (incoming.type === "oversize") {
          // Do not discard valid frames later in this same data chunk. An
          // oversized request has no trustworthy correlation id, so deny it.
          writeFrame(socket, {
            type: "permissionResult",
            wireRequestId: "",
            behavior: "deny",
          });
          continue;
        }
        const { line } = incoming;
        if (!line.trim()) continue;
        let frame: WireFrame;
        try {
          frame = JSON.parse(line) as WireFrame;
        } catch {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          const valid =
            !this.authenticationConsumed &&
            frame.type === "auth" &&
            typeof frame.token === "string" &&
            typeof frame.sessionId === "string" &&
            secureEqual(frame.token, this.token) &&
            secureEqual(frame.sessionId, this.options.sessionId);
          if (!valid) {
            socket.destroy();
            return;
          }
          this.authenticationConsumed = true;
          this.authenticatedSocket = socket;
          authenticated = true;
          writeFrame(socket, { type: "authenticated" });
          continue;
        }
        if (
          socket !== this.authenticatedSocket ||
          frame.type !== "permission"
        ) {
          writeFrame(socket, {
            type: "permissionResult",
            wireRequestId: frame.wireRequestId,
            behavior: "deny",
          });
          continue;
        }
        void this.handlePermissionFrame(socket, frame).catch(() =>
          writeFrame(socket, {
            type: "permissionResult",
            wireRequestId: frame.wireRequestId,
            behavior: "deny",
          }),
        );
      }
    });
    socket.once("error", () => socket.destroy());
    socket.once("close", () => {
      this.sockets.delete(socket);
      if (this.authenticatedSocket === socket)
        this.authenticatedSocket = undefined;
    });
  }
  private async handlePermissionFrame(
    socket: net.Socket,
    frame: WireFrame,
  ): Promise<void> {
    const wireRequestId =
      typeof frame.wireRequestId === "string" ? frame.wireRequestId : "";
    const toolName = typeof frame.tool_name === "string" ? frame.tool_name : "";
    const input = frame.input;
    const reply = (result: WireFrame) =>
      writeFrame(socket, {
        type: "permissionResult",
        wireRequestId,
        ...result,
      });
    if (
      !wireRequestId ||
      !toolName ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      this.disposed
    )
      return reply({ behavior: "deny" });
    const requestId = randomUUID();
    const request: ClaudePermissionRequest = {
      runId: this.runId,
      requestId,
      sessionId: this.options.sessionId,
      inputFingerprint: permissionInputFingerprint(
        input as Record<string, unknown>,
      ),
      toolName,
      input: input as Record<string, unknown>,
      ...(typeof frame.tool_use_id === "string"
        ? { toolUseId: frame.tool_use_id }
        : {}),
    };
    const decision = await new Promise<ClaudePermissionDecision>((resolve) => {
      const pending: Pending = {
        ...request,
        resolve,
        settled: false,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          pending.settled = true;
          resolve("deny");
        }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      };
      this.pending.set(requestId, pending);
      Promise.resolve(this.options.onRequest(request)).catch(() =>
        this.respond({ ...request, decision: "deny" }),
      );
    });
    reply(
      decision === "allow"
        ? { behavior: "allow", updatedInput: request.input }
        : { behavior: "deny" },
    );
  }
}
