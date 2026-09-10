import os from "node:os";
import path from "node:path";

export interface BridgeStorageLayout {
  tempDir: string;
  pnpmStoreDir?: string;
}

function isForbiddenWindowsStoragePath(candidate: string): boolean {
  const normalized = path.win32.normalize(candidate).replace(/[\\/]+$/, "").toLowerCase();
  return new Set([
    "d:\\tmp",
    "d:\\brain\\tmp",
    "d:\\brain\\worktrees",
    "d:\\brain\\pnpm-store",
    "d:\\.pnpm-store",
  ]).has(normalized);
}

export function resolveBridgeStorageLayout(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
  systemTempDir?: string;
} = {}): BridgeStorageLayout {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? (() => false);
  const systemTempDir = options.systemTempDir ?? os.tmpdir();
  const targetPath = platform === "win32" ? path.win32 : path.posix;

  if (platform !== "win32") {
    return {
      tempDir: path.posix.join(systemTempDir, "cukii-vendor-runtime"),
    };
  }

  const configuredScratch = env.CUKII_SCRATCH_DIR?.trim();
  const safeConfiguredScratch =
    configuredScratch &&
    targetPath.isAbsolute(configuredScratch) &&
    !isForbiddenWindowsStoragePath(configuredScratch)
      ? configuredScratch
      : undefined;
  const safeSystemTemp = !isForbiddenWindowsStoragePath(systemTempDir)
    ? systemTempDir
    : path.win32.join(path.win32.parse(systemTempDir).root, "Scratch");
  const scratchRoot =
    pathExists("D:\\Scratch")
      ? "D:\\Scratch"
      : safeConfiguredScratch ?? safeSystemTemp;
  const configuredStore = env.npm_config_store_dir?.trim();
  const safeConfiguredStore =
    configuredStore &&
    targetPath.isAbsolute(configuredStore) &&
    !isForbiddenWindowsStoragePath(configuredStore)
      ? configuredStore
      : undefined;
  const pnpmStoreDir =
    pathExists("D:\\PnpmStore")
      ? "D:\\PnpmStore"
      : safeConfiguredStore;

  return {
    tempDir: targetPath.join(scratchRoot, "cukii-vendor-runtime"),
    ...(pnpmStoreDir ? { pnpmStoreDir } : {}),
  };
}
