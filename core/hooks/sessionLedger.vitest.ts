import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HookSessionLedger } from "./sessionLedger";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("HookSessionLedger", () => {
  it("survives a new instance and closes only the named session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-ledger-"));
    dirs.push(dir);
    const file = path.join(dir, "sessions.json");
    const ledger = new HookSessionLedger(file);

    ledger.open({
      sessionId: "a",
      cwd: "D:/a",
      openedAt: "2026-01-01T00:00:00.000Z",
      state: "starting",
      startInvocationId: "start-a",
    });
    ledger.open({
      sessionId: "b",
      cwd: "D:/b",
      openedAt: "2026-01-01T00:00:00.000Z",
      state: "started",
      startInvocationId: "start-b",
    });
    expect(
      new HookSessionLedger(file).list().map((entry) => entry.sessionId),
    ).toEqual(["a", "b"]);

    ledger.close("a");
    expect(new HookSessionLedger(file).list()).toMatchObject([
      { sessionId: "b", cwd: "D:/b" },
    ]);
  });
});
