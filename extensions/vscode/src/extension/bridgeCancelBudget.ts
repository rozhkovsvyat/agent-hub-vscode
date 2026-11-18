/**
 * Time budgets for cancelling a native bridge run, and the helper that enforces
 * them.
 *
 * Cancellation used to await two promises with no bound at all. Both of them
 * ultimately resolve inside the stream generator's `finally`, which does not
 * run while nobody is pulling the generator — so a run that stalled mid-stream
 * left Stop waiting forever and left the run slot occupied, and the session
 * could be recovered by neither stopping nor restarting it.
 *
 * A budget here is not a claim that the vendor died. It is only the point at
 * which we stop waiting for an answer that may never come and go find out for
 * ourselves, by probing the pid.
 */

/** Distinguishable from any legitimate resolution, including `undefined`. */
export const TIMED_OUT = Symbol("cukii.bridge.cancel.timeout");
export type TimedOut = typeof TIMED_OUT;

/**
 * Matches the coordinator's own replacement budget: a Stop that outlives the
 * window in which a replacement would have given up is already a wedged run.
 */
export const BRIDGE_CANCEL_RECEIPT_MS = 12_000;

/**
 * The completion promise is resolved before the receipt in every ordinary
 * teardown, so this budget only ever covers a future in which the two stop
 * sharing a resolution point. Short on purpose: it must not add latency to
 * Stop.
 */
export const BRIDGE_CANCEL_COMPLETION_MS = 1_000;

/**
 * Resolve with the promise's value, or with {@link TIMED_OUT} after `budgetMs`.
 *
 * A rejection is reported as a timeout rather than propagated: every caller
 * here treats "no verified answer" identically, and letting a teardown error
 * escape would abort the recovery path that frees the slot.
 */
export type CancelObservation = {
  /** What the cancellation receipt said, or that it never answered. */
  receipt: { interrupted: "turn" | "tool" } | TimedOut;
  /** What the run's completion said, or that it never answered. */
  completion: { terminationVerified: boolean; childPid?: number } | TimedOut;
  /** Last pid the run reported spawning, if any. */
  runChildPid?: number;
};

export type CancelDecision = {
  interrupted: "turn" | "tool";
  /** True only on a positive confirmation; silence is never confirmation. */
  terminationVerified: boolean;
  /** The pid to probe before refusing the slot; undefined means nothing spawned. */
  probePid: number | undefined;
};

/**
 * Turn what we managed to observe into what to do about it.
 *
 * Two things this must never do, both of which were bugs:
 * read silence as a verified termination, and read silence as proof that
 * something is still running. A timed-out cancel knows nothing; it hands the
 * question to the pid probe, and if there is no pid to probe then the run
 * never spawned anything and the slot is free.
 */
export function cancelDecision(observation: CancelObservation): CancelDecision {
  const { receipt, completion, runChildPid } = observation;
  return {
    // "turn" is the safe reading when the receipt never answered: claiming a
    // tool was interrupted would put a tool result in the transcript that no
    // tool ever produced.
    interrupted: receipt === TIMED_OUT ? "turn" : receipt.interrupted,
    terminationVerified:
      completion !== TIMED_OUT && completion.terminationVerified,
    probePid: completion === TIMED_OUT ? runChildPid : completion.childPid,
  };
}

export function settledWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<T | TimedOut> {
  return new Promise<T | TimedOut>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
    // Do not keep the extension host alive just to observe a stalled run.
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}
