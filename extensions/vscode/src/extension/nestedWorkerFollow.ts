import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatMessage } from "core";

import type { BridgeEvent } from "./bridgeEvents";
import { pollWorkerStatus } from "./bridgeUiClient";

const DELEGATION_TOOL_MARKERS = [
  "cursor_submit",
  "cursor_delegate",
  "broker_delegate",
  "mcp__cursor-bridge__cursor_submit",
  "mcp__cursor-bridge__cursor_delegate",
  "mcp__cukii-broker__broker_delegate",
] as const;

const LOG_PATH_RE = /\.(log|output\.log)$/i;
const MAX_TAIL_BYTES = 2048;
const BROKER_POLL_MS = 1500;

export type BrokerStatusPoller = (
  scope: string,
  taskId: string,
) => Promise<{ status?: string } | null>;

async function defaultBrokerPoller(
  scope: string,
  taskId: string,
): Promise<{ status?: string } | null> {
  try {
    const result = await pollWorkerStatus(scope, taskId);
    const status =
      (typeof result.worker_status === "string" && result.worker_status) ||
      (typeof result.status === "string" && result.status) ||
      undefined;
    return status ? { status } : null;
  } catch {
    return null;
  }
}

let brokerPoller: BrokerStatusPoller = defaultBrokerPoller;

/** Tests inject a fake poller so drain() never opens a live TCP socket. */
export function setBrokerStatusPollerForTests(
  poller?: BrokerStatusPoller,
): void {
  brokerPoller = poller ?? defaultBrokerPoller;
}

export type NestedWorkerTarget =
  | { kind: "log"; path: string; job?: string }
  | { kind: "broker"; taskId: string; scope: string; status?: string };

export interface LogTailer {
  readNew(): string;
  close(): void;
}

export interface NestedWorkerFollower {
  drain(): ChatMessage[];
  close(): void;
}

export function isDelegationTool(name: string): boolean {
  const lower = name.toLowerCase();
  return DELEGATION_TOOL_MARKERS.some((marker) => lower.includes(marker));
}

function tryParseJsonBlob(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const embedded = trimmed.match(/\{[\s\S]*\}/);
  if (embedded && embedded[0] !== trimmed) {
    candidates.push(embedded[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function looksLikeLogPath(value: string): boolean {
  return LOG_PATH_RE.test(value);
}

/** Tail only worker logs, never an arbitrary path from a tool payload. */
export function isAllowedLogPath(filePath: string): boolean {
  if (!looksLikeLogPath(filePath)) {
    return false;
  }
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return false;
  }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  const tmp = path.resolve(os.tmpdir()).replace(/\\/g, "/").toLowerCase();
  if (normalized === tmp || normalized.startsWith(`${tmp}/`)) {
    return true;
  }
  return (
    normalized.includes("/cursor-bridge/") ||
    normalized.includes("/logs/cukii") ||
    /\/cukii-[^/]+\.log$/.test(normalized)
  );
}

export function parseNestedWorker(output: string): NestedWorkerTarget | null {
  const parsed = tryParseJsonBlob(output);
  if (!parsed) {
    return null;
  }

  const logPath = asNonEmptyString(parsed.output);
  const job = asNonEmptyString(parsed.job);
  if (logPath && isAllowedLogPath(logPath)) {
    return { kind: "log", path: logPath, job };
  }

  const taskId =
    asNonEmptyString(parsed.task_id) ?? asNonEmptyString(parsed.task);
  const scope = asNonEmptyString(parsed.scope);
  if (taskId && scope) {
    return {
      kind: "broker",
      taskId,
      scope,
      status:
        asNonEmptyString(parsed.status) ??
        asNonEmptyString(parsed.worker_status),
    };
  }

  return null;
}

function isMostlyBinary(text: string): boolean {
  if (!text) {
    return false;
  }
  let nonPrintable = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) {
      nonPrintable++;
    }
  }
  return nonPrintable / text.length > 0.3;
}

export function createLogTailer(filePath: string): LogTailer {
  let offset = 0;
  let closed = false;

  return {
    readNew(): string {
      if (closed) {
        return "";
      }
      try {
        if (!fs.existsSync(filePath)) {
          return "";
        }
        const stat = fs.statSync(filePath);
        if (stat.size < offset) {
          offset = 0;
        }
        const unread = stat.size - offset;
        if (unread <= 0) {
          return "";
        }
        const toRead = Math.min(unread, MAX_TAIL_BYTES);
        const fd = fs.openSync(filePath, "r");
        try {
          const buffer = Buffer.alloc(toRead);
          const bytesRead = fs.readSync(fd, buffer, 0, toRead, offset);
          offset += bytesRead;
          const text = buffer.subarray(0, bytesRead).toString("utf8");
          if (text.includes("\0") || isMostlyBinary(text)) {
            return "";
          }
          return text;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    },
    close(): void {
      closed = true;
    },
  };
}

function followerHeader(target: NestedWorkerTarget): string {
  if (target.kind === "log") {
    if (target.job) {
      return `[Composer 2.5 job ${target.job}]\n`;
    }
    return `[nested worker ${path.basename(target.path)}]\n`;
  }
  const status = target.status ? ` status: ${target.status}` : "";
  return `[broker ${target.scope}/${target.taskId}]${status}\n`;
}

export function createNestedWorkerFollower(
  output: string,
): NestedWorkerFollower | null {
  const target = parseNestedWorker(output);
  if (!target) {
    return null;
  }

  if (target.kind === "log") {
    const tailer = createLogTailer(target.path);
    let headerSent = false;
    const header = followerHeader(target);
    return {
      drain(): ChatMessage[] {
        const chunk = tailer.readNew();
        if (!headerSent) {
          headerSent = true;
          return [{ role: "thinking", content: header + chunk }];
        }
        if (!chunk) {
          return [];
        }
        return [{ role: "thinking", content: chunk }];
      },
      close(): void {
        tailer.close();
      },
    };
  }

  const header = followerHeader(target);
  let lastEmitted = target.status ?? "";
  let lastKnown = lastEmitted;
  let headerSent = false;
  let inFlight = false;
  let lastPoll = 0;
  let closed = false;

  const kickPoll = () => {
    if (closed || inFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastPoll < BROKER_POLL_MS && lastPoll !== 0) {
      return;
    }
    lastPoll = now;
    inFlight = true;
    void brokerPoller(target.scope, target.taskId)
      .then((snapshot) => {
        if (snapshot?.status) {
          lastKnown = snapshot.status;
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    drain(): ChatMessage[] {
      const messages: ChatMessage[] = [];
      if (!headerSent) {
        headerSent = true;
        messages.push({ role: "thinking", content: header });
      }
      kickPoll();
      if (lastKnown && lastKnown !== lastEmitted) {
        lastEmitted = lastKnown;
        messages.push({
          role: "thinking",
          content: `[broker ${target.scope}/${target.taskId}] status: ${lastKnown}\n`,
        });
      }
      return messages;
    },
    close(): void {
      closed = true;
    },
  };
}

export function drainFollowers(
  followers: NestedWorkerFollower[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const follower of followers) {
    messages.push(...follower.drain());
  }
  return messages;
}

export function closeFollowers(followers: NestedWorkerFollower[]): void {
  for (const follower of followers) {
    follower.close();
  }
  followers.length = 0;
}

export function registerNestedWorkerFollower(
  event: BridgeEvent,
  toolNamesById: Map<string, string>,
  followers: NestedWorkerFollower[],
): void {
  if (event.kind === "toolStart") {
    toolNamesById.set(event.id, event.name);
    return;
  }
  if (event.kind !== "toolResult") {
    return;
  }
  const toolName = toolNamesById.get(event.id) ?? "";
  if (!isDelegationTool(toolName)) {
    return;
  }
  const follower = createNestedWorkerFollower(event.output);
  if (follower) {
    followers.push(follower);
  }
}
