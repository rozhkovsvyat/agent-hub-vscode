import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getContinueGlobalPath } from "core/util/paths";

/**
 * File inbox for live steering messages to vendors without a stdin channel.
 * The plugin side of `broker/inbox.py`: publish writes a record while the run
 * is live, the vendor agent claims it through the `broker_inbox` MCP tool
 * between steps, and the read mark lets the turn-end drain skip redelivery.
 * Format and root must stay mirror-compatible with the Python reader.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 10;
const STOP_LOCK_WAIT_MS = LOCK_STALE_MS + 5_000;
const CLAIM_LOCK = ".claim-lock";

export type BridgeInboxStatus = "read" | "pending" | "absent";

type InboxRecord = {
  id: string;
  sessionId: string;
  text: string;
  createdMs: number;
  status: "read" | "pending";
  readAt?: string;
  leaseOwner?: string;
  leasePid?: number;
  leaseProcessStartToken?: string;
  leaseUntilMs?: number;
  attachmentScope?: string;
  attachmentFiles?: string[];
  payloadDigest?: string;
};

export type BridgeInboxWriteMetadata = {
  /** Trusted parent used only while validating/retiring a peer scope. */
  attachmentRoot?: string;
  attachmentScope?: string;
  attachmentFiles?: string[];
  payloadDigest?: string;
};

export type BridgeInboxWriteReceipt = {
  accepted: boolean;
  created: boolean;
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

function sleepSync(durationMs: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    durationMs,
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * Age is the only reclaim signal, byte for byte what `_session_lock` in
 * `broker/inbox.py` does. Both parties must agree on when a lock is dead: a
 * host that reclaims on some extra signal the other side never maintains
 * (a liveness marker, an owner pid file) will evict the other's *live*
 * critical section, because that signal outlives the lock it described.
 * Widening this condition therefore requires changing both languages at once.
 */
function reclaimStaleSessionLock(lock: string): void {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
    fs.rmdirSync(lock);
  } catch {
    // The owner may have released the lock between stat and reclaim.
  }
}

/**
 * Nothing may be written inside the lock directory, nor beside it under a
 * `.claim-lock*` name: Python reclaims with `rmdir()`, which fails on a
 * non-empty directory, so any such state would strand a crashed host's lock.
 */
function tryAcquireSessionLock(dir: string): string | undefined {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, CLAIM_LOCK);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    reclaimStaleSessionLock(lock);
    return undefined;
  }
  return lock;
}

function releaseSessionLock(lock: string): void {
  try {
    fs.rmdirSync(lock);
  } catch {
    // A crashed/reclaimed lock must not turn delivery into a second error.
  }
}

/**
 * Mirror the Python broker's per-session `.claim-lock`. Every TypeScript
 * mutation must participate in the same inter-process critical section, or
 * two extension hosts can both accept one message id.
 */
function withSessionLock<T>(dir: string, action: () => T): T {
  let lock: string | undefined;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    lock = tryAcquireSessionLock(dir);
    if (lock) break;
    sleepSync(LOCK_RETRY_MS);
  }
  if (!lock) {
    throw new Error("Cukii inbox claim lock is busy");
  }
  try {
    return action();
  } finally {
    releaseSessionLock(lock);
  }
}

async function withSessionLockUntilAvailable<T>(
  dir: string,
  action: () => T,
): Promise<T> {
  const deadline = Date.now() + STOP_LOCK_WAIT_MS;
  let lock: string | undefined;
  while (Date.now() <= deadline) {
    lock = tryAcquireSessionLock(dir);
    if (lock) break;
    await sleep(LOCK_RETRY_MS);
  }
  if (!lock) {
    throw new Error("Cukii inbox claim lock remained busy during Stop");
  }
  try {
    return action();
  } finally {
    releaseSessionLock(lock);
  }
}

function bridgeAttachmentRoot(): string {
  return path.join(getContinueGlobalPath(), "bridge-attachments");
}

function removeRecordAttachmentScope(
  record: InboxRecord,
  attachmentRoot: string,
): void {
  const candidate = record.attachmentScope;
  if (!candidate || !path.isAbsolute(candidate)) return;
  let root = path.resolve(attachmentRoot);
  let resolved = path.resolve(candidate);
  try {
    root = fs.realpathSync.native(root);
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    resolved = fs.realpathSync.native(resolved);
  } catch {
    return;
  }
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    return;
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // The scope may already have been retired by normal image housekeeping.
  }
}

function recordAttachmentScopeIsUsable(
  record: InboxRecord,
  attachmentRoot?: string,
): boolean {
  if (
    !record.attachmentScope ||
    !path.isAbsolute(record.attachmentScope) ||
    !Array.isArray(record.attachmentFiles) ||
    record.attachmentFiles.length === 0
  ) {
    return false;
  }
  try {
    const stats = fs.lstatSync(record.attachmentScope);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const scope = fs.realpathSync.native(record.attachmentScope);
    if (attachmentRoot) {
      const root = fs.realpathSync.native(attachmentRoot);
      if (!isDirectChild(scope, root)) return false;
    }
    return record.attachmentFiles.every((file) => {
      if (typeof file !== "string" || !path.isAbsolute(file)) return false;
      const resolved = path.resolve(file);
      if (!isDirectChild(resolved, scope) || !record.text.includes(file)) {
        return false;
      }
      const fileStats = fs.lstatSync(resolved);
      return (
        fileStats.isFile() &&
        !fileStats.isSymbolicLink() &&
        fs.realpathSync.native(path.dirname(resolved)) === scope &&
        SAFE_DIGEST.test(path.basename(resolved, path.extname(resolved))) &&
        createHash("sha256").update(fs.readFileSync(resolved)).digest("hex") ===
          path.basename(resolved, path.extname(resolved))
      );
    });
  } catch {
    return false;
  }
}

function isDirectChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  );
}

function replacePendingAttachmentRecord(
  file: string,
  existing: InboxRecord,
  text: string,
  metadata: BridgeInboxWriteMetadata,
): void {
  const replacement: InboxRecord = {
    ...existing,
    text,
    status: "pending",
    attachmentScope: metadata.attachmentScope,
    attachmentFiles: metadata.attachmentFiles,
    payloadDigest: metadata.payloadDigest,
  };
  delete replacement.readAt;
  delete replacement.leaseOwner;
  delete replacement.leasePid;
  delete replacement.leaseProcessStartToken;
  delete replacement.leaseUntilMs;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(replacement), { encoding: "utf8" });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

function purgeExpired(dir: string): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const file of listSessionFiles(path.basename(dir))) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        const record = readRecord(file);
        fs.unlinkSync(file);
        if (record) removeRecordAttachmentScope(record, bridgeAttachmentRoot());
      }
    } catch {
      // Another writer already retired the record.
    }
  }
}

export function writeBridgeInboxMessageWithReceipt(
  sessionId: string,
  messageId: string,
  text: string,
  metadata: BridgeInboxWriteMetadata = {},
): BridgeInboxWriteReceipt {
  const dir = sessionDir(sessionId);
  if (
    !dir ||
    !SAFE_SEGMENT.test(messageId) ||
    !text.trim() ||
    (metadata.payloadDigest !== undefined &&
      !SAFE_DIGEST.test(metadata.payloadDigest)) ||
    (metadata.attachmentScope !== undefined &&
      !path.isAbsolute(metadata.attachmentScope)) ||
    (metadata.attachmentRoot !== undefined &&
      !path.isAbsolute(metadata.attachmentRoot)) ||
    (metadata.attachmentFiles !== undefined &&
      (!Array.isArray(metadata.attachmentFiles) ||
        metadata.attachmentFiles.length === 0 ||
        metadata.attachmentFiles.some((file) => !path.isAbsolute(file)))) ||
    Boolean(metadata.attachmentScope) !== Boolean(metadata.attachmentFiles)
  ) {
    return { accepted: false, created: false };
  }
  if (
    metadata.attachmentScope &&
    !recordAttachmentScopeIsUsable(
      {
        id: messageId,
        sessionId,
        text,
        createdMs: Date.now(),
        status: "pending",
        attachmentScope: metadata.attachmentScope,
        attachmentFiles: metadata.attachmentFiles,
        payloadDigest: metadata.payloadDigest,
      },
      metadata.attachmentRoot,
    )
  ) {
    return { accepted: false, created: false };
  }
  try {
    return withSessionLock(dir, () => {
      purgeExpired(dir);
      // messageId is the transport idempotency key. For image-bearing retries,
      // the rendered @path changes with every isolated peer scope, so compare
      // the digest of the original MessageContent rather than that path.
      for (const file of listSessionFiles(sessionId)) {
        const existing = readRecord(file);
        if (existing?.id !== messageId) continue;
        const samePayload = metadata.payloadDigest
          ? existing.payloadDigest === metadata.payloadDigest
          : existing.text === text;
        const attachmentUsable = metadata.attachmentScope
          ? recordAttachmentScopeIsUsable(existing, metadata.attachmentRoot)
          : true;
        if (
          existing.status === "pending" &&
          samePayload &&
          metadata.attachmentScope &&
          !attachmentUsable
        ) {
          replacePendingAttachmentRecord(file, existing, text, metadata);
          if (
            existing.attachmentScope &&
            path.resolve(existing.attachmentScope) !==
              path.resolve(metadata.attachmentScope)
          ) {
            removeRecordAttachmentScope(
              existing,
              metadata.attachmentRoot ?? bridgeAttachmentRoot(),
            );
          }
          return { accepted: true, created: true };
        }
        return {
          accepted:
            existing.sessionId === sessionId &&
            samePayload &&
            (existing.status === "read" || attachmentUsable),
          created: false,
        };
      }
      const record: InboxRecord = {
        id: messageId,
        sessionId,
        text,
        createdMs: Date.now(),
        status: "pending",
        ...(metadata.attachmentScope
          ? { attachmentScope: metadata.attachmentScope }
          : {}),
        ...(metadata.attachmentFiles
          ? { attachmentFiles: metadata.attachmentFiles }
          : {}),
        ...(metadata.payloadDigest
          ? { payloadDigest: metadata.payloadDigest }
          : {}),
      };
      const target = path.join(
        dir,
        recordFileName(record.createdMs, messageId),
      );
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8" });
        fs.renameSync(tmp, target);
      } finally {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // The atomic rename already consumed the temporary file.
        }
      }
      return { accepted: true, created: true };
    });
  } catch {
    // The durable GUI outbox still delivers at the turn boundary.
    return { accepted: false, created: false };
  }
}

export function writeBridgeInboxMessage(
  sessionId: string,
  messageId: string,
  text: string,
  metadata: BridgeInboxWriteMetadata = {},
): boolean {
  return writeBridgeInboxMessageWithReceipt(
    sessionId,
    messageId,
    text,
    metadata,
  ).accepted;
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

/**
 * Direct prompt delivery is the durable fallback for MCP/hook failures. Mark
 * its exact batch read only after factual vendor stdout, never at child spawn.
 */
export function markBridgeInboxMessagesRead(
  sessionId: string,
  messageIds: string[],
): string[] {
  const wanted = new Set(messageIds.filter((id) => SAFE_SEGMENT.test(id)));
  if (!wanted.size) return [];
  const dir = sessionDir(sessionId);
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return withSessionLock(dir, () => {
      const acked: string[] = [];
      for (const file of listSessionFiles(sessionId)) {
        const record = readRecord(file);
        if (record?.status !== "pending" || !wanted.has(record.id)) {
          continue;
        }
        const updated: InboxRecord = {
          ...record,
          status: "read",
          readAt: new Date().toISOString(),
        };
        delete updated.leaseOwner;
        delete updated.leasePid;
        delete updated.leaseProcessStartToken;
        delete updated.leaseUntilMs;
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmp, JSON.stringify(updated), { encoding: "utf8" });
          fs.renameSync(tmp, file);
          acked.push(record.id);
        } catch {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // No temporary file was created.
          }
        }
      }
      return acked;
    });
  } catch {
    return [];
  }
}

/** Explicit user Stop: unread inbox entries must not resurrect on the next run. */
export async function purgeUnreadBridgeInboxMessages(
  sessionId: string,
  attachmentRoot: string = bridgeAttachmentRoot(),
): Promise<boolean> {
  const dir = sessionDir(sessionId);
  if (!dir || !fs.existsSync(dir)) return true;
  try {
    await withSessionLockUntilAvailable(dir, () => {
      for (const file of listSessionFiles(sessionId)) {
        const record = readRecord(file);
        if (record?.status === "pending") {
          try {
            fs.unlinkSync(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
          removeRecordAttachmentScope(record, attachmentRoot);
        }
      }
    });
    return true;
  } catch {
    return false;
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
