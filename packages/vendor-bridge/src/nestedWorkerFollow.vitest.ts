import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerNestedWorkerFollower } from "./nestedWorkerFollow";
import {
  createLogTailer,
  createNestedWorkerFollower,
  drainFollowers,
  isAllowedLogPath,
  isDelegationTool,
  parseNestedWorker,
  setBrokerStatusPollerForTests,
  type NestedWorkerFollower,
} from "./nestedWorkerFollow";

const DELEGATION_TOOLS = [
  "cursor_submit",
  "cursor_delegate",
  "broker_delegate",
  "mcp__cursor-bridge__cursor_submit",
  "mcp__cursor-bridge__cursor_delegate",
  "mcp__cukii-broker__broker_delegate",
];

const NON_DELEGATION_TOOLS = ["Read", "Write", "Shell"];

describe("isDelegationTool", () => {
  it.each(DELEGATION_TOOLS)("returns true for %s", (name) => {
    expect(isDelegationTool(name)).toBe(true);
    expect(isDelegationTool(`prefix/${name}`)).toBe(true);
    expect(isDelegationTool(name.toUpperCase())).toBe(true);
  });

  it.each(NON_DELEGATION_TOOLS)("returns false for %s", (name) => {
    expect(isDelegationTool(name)).toBe(false);
  });
});

describe("parseNestedWorker", () => {
  it("extracts cursor_submit log path from JSON blob", () => {
    const logPath = "D:\\Scratch\\cukii-bridge\\job.output.log";
    const output = JSON.stringify({
      job: "260825130844-883400-0000",
      output: logPath,
      active: true,
    });
    expect(parseNestedWorker(output)).toEqual({
      kind: "log",
      path: logPath,
      job: "260825130844-883400-0000",
    });
  });

  it("allows cursor-bridge worker logs outside tmpdir", () => {
    expect(
      isAllowedLogPath(
        "D:\\Brain\\repo\\personal\\agent-hub\\data\\logs\\cursor-bridge\\260825130844-883400-0000.output.log",
      ),
    ).toBe(true);
  });

  it("refuses to tail an arbitrary .log path even if job is present", () => {
    expect(
      parseNestedWorker(
        JSON.stringify({
          job: "260825130844-883400-0000",
          output: "C:\\Windows\\System32\\config\\sam.log",
          active: true,
        }),
      ),
    ).toBeNull();
    expect(isAllowedLogPath("C:\\Windows\\System32\\config\\sam.log")).toBe(
      false,
    );
  });

  it("extracts broker task_id and scope", () => {
    const output = JSON.stringify({
      task_id: "t1",
      scope: "hub",
      status: "running",
    });
    expect(parseNestedWorker(output)).toEqual({
      kind: "broker",
      taskId: "t1",
      scope: "hub",
      status: "running",
    });
  });
});

describe("createLogTailer", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const file of tempFiles.splice(0)) {
      fs.rmSync(file, { force: true });
    }
  });

  it("returns only unread bytes across incremental writes", () => {
    const file = path.join(
      os.tmpdir(),
      `nested-worker-tail-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
    );
    tempFiles.push(file);

    const tailer = createLogTailer(file);
    expect(tailer.readNew()).toBe("");

    fs.writeFileSync(file, "alpha\n", "utf8");
    expect(tailer.readNew()).toBe("alpha\n");

    fs.appendFileSync(file, "beta\n", "utf8");
    expect(tailer.readNew()).toBe("beta\n");
    expect(tailer.readNew()).toBe("");

    tailer.close();
    fs.appendFileSync(file, "gamma\n", "utf8");
    expect(tailer.readNew()).toBe("");
  });
});

describe("drainFollowers", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    setBrokerStatusPollerForTests();
    for (const file of tempFiles.splice(0)) {
      fs.rmSync(file, { force: true });
    }
  });

  it("yields thinking from a growing log while the parent stream is silent", () => {
    const root = "D:\\Scratch\\cukii-bridge";
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(
      root,
      `nested-worker-follow-${Date.now()}-${Math.random().toString(16).slice(2)}.output.log`,
    );
    tempFiles.push(file);

    const toolResult = JSON.stringify({
      job: "260825130844-883400-0000",
      output: file,
      active: true,
    });
    const followers: NestedWorkerFollower[] = [];
    const toolNames = new Map<string, string>([["tool-1", "cursor_submit"]]);

    registerNestedWorkerFollower(
      { kind: "toolResult", id: "tool-1", output: toolResult, isError: false },
      toolNames,
      followers,
    );
    expect(followers).toHaveLength(1);

    const launching = drainFollowers(followers);
    expect(launching).toHaveLength(1);
    expect(launching[0].role).toBe("thinking");
    expect(launching[0].content).toBe(
      "[Composer 2.5 job 260825130844-883400-0000]\n",
    );

    fs.writeFileSync(file, "worker started\n", "utf8");
    const first = drainFollowers(followers);
    expect(first).toHaveLength(1);
    expect(first[0].content).toBe("worker started\n");

    fs.appendFileSync(file, "still running\n", "utf8");
    const second = drainFollowers(followers);
    expect(second).toHaveLength(1);
    expect(second[0].content).toBe("still running\n");
    expect(drainFollowers(followers)).toEqual([]);
  });

  it("does not follow a non-delegation tool that happens to return a log JSON", () => {
    const file = path.join(
      os.tmpdir(),
      `nested-worker-nondeny-${Date.now()}.output.log`,
    );
    tempFiles.push(file);
    fs.writeFileSync(file, "secret\n", "utf8");
    const followers: NestedWorkerFollower[] = [];
    registerNestedWorkerFollower(
      {
        kind: "toolResult",
        id: "tool-1",
        output: JSON.stringify({ job: "x", output: file }),
        isError: false,
      },
      new Map([["tool-1", "Write"]]),
      followers,
    );
    expect(followers).toHaveLength(0);
  });

  it("re-emits broker status when the poller reports a change", async () => {
    setBrokerStatusPollerForTests(async () => ({ status: "done" }));
    try {
      const follower = createNestedWorkerFollower(
        JSON.stringify({ task_id: "t1", scope: "hub", status: "running" }),
      );
      expect(follower).not.toBeNull();
      const first = follower!.drain();
      expect(first).toHaveLength(1);
      expect(first[0].content).toBe("[broker hub/t1] status: running\n");
      await Promise.resolve();
      await Promise.resolve();
      const second = follower!.drain();
      expect(second).toHaveLength(1);
      expect(second[0].content).toBe("[broker hub/t1] status: done\n");
      follower!.close();
    } finally {
      setBrokerStatusPollerForTests();
    }
  });
});
