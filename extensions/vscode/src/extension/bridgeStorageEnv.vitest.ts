import { describe, expect, it } from "vitest";

import { resolveBridgeStorageLayout } from "./bridgeStorageEnv";

describe("resolveBridgeStorageLayout", () => {
  it("uses the canonical KOMPUTER scratch and pnpm roots when present", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {},
      pathExists: (candidate) =>
        candidate === "D:\\Scratch" || candidate === "D:\\PnpmStore",
      systemTempDir: "C:\\Users\\owner\\AppData\\Local\\Temp",
    });

    expect(result).toEqual({
      tempDir: "D:\\Scratch\\cukii-vendor-runtime",
      pnpmStoreDir: "D:\\PnpmStore",
    });
  });

  it("honours an explicit absolute scratch root and store", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "E:\\AgentScratch",
        npm_config_store_dir: "E:\\PnpmStore",
      },
      pathExists: () => false,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({
      tempDir: "E:\\AgentScratch\\cukii-vendor-runtime",
      pnpmStoreDir: "E:\\PnpmStore",
    });
  });

  it("keeps KOMPUTER canonical roots above a stale inherited override", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "D:\\tmp",
        npm_config_store_dir: "D:\\Brain\\pnpm-store",
      },
      pathExists: (candidate) =>
        candidate === "D:\\Scratch" || candidate === "D:\\PnpmStore",
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({
      tempDir: "D:\\Scratch\\cukii-vendor-runtime",
      pnpmStoreDir: "D:\\PnpmStore",
    });
  });

  it("rejects forbidden stale roots even when canonical folders are missing", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "D:\\tmp",
        npm_config_store_dir: "D:\\Brain\\pnpm-store",
      },
      pathExists: () => false,
      systemTempDir: "D:\\tmp",
    });

    expect(result).toEqual({
      tempDir: "D:\\Scratch\\cukii-vendor-runtime",
    });
  });

  it("does not invent machine-specific roots on another machine", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: { CUKII_SCRATCH_DIR: "relative", npm_config_store_dir: "relative" },
      pathExists: () => false,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it("keeps non-Windows vendors under their normal temporary root", () => {
    expect(
      resolveBridgeStorageLayout({
        platform: "linux",
        env: { CUKII_SCRATCH_DIR: "/custom" },
        pathExists: () => true,
        systemTempDir: "/tmp",
      }),
    ).toEqual({ tempDir: "/tmp/cukii-vendor-runtime" });
  });
});
