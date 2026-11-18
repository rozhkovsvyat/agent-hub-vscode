import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrokerAutocompact } from "core/protocol/ideWebview";

/**
 * The plugin's Autocompact value, published where the machine's own harness
 * can read it.
 *
 * The threshold used to be restated in every agent contract, so each vendor
 * carried its own number and they drifted. The plugin owns it now. Bridge runs
 * receive it in their prompt, but the PowerShell rotation hooks under
 * `~/.claude` and `~/.codex` are separate processes with no access to VS Code's
 * globalState — this file is the only channel they share.
 *
 * Written on every preference change rather than read on demand: the hooks run
 * between turns and must never block on the extension being alive.
 */
export const CUKII_AUTOCOMPACT_EXPORT_PATH = path.join(
  os.homedir(),
  ".agent-hub",
  "autocompact.json",
);

export type CukiiAutocompactExport = {
  /** "25" | "50" | "75" | "default"; "default" means "no forced share". */
  autocompact: BrokerAutocompact;
  /** Percent of the context window, or null for "default". */
  percent: number | null;
  updatedAt: string;
  source: "cukii-plugin";
};

export function autocompactPercent(value: BrokerAutocompact): number | null {
  return value === "default" ? null : Number(value);
}

/** Attempts of the rename below before giving up. See the retry note. */
export const AUTOCOMPACT_EXPORT_ATTEMPTS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Never throws: a read-only home directory or a locked file must not break
 * saving a preference. The hooks fall back to their own measured default when
 * the file is missing or unreadable, which is the same state as "never set".
 *
 * The rename is retried because on Windows it fails outright while a reader
 * holds the target open without FILE_SHARE_DELETE — and the readers here are
 * PowerShell hooks doing exactly that. Measured at ~22% failures under
 * contention, and a dropped write means the harness silently keeps the previous
 * threshold, so a single attempt is not enough.
 */
export function exportAutocompactForHarness(
  value: BrokerAutocompact,
  filePath: string = CUKII_AUTOCOMPACT_EXPORT_PATH,
  onError: (error: unknown) => void = () => {},
): boolean {
  const payload: CukiiAutocompactExport = {
    autocompact: value,
    percent: autocompactPercent(value),
    updatedAt: new Date().toISOString(),
    source: "cukii-plugin",
  };
  // Written whole, then moved into place: a hook reading mid-write must see
  // either the old value or the new one, never a truncated file.
  const staging = `${filePath}.${process.pid}.tmp`;
  let lastError: unknown;
  for (let attempt = 0; attempt < AUTOCOMPACT_EXPORT_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        staging,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      fs.renameSync(staging, filePath);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < AUTOCOMPACT_EXPORT_ATTEMPTS)
        sleepSync(20 * (attempt + 1));
    }
  }
  // A staging file left beside the one the hooks read is litter, and it
  // accumulates one per failure.
  try {
    fs.rmSync(staging, { force: true });
  } catch {
    // Nothing further to do; the next successful export overwrites it.
  }
  onError(lastError);
  return false;
}
