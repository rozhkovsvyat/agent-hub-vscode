import path from "node:path";

import type { CukiiSteerReceipt } from "core/protocol/ideWebview";
import {
  CUKII_STEER_SCRATCH_ROOT,
  createProductionSteerScratchFile,
  createTestSteerScratchFile,
} from "./bridgeScratch";

export type SteerMessage = {
  messageId: string;
  sessionId: string;
  text: string;
};

export type SteerWriter = (text: string) => Promise<boolean>;

/**
 * Ephemeral IPC is deliberately outside the vault and OS temp.  A native
 * worker may read it while a turn is active, so make every path explicit and
 * delete only that exact file on every terminal path.
 */
export { CUKII_STEER_SCRATCH_ROOT } from "./bridgeScratch";

export type BridgeSteerSpool = {
  path: string;
  append: (text: string) => Promise<boolean>;
  cleanup: () => void;
};

const activeSpoolPaths = new Set<string>();

function spoolPathKey(candidate: string): string {
  return path.resolve(candidate).replaceAll("/", "\\").toLowerCase();
}

function toBridgeSteerSpool(file: {
  path: string;
  append: (text: string) => boolean;
  cleanup: () => void;
}): BridgeSteerSpool {
  const pathKey = spoolPathKey(file.path);
  activeSpoolPaths.add(pathKey);

  return {
    path: file.path,
    async append(text: string): Promise<boolean> {
      const trimmed = text.trim();
      return !!trimmed && file.append(`USER:\n${trimmed}\n\n`);
    },
    cleanup(): void {
      activeSpoolPaths.delete(pathKey);
      file.cleanup();
    },
  };
}

/** Production callers cannot choose the root or filename. */
export function createBridgeSteerSpool(): BridgeSteerSpool {
  return toBridgeSteerSpool(createProductionSteerScratchFile());
}

/** Fixed-root test hook for negative path-security contract tests. */
export function createBridgeSteerSpoolForTest(nonce: string): BridgeSteerSpool {
  return toBridgeSteerSpool(createTestSteerScratchFile(nonce));
}

export function isActiveBridgeSteerSpool(candidate: string): boolean {
  return activeSpoolPaths.has(spoolPathKey(candidate));
}

export function steerPromptInstruction(steerPath: string): string {
  return [
    "The user can send messages in the chat WHILE you work.",
    "Those follow-ups are appended to this live file:",
    steerPath,
    "Immediately after EVERY completed tool call, and BEFORE starting the next one, Read that file.",
    "A tool batch is exactly one tool call: never accumulate follow-ups until the end of a multi-step investigation, build, or test run.",
    "New USER blocks are steering for the CURRENT task: follow them immediately,",
    "do not wait until you finish, and do not start a separate answer.",
    "An empty file means no new steering yet.",
  ].join(" ");
}

type PendingSteer = {
  message: SteerMessage;
  resolve: (receipt: CukiiSteerReceipt) => void;
};

/** Per-run steering ledger. Message ids make transport retries idempotent. */
export class BridgeSteeringController {
  private readonly receipts = new Map<string, Promise<CukiiSteerReceipt>>();
  private readonly pending: PendingSteer[] = [];
  private writer: SteerWriter | undefined;
  private closed = false;
  private flushing = false;

  constructor(
    readonly sessionId: string,
    readonly supportsLiveSteering: boolean,
  ) {}

  deliver(message: SteerMessage): Promise<CukiiSteerReceipt> {
    const duplicate = this.receipts.get(message.messageId);
    if (duplicate) return duplicate;
    const receipt = new Promise<CukiiSteerReceipt>((resolve) => {
      if (
        this.closed ||
        !this.supportsLiveSteering ||
        message.sessionId !== this.sessionId ||
        !message.text.trim()
      ) {
        resolve(this.deferred(message));
        return;
      }
      this.pending.push({ message, resolve });
      void this.flush();
    });
    this.receipts.set(message.messageId, receipt);
    return receipt;
  }

  attachWriter(writer: SteerWriter): void {
    if (this.closed || !this.supportsLiveSteering) return;
    this.writer = writer;
    void this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer = undefined;
    for (const pending of this.pending.splice(0)) {
      pending.resolve(this.deferred(pending.message));
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const writer = this.writer;
    if (!writer || this.closed) return;
    this.flushing = true;
    try {
      while (this.pending.length && this.writer === writer && !this.closed) {
        const pending = this.pending.shift()!;
        let delivered = false;
        try {
          delivered = await writer(pending.message.text);
        } catch {
          delivered = false;
        }
        pending.resolve(
          delivered
            ? {
                messageId: pending.message.messageId,
                sessionId: this.sessionId,
                status: "delivered",
              }
            : this.deferred(pending.message),
        );
      }
    } finally {
      this.flushing = false;
      if (this.pending.length && this.writer && !this.closed) void this.flush();
    }
  }

  private deferred(message: SteerMessage): CukiiSteerReceipt {
    return {
      messageId: message.messageId,
      sessionId: message.sessionId,
      status: "deferred",
    };
  }
}
