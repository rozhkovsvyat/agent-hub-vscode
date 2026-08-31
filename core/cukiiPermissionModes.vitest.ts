import { describe, expect, it } from "vitest";

import {
  CUKII_PERMISSION_MODE_COPY,
  CUKII_PERMISSION_MODE_ORDER,
  VENDOR_CLI_HELP_FIXTURES,
  cyclePermissionMode,
  coerceStoredPermissionMode,
  defaultVendorPermissionCapabilities,
  parseVendorPermissionCapabilities,
  permissionArgvForVendor,
  resolvePermissionModeForVendor,
  visiblePermissionModes,
} from "./cukiiPermissionModes";

describe("Cukii permission modes", () => {
  it("keeps exact Cukii copy and order", () => {
    expect(CUKII_PERMISSION_MODE_ORDER).toEqual([
      "manual",
      "editAutomatically",
      "plan",
      "auto",
      "bypass",
    ]);
    expect(CUKII_PERMISSION_MODE_COPY.manual.title).toBe("Manual");
    expect(CUKII_PERMISSION_MODE_COPY.manual.description).toBe(
      "Cukii will ask for approval before making each edit",
    );
    expect(CUKII_PERMISSION_MODE_COPY.bypass.title).toBe("Bypass permissions");
    expect(CUKII_PERMISSION_MODE_COPY.bypass.description).toBe(
      "Cukii will not ask for approval before running potentially dangerous commands",
    );
  });

  it("hides unsupported modes instead of disabling them", () => {
    const codex = defaultVendorPermissionCapabilities("codex");
    expect(visiblePermissionModes(codex)).toEqual(["bypass"]);
    expect(visiblePermissionModes(codex)).not.toContain("editAutomatically");

    const kimi = defaultVendorPermissionCapabilities("kimi");
    expect(visiblePermissionModes(kimi)).toEqual(["bypass"]);
    expect(kimi.nonInteractiveRoute).toBe("prompt-mode");
    expect(visiblePermissionModes(kimi)).not.toContain("auto");
  });

  it("cycles only through visible modes with Shift+Tab semantics", () => {
    const visible = visiblePermissionModes(
      parseVendorPermissionCapabilities(
        "claude",
        VENDOR_CLI_HELP_FIXTURES.claude,
        "2.1.251",
        true,
      ),
    );
    expect(visible).toEqual([
      "manual",
      "editAutomatically",
      "plan",
      "auto",
      "bypass",
    ]);
    expect(cyclePermissionMode("plan", visible)).toBe("auto");
    expect(cyclePermissionMode("bypass", visible)).toBe("manual");
  });

  it("restores legacy allow-all as bypass and defaults unknown to manual", () => {
    expect(coerceStoredPermissionMode(undefined, true)).toBe("bypass");
    expect(coerceStoredPermissionMode("plan")).toBe("plan");
    expect(coerceStoredPermissionMode("legacy")).toBe("manual");
  });

  it("fails closed rather than escalating an unsupported mode to bypass", () => {
    const codex = defaultVendorPermissionCapabilities("codex");
    expect(resolvePermissionModeForVendor(codex, "editAutomatically")).toBe(
      "manual",
    );
  });

  it("builds exact Claude argv and omits conflicting bypass flags", () => {
    expect(VENDOR_CLI_HELP_FIXTURES.claude).toContain('"manual"');
    const manual = permissionArgvForVendor("claude", "manual");
    expect(manual.args).toEqual(["--permission-mode", "manual"]);
    expect(manual.forbidden).toContain("--dangerously-skip-permissions");

    const bypass = permissionArgvForVendor("claude", "bypass");
    expect(bypass.args).toEqual(["--dangerously-skip-permissions"]);
    expect(bypass.forbidden).toContain("--permission-mode");
  });

  it("does not label Codex sandbox flags as approval semantics", () => {
    const bypass = permissionArgvForVendor("codex", "bypass");
    expect(bypass.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(bypass.forbidden).toContain("--approve-for-me");
    expect(permissionArgvForVendor("codex", "manual").args).toEqual([]);
    expect(permissionArgvForVendor("codex", "plan").args).toEqual([]);
  });

  it("parses capabilities from captured native help fixtures", () => {
    for (const vendor of [
      "claude",
      "codex",
      "grok",
      "cursor",
      "kimi",
      "qwen",
    ] as const) {
      const parsed = parseVendorPermissionCapabilities(
        vendor,
        VENDOR_CLI_HELP_FIXTURES[vendor],
      );
      expect(parsed.supportedModes.length).toBeGreaterThan(0);
    }
    expect(
      defaultVendorPermissionCapabilities("deepseek").supportedModes,
    ).toEqual([]);
  });

  it("exposes all five Claude CLI modes from native capability evidence", () => {
    expect(
      parseVendorPermissionCapabilities(
        "claude",
        VENDOR_CLI_HELP_FIXTURES.claude,
        "2.1.251",
        true,
      ).supportedModes,
    ).toEqual(["manual", "editAutomatically", "plan", "auto", "bypass"]);
  });

  it("hides Claude interactive modes when the permission worker is unavailable", () => {
    expect(
      parseVendorPermissionCapabilities(
        "claude",
        VENDOR_CLI_HELP_FIXTURES.claude,
        "2.1.251",
        false,
      ).supportedModes,
    ).toEqual(["plan", "bypass"]);
  });

  it("maps all five native Qwen approval choices into Cukii modes", () => {
    expect(
      parseVendorPermissionCapabilities(
        "qwen",
        VENDOR_CLI_HELP_FIXTURES.qwen,
        "0.22.2",
      ).supportedModes,
    ).toEqual(["manual", "editAutomatically", "plan", "auto", "bypass"]);
  });

  it.each([
    ["claude", "plan", ["--permission-mode", "plan"]],
    ["claude", "bypass", ["--dangerously-skip-permissions"]],
    ["codex", "bypass", ["--dangerously-bypass-approvals-and-sandbox"]],
    ["grok", "plan", ["--permission-mode", "plan"]],
    ["grok", "bypass", ["--permission-mode", "bypassPermissions"]],
    ["cursor", "plan", ["--plan"]],
    ["cursor", "bypass", ["--force"]],
    ["kimi", "bypass", []],
    ["qwen", "manual", ["--approval-mode", "default"]],
    ["qwen", "editAutomatically", ["--approval-mode", "auto-edit"]],
    ["qwen", "plan", ["--approval-mode", "plan"]],
    ["qwen", "auto", ["--approval-mode", "auto"]],
    ["qwen", "bypass", ["--approval-mode", "yolo"]],
  ] as const)("maps %s %s to its native argv", (vendor, mode, expected) => {
    const argv = permissionArgvForVendor(vendor, mode);
    expect(argv.args).toEqual(expected);
    for (const forbidden of argv.forbidden) {
      expect(argv.args).not.toContain(forbidden);
    }
  });
});
