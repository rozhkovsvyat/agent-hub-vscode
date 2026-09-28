import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createConsistentSqliteSnapshot } from "core/util/sqliteSnapshot";

const LEGACY_DIR_NAME = ".continue";
const CUKII_DIR_NAME = ".cukii";
const HISTORY_DATABASE = "history.sqlite3";
const MIGRATION_LOCK = ".cukii-global-dir-migration-lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

export type CukiiGlobalDirSelection = {
  globalDir: string;
  legacyDir: string;
  usesCukiiDefault: boolean;
};

/**
 * Cukii is forked from Continue, but its runtime data belongs under ~/.cukii.
 * This must run before importing the core: core/util/paths freezes the value
 * of CONTINUE_GLOBAL_DIR when that module is first evaluated.
 */
export function configureCukiiGlobalDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
): CukiiGlobalDirSelection {
  const configured = env.CONTINUE_GLOBAL_DIR?.trim();
  if (configured) {
    return {
      globalDir: path.isAbsolute(configured)
        ? configured
        : path.resolve(cwd, configured),
      legacyDir: path.join(homeDir, LEGACY_DIR_NAME),
      usesCukiiDefault: false,
    };
  }

  const globalDir = path.join(homeDir, CUKII_DIR_NAME);
  env.CONTINUE_GLOBAL_DIR = globalDir;
  return {
    globalDir,
    legacyDir: path.join(homeDir, LEGACY_DIR_NAME),
    usesCukiiDefault: true,
  };
}

function assertRealDirectory(directory: string): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cukii data root is not a real directory: ${directory}`);
  }
}

/** Copy only missing legacy entries. Existing Cukii data always wins. */
function copyMissing(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) return;

  if (sourceStat.isDirectory()) {
    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        return;
      }
    } else {
      try {
        fs.mkdirSync(destination, { mode: sourceStat.mode & 0o777 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const destinationStat = fs.lstatSync(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        return;
      }
    }
    for (const entry of fs.readdirSync(source)) {
      copyMissing(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }

  if (!sourceStat.isFile() || fs.existsSync(destination)) return;
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, sourceStat.mode & 0o777);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function acquireMigrationLock(
  root: string,
  destinationDatabase: string,
): Promise<string | undefined> {
  const lock = path.join(root, MIGRATION_LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock);
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fs.existsSync(destinationDatabase)) return undefined;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmdirSync(lock);
        continue;
      }
    } catch {
      // The owner may have released the lock between stat and removal.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Cukii history migration");
}

/**
 * Migrate legacy Cukii state without deleting or overwriting either root.
 * SQLite VACUUM INTO is a consistent snapshot and therefore includes rows
 * that still live only in history.sqlite3-wal.
 */
export async function migrateLegacyCukiiGlobalDir(
  selection: CukiiGlobalDirSelection,
): Promise<boolean> {
  if (!selection.usesCukiiDefault || !fs.existsSync(selection.legacyDir)) {
    return false;
  }
  if (path.resolve(selection.globalDir) === path.resolve(selection.legacyDir)) {
    return false;
  }

  const legacyStat = fs.lstatSync(selection.legacyDir);
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) {
    throw new Error(
      `Legacy Cukii data root is not a real directory: ${selection.legacyDir}`,
    );
  }
  assertRealDirectory(selection.globalDir);

  for (const entry of fs.readdirSync(selection.legacyDir)) {
    if (
      entry === HISTORY_DATABASE ||
      entry === `${HISTORY_DATABASE}-wal` ||
      entry === `${HISTORY_DATABASE}-shm`
    ) {
      continue;
    }
    copyMissing(
      path.join(selection.legacyDir, entry),
      path.join(selection.globalDir, entry),
    );
  }

  const sourceDatabase = path.join(selection.legacyDir, HISTORY_DATABASE);
  const destinationDatabase = path.join(selection.globalDir, HISTORY_DATABASE);
  if (!fs.existsSync(sourceDatabase) || fs.existsSync(destinationDatabase)) {
    return false;
  }

  const lock = await acquireMigrationLock(
    selection.globalDir,
    destinationDatabase,
  );
  if (!lock) return false;
  const temporaryDatabase = path.join(
    selection.globalDir,
    `${HISTORY_DATABASE}.migrate-${process.pid}-${Date.now()}`,
  );
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {}
  }, 5_000);
  heartbeat.unref();
  try {
    if (fs.existsSync(destinationDatabase)) return false;
    await createConsistentSqliteSnapshot(sourceDatabase, temporaryDatabase);
    if (fs.existsSync(destinationDatabase)) return false;
    fs.renameSync(temporaryDatabase, destinationDatabase);
    return true;
  } finally {
    clearInterval(heartbeat);
    try {
      if (fs.existsSync(temporaryDatabase)) fs.unlinkSync(temporaryDatabase);
    } catch {}
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}
