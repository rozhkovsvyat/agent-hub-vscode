import { describe, expect, it } from "vitest";

import {
  bridgeStorageEnvOverrides,
  bridgeStorageProcessEnv,
  removeCaseInsensitiveEnvKeys,
  resolveBridgeStorageLayout,
  resolveWindowsScratchRoot,
} from "./bridgeStorageEnv";

const identityWindowsFs = {
  pathIsDirectory: (_candidate: string) => true,
  realPath: (candidate: string) => candidate,
};

// The library carries no machine roots of its own; these options emulate what
// the Cukii plugin pins through configureBridgeStorageHost on the owner's
// machine (the "KOMPUTER" ladder these tests describe).
const KOMPUTER_STORAGE = {
  preferredWindowsScratchRoot: "D:\\Scratch",
  preferredWindowsPnpmStoreRoot: "D:\\PnpmStore",
  forbiddenWindowsRoots: [
    "d:\\tmp",
    "d:\\brain\\tmp",
    "d:\\brain\\worktrees",
    "d:\\brain\\pnpm-store",
    "d:\\.pnpm-store",
  ],
};

describe("resolveBridgeStorageLayout", () => {
  it("uses the canonical KOMPUTER scratch and pnpm roots when present", () => {
    const result = resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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

  it("rejects existing descendants of a forbidden Windows root", () => {
    // The descendant check, not the missing-path fallback: every candidate
    // below exists, so only the forbidden-root prefix rule can save us. The
    // preferred host roots are absent so the env rungs are what get tested.
    const result = resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "D:\\tmp\\nested",
        npm_config_store_dir: "D:\\Brain\\pnpm-store\\v3",
      },
      pathExists: (candidate) =>
        candidate !== "D:\\Scratch" && candidate !== "D:\\PnpmStore",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
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
      ...KOMPUTER_STORAGE,
      platform: "win32",
      env: { CUKII_SCRATCH_DIR: "relative", npm_config_store_dir: "relative" },
      pathExists: (candidate) => candidate === "C:\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  // Card CUK-112: Cukii's own bridge/permission/voice scratch had a second,
  // literal copy of this root and every vendor died with
  // `ENOENT: mkdir 'D:\Scratch'` on a machine with no D: volume. One ladder,
  // one answer — so the two cannot disagree again.
  it("hands the same ladder to Cukii's own scratch roots", () => {
    const onKomputer = resolveWindowsScratchRoot({
      ...KOMPUTER_STORAGE,
      env: {},
      pathExists: (candidate) => candidate === "D:\\Scratch",
      ...identityWindowsFs,
      systemTempDir: "C:\\Users\\owner\\AppData\\Local\\Temp",
    });
    expect(onKomputer).toBe("D:\\Scratch");

    // The colleague's machine: no D: at all.
    const withoutDVolume = resolveWindowsScratchRoot({
      ...KOMPUTER_STORAGE,
      env: {},
      pathExists: (candidate) =>
        candidate === "C:\\Users\\STARK\\AppData\\Local\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Users\\STARK\\AppData\\Local\\Temp",
    });
    expect(withoutDVolume).toBe("C:\\Users\\STARK\\AppData\\Local\\Temp");

    const configured = resolveWindowsScratchRoot({
      ...KOMPUTER_STORAGE,
      env: { cukii_scratch_dir: "E:\\AgentScratch" },
      pathExists: (candidate) =>
        candidate === "E:\\AgentScratch" || candidate === "C:\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });
    expect(configured).toBe("E:\\AgentScratch");

    expect(
      resolveWindowsScratchRoot({
      ...KOMPUTER_STORAGE,
        env: {},
        pathExists: () => false,
        ...identityWindowsFs,
        systemTempDir: "C:\\Temp",
      }),
    ).toBeUndefined();
  });

  it.each([
    "\\\\?\\D:\\tmp",
    "\\\\localhost\\d$\\tmp",
    "D:\\tmp.\\nested",
    "D:\\safe \\nested",
  ])("rejects Windows namespace or trailing-alias root %s", (unsafeRoot) => {
    const result = resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
      platform: "win32",
      env: {
        CUKII_SCRATCH_DIR: "E:\\AgentScratch",
        npm_config_store_dir: "E:\\PnpmStore",
      },
      pathExists: (candidate) =>
        candidate !== "D:\\Scratch" && candidate !== "D:\\PnpmStore",
      pathIsDirectory: () => true,
      realPath: (candidate) =>
        candidate === "E:\\AgentScratch" || candidate === "E:\\PnpmStore"
          ? "D:\\tmp"
          : candidate,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });

  it("rejects a vendor-runtime leaf junction that escapes the verified root", () => {
    expect(() =>
      resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
        platform: "win32",
        env: {},
        pathExists: (candidate) =>
          candidate === "D:\\Scratch" ||
          candidate === "D:\\Scratch\\cukii-vendor-runtime",
        pathIsDirectory: () => true,
        realPath: (candidate) =>
          candidate === "D:\\Scratch\\cukii-vendor-runtime"
            ? "D:\\Brain\\tmp"
            : candidate,
        systemTempDir: "C:\\Temp",
      }),
    ).toThrow(/temporary directory escapes/i);
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
      ...KOMPUTER_STORAGE,
      ...common,
      pathIsDirectory: (candidate) => {
        if (candidate === "E:\\AgentScratch") throw new Error("locked");
        return true;
      },
      realPath: (candidate) => candidate,
    });
    const realPathFailure = resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
      ...common,
      pathIsDirectory: () => true,
      realPath: (candidate) => {
        if (candidate === "E:\\AgentScratch") throw new Error("unresolved");
        return candidate;
      },
    });

    expect(statFailure).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
    expect(realPathFailure).toEqual({
      tempDir: "C:\\Temp\\cukii-vendor-runtime",
    });
  });

  it.each(["stat", "realpath"])(
    "fails closed when canonical pnpm storage %s cannot be verified",
    (failure) => {
      expect(() =>
        resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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
      ...KOMPUTER_STORAGE,
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
    expect(Object.keys(bridgeStorageProcessEnv(options))).not.toContain(
      "NPM_CONFIG_STORE_DIR",
    );
  });

  it("keeps non-Windows vendors under their normal temporary root", () => {
    expect(
      resolveBridgeStorageLayout({
      ...KOMPUTER_STORAGE,
        platform: "linux",
        env: { CUKII_SCRATCH_DIR: "/custom" },
        pathExists: () => true,
        systemTempDir: "/tmp",
      }),
    ).toEqual({ tempDir: "/tmp/cukii-vendor-runtime" });
  });

  it("carries no machine roots of its own without host configuration", () => {
    // Even when a D:\Scratch-alike volume exists, the bare library must not
    // prefer it: machine roots arrive only from options or the host config.
    const result = resolveBridgeStorageLayout({
      platform: "win32",
      env: {},
      pathExists: (candidate) =>
        candidate === "D:\\Scratch" || candidate === "C:\\Temp",
      ...identityWindowsFs,
      systemTempDir: "C:\\Temp",
    });

    expect(result).toEqual({ tempDir: "C:\\Temp\\cukii-vendor-runtime" });
  });
});
