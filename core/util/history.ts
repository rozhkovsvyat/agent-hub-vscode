import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";
import { NEW_SESSION_TITLE } from "./constants.js";
import { getContinueGlobalPath, getSessionsFolderPath } from "./paths.js";

const DATABASE = "history.sqlite3";
const LEGACY_PROBE_KEY = "legacy-fast-v1";
type Row = {
  id: string;
  revision: number;
  title: string;
  workspace: string;
  created_at: string;
  created_order: number;
  updated_at: number;
  message_count: number;
  body_json: string;
  manual_title: number;
};
export type HistoryManagerOptions = {
  beforeMutation?: () => Promise<void> | void;
  beforeMigrationCommit?: () => Promise<void> | void;
};
export class HistoryConflictError extends Error {
  readonly code = "HISTORY_CONFLICT";
  readonly userVisible = true;
  constructor(id: string) {
    super(
      `Session ${id} changed in another window. Reload it before saving again.`,
    );
    this.name = "HistoryConflictError";
  }
}
export class HistoryIntegrityError extends Error {
  readonly code = "HISTORY_INTEGRITY";
  constructor(message: string) {
    super(message);
    this.name = "HistoryIntegrityError";
  }
}

export class HistoryManager {
  private connection?: Promise<Database>;
  /** sqlite permits one writer; serialize one manager's async BEGIN/COMMIT
   * pairs so concurrent UI saves cannot interleave nested transactions. */
  private transactionTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: HistoryManagerOptions = {}) {}
  async close() {
    if (!this.connection) return;
    const db = await this.connection;
    this.connection = undefined;
    await db.close();
  }
  private validId(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
      throw new Error(`Invalid session id: ${id}`);
  }
  private root() {
    const root = getContinueGlobalPath();
    fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(root).isSymbolicLink())
      throw new HistoryIntegrityError(
        `History root is a symlink/junction: ${root}`,
      );
    return root;
  }
  private contained(target: string, root = this.root()) {
    const r = path.resolve(root),
      t = path.resolve(target),
      rel = path.relative(r, t);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new HistoryIntegrityError(`History path escapes root: ${target}`);
    let cursor = r;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor)) break;
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new HistoryIntegrityError(
          `History path contains symlink/junction: ${cursor}`,
        );
    }
  }
  private databasePath() {
    const p = path.join(this.root(), DATABASE);
    this.contained(p);
    return p;
  }
  private async db() {
    if (!this.connection) this.connection = this.open();
    return this.connection;
  }
  private async open() {
    const db = await open({
      filename: this.databasePath(),
      driver: sqlite3.Database,
    });
    const attached = await db.all<Array<{ name: string; file: string }>>(
      "PRAGMA database_list",
    );
    const main = attached.find((entry) => entry.name === "main")?.file;
    if (!main) throw new HistoryIntegrityError("SQLite has no main database");
    this.contained(main);
    await db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    const journal = await db.get<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    const timeout = await db.get<{ timeout: number }>("PRAGMA busy_timeout");
    if (
      journal?.journal_mode?.toLowerCase() !== "wal" ||
      timeout?.timeout !== 5000
    )
      throw new HistoryIntegrityError("SQLite WAL/busy_timeout unavailable");
    await db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL, created_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL, body_json TEXT NOT NULL, manual_title INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_versions (id TEXT PRIMARY KEY,max_revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS legacy_imports (id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,imported_revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS legacy_conflicts (id TEXT NOT NULL,content_hash TEXT NOT NULL,body_json TEXT NOT NULL,metadata_json TEXT NOT NULL,detected_at INTEGER NOT NULL,PRIMARY KEY(id,content_hash));`,
    );
    const columns = await db.all<Array<{ name: string }>>(
      "PRAGMA table_info(sessions)",
    );
    if (!columns.some((column) => column.name === "created_order"))
      await db.exec(
        "ALTER TABLE sessions ADD COLUMN created_order INTEGER NOT NULL DEFAULT 0",
      );
    // Seed lineages for a database created by an earlier SQLite preview. Do
    // not replace a tombstone: it may be newer than a currently live row.
    await db.run(
      "INSERT OR IGNORE INTO session_versions (id,max_revision) SELECT id,revision FROM sessions",
    );
    await this.migrateLegacy(db);
    await db.exec(
      "CREATE INDEX IF NOT EXISTS sessions_workspace_updated ON sessions(workspace,updated_at DESC); CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_order DESC);",
    );
    return db;
  }
  private async transaction<T>(db: Database, action: () => Promise<T>) {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      for (let attempt = 0; ; attempt++)
        try {
          await db.exec("BEGIN IMMEDIATE");
          try {
            const value = await action();
            await db.exec("COMMIT");
            return value;
          } catch (e) {
            try {
              await db.exec("ROLLBACK");
            } catch {}
            throw e;
          }
        } catch (e: any) {
          if (e?.code !== "SQLITE_BUSY" || attempt >= 4) throw e;
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * (attempt + 1)),
          );
        }
    } finally {
      release();
    }
  }
  private assistantCount(s: Session) {
    return s.history.filter((item) => item.message.role === "assistant").length;
  }
  private body(s: Session, revision: number, manual: boolean) {
    return { ...s, revision, titleManuallySet: manual || undefined };
  }
  private fromRow(row: Row): Session {
    try {
      const body = JSON.parse(row.body_json) as Session;
      return {
        ...body,
        sessionId: row.id,
        title: row.title,
        workspaceDirectory: row.workspace,
        titleManuallySet: row.manual_title ? true : undefined,
        revision: row.revision,
      };
    } catch {
      throw new HistoryIntegrityError(`Corrupt session body: ${row.id}`);
    }
  }
  private async parallel<T, R>(
    items: T[],
    work: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(48, items.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          out[index] = await work(items[index]);
        }
      }),
    );
    return out;
  }
  /** O(1) durable probe for the official legacy writer. A body-only rewrite
   * that does not update sessions.json is intentionally outside that writer's
   * contract and is not treated as a new source of truth after migration. */
  private async legacyProbe(folder: string) {
    const stat = async (target: string) => {
      try {
        const s = await fs.promises.lstat(target, { bigint: true });
        if (s.isSymbolicLink())
          throw new HistoryIntegrityError(
            `Legacy path is a symlink/junction: ${target}`,
          );
        return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
      } catch (error: any) {
        if (error?.code === "ENOENT") return "missing";
        throw error;
      }
    };
    return JSON.stringify({
      folder: await stat(folder),
      index: await stat(path.join(folder, "sessions.json")),
    });
  }
  private async readLegacyIndex(folder: string) {
    const index = path.join(folder, "sessions.json");
    let before: fs.BigIntStats;
    try {
      before = await fs.promises.lstat(index, { bigint: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return [] as BaseSessionMetadata[];
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink())
      throw new HistoryIntegrityError(
        `Legacy sessions index is a symlink/junction: ${index}`,
      );
    const resolved = await fs.promises.realpath(index);
    // `realpath` expands Windows 8.3 user paths; canonicalize both sides
    // before the containment check so a safe local index is not rejected.
    this.contained(resolved, await fs.promises.realpath(this.root()));
    const text = await fs.promises.readFile(index, "utf8");
    const after = await fs.promises.lstat(index, { bigint: true });
    if (
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    )
      throw new HistoryConflictError("legacy-index");
    try {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows))
        throw new HistoryIntegrityError(
          `Corrupt legacy sessions index: ${index}`,
        );
      return rows.filter(
        (row): row is BaseSessionMetadata =>
          !!row && typeof row.sessionId === "string",
      );
    } catch (error) {
      if (error instanceof HistoryIntegrityError) throw error;
      throw new HistoryIntegrityError(
        `Corrupt legacy sessions index: ${index}`,
      );
    }
  }
  private async rememberVersion(db: Database, id: string, revision: number) {
    await db.run(
      `INSERT INTO session_versions (id,max_revision) VALUES (?,?)
       ON CONFLICT(id) DO UPDATE SET max_revision=MAX(max_revision,excluded.max_revision)`,
      [id, revision],
    );
  }
  private async migrateLegacy(db: Database) {
    const folder = getSessionsFolderPath();
    this.contained(folder, this.root());
    const known = await db.get<{ value: string }>(
      "SELECT value FROM history_meta WHERE key=?",
      LEGACY_PROBE_KEY,
    );
    if (known?.value === (await this.legacyProbe(folder))) return;

    // A concurrent official legacy write is retried from a fresh scan. Source
    // JSON is never deleted; SQLite becomes authoritative only after commit.
    for (let attempt = 0; attempt < 4; attempt++) {
      const legacy: Session[] = [];
      const metadata = new Map<string, BaseSessionMetadata>();
      const fingerprint = async () => {
        if (!fs.existsSync(folder)) return "";
        const names = (await fs.promises.readdir(folder))
          .filter((name) => name.endsWith(".json"))
          .sort();
        return (
          await this.parallel(names, async (name) => {
            const stat = await fs.promises.lstat(path.join(folder, name), {
              bigint: true,
            });
            if (stat.isSymbolicLink())
              throw new HistoryIntegrityError(
                `Legacy path is a symlink/junction: ${path.join(folder, name)}`,
              );
            return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
          })
        ).join("|");
      };
      const scannedFingerprint = await fingerprint();
      const scannedProbe = await this.legacyProbe(folder);
      for (const row of await this.readLegacyIndex(folder))
        metadata.set(row.sessionId, row);
      if (fs.existsSync(folder)) {
        const names = (await fs.promises.readdir(folder)).filter(
          (name) => name !== "sessions.json" && name.endsWith(".json"),
        );
        const loaded = await this.parallel(names, async (name) => {
          const id = name.slice(0, -5);
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
            return undefined as Session | undefined;
          const file = path.join(folder, name),
            stat = await fs.promises.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new HistoryIntegrityError(
              `Legacy session is a symlink/junction: ${file}`,
            );
          try {
            return {
              ...JSON.parse(await fs.promises.readFile(file, "utf8")),
              sessionId: id,
            } as Session;
          } catch {
            throw new HistoryIntegrityError(`Corrupt legacy session: ${file}`);
          }
        });
        legacy.push(...(loaded.filter(Boolean) as Session[]));
      }
      try {
        let conflictedId: string | undefined;
        await this.transaction(db, async () => {
          const existing = new Map(
            (
              await db.all<Array<Pick<Row, "id" | "revision">>>(
                "SELECT id,revision FROM sessions",
              )
            ).map((row) => [row.id, row.revision]),
          );
          const imports = new Map(
            (
              await db.all<
                Array<{
                  id: string;
                  content_hash: string;
                  imported_revision: number;
                }>
              >("SELECT id,content_hash,imported_revision FROM legacy_imports")
            ).map((row) => [row.id, row]),
          );
          const records: Array<{
            values: unknown[];
            id: string;
            hash: string;
            revision: number;
          }> = [];
          for (const s of legacy) {
            const m = metadata.get(s.sessionId),
              revision = Math.max(1, Number(s.revision || 0)),
              manual = !!s.titleManuallySet;
            const title = typeof m?.title === "string" ? m.title : s.title;
            const workspace =
              typeof m?.workspaceDirectory === "string"
                ? m.workspaceDirectory
                : s.workspaceDirectory;
            const createdAt =
              typeof m?.dateCreated === "string"
                ? m.dateCreated
                : String(Date.now());
            const parsed = Date.parse(createdAt),
              createdOrder = Number.isFinite(parsed)
                ? parsed
                : Number(createdAt) || 0;
            const count = Number.isInteger(m?.messageCount)
              ? (m!.messageCount as number)
              : this.assistantCount(s);
            const body = this.body(
              { ...s, title, workspaceDirectory: workspace },
              revision,
              manual,
            );
            const hash = createHash("sha256")
              .update(JSON.stringify({ body, metadata: m || null }))
              .digest("hex");
            const currentRevision = existing.get(s.sessionId);
            const imported = imports.get(s.sessionId);
            if (currentRevision !== undefined) {
              if (imported?.content_hash === hash) continue;
              if (imported && imported.imported_revision === currentRevision) {
                const nextRevision = currentRevision + 1;
                const next = this.body(
                  { ...s, title, workspaceDirectory: workspace },
                  nextRevision,
                  manual,
                );
                const update = await db.run(
                  "UPDATE sessions SET revision=?,title=?,workspace=?,created_at=?,created_order=?,updated_at=?,message_count=?,body_json=?,manual_title=? WHERE id=? AND revision=?",
                  [
                    nextRevision,
                    title,
                    workspace,
                    createdAt,
                    createdOrder,
                    Date.now(),
                    count,
                    JSON.stringify(next),
                    manual ? 1 : 0,
                    s.sessionId,
                    currentRevision,
                  ],
                );
                if (update.changes !== 1)
                  throw new HistoryConflictError(s.sessionId);
                await this.rememberVersion(db, s.sessionId, nextRevision);
                await db.run(
                  "INSERT INTO legacy_imports (id,content_hash,imported_revision) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,imported_revision=excluded.imported_revision",
                  [s.sessionId, hash, nextRevision],
                );
                continue;
              }
              await db.run(
                "INSERT OR IGNORE INTO legacy_conflicts (id,content_hash,body_json,metadata_json,detected_at) VALUES (?,?,?,?,?)",
                [
                  s.sessionId,
                  hash,
                  JSON.stringify(body),
                  JSON.stringify(m || null),
                  Date.now(),
                ],
              );
              // Commit the forensic copy, but deliberately leave the global
              // probe stale. The caller gets HISTORY_CONFLICT afterwards and
              // no later open can silently accept this divergent legacy body.
              conflictedId ||= s.sessionId;
              continue;
            }
            records.push({
              values: [
                s.sessionId,
                revision,
                title,
                workspace,
                createdAt,
                createdOrder,
                Date.now(),
                count,
                JSON.stringify(body),
                manual ? 1 : 0,
              ],
              id: s.sessionId,
              hash,
              revision,
            });
          }
          // SQLite defaults to 999 bind variables. Keep wide session rows at
          // 96 per statement and write the small import receipts separately,
          // rather than adding two fsync-heavy statements per body batch.
          for (let start = 0; start < records.length; start += 96) {
            const batch = records.slice(start, start + 96);
            await db.run(
              `INSERT OR IGNORE INTO sessions (id,revision,title,workspace,created_at,created_order,updated_at,message_count,body_json,manual_title) VALUES ${batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`,
              batch.flatMap((record) => record.values),
            );
          }
          for (let start = 0; start < records.length; start += 320) {
            const batch = records.slice(start, start + 320);
            await db.run(
              `INSERT INTO legacy_imports (id,content_hash,imported_revision) VALUES ${batch.map(() => "(?,?,?)").join(",")} ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,imported_revision=excluded.imported_revision`,
              batch.flatMap((record) => [
                record.id,
                record.hash,
                record.revision,
              ]),
            );
          }
          await db.run(
            "INSERT OR IGNORE INTO session_versions (id,max_revision) SELECT id,revision FROM sessions",
          );
          await this.options.beforeMigrationCommit?.();
          if (conflictedId) return;
          if (
            (await fingerprint()) !== scannedFingerprint ||
            (await this.legacyProbe(folder)) !== scannedProbe
          )
            throw new HistoryConflictError("legacy-migration");
          await db.run("INSERT OR REPLACE INTO history_meta VALUES (?,?)", [
            LEGACY_PROBE_KEY,
            scannedProbe,
          ]);
        });
        if (conflictedId) throw new HistoryConflictError(conflictedId);
        return;
      } catch (error) {
        if (error instanceof HistoryConflictError && attempt < 3) continue;
        throw error;
      }
    }
  }
  private empty(id: string): Session {
    return {
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: id,
    };
  }
  async list(options: ListHistoryOptions = {}) {
    const db = await this.db();
    // An already-open manager pays only the two-stat legacy probe. If the
    // official legacy writer changed its index, migrate before exposing rows.
    await this.migrateLegacy(db);
    const args: unknown[] = [];
    let where = "";
    if (options.workspaceDirectory) {
      where = " WHERE workspace=? COLLATE NOCASE";
      args.push(options.workspaceDirectory);
    }
    let sql = `SELECT id,title,created_at,workspace,message_count,revision FROM sessions${where} ORDER BY created_order DESC,id DESC`;
    if (options.limit) {
      sql += " LIMIT ? OFFSET ?";
      args.push(options.limit, options.offset || 0);
    }
    const rows = await db.all<
      Array<
        Pick<
          Row,
          | "id"
          | "title"
          | "created_at"
          | "workspace"
          | "message_count"
          | "revision"
        >
      >
    >(sql, args);
    return rows.map((r): BaseSessionMetadata => ({
      sessionId: r.id,
      title: r.title,
      dateCreated: r.created_at,
      workspaceDirectory: r.workspace,
      messageCount: r.message_count,
      revision: r.revision,
    }));
  }
  async load(id: string) {
    this.validId(id);
    const row = await (
      await this.db()
    ).get<Row>("SELECT * FROM sessions WHERE id=?", id);
    return row ? this.fromRow(row) : this.empty(id);
  }
  async save(incoming: Session, opts?: { authoritativeTitle?: boolean }) {
    this.validId(incoming.sessionId);
    const db = await this.db();
    await this.options.beforeMutation?.();
    const result = await this.transaction(db, async () => {
      const current = await db.get<Row>(
        "SELECT * FROM sessions WHERE id=?",
        incoming.sessionId,
      );
      if (!current) {
        const lineage = await db.get<{ max_revision: number }>(
          "SELECT max_revision FROM session_versions WHERE id=?",
          incoming.sessionId,
        );
        // A deleted/cleared id is a tombstone. Only an explicit fresh object
        // (revision 0) may recreate it, and receives a newer revision; an old
        // rev-1 save therefore cannot pass through this ABA boundary.
        if (Number(incoming.revision || 0) !== 0)
          throw new HistoryConflictError(incoming.sessionId);
        const next = this.body(
            incoming,
            (lineage?.max_revision || 0) + 1,
            !!incoming.titleManuallySet,
          ),
          now = Date.now();
        await this.rememberVersion(db, incoming.sessionId, next.revision);
        await db.run(
          "INSERT INTO sessions (id,revision,title,workspace,created_at,created_order,updated_at,message_count,body_json,manual_title) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            incoming.sessionId,
            next.revision,
            next.title,
            next.workspaceDirectory,
            String(now),
            now,
            now,
            this.assistantCount(next),
            JSON.stringify(next),
            next.titleManuallySet ? 1 : 0,
          ],
        );
        return next;
      }
      if (Number(incoming.revision || 0) !== current.revision)
        throw new HistoryConflictError(incoming.sessionId);
      const old = this.fromRow(current),
        manual = !!current.manual_title || !!incoming.titleManuallySet,
        next = this.body(
          {
            ...old,
            ...incoming,
            title:
              current.manual_title && !opts?.authoritativeTitle
                ? current.title
                : incoming.title,
            history: incoming.history,
          },
          current.revision + 1,
          manual,
        );
      const update = await db.run(
        "UPDATE sessions SET revision=?,title=?,workspace=?,updated_at=?,message_count=?,body_json=?,manual_title=? WHERE id=? AND revision=?",
        [
          next.revision,
          next.title,
          next.workspaceDirectory,
          Date.now(),
          this.assistantCount(next),
          JSON.stringify(next),
          manual ? 1 : 0,
          incoming.sessionId,
          current.revision,
        ],
      );
      if (update.changes !== 1)
        throw new HistoryConflictError(incoming.sessionId);
      await this.rememberVersion(db, incoming.sessionId, next.revision);
      return next;
    });
    Object.assign(incoming, result);
    return result;
  }
  async renameExisting(id: string, title: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.load(id);
      if (current.title === NEW_SESSION_TITLE && !current.history.length)
        return undefined;
      try {
        return await this.save(
          { ...current, title, titleManuallySet: true },
          { authoritativeTitle: true },
        );
      } catch (error) {
        if (error instanceof HistoryConflictError && attempt < 3) continue;
        throw error;
      }
    }
    return undefined;
  }
  async delete(id: string) {
    this.validId(id);
    const db = await this.db();
    await this.options.beforeMutation?.();
    await this.transaction(db, async () => {
      const row = await db.get<Pick<Row, "revision">>(
        "SELECT revision FROM sessions WHERE id=?",
        id,
      );
      if (!row) throw new Error(`Session ${id} does not exist`);
      const removed = await db.run(
        "DELETE FROM sessions WHERE id=? AND revision=?",
        [id, row.revision],
      );
      if (removed.changes !== 1) throw new HistoryConflictError(id);
      await this.rememberVersion(db, id, row.revision);
    });
  }
  async clearAll() {
    const db = await this.db();
    await this.options.beforeMutation?.();
    await this.transaction(db, async () => {
      // Lineage rows survive the clear, preventing old objects from becoming
      // valid again if a future caller tries to reuse their id.
      await db.run(
        "INSERT OR IGNORE INTO session_versions (id,max_revision) SELECT id,revision FROM sessions",
      );
      await db.run("DELETE FROM sessions");
    });
  }
}
export default new HistoryManager();
