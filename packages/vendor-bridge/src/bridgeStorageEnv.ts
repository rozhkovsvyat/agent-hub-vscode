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
  /** Preferred Windows scratch root tried before CUKII_SCRATCH_DIR. */
  preferredWindowsScratchRoot?: string;
  /** Preferred Windows pnpm store root tried before npm_config_store_dir. */
  preferredWindowsPnpmStoreRoot?: string;
  /** Windows roots a storage path may never resolve into. */
  forbiddenWindowsRoots?: string[];
}

/**
 * Machine-specific storage values supplied by the host (the Cukii plugin pins
 * its own rotation-managed volumes here). The library default is deliberately
 * machine-free: no preferred roots, no forbidden list, and the ladder ends at
 * the system temporary directory.
 */
export interface BridgeStorageHostConfig {
  preferredWindowsScratchRoot?: string;
  preferredWindowsPnpmStoreRoot?: string;
  forbiddenWindowsRoots?: string[];
}

let bridgeStorageHostConfig: BridgeStorageHostConfig = {};

export function configureBridgeStorageHost(
  config: BridgeStorageHostConfig,
): void {
  bridgeStorageHostConfig = { ...config };
}

function forbiddenWindowsRootsOf(options: BridgeStorageOptions): string[] {
  return (
    options.forbiddenWindowsRoots ??
    bridgeStorageHostConfig.forbiddenWindowsRoots ??
    []
  );
}

function isForbiddenWindowsStoragePath(
  candidate: string,
  forbiddenRoots: string[],
): boolean {
  const normalized = path.win32
    .normalize(candidate)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
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
  > & { forbiddenRoots: string[] },
): string | undefined {
  const requested = candidate?.trim();
  if (!requested || !isOrdinaryWindowsDrivePath(requested)) return undefined;

  try {
    if (!options.pathExists(requested) || !options.pathIsDirectory(requested)) {
      return undefined;
    }
    const physical = options.realPath(requested);
    if (!isOrdinaryWindowsDrivePath(physical)) return undefined;
    if (isForbiddenWindowsStoragePath(physical, options.forbiddenRoots))
      return undefined;
    return path.win32.normalize(physical).replace(/[\\/]+$/, "");
  } catch {
    return undefined;
  }
}

function canonicalWindowsRoot(
  candidate: string,
  label: string,
  options: Required<
    Pick<BridgeStorageOptions, "pathExists" | "pathIsDirectory" | "realPath">
  > & { forbiddenRoots: string[] },
): string | undefined {
  let exists: boolean;
  try {
    exists = options.pathExists(candidate);
  } catch (error) {
    throw new Error(`Cannot inspect canonical ${label} root ${candidate}`, {
      cause: error,
    });
  }
  if (!exists) return undefined;

  const safe = safeExistingWindowsRoot(candidate, options);
  if (!safe) {
    throw new Error(
      `Canonical ${label} root is not a safe physical directory: ${candidate}`,
    );
  }
  return safe;
}

/**
 * The one degradation ladder for a Windows scratch root, shared by the vendor
 * runtime and by Cukii's own bridge/permission/voice scratch directories: the
 * host-preferred root when that volume is actually there, then an explicitly
 * configured `CUKII_SCRATCH_DIR`, then the system temporary directory. A
 * machine without the host's volume is an ordinary machine, not a broken one —
 * `mkdir <preferred>` there is ENOENT and takes the whole bridge down with it.
 */
export function resolveWindowsScratchRoot(
  options: Pick<
    BridgeStorageOptions,
    | "env"
    | "pathExists"
    | "pathIsDirectory"
    | "realPath"
    | "systemTempDir"
    | "preferredWindowsScratchRoot"
    | "forbiddenWindowsRoots"
  > = {},
): string | undefined {
  const env = options.env ?? process.env;
  const systemTempDir = options.systemTempDir ?? os.tmpdir();
  const rootOptions = {
    pathExists: options.pathExists ?? fs.existsSync,
    pathIsDirectory:
      options.pathIsDirectory ??
      ((candidate: string) => fs.statSync(candidate).isDirectory()),
    realPath: options.realPath ?? fs.realpathSync.native,
    forbiddenRoots: forbiddenWindowsRootsOf(options),
  };
  const preferred =
    options.preferredWindowsScratchRoot ??
    bridgeStorageHostConfig.preferredWindowsScratchRoot;
  return (
    (preferred
      ? canonicalWindowsRoot(preferred, "scratch", rootOptions)
      : undefined) ??
    safeExistingWindowsRoot(
      caseInsensitiveEnvValue(env, "CUKII_SCRATCH_DIR"),
      rootOptions,
    ) ??
    safeExistingWindowsRoot(systemTempDir, rootOptions)
  );
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
    options.pathIsDirectory ??
    ((candidate) => fs.statSync(candidate).isDirectory());
  const realPath = options.realPath ?? fs.realpathSync.native;
  const rootOptions = {
    pathExists,
    pathIsDirectory,
    realPath,
    forbiddenRoots: forbiddenWindowsRootsOf(options),
  };
  const scratchRoot = resolveWindowsScratchRoot({
    ...options,
    env,
    systemTempDir,
  });
  if (!scratchRoot) {
    throw new Error("No safe existing Windows temporary root is available");
  }
  const tempDir = targetPath.join(scratchRoot, "cukii-vendor-runtime");
  if (pathExists(tempDir)) {
    const physicalTempDir = safeExistingWindowsRoot(tempDir, rootOptions);
    const expectedPhysicalTempDir = path.win32
      .normalize(tempDir)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
    if (
      !physicalTempDir ||
      physicalTempDir.toLowerCase() !== expectedPhysicalTempDir
    ) {
      throw new Error(
        `Canonical vendor temporary directory escapes its verified root: ${tempDir}`,
      );
    }
  }
  const preferredPnpmStore =
    options.preferredWindowsPnpmStoreRoot ??
    bridgeStorageHostConfig.preferredWindowsPnpmStoreRoot;
  const pnpmStoreDir =
    (preferredPnpmStore
      ? canonicalWindowsRoot(preferredPnpmStore, "pnpm store", rootOptions)
      : undefined) ??
    safeExistingWindowsRoot(
      caseInsensitiveEnvValue(env, "npm_config_store_dir"),
      rootOptions,
    );

  return {
    tempDir,
    ...(pnpmStoreDir ? { pnpmStoreDir } : {}),
  };
}

export function bridgeStorageEnvOverrides(
  options: BridgeStorageOptions = {},
): Record<string, string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};

  const inherited = options.env ?? process.env;
  const storage = resolveBridgeStorageLayout({
    ...options,
    platform,
    env: inherited,
  });
  const overrides: Record<string, string | null> = {};
  for (const key of Object.keys(inherited)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "temp" ||
      normalized === "tmp" ||
      normalized === "tmpdir"
    ) {
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
  const storage = resolveBridgeStorageLayout({
    ...options,
    platform,
    env: inherited,
  });
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
