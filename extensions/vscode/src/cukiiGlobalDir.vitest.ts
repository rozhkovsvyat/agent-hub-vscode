import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import sqlite3 from "../../../core/node_modules/sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import {
  configureCukiiGlobalDir,
  migrateLegacyCukiiGlobalDir,
} from "./cukiiGlobalDir";

const roots: string[] = [];

function temporaryHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-global-dir-test-"));
  roots.push(root);
  return root;
}

function openDatabase(filename: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) =>
      error ? reject(error) : resolve(database),
    );
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) =>
    database.close((error) => (error ? reject(error) : resolve())),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Cukii global data directory", () => {
  test("defaults to ~/.cukii before core paths are imported", () => {
    const home = temporaryHome();
    const env: NodeJS.ProcessEnv = {};
    const selected = configureCukiiGlobalDir(env, home);

    expect(selected).toEqual({
      globalDir: path.join(home, ".cukii"),
      legacyDir: path.join(home, ".continue"),
      usesCukiiDefault: true,
    });
    expect(env.CONTINUE_GLOBAL_DIR).toBe(path.join(home, ".cukii"));
  });

  test("preserves an explicit relative CONTINUE_GLOBAL_DIR", () => {
    const home = temporaryHome();
    const cwd = path.join(home, "workspace");
    const env: NodeJS.ProcessEnv = { CONTINUE_GLOBAL_DIR: "custom-state" };
    const selected = configureCukiiGlobalDir(env, home, cwd);

    expect(selected.globalDir).toBe(path.join(cwd, "custom-state"));
    expect(selected.usesCukiiDefault).toBe(false);
    expect(env.CONTINUE_GLOBAL_DIR).toBe("custom-state");
  });

  test("copies missing state and snapshots rows that only exist in WAL", async () => {
    const home = temporaryHome();
    const legacy = path.join(home, ".continue");
    const target = path.join(home, ".cukii");
    fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.yaml"), "legacy: true\n");
    fs.writeFileSync(path.join(target, "config.yaml"), "cukii: true\n");
    fs.writeFileSync(path.join(legacy, "sessions", "old.json"), "{}\n");

    const source = await openDatabase(path.join(legacy, "history.sqlite3"));
    await new Promise<void>((resolve, reject) => {
      source.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES ('from-wal');",
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const selected = configureCukiiGlobalDir({}, home);
    expect(await migrateLegacyCukiiGlobalDir(selected)).toBe(true);
    await closeDatabase(source);

    expect(fs.readFileSync(path.join(target, "config.yaml"), "utf8")).toBe(
      "cukii: true\n",
    );
    expect(
      fs.readFileSync(path.join(target, "sessions", "old.json"), "utf8"),
    ).toBe("{}\n");

    const migrated = await openDatabase(path.join(target, "history.sqlite3"));
    const row = await new Promise<{ value: string }>((resolve, reject) => {
      migrated.get(
        "SELECT value FROM messages",
        (error, value: { value: string }) =>
          error ? reject(error) : resolve(value),
      );
    });
    await closeDatabase(migrated);
    expect(row.value).toBe("from-wal");
  });

  test("never overwrites an existing Cukii history database", async () => {
    const home = temporaryHome();
    const legacy = path.join(home, ".continue");
    const target = path.join(home, ".cukii");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "history.sqlite3"), "legacy");
    fs.writeFileSync(path.join(target, "history.sqlite3"), "cukii");

    const selected = configureCukiiGlobalDir({}, home);
    expect(await migrateLegacyCukiiGlobalDir(selected)).toBe(false);
    expect(fs.readFileSync(path.join(target, "history.sqlite3"), "utf8")).toBe(
      "cukii",
    );
  });

  test("serializes two first-run migrations without replacing the winner", async () => {
    const home = temporaryHome();
    const legacy = path.join(home, ".continue");
    fs.mkdirSync(legacy, { recursive: true });
    const source = await openDatabase(path.join(legacy, "history.sqlite3"));
    await new Promise<void>((resolve, reject) => {
      source.exec(
        "CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES ('one-copy');",
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await closeDatabase(source);

    const selected = configureCukiiGlobalDir({}, home);
    const results = await Promise.all([
      migrateLegacyCukiiGlobalDir(selected),
      migrateLegacyCukiiGlobalDir(selected),
    ]);
    expect(results.sort()).toEqual([false, true]);

    const migrated = await openDatabase(
      path.join(home, ".cukii", "history.sqlite3"),
    );
    const row = await new Promise<{ value: string }>((resolve, reject) => {
      migrated.get(
        "SELECT value FROM messages",
        (error, value: { value: string }) =>
          error ? reject(error) : resolve(value),
      );
    });
    await closeDatabase(migrated);
    expect(row.value).toBe("one-copy");
  });

  test("does not publish an empty target when the legacy database is corrupt", async () => {
    const home = temporaryHome();
    const legacy = path.join(home, ".continue");
    const target = path.join(home, ".cukii");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "history.sqlite3"), "not sqlite");

    const selected = configureCukiiGlobalDir({}, home);
    await expect(migrateLegacyCukiiGlobalDir(selected)).rejects.toThrow();
    expect(fs.existsSync(path.join(target, "history.sqlite3"))).toBe(false);
    expect(
      fs
        .readdirSync(target)
        .some((entry) => entry.startsWith("history.sqlite3.migrate-")),
    ).toBe(false);
  });
});
