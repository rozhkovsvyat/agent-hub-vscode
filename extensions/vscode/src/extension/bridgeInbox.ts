import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * File inbox for live steering messages to vendors without a stdin channel.
 * The plugin side of `broker/inbox.py`: publish writes a record while the run
 * is live, the vendor agent claims it through the `broker_inbox` MCP tool
 * between steps, and the read mark lets the turn-end drain skip redelivery.
 * Format and root must stay mirror-compatible with the Python reader.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type BridgeInboxStatus = "read" | "pending" | "absent";

type InboxRecord = {
  id: string;
  sessionId: string;
  text: string;
  createdMs: number;
  status: "read" | "pending";
  readAt?: string;
};

export function bridgeInboxRoot(): string {
  return (
    process.env.CUKII_INBOX_DIR ||
    path.join(os.homedir(), ".continue", "cukii-inbox")
  );
}

function sessionDir(sessionId: string): string | undefined {
  if (!SAFE_SEGMENT.test(sessionId)) return undefined;
  return path.join(bridgeInboxRoot(), sessionId);
}

function recordFileName(createdMs: number, messageId: string): string {
  const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return `${createdMs}-${safeId}.json`;
}

function readRecord(file: string): InboxRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as InboxRecord;
    if (typeof record?.id === "string" && typeof record?.status === "string") {
      return record;
    }
  } catch {
    // Torn or foreign file: the drain fallback still owns the message.
  }
  return undefined;
}

function listSessionFiles(sessionId: string): string[] {
  const dir = sessionDir(sessionId);
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function purgeExpired(dir: string): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const file of listSessionFiles(path.basename(dir))) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Another writer already retired the record.
    }
  }
}

export function writeBridgeInboxMessage(
  sessionId: string,
  messageId: string,
  text: string,
): boolean {
  const dir = sessionDir(sessionId);
  if (!dir || !SAFE_SEGMENT.test(messageId) || !text.trim()) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    purgeExpired(dir);
    const record: InboxRecord = {
      id: messageId,
      sessionId,
      text,
      createdMs: Date.now(),
      status: "pending",
    };
    const target = path.join(dir, recordFileName(record.createdMs, messageId));
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8" });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    // The durable GUI outbox still delivers at the turn boundary.
    return false;
  }
}

export function bridgeInboxMessageStatus(
  sessionId: string,
  messageId: string,
): BridgeInboxStatus {
  for (const file of listSessionFiles(sessionId)) {
    if (!file.endsWith(`-${messageId}.json`)) continue;
    const record = readRecord(file);
    if (record?.id === messageId) return record.status;
  }
  return "absent";
}

/** Explicit user Stop: unread inbox entries must not resurrect on the next run. */
export function purgeUnreadBridgeInboxMessages(sessionId: string): void {
  for (const file of listSessionFiles(sessionId)) {
    const record = readRecord(file);
    if (record?.status === "pending") {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already claimed or removed.
      }
    }
  }
}

/** Message ids that the vendor tool has already claimed (status "read"). */
export function readBridgeInboxMessageIds(sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listSessionFiles(sessionId)) {
    const record = readRecord(file);
    if (record?.status === "read") ids.add(record.id);
  }
  return ids;
}

/**
 * Polls one session's inbox while a non-live run is in flight and reports
 * message ids the vendor tool has claimed since the previous tick. Gives the
 * GUI its messenger-style read receipt without waiting for the turn to end.
 */
export class BridgeInboxWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seenRead = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly onRead: (messageId: string) => void,
  ) {}

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  tick(): void {
    for (const id of readBridgeInboxMessageIds(this.sessionId)) {
      if (!this.seenRead.has(id)) {
        this.seenRead.add(id);
        this.onRead(id);
      }
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
