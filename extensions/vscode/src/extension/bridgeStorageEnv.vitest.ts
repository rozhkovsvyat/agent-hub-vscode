import { describe, expect, it } from "vitest";

import {
  bridgeStorageEnvOverrides,
  bridgeStorageProcessEnv,
  removeCaseInsensitiveEnvKeys,
  resolveBridgeStorageLayout,
} from "./bridgeStorageEnv";

const identityWindowsFs = {
  pathIsDirectory: (_candidate: string) => true,
  realPath: (candidate: string) => candidate,
};

describe("resolveBridgeStorageLayout", () => {
  it("uses the canonical KOMPUTER scratch and pnpm roots when present", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {},
      pathExists: (candidate) =>
        candidate === "D:\\Scratch" || candidate === "D:\\PnpmStore",
      ...identityWindowsFs,
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
      pathExists: (candidate) =>
        candidate === "E:\\AgentScratch" ||
        candidate === "E:\\PnpmStore" ||
        candidate === "C:\\Temp",
      ...identityWindowsFs,
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
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({
      tempDir: "D:\\Scratch\\cukii-vendor-runtime",
      pnpmStoreDir: "D:\\PnpmStore",
    });
  });

  it("rejects forbidden stale roots even when canonical folders are missing", () => {
    expect(() =>
      resolveBridgeStorageLayout({
        platform: "win32",
        env: {
          CUKII_SCRATCH_DIR: "D:\\tmp",
          npm_config_store_dir: "D:\\Brain\\pnpm-store",
        },
        pathExists: () => false,
        ...identityWindowsFs,
        systemTempDir: "D:\\tmp",
      }),
    ).toThrow(/no safe existing windows temporary root/i);
  });

  it("rejects descendants of every forbidden Windows root", () => {
    expect(() =>
      resolveBridgeStorageLayout({
        platform: "win32",
        env: {
          CUKII_SCRATCH_DIR: "D:\\tmp\\nested",
          npm_config_store_dir: "D:\\Brain\\pnpm-store\\v3",
        },
        pathExists: () => false,
        ...identityWindowsFs,
        systemTempDir: "D:\\Brain\\tmp\\vendor",
      }),
    ).toThrow(/no safe existing windows temporary root/i);
  });

  it("removes inherited environment keys case-insensitively", () => {
    expect(
      removeCaseInsensitiveEnvKeys(
        {
          NPM_CONFIG_STORE_DIR: "D:\\Brain\\pnpm-store",
          npm_config_store_dir: "E:\\stale",
          Path: "C:\\Windows",
        },
        ["npm_config_store_dir"],
      ),
    ).toEqual({ Path: "C:\\Windows" });
  });

  it("does not invent machine-specific roots on another machine", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: { CUKII_SCRATCH_DIR: "relative", npm_config_store_dir: "relative" },
      pathExists: (candidate) => candidate === "C:\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it.each([
    "\\\\?\\D:\\tmp",
    "\\\\localhost\\d$\\tmp",
    "D:\\tmp.\\nested",
    "D:\\safe \\nested",
  ])("rejects Windows namespace or trailing-alias root %s", (unsafeRoot) => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: unsafeRoot,
        npm_config_store_dir: unsafeRoot,
      },
      pathExists: (candidate) =>
        candidate === unsafeRoot || candidate === "C:\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it("rejects a permitted-looking junction whose physical target is forbidden", () => {
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "E:\\AgentScratch",
        npm_config_store_dir: "E:\\PnpmStore",
      },
      pathExists: (candidate) => candidate !== "D:\\Scratch" && candidate !== "D:\\PnpmStore",
      pathIsDirectory: () => true,
      realPath: (candidate) =>
        candidate === "E:\\AgentScratch" || candidate === "E:\\PnpmStore"
          ? "D:\\tmp"
          : candidate,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it("falls back to a verified system temp when a configured root cannot be inspected", () => {
    const common = {
      platform: "win32" as const,
      env: { CUKII_SCRATCH_DIR: "E:\\AgentScratch" },
      pathExists: (candidate: string) =>
        candidate !== "D:\\Scratch" && candidate !== "D:\\PnpmStore",
      systemTempDir: "C:\\Temp",
    };
    const statFailure = resolveBridgeStorageLayout({
      ...common,
      pathIsDirectory: (candidate) => {
        if (candidate === "E:\\AgentScratch") throw new Error("locked");
        return true;
      },
      realPath: (candidate) => candidate,
    });
    const realPathFailure = resolveBridgeStorageLayout({
      ...common,
      pathIsDirectory: () => true,
      realPath: (candidate) => {
        if (candidate === "E:\\AgentScratch") throw new Error("unresolved");
        return candidate;
      },
    });

    expect(statFailure).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
    expect(realPathFailure).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it.each(["stat", "realpath"])(
    "fails closed when canonical pnpm storage %s cannot be verified",
    (failure) => {
      expect(() =>
        resolveBridgeStorageLayout({
          platform: "win32",
          env: { npm_config_store_dir: "E:\\Store" },
          pathExists: (candidate) =>
            candidate === "D:\\Scratch" ||
            candidate === "D:\\PnpmStore" ||
            candidate === "E:\\Store",
          pathIsDirectory: (candidate) => {
            if (failure === "stat" && candidate === "D:\\PnpmStore") {
              throw new Error("locked");
            }
            return true;
          },
          realPath: (candidate) => {
            if (failure === "realpath" && candidate === "D:\\PnpmStore") {
              throw new Error("unresolved");
            }
            return candidate;
          },
          systemTempDir: "C:\\Temp",
        }),
      ).toThrow(/canonical pnpm store root is not a safe physical directory/i);
    },
  );

  it("fails closed when no verified temp root exists instead of inventing C:\\Temp", () => {
    expect(() =>
      resolveBridgeStorageLayout({
        platform: "win32",
        env: {},
        pathExists: () => false,
        ...identityWindowsFs,
        systemTempDir: "C:\\Temp",
      }),
    ).toThrow(/no safe existing windows temporary root/i);
  });

  it("sanitizes mixed-case terminal and process storage variables", () => {
    const options = {
      platform: "win32" as const,
      env: {
        TeMp: "D:\\tmp",
        tmp: "D:\\Brain\\tmp",
        NPM_CONFIG_STORE_DIR: "D:\\Brain\\pnpm-store",
        Path: "C:\\Windows",
      },
      pathExists: (candidate: string) =>
        candidate === "D:\\Scratch" || candidate === "D:\\PnpmStore",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    };

    expect(bridgeStorageEnvOverrides(options)).toMatchObject({
      TeMp: "D:\\Scratch\\cukii-vendor-runtime",
      tmp: "D:\\Scratch\\cukii-vendor-runtime",
      NPM_CONFIG_STORE_DIR: "D:\\PnpmStore",
      TEMP: "D:\\Scratch\\cukii-vendor-runtime",
      TMP: "D:\\Scratch\\cukii-vendor-runtime",
      TMPDIR: "D:\\Scratch\\cukii-vendor-runtime",
      npm_config_store_dir: "D:\\PnpmStore",
    });
    expect(bridgeStorageProcessEnv(options)).toMatchObject({
      Path: "C:\\Windows",
      TEMP: "D:\\Scratch\\cukii-vendor-runtime",
      TMP: "D:\\Scratch\\cukii-vendor-runtime",
      TMPDIR: "D:\\Scratch\\cukii-vendor-runtime",
      npm_config_store_dir: "D:\\PnpmStore",
    });
    expect(Object.keys(bridgeStorageProcessEnv(options))).not.toContain("TeMp");
    expect(Object.keys(bridgeStorageProcessEnv(options))).not.toContain("NPM_CONFIG_STORE_DIR");
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
