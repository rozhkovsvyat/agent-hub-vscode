import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "VsCodeMessenger.ts"), "utf8");

describe("VsCodeMessenger native bridge run contract", () => {
  it("uses one coalescing coordinator instead of a previous.done chain", () => {
    expect(source).toContain("messenger.bridgeRuns.acquire(");
    expect(source).not.toMatch(/if \(previous\) await previous\.done/);
    expect(source).not.toContain("activeBridgeRuns.set(protocol, run)");
  });

  it("blocks replacement when process-tree termination is unverified", () => {
    expect(source).toContain("if (!completion.terminationVerified)");
    expect(source).toContain("replacement is blocked");
    expect(source).toContain("onTerminationResult: (terminated)");
    expect(source).toMatch(
      /if \(terminationVerified\) \{\s*messenger\.bridgeRuns\.release\(protocol, run\)/,
    );
  });

  it("routes steering through the model-bound active-run identity", () => {
    expect(source).toContain("brokerModel: msg.data.brokerModel");
    expect(source).toContain("bridgeRunAcceptsSteer(run, msg.data)");
  });
});
