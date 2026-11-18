import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLifecycleHooks, runToolHooks } from "./toolHooks";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createSettings(
  output: object | undefined,
  exitCode = 0,
  event = "PreToolUse",
  capturePath?: string,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-hooks-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "hook.cjs");
  fs.writeFileSync(
    scriptPath,
    `let input = ""; process.stdin.on('data', (chunk) => input += chunk); process.stdin.on('end', () => { ${capturePath ? `require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, input);` : ""} ${output ? `process.stdout.write(${JSON.stringify(JSON.stringify(output))});` : ""} process.exit(${exitCode}); });`,
  );
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        [event]: [
          {
            matcher: event.includes("Tool") ? "^read_file$" : "",
            hooks: [
              {
                type: "command",
                command: `node ${scriptPath}`,
              },
            ],
          },
        ],
      },
    }),
  );
  return { dir, settingsPath };
}

describe("runToolHooks", () => {
  it("passes Claude-compatible input and applies updatedInput", async () => {
    const { dir, settingsPath } = createSettings({
      hookSpecificOutput: { updatedInput: { path: "safe.txt" } },
    });

    await expect(
      runToolHooks(
        "PreToolUse",
        "read_file",
        { path: "old.txt" },
        "call-1",
        dir,
        {},
        [settingsPath],
      ),
    ).resolves.toEqual({ blocked: false, updatedInput: { path: "safe.txt" } });
  });

  it("blocks before execution when a hook exits with code 2", async () => {
    const { dir, settingsPath } = createSettings(undefined, 2);

    await expect(
      runToolHooks("PreToolUse", "read_file", {}, "call-1", dir, {}, [
        settingsPath,
      ]),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("does not let a lower-precedence disableAllHooks bypass a project hook", async () => {
    const { dir, settingsPath } = createSettings(undefined, 2);
    const globalSettings = path.join(dir, "global-settings.json");
    fs.writeFileSync(globalSettings, JSON.stringify({ disableAllHooks: true }));

    await expect(
      runToolHooks("PreToolUse", "read_file", {}, "call-1", dir, {}, [
        globalSettings,
        settingsPath,
      ]),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("does not let project disableAllHooks bypass a mandatory global hook", async () => {
    const { dir, settingsPath } = createSettings(undefined, 2);
    const projectSettings = path.join(dir, "project-settings.json");
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({ disableAllHooks: true }),
    );

    await expect(
      runToolHooks("PreToolUse", "read_file", {}, "call-1", dir, {}, [
        settingsPath,
        projectSettings,
      ]),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("passes lifecycle session identity and returns hook context", async () => {
    const captured = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "continue-hooks-input-")),
      "input.json",
    );
    tempDirs.push(path.dirname(captured));
    const { dir, settingsPath } = createSettings(
      { hookSpecificOutput: { additionalContext: "continue working" } },
      0,
      "Stop",
      captured,
    );

    await expect(
      runLifecycleHooks(
        "Stop",
        { stop_hook_active: false },
        dir,
        "session-123",
        "C:/transcripts/session-123.json",
        "",
        [settingsPath],
      ),
    ).resolves.toMatchObject({
      blocked: false,
      additionalContext: "continue working",
    });
    expect(JSON.parse(fs.readFileSync(captured, "utf8"))).toMatchObject({
      session_id: "session-123",
      transcript_path: "C:/transcripts/session-123.json",
      hook_event_name: "Stop",
    });
  });
});
