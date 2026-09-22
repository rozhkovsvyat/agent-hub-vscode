import type { BrokerModel } from "core/protocol/ideWebview";

export type BridgeRunIdentity = {
  runId: string;
  sessionId: string;
  brokerModel: BrokerModel;
  /** Vendor child pid once spawned. Lets a liveness probe reclaim a slot whose
   * occupant is verifiably dead although its teardown never verified it. */
  childPid?: number;
};

export type BridgeRunAcquireResult = "acquired" | "superseded" | "blocked";

export type BridgeRunCoordinatorOptions = {
  /** Liveness probe for an occupant's childPid. Injected so recovery tests
   * stay deterministic without real processes. */
  /** `undefined` means the probe could not answer. Unknown must never be
   * promoted to verified death. */
  isPidAlive?: (
    pid: number,
  ) => boolean | undefined | Promise<boolean | undefined>;
};

type Slot<Run extends BridgeRunIdentity> = {
  active?: Run;
  latestTicket: number;
  waiters: number;
  cancellation?: {
    runId: string;
    promise: Promise<boolean>;
  };
};

function bounded(
  operation: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * Serializes native bridge replacement per webview without building a
 * previous.done linked list. Concurrent replacements share one cancellation
 * barrier and only the latest candidate may acquire the slot afterwards.
 */
export class BridgeRunCoordinator<Key, Run extends BridgeRunIdentity> {
  private readonly slots = new Map<Key, Slot<Run>>();
  private readonly isPidAlive?: (
    pid: number,
  ) => boolean | undefined | Promise<boolean | undefined>;

  constructor(
    private readonly replacementTimeoutMs = 12_000,
    options: BridgeRunCoordinatorOptions = {},
  ) {
    this.isPidAlive = options.isPidAlive;
  }

  activeFor(key: Key): Run | undefined {
    return this.slots.get(key)?.active;
  }

  async acquire(
    key: Key,
    candidate: Run,
    cancel: (run: Run) => Promise<boolean>,
  ): Promise<BridgeRunAcquireResult> {
    let slot = this.slotFor(key);
    slot.waiters += 1;
    let ticket = ++slot.latestTicket;

    try {
      while (true) {
        if (!this.isCurrentSlot(key, slot, ticket)) return "superseded";

        const active = slot.active;
        if (!active) {
          slot.active = candidate;
          return "acquired";
        }
        if (active.runId === candidate.runId) return "acquired";

        const liveness =
          this.isPidAlive && active.childPid !== undefined
            ? await this.isPidAlive(active.childPid)
            : undefined;
        // release()/forget() may replace or delete the map entry while the OS
        // probe is pending. Never acquire through a detached Slot object and
        // never let a stale false probe delete a newer run.
        if (!this.isCurrentSlot(key, slot, ticket)) return "superseded";
        if (!slot.active) continue;
        if (slot.active.runId !== active.runId) return "superseded";
        if (liveness === false) {
          // This candidate is still the newest waiter and the occupant is
          // verifiably dead. Reuse the same tracked slot so the candidate does
          // not disappear between Stop(A) and acquisition(B).
          slot.active = undefined;
          slot.cancellation = undefined;
          continue;
        }

        let cancellation = slot.cancellation;
        if (!cancellation || cancellation.runId !== active.runId) {
          cancellation = {
            runId: active.runId,
            promise: bounded(cancel(active), this.replacementTimeoutMs),
          };
          slot.cancellation = cancellation;
        }

        const cancelled = await cancellation.promise;
        if (!this.isCurrentSlot(key, slot, ticket)) return "superseded";
        if (slot.cancellation === cancellation) {
          slot.cancellation = undefined;
        }
        if (!cancelled) return "blocked";
        if (slot.active?.runId === active.runId) {
          slot.active = undefined;
        }
      }
    } finally {
      slot.waiters = Math.max(0, slot.waiters - 1);
      if (this.slots.get(key) === slot) this.deleteIfIdle(key, slot);
    }
  }

  release(key: Key, run: Run): void {
    const slot = this.slots.get(key);
    if (!slot || slot.active?.runId !== run.runId) return;
    slot.active = undefined;
    if (!slot.cancellation) this.deleteIfIdle(key, slot);
  }

  forget(key: Key): void {
    const slot = this.slots.get(key);
    if (slot) ++slot.latestTicket;
    this.slots.delete(key);
  }

  private slotFor(key: Key): Slot<Run> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { latestTicket: 0, waiters: 0 };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private isCurrentSlot(key: Key, slot: Slot<Run>, ticket: number): boolean {
    return this.slots.get(key) === slot && slot.latestTicket === ticket;
  }

  private deleteIfIdle(key: Key, slot: Slot<Run>): void {
    if (slot.active || slot.cancellation || slot.waiters > 0) return;
    this.slots.delete(key);
  }
}

export function bridgeRunAcceptsSteer<Run extends BridgeRunIdentity>(
  run: Run | undefined,
  request: { sessionId: string; brokerModel?: BrokerModel },
): run is Run {
  return Boolean(
    run &&
      run.sessionId === request.sessionId &&
      request.brokerModel &&
      run.brokerModel === request.brokerModel,
  );
}
