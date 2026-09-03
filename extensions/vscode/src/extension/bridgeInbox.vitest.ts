import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BridgeInboxWatch,
  bridgeInboxMessageStatus,
  bridgeInboxRoot,
  purgeUnreadBridgeInboxMessages,
  readBridgeInboxMessageIds,
  writeBridgeInboxMessage,
} from "./bridgeInbox";

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

  it("refuses traversal-shaped segments and empty text", () => {
    expect(writeBridgeInboxMessage("../evil", "msg-1", "нет")).toBe(false);
    expect(writeBridgeInboxMessage("session-1", "../evil", "нет")).toBe(
      false,
    );
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
    expect(readBridgeInboxMessageIds("session-1")).toEqual(
      new Set(["msg-1"]),
    );
  });

  it("purges unread entries on explicit Stop but keeps claimed ones", () => {
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

    purgeUnreadBridgeInboxMessages("session-1");

    expect(bridgeInboxMessageStatus("session-1", "msg-1")).toBe("absent");
    expect(bridgeInboxMessageStatus("session-1", "msg-2")).toBe("read");
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
