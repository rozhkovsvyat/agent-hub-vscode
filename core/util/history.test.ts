import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { performance } from "perf_hooks";
import { v4 as uuid } from "uuid";
import { Session } from "..";
import { getContinueGlobalPath, getSessionsFolderPath } from "./paths";
import {
  HistoryConflictError,
  HistoryIntegrityError,
  HistoryManager,
} from "./history";

const make = (
  id: string,
  title = id,
  history: Session["history"] = [],
): Session => ({
  sessionId: id,
  title,
  workspaceDirectory: "C:/workspace",
  history,
});
const user = (id: string, value: unknown) => ({
  message: { id, role: "user", content: value } as any,
  contextItems: [],
});
async function child(
  operation: string,
  session: Session,
  barrier: string,
  label: string,
  globalDir?: string,
) {
  const root = path.resolve(process.cwd());
  const childProcess = spawn(
    process.execPath,
    [
      "--experimental-vm-modules",
      path.join(root, "node_modules", "jest", "bin", "jest.js"),
      "--config",
      "test/jest.history-child.config.js",
      "--runInBand",
    ],
    {
      cwd: root,
      env: {
        ...global.process.env,
        CUKII_HISTORY_BARRIER: barrier,
        CUKII_HISTORY_LABEL: label,
        CUKII_HISTORY_OPERATION: operation,
        CUKII_HISTORY_SESSION: JSON.stringify(session),
        ...(globalDir ? { CONTINUE_GLOBAL_DIR: globalDir } : {}),
      },
      stdio: "ignore",
    },
  );
  return new Promise<void>((resolve, reject) =>
    childProcess.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`child ${label} exit ${code}`)),
    ),
  );
}
async function barrierWait(dir: string, names: string[]) {
  for (let i = 0; i < 3000; i++) {
    if (names.every((n) => fs.existsSync(path.join(dir, `${n}.ready`)))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("barrier timeout");
}

describe("SQLite session history", () => {
  let history: HistoryManager;
  beforeEach(async () => {
    history = new HistoryManager();
    await history.clearAll();
  });

  test("exact body, model controls, unicode/null and manual title round-trip", async () => {
    const id = `round-${uuid()}`;
    const first = await history.save({
      ...make(id, "Куки 🍪", [user("u", null)]),
      chatModelTitle: "Opus 5",
      brokerModel: "qwen",
      brokerEffort: "high",
      usage: { remaining: 0 } as any,
    });
    const renamed = await history.renameExisting(id, "ручное имя");
    const automatic = await history.save({
      ...renamed!,
      title: "automatic",
      history: [...renamed!.history, user("u2", "x")],
    });
    expect(renamed?.title).toBe("ручное имя");
    expect(automatic.title).toBe("ручное имя");
    expect(await history.load(id)).toMatchObject({
      title: "ручное имя",
      chatModelTitle: "Opus 5",
      brokerModel: "qwen",
      brokerEffort: "high",
      titleManuallySet: true,
    });
    expect(
      (await history.list()).find((item) => item.sessionId === id),
    ).toMatchObject({
      title: "ручное имя",
      revision: automatic.revision,
    });
  });
  test("sequential manual renameExisting applies each requested title", async () => {
    const id = `rename-seq-${uuid()}`;
    const initial = await history.save(make(id, "A", [user("u", "x")]));
    const first = await history.renameExisting(id, "B");
    expect(first?.title).toBe("B");
    expect(first?.titleManuallySet).toBe(true);
    expect(first!.revision!).toBeGreaterThan(initial.revision!);
    const second = await history.renameExisting(id, "C");
    expect(second?.title).toBe("C");
    expect(second?.titleManuallySet).toBe(true);
    expect(second!.revision!).toBeGreaterThan(first!.revision!);
    const loaded = await history.load(id);
    expect(loaded).toMatchObject({
      title: "C",
      titleManuallySet: true,
      revision: second!.revision,
    });
    expect(
      (await history.list()).find((item) => item.sessionId === id),
    ).toMatchObject({
      title: "C",
      revision: second!.revision,
    });
  });
  test("concurrent manual renames retry at the CAS boundary without losing either commit", async () => {
    const id = `rename-race-${uuid()}`;
    const initial = await history.save(make(id, "A", [user("u", "x")]));
    const [one, two] = await Promise.all([
      history.renameExisting(id, "B"),
      history.renameExisting(id, "C"),
    ]);
    expect(one?.title).toBe("B");
    expect(two?.title).toBe("C");
    expect(one?.revision).not.toBe(two?.revision);
    const final = await history.load(id);
    expect(["B", "C"]).toContain(final.title);
    const winner = (one!.revision! > two!.revision! ? one : two)!;
    expect(final.title).toBe(winner.title);
    expect(final.revision).toBe(winner.revision);
    expect(final.revision).toBe(initial.revision! + 2);
    expect(final.titleManuallySet).toBe(true);
  });
  test("legacy JSON migration is idempotent and retains source", async () => {
    const id = `legacy-${uuid()}`,
      file = path.join(getSessionsFolderPath(), `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(make(id, "legacy")));
    const db = await (history as any).db();
    await db.run("DELETE FROM history_meta WHERE key='legacy-fast-v1'");
    fs.writeFileSync(
      path.join(getSessionsFolderPath(), "sessions.json"),
      JSON.stringify([
        {
          sessionId: id,
          title: "indexed title",
          workspaceDirectory: "file:///C:/legacy",
          dateCreated: "123",
          messageCount: 7,
        },
      ]),
    );
    const one = new HistoryManager(),
      two = new HistoryManager();
    expect((await one.load(id)).title).toBe("indexed title");
    expect((await two.list({})).find((x) => x.sessionId === id)).toMatchObject({
      dateCreated: "123",
      messageCount: 7,
      workspaceDirectory: "file:///C:/legacy",
    });
    expect(fs.existsSync(file)).toBe(true);
  });
  test("official legacy same-id rewrite updates an unchanged imported SQLite row", async () => {
    const id = `legacy-refresh-${uuid()}`;
    const folder = getSessionsFolderPath();
    fs.writeFileSync(
      path.join(folder, `${id}.json`),
      JSON.stringify(make(id, "old")),
    );
    fs.writeFileSync(
      path.join(folder, "sessions.json"),
      JSON.stringify([
        {
          sessionId: id,
          title: "old",
          workspaceDirectory: "C:/old",
          dateCreated: "1",
          messageCount: 0,
        },
      ]),
    );
    const db = await (history as any).db();
    await db.run("DELETE FROM history_meta WHERE key='legacy-fast-v1'");
    const imported = await history.load(id);
    fs.writeFileSync(
      path.join(folder, `${id}.json`),
      JSON.stringify(make(id, "new legacy title")),
    );
    fs.writeFileSync(
      path.join(folder, "sessions.json"),
      JSON.stringify([
        {
          sessionId: id,
          title: "new indexed title",
          workspaceDirectory: "C:/new",
          dateCreated: "2",
          messageCount: 0,
        },
      ]),
    );
    await history.list({});
    const refreshed = await history.load(id);
    expect(refreshed).toMatchObject({
      title: "new indexed title",
      workspaceDirectory: "C:/new",
    });
    expect(refreshed.revision).toBe((imported.revision || 0) + 1);
  });
  test("divergent same-id legacy rewrite is quarantined and surfaces a conflict", async () => {
    const id = `legacy-diverge-${uuid()}`;
    const folder = getSessionsFolderPath();
    fs.writeFileSync(
      path.join(folder, `${id}.json`),
      JSON.stringify(make(id, "old")),
    );
    fs.writeFileSync(
      path.join(folder, "sessions.json"),
      JSON.stringify([{ sessionId: id, title: "old" }]),
    );
    const db = await (history as any).db();
    await db.run("DELETE FROM history_meta WHERE key='legacy-fast-v1'");
    const imported = await history.load(id);
    await history.save({ ...imported, title: "SQLite winner" });
    fs.writeFileSync(
      path.join(folder, `${id}.json`),
      JSON.stringify(make(id, "legacy changed")),
    );
    fs.writeFileSync(
      path.join(folder, "sessions.json"),
      JSON.stringify([{ sessionId: id, title: "legacy changed" }]),
    );
    await expect(history.list({})).rejects.toBeInstanceOf(HistoryConflictError);
    expect(
      await db.get("SELECT id FROM legacy_conflicts WHERE id=?", id),
    ).toMatchObject({ id });
    expect((await history.load(id)).title).toBe("SQLite winner");
    fs.unlinkSync(path.join(folder, `${id}.json`));
    fs.writeFileSync(path.join(folder, "sessions.json"), "[]");
    await history.list({});
  });
  test("legacy sessions index symlink is rejected before probe or read", async () => {
    const folder = getSessionsFolderPath();
    const index = path.join(folder, "sessions.json");
    const target = path.join(folder, `index-target-${uuid()}.json`);
    const db = await (history as any).db();
    await db.run("DELETE FROM history_meta WHERE key='legacy-fast-v1'");
    fs.writeFileSync(target, "[]");
    fs.rmSync(index, { force: true });
    fs.symlinkSync(target, index, "file");
    await expect(history.list({})).rejects.toBeInstanceOf(
      HistoryIntegrityError,
    );
    fs.rmSync(index, { force: true });
    fs.rmSync(target, { force: true });
    fs.writeFileSync(index, "[]");
    await history.list({});
  });
  test("failed migration rolls back marker/rows and a later open retries", async () => {
    const id = `retry-${uuid()}`,
      file = path.join(getSessionsFolderPath(), `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(make(id, "retry")));
    const db = await (history as any).db();
    await db.run("DELETE FROM history_meta WHERE key='legacy-fast-v1'");
    await expect(
      new HistoryManager({
        beforeMigrationCommit: () => {
          throw new Error("inject");
        },
      }).list({}),
    ).rejects.toThrow("inject");
    expect((await new HistoryManager().load(id)).title).toBe("retry");
    expect(fs.existsSync(file)).toBe(true);
  });
  test("same revision concurrent saves expose one explicit conflict; independent ids both persist", async () => {
    const id = `race-${uuid()}`,
      base = await history.save(make(id));
    const a = new HistoryManager(),
      b = new HistoryManager();
    const result = await Promise.allSettled([
      a.save({ ...base, title: "a" }),
      b.save({ ...base, title: "b" }),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      result.filter(
        (x) =>
          x.status === "rejected" &&
          (x as PromiseRejectedResult).reason instanceof HistoryConflictError,
      ),
    ).toHaveLength(1);
    const sharedBase = await history.save(make(`shared-${uuid()}`));
    const shared = await Promise.allSettled([
      history.save({ ...sharedBase, title: "one" }),
      history.save({ ...sharedBase, title: "two" }),
    ]);
    expect(shared.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await Promise.all([
      a.save(make(`a-${uuid()}`)),
      b.save(make(`b-${uuid()}`)),
    ]);
  });
  test("OS-process CAS gives one same-id winner and preserves different ids", async () => {
    const id = `os-${uuid()}`,
      base = await history.save(make(id));
    const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-sqlite-"));
    try {
      const same = [
        child("save", { ...base, title: "a" }, barrier, "a"),
        child("save", { ...base, title: "b" }, barrier, "b"),
      ];
      await barrierWait(barrier, ["a", "b"]);
      fs.writeFileSync(path.join(barrier, "release"), "");
      await Promise.all(same);
      const results = ["a", "b"].map((n) =>
        JSON.parse(
          fs.readFileSync(path.join(barrier, `${n}.result.json`), "utf8"),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.conflict)).toHaveLength(1);
      fs.unlinkSync(path.join(barrier, "release"));
      const x = make(`osx-${uuid()}`),
        y = make(`osy-${uuid()}`);
      const different = [
        child("save", x, barrier, "x"),
        child("save", y, barrier, "y"),
      ];
      await barrierWait(barrier, ["x", "y"]);
      fs.writeFileSync(path.join(barrier, "release"), "");
      await Promise.all(different);
      expect((await history.list({})).map((r) => r.sessionId)).toEqual(
        expect.arrayContaining([x.sessionId, y.sessionId]),
      );
    } finally {
      fs.rmSync(barrier, { recursive: true, force: true });
    }
  }, 60000);
  test("OS-process delete/clear racing a stale save cannot resurrect", async () => {
    for (const operation of ["delete", "clear"] as const) {
      const id = `linear-${operation}-${uuid()}`,
        base = await history.save(make(id));
      const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-sqlite-"));
      try {
        const work = [
          child("save", { ...base, title: "stale" }, barrier, "save"),
          child(operation, base, barrier, operation),
        ];
        await barrierWait(barrier, ["save", operation]);
        fs.writeFileSync(path.join(barrier, "release"), "");
        await Promise.all(work);
        const receipt = ["save", operation].map((name) =>
          JSON.parse(
            fs.readFileSync(path.join(barrier, `${name}.result.json`), "utf8"),
          ),
        );
        expect(receipt.some((row) => row.ok || row.conflict)).toBe(true);
        expect(
          (await history.list({})).some((row) => row.sessionId === id),
        ).toBe(false);
      } finally {
        fs.rmSync(barrier, { recursive: true, force: true });
      }
    }
  }, 60000);
  test("delete and clear are transactional with no resurrection from stale save", async () => {
    const id = `delete-${uuid()}`,
      base = await history.save(make(id));
    await history.delete(id);
    await expect(
      new HistoryManager().save({ ...base, title: "stale" }),
    ).rejects.toBeInstanceOf(HistoryConflictError);
    await history.clearAll();
    expect(await history.list({})).toEqual([]);
    expect(await new HistoryManager().list({})).toEqual([]);
  });
  test("tombstone revision defeats ABA after delete and clear", async () => {
    const deletedId = `aba-delete-${uuid()}`;
    const deleted = await history.save(make(deletedId));
    await history.delete(deletedId);
    await expect(
      history.save({ ...deleted, title: "stale" }),
    ).rejects.toBeInstanceOf(HistoryConflictError);

    const clearedId = `aba-clear-${uuid()}`;
    const cleared = await history.save(make(clearedId));
    await history.clearAll();
    await expect(
      history.save({ ...cleared, title: "stale" }),
    ).rejects.toBeInstanceOf(HistoryConflictError);
    expect((await history.save(make(clearedId))).revision).toBeGreaterThan(
      cleared.revision!,
    );
  });
  test("indexed list filters and deterministic pagination", async () => {
    for (let i = 0; i < 12; i++)
      await history.save({
        ...make(`page-${i}-${uuid()}`, String(i)),
        workspaceDirectory: i % 2 ? "A" : "B",
      });
    const rows = await history.list({
      workspaceDirectory: "a",
      limit: 3,
      offset: 1,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.workspaceDirectory === "A")).toBe(true);
  });
  test("cold new manager lists 3828 / ~39MB sessions within SLA", async () => {
    const payload = "x".repeat(10_200),
      db = await (history as any).db();
    await (history as any).transaction(db, async () => {
      for (let i = 0; i < 3828; i++) {
        const id = `perf-${i}-${uuid()}`,
          body = make(id, `P${i}`, [user(`u${i}`, payload)]);
        await db.run(
          "INSERT INTO sessions (id,revision,title,workspace,created_at,created_order,updated_at,message_count,body_json,manual_title) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            1,
            body.title,
            body.workspaceDirectory,
            String(i),
            i,
            i,
            0,
            JSON.stringify(body),
            0,
          ],
        );
      }
    });
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const rows = await new HistoryManager().list({});
      expect(rows.length).toBeGreaterThanOrEqual(3828);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThanOrEqual(2500);
    console.info(`HISTORY_SQLITE_COLD_P95=${times[2].toFixed(1)}ms`);
  }, 60000);
  test("first OS-process legacy upgrade migrates 3828 / ~39MB within SLA", async () => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "cukii-legacy-upgrade-"),
      ),
      sessions = path.join(root, "sessions"),
      barrier = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-sqlite-"));
    const payload = "x".repeat(10_200),
      rows: any[] = [];
    try {
      fs.mkdirSync(sessions, { recursive: true });
      for (let i = 0; i < 3828; i++) {
        const id = `legacyperf-${i}`;
        const body = make(id, `P${i}`, [user(`u${i}`, payload)]);
        fs.writeFileSync(
          path.join(sessions, `${id}.json`),
          JSON.stringify(body),
        );
        rows.push({
          sessionId: id,
          title: body.title,
          workspaceDirectory: body.workspaceDirectory,
          dateCreated: String(i),
          messageCount: 0,
        });
      }
      fs.writeFileSync(
        path.join(sessions, "sessions.json"),
        JSON.stringify(rows),
      );
      const start = performance.now();
      await child("list", make("ignored"), barrier, "upgrade", root);
      const elapsed = performance.now() - start;
      const result = JSON.parse(
        fs.readFileSync(path.join(barrier, "upgrade.result.json"), "utf8"),
      );
      expect(result.rows).toHaveLength(3828);
      expect(result.rows[0].dateCreated).toBe("3827");
      expect(fs.existsSync(path.join(sessions, "legacyperf-0.json"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(root, "history.sqlite3"))).toBe(true);
      expect(result.operationMs).toBeLessThanOrEqual(2500);
      console.info(
        `HISTORY_LEGACY_UPGRADE operationMs=${result.operationMs.toFixed(1)} processMs=${elapsed.toFixed(1)}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(barrier, { recursive: true, force: true });
    }
  }, 120000);
});
