import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCukiiDiagnosticsForTest,
  recentCukiiDiagnostics,
  recordCukiiDiagnostic,
} from "./cukiiDiagnosticBuffer";

describe("cukiiDiagnosticBuffer", () => {
  beforeEach(() => clearCukiiDiagnosticsForTest());

  it("keeps one report to its own session", () => {
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "mine" });
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "neighbour" });
    recordCukiiDiagnostic("bridge.run.failed", { sessionId: "neighbour" });

    const mine = recentCukiiDiagnostics(120, "mine").join("\n");

    expect(mine).toContain("mine");
    // A neighbouring window's lifecycle used to land in someone else's bug
    // card, both leaking it and crowding out the session being reported.
    expect(mine).not.toContain("neighbour");
  });

  it("keeps host-level lines that belong to no session", () => {
    recordCukiiDiagnostic("yougile.report.orphan_cleanup_failed", {
      code: "EPERM",
    });
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "other" });

    const scoped = recentCukiiDiagnostics(120, "mine").join("\n");

    expect(scoped).toContain("orphan_cleanup_failed");
    expect(scoped).not.toContain("other");
  });

  it("does not let a busy neighbour evict a quiet session's history", () => {
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "quiet" });
    for (let index = 0; index < 300; index++) {
      recordCukiiDiagnostic("bridge.tool.finish", {
        sessionId: "busy",
        toolId: `call-${index}`,
      });
    }

    expect(recentCukiiDiagnostics(120, "quiet").join("\n")).toContain("quiet");
  });

  it("keeps the rare lifecycle events that explain a freeze", () => {
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "s" });
    recordCukiiDiagnostic("bridge.child.spawned", { sessionId: "s", pid: 42 });
    for (let index = 0; index < 400; index++) {
      recordCukiiDiagnostic("bridge.tool.start", {
        sessionId: "s",
        toolId: `call-${index}`,
      });
    }
    recordCukiiDiagnostic("bridge.run.failed", {
      sessionId: "s",
      error: "vendor-stalled",
    });

    const report = recentCukiiDiagnostics(120, "s");

    // A plain tail of a busy turn was tool start/finish pairs only, so a report
    // about a freeze carried no spawn, failure or termination line at all.
    const text = report.join("\n");
    expect(text).toContain("bridge.run.started");
    expect(text).toContain("bridge.child.spawned");
    expect(text).toContain("vendor-stalled");
    expect(report.length).toBeLessThanOrEqual(120);
    // Chronological order survives the prioritisation.
    expect(
      report.indexOf(report.find((l) => l.includes("run.started")) ?? ""),
    ).toBeLessThan(
      report.indexOf(report.find((l) => l.includes("run.failed")) ?? ""),
    );
  });

  it("still reports every session when no session is named", () => {
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "a" });
    recordCukiiDiagnostic("bridge.run.started", { sessionId: "b" });

    const all = recentCukiiDiagnostics(120).join("\n");

    expect(all).toContain("a");
    expect(all).toContain("b");
  });
});
