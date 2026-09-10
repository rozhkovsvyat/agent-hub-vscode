import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BridgeStorageLayout {
  tempDir: string;
  pnpmStoreDir?: string;
}

export interface BridgeStorageOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
  pathIsDirectory?: (candidate: string) => boolean;
  realPath?: (candidate: string) => string;
  systemTempDir?: string;
}

function isForbiddenWindowsStoragePath(candidate: string): boolean {
  const normalized = path.win32.normalize(candidate).replace(/[\\/]+$/, "").toLowerCase();
  const forbiddenRoots = [
    "d:\\tmp",
    "d:\\brain\\tmp",
    "d:\\brain\\worktrees",
    "d:\\brain\\pnpm-store",
    "d:\\.pnpm-store",
  ];
  return forbiddenRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}\\`),
  );
}

function isOrdinaryWindowsDrivePath(candidate: string): boolean {
  if (!/^[a-z]:[\\/]/i.test(candidate)) return false;
  return !candidate
    .slice(3)
    .split(/[\\/]/)
    .some((component) => component.endsWith(".") || component.endsWith(" "));
}

function caseInsensitiveEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const match = Object.entries(env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function safeExistingWindowsRoot(
  candidate: string | undefined,
  options: Required<
    Pick<BridgeStorageOptions, "pathExists" | "pathIsDirectory" | "realPath">
  >,
): string | undefined {
  const requested = candidate?.trim();
  if (!requested || !isOrdinaryWindowsDrivePath(requested)) return undefined;

  try {
    if (!options.pathExists(requested) || !options.pathIsDirectory(requested)) {
      return undefined;
    }
    const physical = options.realPath(requested);
    if (!isOrdinaryWindowsDrivePath(physical)) return undefined;
    if (isForbiddenWindowsStoragePath(physical)) return undefined;
    return path.win32.normalize(physical).replace(/[\\/]+$/, "");
  } catch {
    return undefined;
  }
}

export function removeCaseInsensitiveEnvKeys(
  env: NodeJS.ProcessEnv,
  keys: string[],
): NodeJS.ProcessEnv {
  const blocked = new Set(keys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !blocked.has(key.toLowerCase())),
  );
}

export function resolveBridgeStorageLayout(
  options: BridgeStorageOptions = {},
): BridgeStorageLayout {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const systemTempDir = options.systemTempDir ?? os.tmpdir();
  const targetPath = platform === "win32" ? path.win32 : path.posix;

  if (platform !== "win32") {
    return {
      tempDir: path.posix.join(systemTempDir, "cukii-vendor-runtime"),
    };
  }

  const pathExists = options.pathExists ?? fs.existsSync;
  const pathIsDirectory =
    options.pathIsDirectory ?? ((candidate) => fs.statSync(candidate).isDirectory());
  const realPath = options.realPath ?? fs.realpathSync.native;
  const rootOptions = { pathExists, pathIsDirectory, realPath };
  const scratchRoot =
    safeExistingWindowsRoot("D:\\Scratch", rootOptions) ??
    safeExistingWindowsRoot(
      caseInsensitiveEnvValue(env, "CUKII_SCRATCH_DIR"),
      rootOptions,
    ) ??
    safeExistingWindowsRoot(systemTempDir, rootOptions) ??
    "C:\\Temp";
  const pnpmStoreDir =
    safeExistingWindowsRoot("D:\\PnpmStore", rootOptions) ??
    safeExistingWindowsRoot(
      caseInsensitiveEnvValue(env, "npm_config_store_dir"),
      rootOptions,
    );

  return {
    tempDir: targetPath.join(scratchRoot, "cukii-vendor-runtime"),
    ...(pnpmStoreDir ? { pnpmStoreDir } : {}),
  };
}

export function bridgeStorageEnvOverrides(
  options: BridgeStorageOptions = {},
): Record<string, string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};

  const inherited = options.env ?? process.env;
  const storage = resolveBridgeStorageLayout({ ...options, platform, env: inherited });
  const overrides: Record<string, string | null> = {};
  for (const key of Object.keys(inherited)) {
    const normalized = key.toLowerCase();
    if (normalized === "temp" || normalized === "tmp" || normalized === "tmpdir") {
      overrides[key] = storage.tempDir;
    } else if (normalized === "npm_config_store_dir") {
      overrides[key] = storage.pnpmStoreDir ?? null;
    }
  }
  overrides.TEMP = storage.tempDir;
  overrides.TMP = storage.tempDir;
  overrides.TMPDIR = storage.tempDir;
  if (storage.pnpmStoreDir) {
    overrides.npm_config_store_dir = storage.pnpmStoreDir;
  }
  return overrides;
}

export function bridgeStorageProcessEnv(
  options: BridgeStorageOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const inherited = options.env ?? process.env;
  if (platform !== "win32") return { ...inherited };

  const cleaned = removeCaseInsensitiveEnvKeys(inherited, [
    "TEMP",
    "TMP",
    "TMPDIR",
    "npm_config_store_dir",
  ]);
  const storage = resolveBridgeStorageLayout({ ...options, platform, env: inherited });
  return {
    ...cleaned,
    TEMP: storage.tempDir,
    TMP: storage.tempDir,
    TMPDIR: storage.tempDir,
    ...(storage.pnpmStoreDir
      ? { npm_config_store_dir: storage.pnpmStoreDir }
      : {}),
  };
}
