import type { MessageContent } from "core";
import type { CukiiSteerReceipt } from "core/protocol/ideWebview";
import { hasImageAttachments, stripImages } from "core/util/messageContent";

export type SteerMessage = {
  messageId: string;
  sessionId: string;
  content: MessageContent;
};

export type SteerWriter = (message: SteerMessage) => Promise<boolean>;

type PendingSteer = {
  message: SteerMessage;
  resolve: (receipt: CukiiSteerReceipt) => void;
};

type AwaitingEcho = PendingSteer;

/** Per-run steering ledger. Message ids make transport retries idempotent. */
export class BridgeSteeringController {
  private readonly receipts = new Map<string, Promise<CukiiSteerReceipt>>();
  private readonly pending: PendingSteer[] = [];
  private writer: SteerWriter | undefined;
  private inFlight: PendingSteer | undefined;
  /**
   * Stdin accepted the envelope, but the vendor has not echoed it yet.
   * A successful write is not delivery: Claude `-p --input-format stream-json`
   * can still emit `result` and exit without consuming that next user turn.
   * Resolving "delivered" here stranded the GUI outbox (it only drains
   * queued/deferred bubbles) and killed the native session on `result`.
   */
  private readonly awaitingVendorEcho: AwaitingEcho[] = [];
  /**
   * Echo-less transports acknowledge inside their async writer callback,
   * before `flush()` receives the successful writer result. Remember that
   * exact in-flight id so `flush()` does not put an already-read envelope
   * back into the echo ledger.
   */
  private readonly acknowledgedInFlightWrites = new Set<string>();
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
        (!stripImages(message.content).trim() &&
          !hasImageAttachments(message.content))
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
    this.acknowledgedInFlightWrites.clear();
    if (this.inFlight) {
      this.inFlight.resolve(this.deferred(this.inFlight.message));
      this.inFlight = undefined;
    }
    for (const awaiting of this.awaitingVendorEcho.splice(0)) {
      awaiting.resolve(this.deferred(awaiting.message));
    }
    for (const pending of this.pending.splice(0)) {
      pending.resolve(this.deferred(pending.message));
    }
  }

  /**
   * Stdin follow-ups the vendor has not echoed (or even accepted) yet.
   * A Claude `result` must not settle the GUI run while this is true:
   * stream-json keeps stdin open specifically so the next user turn can
   * start in the same native process.
   */
  hasUnconsumedLiveSteers(): boolean {
    return (
      !this.closed &&
      (this.pending.length > 0 ||
        this.inFlight !== undefined ||
        this.awaitingVendorEcho.length > 0)
    );
  }

  /**
   * Returns one receipt only when the vendor echoes the exact user envelope
   * it received. This is intentionally stricter than "some stdout arrived":
   * adjacent queued follow-ups can therefore never get a premature second
   * checkmark from another turn's tool/text output.
   */
  consumeVendorEcho(text: string): string | undefined {
    const index = this.awaitingVendorEcho.findIndex(
      (awaiting) => stripImages(awaiting.message.content) === text,
    );
    if (index < 0) return undefined;
    const awaiting = this.awaitingVendorEcho.splice(index, 1)[0];
    // A duplicate text is held in FIFO until this exact echo retires the
    // earlier message. Without that gate, two equal strings have no vendor
    // identifier and an out-of-order echo could paint ✓✓ on the wrong bubble.
    awaiting.resolve(this.accepted(awaiting.message));
    void this.flush();
    return awaiting.message.messageId;
  }

  /**
   * Claude's streaming transport consumes stdin user envelopes without ever
   * echoing them back on stdout, so the echo-based read receipt would leave
   * every live steer at one checkmark forever. A successful stdin write is
   * that vendor's definitive acceptance: retire the ledger entry so the
   * adapter can paint the read receipt, and unblock equal-text follow-ups.
   */
  acknowledgeWritten(messageId: string): boolean {
    if (this.closed) return false;
    const index = this.awaitingVendorEcho.findIndex(
      (awaiting) => awaiting.message.messageId === messageId,
    );
    if (index >= 0) {
      const awaiting = this.awaitingVendorEcho.splice(index, 1)[0];
      awaiting.resolve(this.accepted(awaiting.message));
    } else if (
      this.inFlight?.message.messageId === messageId &&
      !this.acknowledgedInFlightWrites.has(messageId)
    ) {
      this.acknowledgedInFlightWrites.add(messageId);
    } else {
      return false;
    }
    void this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const writer = this.writer;
    if (!writer || this.closed) return;
    this.flushing = true;
    try {
      while (this.pending.length && this.writer === writer && !this.closed) {
        const next = this.pending[0];
        // Native user envelopes carry text, not the Cukii message id. Keep
        // equal follow-ups serialized until their predecessor is observed.
        if (
          this.awaitingVendorEcho.some(
            (awaiting) =>
              stripImages(awaiting.message.content) ===
              stripImages(next.message.content),
          )
        ) {
          break;
        }
        const pending = this.pending.shift()!;
        this.inFlight = pending;
        let delivered = false;
        try {
          delivered = await writer(pending.message);
        } catch {
          delivered = false;
        }
        if (delivered && !this.closed) {
          if (
            this.acknowledgedInFlightWrites.delete(pending.message.messageId)
          ) {
            pending.resolve(this.accepted(pending.message));
          } else {
            // Bytes reached stdin. Delivery waits for the vendor echo (or
            // close(), which honestly defers so the GUI outbox can redeliver).
            this.awaitingVendorEcho.push(pending);
          }
        } else {
          this.acknowledgedInFlightWrites.delete(pending.message.messageId);
          pending.resolve(this.deferred(pending.message));
        }
        if (this.inFlight === pending) this.inFlight = undefined;
      }
    } finally {
      this.flushing = false;
      const next = this.pending[0];
      if (
        next &&
        this.writer &&
        !this.closed &&
        !this.awaitingVendorEcho.some(
          (awaiting) =>
            stripImages(awaiting.message.content) ===
            stripImages(next.message.content),
        )
      ) {
        void this.flush();
      }
    }
  }

  private accepted(message: SteerMessage): CukiiSteerReceipt {
    return {
      messageId: message.messageId,
      sessionId: this.sessionId,
      status: "delivered",
    };
  }

  private deferred(message: SteerMessage): CukiiSteerReceipt {
    return {
      messageId: message.messageId,
      sessionId: message.sessionId,
      status: "deferred",
    };
  }
}

/** Claude `result` is not the end of a stream-json session while stdin follow-ups are in flight. */
export function shouldHoldBridgeTerminal(steering?: {
  hasUnconsumedLiveSteers(): boolean;
}): boolean {
  return Boolean(steering?.hasUnconsumedLiveSteers());
}
