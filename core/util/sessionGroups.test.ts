import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { SessionGroupState } from "./sessionGroups";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-session-groups-"));
const previousGlobalDir = process.env.CONTINUE_GLOBAL_DIR;
process.env.CONTINUE_GLOBAL_DIR = testDir;

// paths.ts freezes CONTINUE_GLOBAL_DIR at import time, so the module under
// test must load after the environment override above.
let sessionGroupsModule: typeof import("./sessionGroups");

beforeAll(async () => {
  sessionGroupsModule = await import("./sessionGroups");
});

afterAll(() => {
  if (previousGlobalDir === undefined) {
    delete process.env.CONTINUE_GLOBAL_DIR;
  } else {
    process.env.CONTINUE_GLOBAL_DIR = previousGlobalDir;
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe("session group storage", () => {
  it("parses a valid stored state", () => {
    const state = sessionGroupsModule.parseStoredSessionGroups({
      groups: [
        { id: "g1", name: "Работа" },
        { id: "g2", name: "Личное" },
      ],
      assignments: { s1: "g1", s2: "g2" },
    });
    expect(state.groups).toEqual([
      { id: "g1", name: "Работа" },
      { id: "g2", name: "Личное" },
    ]);
    expect(state.assignments).toEqual({ s1: "g1", s2: "g2" });
  });

  it("drops malformed groups and assignments to unknown groups", () => {
    const state = sessionGroupsModule.parseStoredSessionGroups({
      groups: [
        { id: "", name: "empty-id" },
        { id: "ok", name: 42 },
        { id: "keep", name: "Ок" },
        "garbage",
        null,
      ],
      assignments: { s1: "keep", s2: "ghost", s3: 7 },
    });
    expect(state.groups).toEqual([{ id: "keep", name: "Ок" }]);
    expect(state.assignments).toEqual({ s1: "keep" });
  });

  it("returns empty state for junk input instead of throwing", () => {
    const { parseStoredSessionGroups } = sessionGroupsModule;
    expect(parseStoredSessionGroups(undefined)).toEqual({
      groups: [],
      assignments: {},
    });
    expect(parseStoredSessionGroups("string")).toEqual({
      groups: [],
      assignments: {},
    });
    expect(parseStoredSessionGroups({ groups: "nope" })).toEqual({
      groups: [],
      assignments: {},
    });
  });

  it("loads empty state when no file exists", async () => {
    await expect(sessionGroupsModule.loadSessionGroups()).resolves.toEqual({
      groups: [],
      assignments: {},
    });
  });

  it("round-trips state through the shared host file", async () => {
    const state: SessionGroupState = {
      groups: [{ id: "g1", name: "Проект" }],
      assignments: { "session-a": "g1" },
    };
    await sessionGroupsModule.saveSessionGroups(state);
    expect(sessionGroupsModule.sessionGroupsFilePath()).toBe(
      path.join(testDir, "session-groups.json"),
    );
    await expect(sessionGroupsModule.loadSessionGroups()).resolves.toEqual(
      state,
    );
  });

  it("leaves no tmp artefact after a save", async () => {
    await sessionGroupsModule.saveSessionGroups({
      groups: [],
      assignments: {},
    });
    expect(
      fs.existsSync(`${sessionGroupsModule.sessionGroupsFilePath()}.tmp`),
    ).toBe(false);
  });
});
