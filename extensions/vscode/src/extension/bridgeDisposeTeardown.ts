import type { CukiiBridgeRunCompletion } from "core/protocol/ideWebview";

import {
  manualTreeKillCommand,
  retryBridgeTreeKill,
  type BridgeTreeKillRetryOptions,
} from "./bridgeChildLifecycle";

export type BridgeDisposeTeardownOptions = BridgeTreeKillRetryOptions & {
  log?: (message: string) => void;
};

/**
 * Dispose-time fallback for a bridge run whose cancellation could not verify
 * the process tree's death. Retries exactly one forced tree kill; when death
 * still cannot be verified, the orphan's pid and the manual kill command are
 * logged so an operator can reap it. Never throws and never swallows: every
 * unverified outcome leaves a trace.
 */
export async function retryBridgeTeardownOnDispose(
  run: {
    runId: string;
    sessionId: string;
    done: Promise<CukiiBridgeRunCompletion>;
  },
  options: BridgeDisposeTeardownOptions = {},
): Promise<{ verified: boolean }> {
  const log = options.log ?? ((message: string) => console.error(message));
  const completion = await run.done;
  const pid = completion.childPid;
  if (pid === undefined) {
    log(
      `Cukii bridge run ${run.runId} (session ${run.sessionId}) ended dispose ` +
        "without verified termination and no known child pid; check for " +
        "orphaned vendor CLI processes.",
    );
    return { verified: false };
  }
  const verified = await retryBridgeTreeKill(pid, options);
  if (verified) return { verified: true };
  log(
    `Cukii bridge run ${run.runId} (session ${run.sessionId}) survived ` +
      `panel dispose; orphaned process tree at pid ${pid}. Kill it manually: ` +
      manualTreeKillCommand(pid, options.platform),
  );
  return { verified: false };
}
