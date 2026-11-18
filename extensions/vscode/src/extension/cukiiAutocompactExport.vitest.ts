import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOCOMPACT_EXPORT_ATTEMPTS,
  autocompactPercent,
  CUKII_AUTOCOMPACT_EXPORT_PATH,
  exportAutocompactForHarness,
} from "./cukiiAutocompactExport";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-autocompact-"));
const target = path.join(scratch, "nested", "autocompact.json");

afterEach(() => {
  fs.rmSync(path.join(scratch, "nested"), { recursive: true, force: true });
});

function readBack() {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

describe("autocompact export for the machine harness", () => {
  it("lands beside the other agent-hub state, not inside the extension", () => {
    expect(CUKII_AUTOCOMPACT_EXPORT_PATH).toBe(
      path.join(os.homedir(), ".agent-hub", "autocompact.json"),
    );
  });

  it("publishes a share as a number the PowerShell reader can parse", () => {
    expect(exportAutocompactForHarness("25", target)).toBe(true);
    expect(readBack()).toMatchObject({
      autocompact: "25",
      percent: 25,
      source: "cukii-plugin",
    });
  });

  it("publishes Default as a null share, not as a number", () => {
    // The reader treats `percent: null` as "no forced share" and falls back to
    // the harness's own measured threshold. A 0 or a 100 here would silently
    // become a threshold.
    expect(exportAutocompactForHarness("default", target)).toBe(true);
    expect(readBack().percent).toBeNull();
    expect(readBack().autocompact).toBe("default");
  });

  it("maps every stop the toggle offers", () => {
    expect(autocompactPercent("25")).toBe(25);
    expect(autocompactPercent("50")).toBe(50);
    expect(autocompactPercent("75")).toBe(75);
    expect(autocompactPercent("default")).toBeNull();
  });

  it("creates the directory rather than failing on a fresh machine", () => {
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(exportAutocompactForHarness("75", target)).toBe(true);
    expect(readBack().percent).toBe(75);
  });

  it("leaves no staging file behind for the reader to trip over", () => {
    exportAutocompactForHarness("50", target);
    expect(
      fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("replaces a previous value instead of appending to it", () => {
    exportAutocompactForHarness("75", target);
    exportAutocompactForHarness("25", target);
    expect(readBack().percent).toBe(25);
  });

  it("reports failure instead of throwing when the path is unusable", () => {
    // A directory where the file should be: the write cannot succeed, and a
    // saved preference must not turn into an unhandled rejection.
    fs.mkdirSync(target, { recursive: true });
    expect(exportAutocompactForHarness("50", target)).toBe(false);
  });

  it("hands the caller the reason so a dropped write can be surfaced", () => {
    // A silent false is how the harness ends up on a stale threshold while the
    // UI shows the new one, with nothing in the window to explain it.
    fs.mkdirSync(target, { recursive: true });
    const seen: unknown[] = [];
    expect(exportAutocompactForHarness("50", target, (e) => seen.push(e))).toBe(
      false,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
  });

  it("does not call back on success", () => {
    const onError = vi.fn();
    expect(exportAutocompactForHarness("25", target, onError)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves no staging file behind after giving up either", () => {
    // One per failure would accumulate right beside the file the hooks read.
    fs.mkdirSync(target, { recursive: true });
    expect(exportAutocompactForHarness("50", target)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("retries the rename rather than dropping the value on one clash", () => {
    // On Windows the rename fails outright while a reader holds the target
    // open; a single attempt loses the setting roughly a fifth of the time.
    expect(AUTOCOMPACT_EXPORT_ATTEMPTS).toBeGreaterThan(1);
  });
});
