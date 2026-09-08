import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BridgeInboxWatch,
  bridgeInboxMessageStatus,
  bridgeInboxRoot,
  markBridgeInboxMessagesRead,
  purgeUnreadBridgeInboxMessages,
  readBridgeInboxMessageIds,
  writeBridgeInboxMessage,
} from "./bridgeInbox";

function spawnLockReleaser(lockPath: string, delayMs: number) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs = require('node:fs');",
        "process.stdout.write('ready\\n');",
        "setTimeout(() => fs.rmdirSync(process.argv[1]), Number(process.argv[2]));",
      ].join(" "),
      lockPath,
      String(delayMs),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("ready\n")) {
        resolve();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!output.includes("ready\n")) {
        reject(new Error(`releaser exited ${code} before ready`));
      }
    });
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`releaser exited ${code}`)),
    );
  });

  return { ready, closed };
}

describe("bridgeInbox", () => {
  let previousRoot: string | undefined;
  let root: string;

  beforeEach(() => {
    previousRoot = process.env.CUKII_INBOX_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-inbox-test-"));
    process.env.CUKII_INBOX_DIR = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CUKII_INBOX_DIR;
    else process.env.CUKII_INBOX_DIR = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a pending record the python reader can claim", () => {
    expect(writeBridgeInboxMessage("session-1", "msg-1", "живой ввод")).toBe(
      true,
    );
    expect(bridgeInboxMessageStatus("session-1", "msg-1")).toBe("pending");
    const file = fs
      .readdirSync(path.join(root, "session-1"))
      .find((name) => name.endsWith("-msg-1.json"));
    expect(file).toBeDefined();
    const record = JSON.parse(
      fs.readFileSync(path.join(root, "session-1", file!), "utf8"),
    );
    expect(record).toMatchObject({
      id: "msg-1",
      sessionId: "session-1",
      text: "живой ввод",
      status: "pending",
    });
  });

  it("uses messageId as an idempotency key across transport retries", () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);
    try {
      expect(
        writeBridgeInboxMessage("session-1", "same-id", "ровно один раз"),
      ).toBe(true);
      expect(
        writeBridgeInboxMessage("session-1", "same-id", "ровно один раз"),
      ).toBe(true);
      expect(
        fs
          .readdirSync(path.join(root, "session-1"))
          .filter((name) => name.endsWith("-same-id.json")),
      ).toHaveLength(1);

      expect(
        writeBridgeInboxMessage("session-1", "same-id", "другой payload"),
      ).toBe(false);
      expect(bridgeInboxMessageStatus("session-1", "same-id")).toBe("pending");
    } finally {
      clock.mockRestore();
    }
  });

  it("waits for the cross-process claim lock before writing", async () => {
    const dir = path.join(root, "session-1");
    const lock = path.join(dir, ".claim-lock");
    fs.mkdirSync(lock, { recursive: true });
    const releaser = spawnLockReleaser(lock, 150);
    await releaser.ready;

    const startedAt = Date.now();
    expect(writeBridgeInboxMessage("session-1", "locked", "payload")).toBe(
      true,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
    await releaser.closed;
  });

  it("holds the claim lock as bare state python can rmdir", () => {
    const originalRename = fs.renameSync.bind(fs);
    let lockEntries: string[] = ["<never entered>"];
    let siblings: string[] = ["<never entered>"];
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("-bare-lock.json")) {
        const dir = path.join(root, "session-1");
        lockEntries = fs.readdirSync(path.join(dir, ".claim-lock"));
        siblings = fs
          .readdirSync(dir)
          .filter((name) => name.startsWith(".claim-lock"));
      }
      return originalRename(from, to);
    });
    try {
      expect(writeBridgeInboxMessage("session-1", "bare-lock", "payload")).toBe(
        true,
      );
      // `broker/inbox.py` reclaims with rmdir(), which fails on a non-empty
      // directory, and knows nothing about any companion file. State inside
      // the lock would strand it after a crash; state beside it under a
      // `.claim-lock*` name outlives the lock and would later be mistaken for
      // a description of whoever holds it next.
      expect(lockEntries).toEqual([]);
      expect(siblings).toEqual([".claim-lock"]);
    } finally {
      rename.mockRestore();
    }
  });

  it("reclaims the claim lock by age only, never by owner liveness", () => {
    const dir = path.join(root, "session-1");
    const lock = path.join(dir, ".claim-lock");
    fs.mkdirSync(lock, { recursive: true });

    // No process on this machine holds this lock, which is exactly how a
    // Python holder looks to us: it publishes no liveness signal at all.
    // Reclaiming it early would evict a live `_session_lock` critical section.
    expect(writeBridgeInboxMessage("session-1", "still-held", "payload")).toBe(
      false,
    );
    expect(fs.existsSync(lock)).toBe(true);
    expect(bridgeInboxMessageStatus("session-1", "still-held")).toBe("absent");

    // Past the staleness window both languages agree the holder is gone.
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    expect(writeBridgeInboxMessage("session-1", "after-stale", "payload")).toBe(
      true,
    );
    expect(bridgeInboxMessageStatus("session-1", "after-stale")).toBe(
      "pending",
    );
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("refuses traversal-shaped segments and empty text", () => {
    expect(writeBridgeInboxMessage("../evil", "msg-1", "нет")).toBe(false);
    expect(writeBridgeInboxMessage("session-1", "../evil", "нет")).toBe(false);
    expect(writeBridgeInboxMessage("session-1", "msg-1", "   ")).toBe(false);
    expect(fs.existsSync(path.join(root, "session-1"))).toBe(false);
  });

  it("reports read once the vendor tool marks the record", () => {
    writeBridgeInboxMessage("session-1", "msg-1", "текст");
    const dir = path.join(root, "session-1");
    const file = fs
      .readdirSync(dir)
      .find((name) => name.endsWith("-msg-1.json"))!;
    const target = path.join(dir, file);
    const record = JSON.parse(fs.readFileSync(target, "utf8"));
    fs.writeFileSync(
      target,
      JSON.stringify({ ...record, status: "read" }),
      "utf8",
    );
    expect(bridgeInboxMessageStatus("session-1", "msg-1")).toBe("read");
    expect(readBridgeInboxMessageIds("session-1")).toEqual(new Set(["msg-1"]));
  });

  it("acks a direct-prompt batch only when the vendor becomes active", () => {
    writeBridgeInboxMessage("session-1", "msg-1", "первое");
    writeBridgeInboxMessage("session-1", "msg-2", "второе");
    const dir = path.join(root, "session-1");
    const leasedFile = fs
      .readdirSync(dir)
      .find((name) => name.endsWith("-msg-1.json"))!;
    const leasedPath = path.join(dir, leasedFile);
    const leased = JSON.parse(fs.readFileSync(leasedPath, "utf8"));
    fs.writeFileSync(
      leasedPath,
      JSON.stringify({
        ...leased,
        leaseOwner: "old-reader",
        leasePid: 42,
        leaseProcessStartToken: "old",
        leaseUntilMs: Date.now() + 60_000,
      }),
      "utf8",
    );

    expect(
      markBridgeInboxMessagesRead("session-1", ["msg-1", "msg-2"]),
    ).toEqual(["msg-1", "msg-2"]);
    expect(readBridgeInboxMessageIds("session-1")).toEqual(
      new Set(["msg-1", "msg-2"]),
    );
    const after = JSON.parse(fs.readFileSync(leasedPath, "utf8"));
    expect(after).toMatchObject({ status: "read" });
    expect(after).not.toHaveProperty("leaseOwner");
  });

  it("purges unread entries on explicit Stop but keeps claimed ones", async () => {
    writeBridgeInboxMessage("session-1", "msg-1", "заберут");
    writeBridgeInboxMessage("session-1", "msg-2", "останется");
    const dir = path.join(root, "session-1");
    const keepFile = fs
      .readdirSync(dir)
      .find((name) => name.endsWith("-msg-2.json"))!;
    const keepTarget = path.join(dir, keepFile);
    const record = JSON.parse(fs.readFileSync(keepTarget, "utf8"));
    fs.writeFileSync(
      keepTarget,
      JSON.stringify({ ...record, status: "read" }),
      "utf8",
    );

    await purgeUnreadBridgeInboxMessages("session-1");

    expect(bridgeInboxMessageStatus("session-1", "msg-1")).toBe("absent");
    expect(bridgeInboxMessageStatus("session-1", "msg-2")).toBe("read");
  });

  it("waits for a live claim lock before confirming explicit Stop", async () => {
    writeBridgeInboxMessage("session-1", "stop-race", "не воскресить");
    const dir = path.join(root, "session-1");
    const lock = path.join(dir, ".claim-lock");
    fs.mkdirSync(lock);
    const releaser = spawnLockReleaser(lock, 1500);
    await releaser.ready;

    await purgeUnreadBridgeInboxMessages("session-1");
    await releaser.closed;

    expect(bridgeInboxMessageStatus("session-1", "stop-race")).toBe("absent");
  });

  it("removes the image scope referenced by a purged unread record", async () => {
    const attachments = path.join(root, "attachments");
    const scope = path.join(
      attachments,
      "run-123-00000000-0000-4000-8000-000000000001",
    );
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(path.join(scope, "image.png"), "image");
    writeBridgeInboxMessage("session-1", "with-image", `@${scope}\\image.png`);
    const recordPath = fs
      .readdirSync(path.join(root, "session-1"))
      .filter((name) => name.endsWith("-with-image.json"))
      .map((name) => path.join(root, "session-1", name))[0];
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    fs.writeFileSync(
      recordPath,
      JSON.stringify({ ...record, attachmentScope: scope }),
      "utf8",
    );

    await purgeUnreadBridgeInboxMessages("session-1", attachments);

    expect(fs.existsSync(recordPath)).toBe(false);
    expect(fs.existsSync(scope)).toBe(false);
  });

  it("never removes an attachment scope outside the trusted root", async () => {
    const attachments = path.join(root, "attachments");
    const outside = path.join(root, "outside");
    fs.mkdirSync(attachments, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    writeBridgeInboxMessage("session-1", "untrusted-image", "@outside");
    const recordPath = fs
      .readdirSync(path.join(root, "session-1"))
      .filter((name) => name.endsWith("-untrusted-image.json"))
      .map((name) => path.join(root, "session-1", name))[0];
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    fs.writeFileSync(
      recordPath,
      JSON.stringify({ ...record, attachmentScope: outside }),
      "utf8",
    );

    await purgeUnreadBridgeInboxMessages("session-1", attachments);

    expect(fs.existsSync(recordPath)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("watch reports each claimed message exactly once", () => {
    writeBridgeInboxMessage("session-1", "msg-1", "первое");
    writeBridgeInboxMessage("session-1", "msg-2", "второе");
    const dir = path.join(root, "session-1");
    const markRead = (messageId: string) => {
      const file = fs
        .readdirSync(dir)
        .find((name) => name.endsWith(`-${messageId}.json`))!;
      const target = path.join(dir, file);
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      fs.writeFileSync(
        target,
        JSON.stringify({ ...record, status: "read" }),
        "utf8",
      );
    };
    const seen: string[] = [];
    const watch = new BridgeInboxWatch("session-1", (id) => seen.push(id));

    markRead("msg-1");
    watch.tick();
    watch.tick();
    expect(seen).toEqual(["msg-1"]);

    markRead("msg-2");
    watch.tick();
    expect(seen).toEqual(["msg-1", "msg-2"]);

    watch.close();
    markRead("msg-2");
    watch.tick();
    expect(seen).toEqual(["msg-1", "msg-2"]);
  });

  it("keeps the root overridable for tests and stable otherwise", () => {
    expect(bridgeInboxRoot()).toBe(root);
    delete process.env.CUKII_INBOX_DIR;
    expect(bridgeInboxRoot()).toBe(
      path.join(os.homedir(), ".continue", "cukii-inbox"),
    );
    process.env.CUKII_INBOX_DIR = root;
  });

  it("watch timer never keeps the process alive", () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    const watch = new BridgeInboxWatch("session-1", () => {});
    watch.start();
    expect(unref).toHaveBeenCalled();
    watch.close();
    spy.mockRestore();
  });
});
