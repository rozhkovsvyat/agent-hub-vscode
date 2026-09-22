import { describe, expect, it } from "vitest";

import { windowsVendorCliCandidates } from "./vendorCliCandidates";

const HOME = "C:\\Users\\owner";
const ENV = {
  LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
} as NodeJS.ProcessEnv;

describe("windowsVendorCliCandidates", () => {
  it("finds the official cursor-agent installer location first", () => {
    const candidates = windowsVendorCliCandidates("agent", HOME, ENV);

    // The stock `cursor-agent` install puts nothing in ~/.cursor/bin, so
    // omitting this path made every Cursor run and permission probe ENOENT
    // while account detection still reported Cursor as connected.
    expect(candidates[0]).toBe(
      "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.cmd",
    );
  });

  it("offers no route CreateProcess cannot launch", () => {
    const candidates = windowsVendorCliCandidates("agent", HOME, ENV);

    // agent.ps1 ships beside agent.cmd and exists on disk, so a bare existence
    // check would pick it and fail exactly like the missing path did.
    expect(candidates.some((entry) => entry.endsWith(".ps1"))).toBe(false);
    for (const entry of candidates) {
      expect(entry).toMatch(/\.(?:cmd|exe)$/);
    }
  });

  it("keeps the native Grok executable ahead of any npm shim", () => {
    expect(windowsVendorCliCandidates("grok", HOME, ENV)).toEqual([
      "C:\\Users\\owner\\.grok\\bin\\grok.exe",
    ]);
  });

  it("returns nothing for a program with no vendor-specific install", () => {
    expect(windowsVendorCliCandidates("claude", HOME, ENV)).toEqual([]);
  });
});
