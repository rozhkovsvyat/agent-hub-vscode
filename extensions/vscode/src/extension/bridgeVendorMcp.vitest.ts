import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROKER_MCP_NAME,
  brokerPythonCommand,
  ensureBrokerVendorIntegration,
  ensureCodexBrokerRegistration,
  ensureClaudeBrokerRegistration,
  ensureCursorBrokerRegistration,
  ensureGrokBrokerRegistration,
  ensureKimiBrokerRegistration,
  ensureQwenBrokerRegistration,
  registerBrokerSessionBinding,
  resetBrokerIntegrationMemoForTests,
  resolveBrokerDir,
} from "./bridgeVendorMcp";
import type { CukiiRunBinding } from "./bridgeRunBinding";

describe("bridgeVendorMcp", () => {
  let home: string;
  let brokerDir: string;

  const options = () => ({ userHome: home, env: {} as NodeJS.ProcessEnv });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-vendor-home-"));
    brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-broker-pkg-"));
    fs.writeFileSync(path.join(brokerDir, "mcp_server.py"), "", "utf8");
    fs.writeFileSync(path.join(brokerDir, "session_identity.py"), "", "utf8");
    fs.mkdirSync(path.join(brokerDir, "hooks"));
    fs.writeFileSync(
      path.join(brokerDir, "hooks", "inbox_gate.py"),
      "",
      "utf8",
    );
    resetBrokerIntegrationMemoForTests();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(brokerDir, { recursive: true, force: true });
    resetBrokerIntegrationMemoForTests();
  });

  describe("resolveBrokerDir", () => {
    it("prefers the explicit env override", () => {
      const resolved = resolveBrokerDir({
        userHome: home,
        env: { CUKII_BROKER_DIR: brokerDir },
      });
      expect(resolved).toBe(brokerDir);
    });

    it("discovers the package from the qwen registration", () => {
      fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".qwen", "settings.json"),
        JSON.stringify({
          mcpServers: {
            [BROKER_MCP_NAME]: {
              command: "python",
              args: [path.join(brokerDir, "mcp_server.py")],
            },
          },
        }),
        "utf8",
      );
      expect(resolveBrokerDir(options())).toBe(brokerDir);
    });

    it("returns undefined when nothing resolves (fail-open)", () => {
      expect(resolveBrokerDir(options())).toBeUndefined();
    });
  });

  describe("live session binding", () => {
    it("registers the exact vendor pid and session through the broker-owned helper", () => {
      const spawn = vi.fn().mockReturnValue({ status: 0 });
      const binding: CukiiRunBinding = {
        version: 2,
        vendorPid: 4242,
        processStartToken: "start-token",
        sessionId: "session-safe_1",
        runId: "run-safe_1",
        nonce: "a".repeat(64),
        createdMs: 1000,
        expiresMs: 2000,
      };
      const result = registerBrokerSessionBinding(
        4242,
        "session-safe_1",
        "run-safe_1",
        ["pending-1", "pending-2"],
        {
          userHome: home,
          env: {
            CUKII_BROKER_DIR: brokerDir,
            CUKII_BINDING_DIR: "D:/bindings",
          },
          spawn: spawn as never,
          registerBinding: vi.fn(() => binding),
        },
      );

      expect(result).toEqual(binding);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [program, args, spawnOptions] = spawn.mock.calls[0];
      // `brokerPythonCommand` launches `python` on Windows (the py launcher
      // name) and `python3` everywhere else; the rest of the contract — helper
      // path, flags, and env passthrough — is identical on both.
      expect(program).toBe(process.platform === "win32" ? "python" : "python3");
      expect(args).toEqual([
        path.join(brokerDir, "session_identity.py"),
        "--lease-existing",
        "4242",
        "--message-id",
        "pending-1",
        "--message-id",
        "pending-2",
      ]);
      expect(spawnOptions.env.CUKII_BINDING_DIR).toBe("D:/bindings");
    });

    it("fails open for an invalid pid or a rejected helper", () => {
      const spawn = vi.fn().mockReturnValue({ status: 1 });
      expect(
        registerBrokerSessionBinding(0, "session", "run", [], options()),
      ).toBeUndefined();
      expect(
        registerBrokerSessionBinding(4242, "session", "run", ["pending"], {
          ...options(),
          env: { CUKII_BROKER_DIR: brokerDir },
          spawn: spawn as never,
          registerBinding: vi.fn((): CukiiRunBinding => ({
            version: 2,
            vendorPid: 4242,
            processStartToken: "start-token",
            sessionId: "session",
            runId: "run",
            nonce: "a".repeat(64),
            createdMs: 1000,
            expiresMs: 2000,
          })),
        }),
      ).toBeUndefined();
    });
  });

  describe("qwen registration", () => {
    const writeSettings = (body: unknown) => {
      fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".qwen", "settings.json"),
        JSON.stringify(body),
        "utf8",
      );
    };
    const readSettings = () =>
      JSON.parse(
        fs.readFileSync(path.join(home, ".qwen", "settings.json"), "utf8"),
      );

    it("adds the MCP server and the gate hook once", () => {
      writeSettings({ mcpServers: { other: { command: "x" } }, hooks: {} });
      const first = ensureQwenBrokerRegistration(brokerDir, options());
      expect(first).toMatchObject({ mcpAdded: true, hookAdded: true });

      const settings = readSettings();
      expect(settings.mcpServers.other).toEqual({ command: "x" });
      const entry = settings.mcpServers[BROKER_MCP_NAME];
      expect(entry.command).toBe(brokerPythonCommand(options()));
      expect(entry.args[0]).toBe(path.join(brokerDir, "mcp_server.py"));
      expect(entry.trust).toBe(true);
      expect(entry.env.PYTHONPATH).toBe(path.dirname(brokerDir));
      const preToolUse = settings.hooks.PreToolUse;
      expect(preToolUse).toHaveLength(1);
      const hookCommand = preToolUse[0].hooks[0].command as string;
      expect(hookCommand).toContain("inbox_gate.py");
      expect(hookCommand).toContain("-Harness qwen");
      // Qwen splits the command on whitespace without shell quoting: any
      // quote character reaches python as part of the filename and bricks
      // every tool call.
      expect(hookCommand).not.toMatch(/["']/);

      const afterFirst = fs.readFileSync(
        path.join(home, ".qwen", "settings.json"),
        "utf8",
      );
      const second = ensureQwenBrokerRegistration(brokerDir, options());
      expect(second).toMatchObject({ mcpAdded: false, hookAdded: false });
      const again = readSettings();
      expect(again.hooks.PreToolUse).toHaveLength(1);
      expect(Object.keys(again.mcpServers)).toHaveLength(2);
      expect(
        fs.readFileSync(path.join(home, ".qwen", "settings.json"), "utf8"),
      ).toBe(afterFirst);
    });

    it("keeps an existing PreToolUse list and only appends", () => {
      writeSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: "write_file",
              hooks: [{ type: "command", command: "guard" }],
            },
          ],
        },
      });
      ensureQwenBrokerRegistration(brokerDir, options());
      const settings = readSettings();
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0].matcher).toBe("write_file");
    });

    it("normalizes a legacy trust:false entry even when nothing else changes", () => {
      writeSettings({ mcpServers: { other: { command: "x" } }, hooks: {} });
      ensureQwenBrokerRegistration(brokerDir, options());
      const seeded = readSettings();
      delete seeded.mcpServers[BROKER_MCP_NAME].env.PYTHONPATH;
      seeded.mcpServers[BROKER_MCP_NAME].trust = false;
      writeSettings(seeded);
      const result = ensureQwenBrokerRegistration(brokerDir, options());
      expect(result).toMatchObject({ mcpAdded: false, hookAdded: false });
      const upgraded = readSettings().mcpServers[BROKER_MCP_NAME];
      // trust:false hides the broker MCP entirely in non-interactive runs.
      expect(upgraded.trust).toBe(true);
      expect(upgraded.env.PYTHONPATH).toBe(path.dirname(brokerDir));
      expect(upgraded.env.PYTHONIOENCODING).toBe("utf-8");
    });

    const spacedBrokerDir = () => {
      const dir = path.join(home, "broker pkg");
      fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(dir, "hooks", "inbox_gate.py"), "# gate", "utf8");
      fs.writeFileSync(path.join(dir, "mcp_server.py"), "# server", "utf8");
      return dir;
    };

    it.runIf(process.platform === "win32")(
      "serves a spaced gate path through the space-free ProgramData shim",
      () => {
        writeSettings({ mcpServers: {}, hooks: {} });
        const dir = spacedBrokerDir();
        const programData = path.join(home, "ProgramData");
        const env = { ProgramData: programData };
        const result = ensureQwenBrokerRegistration(dir, {
          userHome: home,
          env,
        });
        expect(result).toMatchObject({ mcpAdded: true, hookAdded: true });

        const settings = readSettings();
        const hookCommand = settings.hooks.PreToolUse[0].hooks[0]
          .command as string;
        const shimPath = path.join(
          programData,
          "cukii",
          "qwen-gate",
          "inbox_gate.py",
        );
        // Qwen splits the command on whitespace without shell quoting: any
        // quote or space reaches python as part of the filename and bricks
        // every tool call, so the hook names the shim, never the real gate.
        expect(hookCommand).toBe(
          `${brokerPythonCommand({ userHome: home, env })} ${shimPath} -Harness qwen`,
        );
        expect(hookCommand).not.toMatch(/["']/);
        expect(shimPath).not.toContain(" ");
        expect(hookCommand).not.toContain("broker pkg");
        // The shim delegates to the real gate, baking in its spaced path.
        const shim = fs.readFileSync(shimPath, "utf8");
        expect(shim).toContain(
          JSON.stringify(path.join(dir, "hooks", "inbox_gate.py")),
        );
        expect(shim).toContain("subprocess.call");

        // Idempotent: the shim path keeps the gate marker, so a second pass
        // adds nothing and rewrites neither settings nor the shim.
        const before = fs.readFileSync(
          path.join(home, ".qwen", "settings.json"),
          "utf8",
        );
        const second = ensureQwenBrokerRegistration(dir, {
          userHome: home,
          env,
        });
        expect(second).toMatchObject({ mcpAdded: false, hookAdded: false });
        expect(
          fs.readFileSync(path.join(home, ".qwen", "settings.json"), "utf8"),
        ).toBe(before);
      },
    );

    it.runIf(process.platform === "win32")(
      "degrades the hook with an actionable message when even ProgramData is spaced, without rolling back MCP",
      () => {
        writeSettings({ mcpServers: {}, hooks: {} });
        const dir = spacedBrokerDir();
        const result = ensureQwenBrokerRegistration(dir, {
          userHome: home,
          env: { ProgramData: path.join(home, "spaced ProgramData") },
        });
        // MCP args are a JSON array, so a space in the broker path is fine.
        // Only the PreToolUse command is fail-closed; the message must not
        // be mislabeled as a lock conflict, and activation must continue.
        expect(result.mcpAdded).toBe(true);
        expect(result.hookAdded).toBe(false);
        expect(result.skipped).toContain("PreToolUse gate for qwen");
        expect(result.skipped).toContain("CUKII_BROKER_DIR");
        expect(result.skipped).toContain(dir);
        expect(result.skipped).not.toContain("config busy");
        const settings = readSettings();
        expect(settings.mcpServers[BROKER_MCP_NAME]).toBeDefined();
        expect(JSON.stringify(settings.hooks ?? {})).not.toContain(
          "inbox_gate.py",
        );
      },
    );

    it.runIf(process.platform === "win32")(
      "rewrites an already-registered spaced gate command onto the shim",
      () => {
        const dir = spacedBrokerDir();
        const spacedCommand = `${brokerPythonCommand({ userHome: home, env: {} })} ${path.join(dir, "hooks", "inbox_gate.py")} -Harness qwen`;
        writeSettings({
          mcpServers: {},
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: "command", command: spacedCommand, timeout: 15000 },
                ],
              },
            ],
          },
        });
        const programData = path.join(home, "ProgramData");
        const env = { ProgramData: programData };
        const result = ensureQwenBrokerRegistration(dir, {
          userHome: home,
          env,
        });
        expect(result.hookAdded).toBe(false);
        const hookCommand = readSettings().hooks.PreToolUse[0].hooks[0]
          .command as string;
        const shimPath = path.join(
          programData,
          "cukii",
          "qwen-gate",
          "inbox_gate.py",
        );
        expect(hookCommand).toBe(
          `${brokerPythonCommand({ userHome: home, env })} ${shimPath} -Harness qwen`,
        );
        expect(hookCommand).not.toMatch(/["']/);
        expect(hookCommand).not.toContain("broker pkg");
      },
    );

    it.runIf(process.platform !== "win32")(
      "degrades the hook with an actionable message for a spaced gate path off Windows, without rolling back MCP",
      () => {
        writeSettings({ mcpServers: {}, hooks: {} });
        const dir = spacedBrokerDir();
        const result = ensureQwenBrokerRegistration(dir, options());
        expect(result.mcpAdded).toBe(true);
        expect(result.hookAdded).toBe(false);
        expect(result.skipped).toContain("CUKII_BROKER_DIR");
        expect(result.skipped).not.toContain("config busy");
        const settings = readSettings();
        expect(settings.mcpServers[BROKER_MCP_NAME]).toBeDefined();
        expect(JSON.stringify(settings.hooks ?? {})).not.toContain(
          "inbox_gate.py",
        );
      },
    );

    it("does not throw into ensureBrokerVendorIntegration when the gate path contains a space", () => {
      writeSettings({ mcpServers: {}, hooks: {} });
      const dir = spacedBrokerDir();
      const env = {
        CUKII_BROKER_DIR: dir,
        ProgramData: path.join(home, "ProgramData"),
      };
      expect(() =>
        ensureBrokerVendorIntegration("qwen3.8-max", {
          userHome: home,
          env,
        }),
      ).not.toThrow();
      const result = ensureBrokerVendorIntegration("qwen3.8-max", {
        userHome: home,
        env,
      });
      // Second call is memoized; the first must have returned a result, not thrown.
      expect(result).toBeUndefined();
      const hookCommand = readSettings().hooks.PreToolUse[0].hooks[0]
        .command as string;
      expect(hookCommand).toContain("inbox_gate.py");
      expect(hookCommand).not.toMatch(/["']/);
      expect(hookCommand).not.toContain("broker pkg");
    });

    it("skips silently when the settings file is torn", () => {
      fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".qwen", "settings.json"),
        "{not json",
        "utf8",
      );
      const result = ensureQwenBrokerRegistration(brokerDir, options());
      expect(result.skipped).toBeDefined();
      expect(
        fs.readFileSync(path.join(home, ".qwen", "settings.json"), "utf8"),
      ).toBe("{not json");
    });
  });

  describe("claude registration", () => {
    it("uses the official user-scoped CLI without rewriting .claude.json", () => {
      const spawn = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });
      const result = ensureClaudeBrokerRegistration(brokerDir, {
        ...options(),
        spawn: spawn as never,
      });
      expect(result).toEqual({ mcpAdded: true, hookAdded: false });
      expect(spawn.mock.calls[0][1]).toEqual(["mcp", "get", BROKER_MCP_NAME]);
      expect(spawn.mock.calls[1][1]).toEqual([
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "--env",
        "PYTHONIOENCODING=utf-8",
        "--env",
        "PYTHONUTF8=1",
        BROKER_MCP_NAME,
        "--",
        brokerPythonCommand(options()),
        path.join(brokerDir, "mcp_server.py"),
      ]);
      expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    });

    it("does not add a duplicate when Claude already knows the server", () => {
      const spawn = vi.fn().mockReturnValue({ status: 0 });
      expect(
        ensureClaudeBrokerRegistration(brokerDir, {
          ...options(),
          spawn: spawn as never,
        }),
      ).toEqual({ mcpAdded: false, hookAdded: false });
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("cursor registration", () => {
    it("creates ~/.cursor/mcp.json with the entry when absent", () => {
      const result = ensureCursorBrokerRegistration(brokerDir, options());
      expect(result.mcpAdded).toBe(true);
      const config = JSON.parse(
        fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"),
      );
      expect(config.mcpServers[BROKER_MCP_NAME].args[0]).toBe(
        path.join(brokerDir, "mcp_server.py"),
      );
    });

    it("preserves foreign servers and is idempotent", () => {
      fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { memory: { command: "mem" } } }),
        "utf8",
      );
      ensureCursorBrokerRegistration(brokerDir, options());
      const second = ensureCursorBrokerRegistration(brokerDir, options());
      expect(second.mcpAdded).toBe(false);
      const config = JSON.parse(
        fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"),
      );
      expect(config.mcpServers.memory).toEqual({ command: "mem" });
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    });
  });

  describe("codex registration", () => {
    const configPath = () => path.join(home, ".codex", "config.toml");

    it("appends a managed block with backup and stays idempotent", () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(configPath(), 'model = "gpt-5.5"\n', "utf8");

      const first = ensureCodexBrokerRegistration(brokerDir, options());
      expect(first).toMatchObject({ mcpAdded: true, hookAdded: true });
      const body = fs.readFileSync(configPath(), "utf8");
      expect(body.startsWith('model = "gpt-5.5"\n')).toBe(true);
      expect(body).toContain("[mcp_servers.cukii-broker]");
      expect(body).toContain("[[hooks.PreToolUse]]");
      expect(body).toContain("-Harness codex");
      const backups = fs
        .readdirSync(path.join(home, ".codex"))
        .filter((name) => name.startsWith("config.toml.bak-cukii-"));
      expect(backups).toHaveLength(1);

      const before = fs.readFileSync(configPath(), "utf8");
      const second = ensureCodexBrokerRegistration(brokerDir, options());
      expect(second).toMatchObject({ mcpAdded: false, hookAdded: false });
      expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    });

    it("recognizes the pre-existing agent-hub-broker entry and adds only the gate", () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(
        configPath(),
        "[mcp_servers.agent-hub-broker]\ncommand = 'pythonw'\n",
        "utf8",
      );
      const result = ensureCodexBrokerRegistration(brokerDir, options());
      expect(result).toMatchObject({ mcpAdded: false, hookAdded: true });
      const body = fs.readFileSync(configPath(), "utf8");
      expect(body).not.toContain("[mcp_servers.cukii-broker]");
      expect(body).toContain("[[hooks.PreToolUse]]");
    });
  });

  describe("grok registration", () => {
    it("uses the official `mcp add` and writes the plugin-owned hook file", () => {
      const spawn = vi.fn().mockReturnValue({ status: 0 });
      const result = ensureGrokBrokerRegistration(brokerDir, {
        ...options(),
        spawn: spawn as never,
      });
      expect(result.mcpAdded).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [program, args] = spawn.mock.calls[0];
      expect(program).toBe("grok");
      expect(args.slice(0, 3)).toEqual(["mcp", "add", BROKER_MCP_NAME]);
      expect(args).toContain(path.join(brokerDir, "mcp_server.py"));

      const hookFile = JSON.parse(
        fs.readFileSync(
          path.join(home, ".grok", "hooks", "cukii-inbox.json"),
          "utf8",
        ),
      );
      expect(hookFile.hooks.PreToolUse[0].hooks[0].command).toContain(
        "-Harness grok",
      );

      const second = ensureGrokBrokerRegistration(brokerDir, {
        ...options(),
        spawn: spawn as never,
      });
      expect(second.hookAdded).toBe(false);
    });

    it("survives a failing grok CLI (fail-open)", () => {
      const spawn = vi.fn().mockImplementation(() => {
        throw new Error("grok not found");
      });
      const result = ensureGrokBrokerRegistration(brokerDir, {
        ...options(),
        spawn: spawn as never,
      });
      expect(result.mcpAdded).toBe(false);
    });
  });

  describe("kimi registration", () => {
    const mcpPath = () => path.join(home, ".kimi-code", "mcp.json");
    const configPath = () => path.join(home, ".kimi-code", "config.toml");

    it("adds the server to mcp.json and appends the gate hook to config.toml", () => {
      fs.mkdirSync(path.join(home, ".kimi-code"), { recursive: true });
      fs.writeFileSync(
        mcpPath(),
        JSON.stringify({ mcpServers: { memory: { command: "mem" } } }),
        "utf8",
      );
      fs.writeFileSync(
        configPath(),
        'default_model = "kimi-code/k3"\n',
        "utf8",
      );

      const first = ensureKimiBrokerRegistration(brokerDir, options());
      expect(first).toMatchObject({ mcpAdded: true, hookAdded: true });
      const config = JSON.parse(fs.readFileSync(mcpPath(), "utf8"));
      expect(config.mcpServers.memory).toEqual({ command: "mem" });
      expect(config.mcpServers[BROKER_MCP_NAME].args[0]).toBe(
        path.join(brokerDir, "mcp_server.py"),
      );
      const body = fs.readFileSync(configPath(), "utf8");
      expect(body.startsWith('default_model = "kimi-code/k3"\n')).toBe(true);
      expect(body).toContain('event = "PreToolUse"');
      expect(body).toContain("-Harness kimi");
      const backups = fs
        .readdirSync(path.join(home, ".kimi-code"))
        .filter((name) => name.startsWith("config.toml.bak-cukii-"));
      expect(backups).toHaveLength(1);

      const before = fs.readFileSync(configPath(), "utf8");
      const second = ensureKimiBrokerRegistration(brokerDir, options());
      expect(second).toMatchObject({ mcpAdded: false, hookAdded: false });
      expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    });

    it("creates mcp.json when absent and survives a missing config.toml", () => {
      const result = ensureKimiBrokerRegistration(brokerDir, options());
      expect(result.mcpAdded).toBe(true);
      expect(result.hookAdded).toBe(false);
      const config = JSON.parse(fs.readFileSync(mcpPath(), "utf8"));
      expect(config.mcpServers[BROKER_MCP_NAME]).toBeDefined();
    });
  });

  describe("ensureBrokerVendorIntegration", () => {
    const seedQwenSettings = () => {
      fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".qwen", "settings.json"),
        JSON.stringify({
          mcpServers: {
            [BROKER_MCP_NAME]: {
              command: "python",
              args: [path.join(brokerDir, "mcp_server.py")],
            },
          },
        }),
        "utf8",
      );
    };

    it("wires qwen once and memoizes per vendor", () => {
      seedQwenSettings();
      const first = ensureBrokerVendorIntegration("qwen3.8-max", options());
      expect(first?.hookAdded).toBe(true);
      fs.unlinkSync(path.join(home, ".qwen", "settings.json"));
      const second = ensureBrokerVendorIntegration("qwen3.8-max", options());
      expect(second).toBeUndefined();
      expect(fs.existsSync(path.join(home, ".qwen", "settings.json"))).toBe(
        false,
      );
    });

    it("wires Claude to the same MCP question surface without an inbox hook", () => {
      seedQwenSettings();
      const spawn = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });
      expect(
        ensureBrokerVendorIntegration("opus-5", {
          ...options(),
          spawn: spawn as never,
        }),
      ).toEqual({ mcpAdded: true, hookAdded: false });
      expect(spawn.mock.calls[1][1]).toContain("user");
      expect(fs.readdirSync(home).sort()).toEqual([".claude.json", ".qwen"]);
      const claude = JSON.parse(
        fs.readFileSync(path.join(home, ".claude.json"), "utf8"),
      );
      expect(claude.mcpServers["cukii-question"]).toMatchObject({
        env: { CUKII_QUESTION_MANAGED: "1" },
      });
    });

    it("wires kimi through mcp.json and the config.toml gate", () => {
      seedQwenSettings();
      fs.mkdirSync(path.join(home, ".kimi-code"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".kimi-code", "config.toml"),
        "default_model = 'kimi-code/k3'\n",
        "utf8",
      );
      const result = ensureBrokerVendorIntegration("kimi-k2", options());
      expect(result).toMatchObject({ mcpAdded: true, hookAdded: true });
    });

    it("installs the bundled question MCP without an external broker package", () => {
      fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
      const result = ensureBrokerVendorIntegration("composer-2-5", options());
      expect(result).toEqual({ mcpAdded: true, hookAdded: false });
      const config = JSON.parse(
        fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"),
      );
      expect(config.mcpServers["cukii-question"]).toMatchObject({
        env: { CUKII_QUESTION_MANAGED: "1" },
      });
    });

    it("does not overwrite a malformed owner MCP container", () => {
      fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
      const target = path.join(home, ".cursor", "mcp.json");
      const owner = '{"mcpServers":"owner-format"}';
      fs.writeFileSync(target, owner, "utf8");
      const result = ensureBrokerVendorIntegration("composer-2-5", options());
      expect(result?.mcpAdded).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe(owner);
    });

    it("does not repair a torn managed TOML block by appending a duplicate", () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      const target = path.join(home, ".codex", "config.toml");
      const owner = [
        "model = 'owner'",
        "# cukii-question managed begin",
        "[mcp_servers.cukii-question]",
      ].join("\n");
      fs.writeFileSync(target, owner, "utf8");
      const result = ensureBrokerVendorIntegration("codex-5-6-sol", options());
      expect(result?.mcpAdded).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe(owner);
    });
  });
});
