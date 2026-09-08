import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(__dirname, "VsCodeMessenger.ts"),
  "utf8",
);

describe("VsCodeMessenger native bridge run contract", () => {
  it("uses one coalescing coordinator instead of a previous.done chain", () => {
    expect(source).toContain("messenger.bridgeRuns.acquire(");
    expect(source).not.toMatch(/if \(previous\) await previous\.done/);
    expect(source).not.toContain("activeBridgeRuns.set(protocol, run)");
  });

  it("blocks replacement when process-tree termination is unverified", () => {
    // The verdict no longer comes from awaiting `run.done` outright — that await
    // is what wedged the panel when nobody pulled the generator, so both waits
    // are budgeted now and `cancelDecision` folds a timeout into "unverified".
    // The guard itself must stay: an unverified teardown may not free the slot.
    expect(source).toContain("} = cancelDecision({");
    expect(source).toContain("if (!terminationVerified)");
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

  it("invalidates pending replacements when their webview is disposed", () => {
    expect(source).toMatch(
      /onDispose\(\(protocol\) => \{[\s\S]*?const run = this\.bridgeRuns\.activeFor\(protocol\);[\s\S]*?this\.bridgeRuns\.forget\(protocol\);[\s\S]*?this\.cancelBridgeRun\((protocol, )?run/,
    );
  });

  it("retries an unverified dispose teardown and reports orphans instead of swallowing", () => {
    expect(source).toContain("retryBridgeTeardownOnDispose(");
    // The old dispose path swallowed cancellation refusals with a two-armed
    // no-op .then(); a refused teardown must reach a retry and telemetry.
    expect(source).not.toMatch(
      /cancelBridgeRun\(run, `dispose:\$\{run\.sessionId\}`\)\.then\(/,
    );
  });

  it("re-probes pid liveness before blocking on an unverified cancellation", () => {
    expect(source).toContain("isBridgePidAlive(");
    expect(source).toContain("replacement is blocked");
  });

  it("does not acknowledge explicit Stop before pending inbox messages are retired", () => {
    expect(source).toMatch(
      /const purge = purgeUnreadBridgeInboxMessages\(msg\.data\.sessionId\);\s*if \(!run \|\| run\.sessionId !== msg\.data\.sessionId\) \{\s*if \(!\(await purge\)\)/,
    );
    expect(source).toMatch(
      /const \[receipt, purged\] = await Promise\.all\(\[\s*this\.cancelBridgeRun\([\s\S]*?purge,\s*\]\);[\s\S]*?if \(!purged\) \{[\s\S]*?return receipt;/,
    );
  });
});
