import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bridgeTerminalLaunchSpec } from "./bridgeTerminalCommand";

// The host values the plugin pins via configureBridgeStorageHost; the test
// passes them explicitly because the library default is machine-free.
const windowsStorageOptions = {
  preferredWindowsScratchRoot: "D:\\Scratch",
  preferredWindowsPnpmStoreRoot: "D:\\PnpmStore",
  forbiddenWindowsRoots: [
    "d:\\tmp",
    "d:\\brain\\tmp",
    "d:\\brain\\worktrees",
    "d:\\brain\\pnpm-store",
    "d:\\.pnpm-store",
  ],
  env: {
    TeMp: "D:\\tmp",
    NPM_CONFIG_STORE_DIR: "D:\\Brain\\pnpm-store",
  },
  pathExists: (candidate: string) =>
    candidate === "D:\\Scratch" || candidate === "D:\\PnpmStore",
  pathIsDirectory: (_candidate: string) => true,
  realPath: (candidate: string) => candidate,
  systemTempDir: "C:\\Temp",
  ensureDirectory: (_candidate: string) => {},
};

describe("interactive bridge terminal command", () => {
  it("uses Cursor's native Windows agent CLI with no wrapper argv", () => {
    const spec = bridgeTerminalLaunchSpec(
      "cursor",
      "D:\\Brain\\repo",
      "bridge-session",
      "subagent",
      "module",
      "win32",
      windowsStorageOptions,
    );
    expect(spec).toEqual({
      program: "agent",
      args: [],
      cwd: "D:\\Brain\\repo",
      env: {
        AGENT_HUB_BRIDGE_SESSION: "bridge-session",
        AGENT_HUB_BRIDGE_ROLE: "subagent",
        AGENT_HUB_BRIDGE_SCOPE: "module",
        TeMp: "D:\\Scratch\\cukii-vendor-runtime",
        NPM_CONFIG_STORE_DIR: "D:\\PnpmStore",
        TEMP: "D:\\Scratch\\cukii-vendor-runtime",
        TMP: "D:\\Scratch\\cukii-vendor-runtime",
        TMPDIR: "D:\\Scratch\\cukii-vendor-runtime",
        npm_config_store_dir: "D:\\PnpmStore",
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
      windowsStorageOptions,
    );
    expect(spec.program).toBe(program);
    expect(spec.args).toEqual(args);
  });

  it("does not ship the obsolete Qwen preview model id", () => {
    const vendorBridgeSrc = path.join(
      __dirname,
      "..",
      "..",
      "node_modules",
      "@cukii",
      "vendor-bridge",
      "src",
    );
    for (const [dir, file] of [
      [vendorBridgeSrc, "bridgeChatAdapter.ts"],
      [__dirname, "bridgeTerminalCommand.ts"],
      [vendorBridgeSrc, "bridgeVendorAuth.ts"],
    ]) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      expect(source).not.toContain("qwen3.8-max-preview");
    }
    expect(
      bridgeTerminalLaunchSpec(
        "qwen",
        "D:\\Brain\\repo",
        "bridge-session",
        "subagent",
        "module",
        "win32",
        windowsStorageOptions,
      ).args,
    ).toEqual(["--model", "qwen3.8-max"]);
  });

  it("points Qwen at the Singapore compatible-mode endpoint without secrets", () => {
    const spec = bridgeTerminalLaunchSpec(
      "qwen",
      "D:\\Brain\\repo",
      "bridge-session",
      "subagent",
      "module",
      "win32",
      windowsStorageOptions,
    );
    expect(spec.env.OPENAI_BASE_URL).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(spec.env.OPENAI_BASE_URL).not.toContain("anthropic");
    expect(JSON.stringify(spec)).not.toMatch(/sk-|api[_-]?key|BAILIAN_/i);
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
