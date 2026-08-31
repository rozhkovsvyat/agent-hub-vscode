import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bridgeTerminalLaunchSpec } from "./bridgeTerminalCommand";

describe("interactive bridge terminal command", () => {
  it("uses Cursor's native Windows agent CLI with no wrapper argv", () => {
    const spec = bridgeTerminalLaunchSpec(
      "cursor",
      "D:\\Brain\\repo",
      "bridge-session",
      "subagent",
      "module",
      "win32",
    );
    expect(spec).toEqual({
      program: "agent",
      args: [],
      cwd: "D:\\Brain\\repo",
      env: {
        AGENT_HUB_BRIDGE_SESSION: "bridge-session",
        AGENT_HUB_BRIDGE_ROLE: "subagent",
        AGENT_HUB_BRIDGE_SCOPE: "module",
      },
    });
    expect(JSON.stringify(spec)).not.toMatch(/wsl|bash|cursor-agent/i);
  });

  it("uses the native non-Windows Cursor fallback", () => {
    expect(
      bridgeTerminalLaunchSpec(
        "cursor",
        "/workspace/repo",
        "bridge-session",
        "subagent",
        "module",
        "linux",
      ),
    ).toMatchObject({
      program: "cursor-agent",
      args: [],
      cwd: "/workspace/repo",
    });
  });

  it.each([
    ["claude", [], "claude"],
    ["codex", ["--cd", "D:\\Brain\\repo"], "codex"],
    ["grok", ["--cwd", "D:\\Brain\\repo"], "grok"],
    ["qwen", ["--model", "qwen3.8-max"], "qwen"],
  ])("preserves %s native terminal argv", (agent, args, program) => {
    const spec = bridgeTerminalLaunchSpec(
      agent,
      "D:\\Brain\\repo",
      "bridge-session",
      "subagent",
      "module",
      "win32",
    );
    expect(spec.program).toBe(program);
    expect(spec.args).toEqual(args);
  });

  it("keeps the interactive UI route free of WSL launch machinery", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "VsCodeExtension.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /wsl\.exe|Ubuntu-24\.04|bash["']?\s*,\s*["']?-lc/i,
    );
  });
});
