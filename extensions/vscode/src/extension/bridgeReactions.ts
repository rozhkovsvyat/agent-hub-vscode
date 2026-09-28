import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CukiiUserMessageReaction,
  CukiiUserReactionEmoji,
} from "core/protocol/ideWebview";
import {
  readRunBindingForPid,
  type CukiiRunBinding,
} from "@cukii/vendor-bridge";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const REACTION_EMOJIS = new Set<CukiiUserReactionEmoji>([
  "❤️",
  "😂",
  "👍",
  "🔥",
  "👏",
  "😮",
  "😢",
  "🤝",
]);

type ReactionRecord = {
  id: string;
  sessionId: string;
  runId: string;
  producerNonce: string;
  createdMs: number;
  status: "pending";
  emoji: CukiiUserReactionEmoji;
};

export function bridgeReactionsRoot(): string {
  return (
    process.env.CUKII_REACTIONS_DIR ||
    path.join(os.homedir(), ".continue", "cukii-reactions")
  );
}

function readReactionRecord(file: string): ReactionRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as ReactionRecord;
    if (
      SAFE_SEGMENT.test(record?.id ?? "") &&
      SAFE_SEGMENT.test(record?.sessionId ?? "") &&
      SAFE_SEGMENT.test(record?.runId ?? "") &&
      /^[a-f0-9]{64}$/.test(record?.producerNonce ?? "") &&
      Number.isSafeInteger(record?.createdMs) &&
      record?.status === "pending" &&
      REACTION_EMOJIS.has(record?.emoji)
    ) {
      return record;
    }
  } catch {
    // A torn, stale or foreign record is never surfaced to the panel.
  }
  return undefined;
}

function listReactionRecords(
  sessionId: string,
): { file: string; record: ReactionRecord }[] {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  const directory = path.join(bridgeReactionsRoot(), sessionId);
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        file: path.join(directory, name),
        record: readReactionRecord(path.join(directory, name)),
      }))
      .filter(
        (item): item is { file: string; record: ReactionRecord } =>
          Boolean(item.record) && item.record?.sessionId === sessionId,
      )
      .sort((left, right) => left.record.createdMs - right.record.createdMs);
  } catch {
    return [];
  }
}

/**
 * Validates MCP reaction records against the exact native process binding and
 * emits at most one event for a run. A model can ask; only this host-owned
 * authority can attach the reaction to a transcript message.
 */
export class BridgeReactionBroker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private binding: CukiiRunBinding | undefined;
  private delivered = false;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private messageId: string,
    private readonly onReaction: (reaction: CukiiUserMessageReaction) => void,
    private readonly bindingReader: typeof readRunBindingForPid = readRunBindingForPid,
  ) {}

  /** The newest user bubble the exact native run has actually accepted. */
  setTargetMessage(messageId: string): boolean {
    if (this.delivered || messageId.length === 0) return false;
    this.messageId = messageId;
    return true;
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  bindVendorProcess(
    vendorPid: number,
    verifiedBinding?: CukiiRunBinding,
  ): boolean {
    const binding = verifiedBinding ?? this.bindingReader(vendorPid);
    if (
      !binding ||
      binding.vendorPid !== vendorPid ||
      binding.sessionId !== this.sessionId ||
      binding.runId !== this.runId
    ) {
      return false;
    }
    this.binding = binding;
    this.tick();
    return true;
  }

  tick(now = Date.now()): void {
    if (!this.binding || this.delivered) return;
    const candidate = listReactionRecords(this.sessionId).find(
      ({ record }) =>
        record.runId === this.runId &&
        record.producerNonce === this.binding?.nonce &&
        record.createdMs >=
          (this.binding?.createdMs ?? Number.MAX_SAFE_INTEGER) &&
        record.createdMs <= now + 5_000,
    );
    if (!candidate) return;
    this.onReaction({
      sessionId: this.sessionId,
      runId: this.runId,
      reactionId: candidate.record.id,
      messageId: this.messageId,
      emoji: candidate.record.emoji,
      reactedAt: candidate.record.createdMs,
    });
    this.delivered = true;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.binding = undefined;
  }
}
