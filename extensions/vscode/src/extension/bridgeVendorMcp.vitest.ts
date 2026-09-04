import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROKER_MCP_NAME,
  brokerPythonCommand,
  ensureBrokerVendorIntegration,
  ensureCodexBrokerRegistration,
  ensureCursorBrokerRegistration,
  ensureGrokBrokerRegistration,
  ensureKimiBrokerRegistration,
  ensureQwenBrokerRegistration,
  resetBrokerIntegrationMemoForTests,
  resolveBrokerDir,
} from "./bridgeVendorMcp";

describe("bridgeVendorMcp", () => {
  let home: string;
  let brokerDir: string;

  const options = () => ({ userHome: home, env: {} as NodeJS.ProcessEnv });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-vendor-home-"));
    brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-broker-pkg-"));
    fs.writeFileSync(path.join(brokerDir, "mcp_server.py"), "", "utf8");
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
      const preToolUse = settings.hooks.PreToolUse;
      expect(preToolUse).toHaveLength(1);
      expect(preToolUse[0].hooks[0].command).toContain("inbox_gate.py");
      expect(preToolUse[0].hooks[0].command).toContain("-Harness qwen");

      const second = ensureQwenBrokerRegistration(brokerDir, options());
      expect(second).toMatchObject({ mcpAdded: false, hookAdded: false });
      const again = readSettings();
      expect(again.hooks.PreToolUse).toHaveLength(1);
      expect(Object.keys(again.mcpServers)).toHaveLength(2);
    });

    it("keeps an existing PreToolUse list and only appends", () => {
      writeSettings({
        hooks: {
          PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "guard" }] }],
        },
      });
      ensureQwenBrokerRegistration(brokerDir, options());
      const settings = readSettings();
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0].matcher).toBe("write_file");
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
      expect(
        hookFile.hooks.PreToolUse[0].hooks[0].command,
      ).toContain("-Harness grok");

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
      fs.writeFileSync(configPath(), 'default_model = "kimi-code/k3"\n', "utf8");

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
      expect(
        fs.existsSync(path.join(home, ".qwen", "settings.json")),
      ).toBe(false);
    });

    it("skips claude models entirely", () => {
      seedQwenSettings();
      expect(
        ensureBrokerVendorIntegration("opus-5", options()),
      ).toBeUndefined();
      expect(fs.readdirSync(home)).toEqual([".qwen"]);
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

    it("no-ops without a resolved broker package", () => {
      fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
      const result = ensureBrokerVendorIntegration("composer-2-5", options());
      expect(result?.skipped).toBe("broker package not resolved");
      expect(
        fs.existsSync(path.join(home, ".cursor", "mcp.json")),
      ).toBe(false);
    });
  });
});
