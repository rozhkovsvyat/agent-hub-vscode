import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const messengerSource = fs.readFileSync(
  path.join(__dirname, "VsCodeMessenger.ts"),
  "utf8",
);

describe("vendor usage API poller wiring", () => {
  it("starts and stops one host-owned poller", () => {
    expect(messengerSource).toContain("this.usagePoller = createUsagePoller({");
    expect(messengerSource).toContain("this.usagePoller.start()");
    expect(messengerSource).toContain(
      "context.subscriptions.push({ dispose: () => this.usagePoller.stop() })",
    );
  });

  it("refreshes the selected vendor directly instead of waiting for a CLI run", () => {
    const handlerAt = messengerSource.indexOf(
      'this.onWebview("cukii/getVendorUsage"',
    );
    const detailsAt = messengerSource.indexOf(
      'this.onWebview("cukii/openVendorUsageDetails"',
      handlerAt,
    );
    expect(handlerAt).toBeGreaterThan(-1);
    expect(detailsAt).toBeGreaterThan(handlerAt);
    const handler = messengerSource.slice(handlerAt, detailsAt);
    expect(handler).toContain("this.usagePoller.pollOnce(data.vendor)");
    expect(handler).toContain("hasFreshUsage");
    expect(handler).toContain("cached.windows");
  });

  it("merges CLI pushes and API snapshots through the same persistence path", () => {
    expect(messengerSource.match(/this\.publishVendorUsage\(/g)).toHaveLength(
      2,
    );
    expect(messengerSource).toContain(
      'this.webviewProtocol.send("cukii/vendorUsageChanged", snapshot)',
    );
  });
});

describe("vendor CLI auto-update wiring", () => {
  it("never installs while a bridge run is active and bounds an in-flight install", () => {
    const updaterAt = messengerSource.indexOf(
      "private async updateManagedVendorClis",
    );
    const updaterEnd = messengerSource.indexOf(
      "private enqueueSessionRename",
      updaterAt,
    );
    const updater = messengerSource.slice(updaterAt, updaterEnd);

    expect(updaterAt).toBeGreaterThan(-1);
    expect(updater).toContain("this.bridgeRunCandidates.size > 0");
    expect(updater.indexOf("this.bridgeRunCandidates.size > 0")).toBeLessThan(
      updater.indexOf("runVendorInstallProcess(spec"),
    );
    expect(messengerSource).toContain("this.vendorCliUpdating === runVendor");
    expect(messengerSource).toContain(
      "timeoutMs: VENDOR_CLI_UPDATE_INSTALL_TIMEOUT_MS",
    );
    expect(messengerSource).toContain("await vendorCliUpdateRun");
  });

  it("uses only ownership-checked specs and invalidates model probes after updating", () => {
    expect(messengerSource).toContain("managedVendorAutoUpdateSpec(vendor)");
    expect(messengerSource).not.toContain("vendorInstallTerminalSpec(vendor)");
    expect(messengerSource).toContain("clearBrokerVendorAccountCache()");
    expect(messengerSource).toContain(
      'if (vendor === "claude") resetClaudeCatalogProbeCache()',
    );
  });
});
