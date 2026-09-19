import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(__dirname, "VsCodeMessenger.ts"),
  "utf8",
);
const adapterSource = fs.readFileSync(
  path.join(__dirname, "bridgeChatAdapter.ts"),
  "utf8",
);

describe("VsCodeMessenger native bridge run contract", () => {
  it("uses one coalescing coordinator instead of a previous.done chain", () => {
    expect(source).toContain("messenger.bridgeRuns.acquire(");
    expect(source).not.toMatch(/if \(previous\) await previous\.done/);
    expect(source).not.toContain("activeBridgeRuns.set(protocol, run)");
  });

  it("blocks replacement when process-tree termination is unverified", () => {
    // Stop verifies the OS process tree directly. It must never await the
    // generator's `done` promise because a disappeared consumer cannot drive
    // that finally block.
    expect(source).toContain("await retryBridgeTreeKill(run.childPid");
    expect(source).not.toMatch(/await (?:run\.done|receipt)/);
    expect(source).toContain("replacement is blocked");
    expect(source).toContain("onTerminationResult: (terminated)");
    expect(source).toMatch(
      /if \(terminationVerified\) \{\s*messenger\.bridgeRuns\.release\(protocol, run\)/,
    );
  });

  it("routes steering through the model-bound active-run identity", () => {
    expect(source).toContain("brokerModel: msg.data.brokerModel");
    expect(source).toContain("this.bridgeRunForSteer(protocol, msg.data)");
    expect(source).toContain("bridgeRunAcceptsSteer(active, request)");
    expect(source).toContain("bridgeRunAcceptsSteer(candidate, request)");
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
    expect(source).toContain("isBridgeProcessTreeAlive(");
    expect(source).toContain("replacement is blocked");
  });

  it("does not acknowledge explicit Stop before pending inbox messages are retired", () => {
    expect(source).toMatch(
      /if \([\s\S]*?run\.runId !== msg\.data\.runId[\s\S]*?return \{[\s\S]*?status: "already-cancelled"[\s\S]*?const purge = purgeUnreadBridgeInboxMessages\(msg\.data\.sessionId\)/,
    );
    expect(source).toMatch(
      /const \[receipt, purged\] = await Promise\.all\(\[\s*this\.cancelBridgeRun\([\s\S]*?purge,\s*\]\);[\s\S]*?if \(!purged\) \{[\s\S]*?return receipt;/,
    );
  });

  it("binds abort and explicit Stop to the exact bridge run", () => {
    expect(source).toContain("streamMessageId: msg.messageId");
    expect(source).toContain("streamMessageId: expectedStreamMessageId");
    expect(source).toContain("run.runId !== msg.data.runId");
  });

  it("registers pending runs so Stop before acquisition prevents spawn", () => {
    expect(source).toContain("private readonly bridgeRunCandidates");
    expect(source).toContain("this.registerBridgeCandidate(protocol, run)");
    expect(source).toMatch(
      /"cukii\/cancelBridgeRun"[\s\S]*?this\.bridgeCandidateFor\(protocol, \{\s*runId: msg\.data\.runId/,
    );
    expect(source).toMatch(
      /const acquisition = await messenger\.bridgeRuns\.acquire[\s\S]*?if \(controller\.signal\.aborted\) \{[\s\S]*?messenger\.bridgeRuns\.release\(protocol, run\)/,
    );
  });

  it("starts physical process-tree teardown from Abort, not generator finally", () => {
    expect(adapterSource).toContain('detached: process.platform !== "win32"');
    expect(adapterSource).toMatch(
      /const abortChild = \(\) => \{[\s\S]*?void terminateOnce\(\)/,
    );
    expect(adapterSource).toMatch(
      /finally \{[\s\S]*?terminated = await terminateOnce\(\)/,
    );
  });

  it("checks abort after async vendor environment discovery and before spawn", () => {
    expect(adapterSource).toMatch(
      /const vendorEnv = await alibabaSpawnEnv\(brokerModel\);[\s\S]*?if \(permissionTransport\?\.abortSignal\?\.aborted\)[\s\S]*?const child = childProcess\.spawn/,
    );
    expect(adapterSource).not.toMatch(
      /childProcess\.spawn\([\s\S]*?await alibabaSpawnEnv/,
    );
  });

  it("releases permission and prompt resources even when Stop wins before spawn", () => {
    expect(adapterSource).toMatch(
      /const releasePreparedResources = async \(\) => \{[\s\S]*?removeBridgeScratchFile\(route\.promptFile\)[\s\S]*?await permissionBroker\.dispose\(\)[\s\S]*?try \{[\s\S]*?await permissionBroker\.start\(\)[\s\S]*?finally \{\s*await releasePreparedResources\(\)/,
    );
  });

  it("snapshots old permission brokers before awaiting run cancellation", () => {
    const owner = source.indexOf("const disposePermissionBrokersFor");
    const snapshot = source.indexOf("const brokers = [", owner);
    const cancellation = source.indexOf("await this.cancelBridgeRun", owner);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(owner);
    expect(cancellation).toBeGreaterThan(snapshot);
    expect(source).toContain("runIds.has(owned.runId)");
  });
});
