import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureCukiiMemoryVendorMcp,
  memoryMcpEntry,
  removeCukiiMemoryVendorMcp,
  type CukiiMemoryRelayDescriptor,
} from "./cukiiMemoryVendorMcp";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-memory-mcp-"));
  roots.push(root);
  const descriptor: CukiiMemoryRelayDescriptor = {
    url: "http://127.0.0.1:43123/mcp",
    capability: "local-capability-" + "x".repeat(40),
    proxyPath: path.join(root, "extension", "out", "cukiiMemoryProxy.js"),
    nodePath: path.join(root, "Code.exe"),
  };
  return { root, descriptor };
}

describe("Cukii memory vendor MCP registration", () => {
  it("uses the bundled runtime and only the loopback capability", () => {
    const { descriptor } = fixture();
    const entry = memoryMcpEntry(descriptor);
    expect(entry).toEqual({
      command: descriptor.nodePath,
      args: [descriptor.proxyPath],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        CUKII_MEMORY_MANAGED: "1",
        CUKII_MEMORY_RELAY_URL: descriptor.url,
        CUKII_MEMORY_RELAY_TOKEN: descriptor.capability,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("remote-box-token");
  });

  it.each([
    ["claude", ".claude.json"],
    ["qwen", path.join(".qwen", "settings.json")],
    ["cursor", path.join(".cursor", "mcp.json")],
    ["kimi", path.join(".kimi-code", "mcp.json")],
  ] as const)("preserves existing %s MCP servers", (vendor, relative) => {
    const { root, descriptor } = fixture();
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({ mcpServers: { owner: { command: "owner-command" } } }),
    );

    expect(
      ensureCukiiMemoryVendorMcp(vendor, descriptor, { userHome: root }),
    ).toBe(true);
    const config = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(config.mcpServers.owner).toEqual({ command: "owner-command" });
    expect(config.mcpServers["cukii-memory"]).toMatchObject({
      command: descriptor.nodePath,
      args: [descriptor.proxyPath],
    });

    removeCukiiMemoryVendorMcp(vendor, { userHome: root });
    const removed = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(removed.mcpServers.owner).toEqual({ command: "owner-command" });
    expect(removed.mcpServers["cukii-memory"]).toBeUndefined();
  });

  it.each(["codex", "grok"] as const)(
    "uses the official %s MCP command without the remote bearer",
    (vendor) => {
      const { root, descriptor } = fixture();
      const spawn = vi.fn(() => ({ status: 0 })) as never;
      expect(
        ensureCukiiMemoryVendorMcp(vendor, descriptor, {
          userHome: root,
          spawn,
        }),
      ).toBe(true);
      const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const addArguments = calls.at(-1)?.[1] as string[];
      expect(addArguments).toContain("cukii-memory");
      expect(addArguments).toContain(descriptor.proxyPath);
      expect(JSON.stringify(calls)).not.toContain("remote-box-token");
    },
  );

  it("leaves a torn owner JSON config byte-for-byte untouched", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"mcpServers":', "utf8");

    expect(
      ensureCukiiMemoryVendorMcp("cursor", descriptor, { userHome: root }),
    ).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe('{"mcpServers":');
  });

  it("replaces a previous Cukii Box python memory proxy so Kimi sees the live relay", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".kimi-code", "mcp.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({
        mcpServers: {
          owner: { command: "owner-command" },
          "cukii-memory": {
            command: path.join(root, "pythonw.exe"),
            args: [path.join(root, "cukii-box", "memory", "mcp_proxy.py")],
            env: {
              AGENT_HUB_MEMORY_URL: "http://127.0.0.1:8780/mcp",
              AGENT_HUB_FALLBACK: "0",
            },
          },
        },
      }),
    );

    expect(
      ensureCukiiMemoryVendorMcp("kimi", descriptor, { userHome: root }),
    ).toBe(true);
    const config = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(config.mcpServers.owner).toEqual({ command: "owner-command" });
    expect(config.mcpServers["cukii-memory"]).toMatchObject({
      command: descriptor.nodePath,
      args: [descriptor.proxyPath],
      env: {
        CUKII_MEMORY_MANAGED: "1",
        CUKII_MEMORY_RELAY_URL: descriptor.url,
      },
    });
    expect(JSON.stringify(config.mcpServers["cukii-memory"])).not.toContain(
      "AGENT_HUB_MEMORY_URL",
    );
  });

  it("does not replace or remove an owner-defined cukii-memory server", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".qwen", "settings.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const owner = {
      mcpServers: { "cukii-memory": { command: "owner-command" } },
    };
    fs.writeFileSync(target, JSON.stringify(owner), "utf8");

    expect(
      ensureCukiiMemoryVendorMcp("qwen", descriptor, { userHome: root }),
    ).toBe(false);
    removeCukiiMemoryVendorMcp("qwen", { userHome: root });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(owner);
  });

  it("leaves a malformed owner MCP container byte-for-byte untouched", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const owner = '{"mcpServers":"owner-format"}';
    fs.writeFileSync(target, owner, "utf8");
    expect(
      ensureCukiiMemoryVendorMcp("cursor", descriptor, { userHome: root }),
    ).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(owner);
  });

  it("restores a managed CLI config when replacement fails", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = [
      "# owner setting",
      "model = 'owner'",
      "[mcp_servers.cukii-memory]",
      `command = '${descriptor.nodePath}'`,
      `args = ['${descriptor.proxyPath.replace(/\\/g, "\\\\")}']`,
      "[mcp_servers.cukii-memory.env]",
      "CUKII_MEMORY_RELAY_URL = 'http://127.0.0.1:1/mcp'",
      "",
    ].join("\n");
    fs.writeFileSync(target, original, "utf8");
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 }) as never;

    expect(
      ensureCukiiMemoryVendorMcp("codex", descriptor, {
        userHome: root,
        spawn,
      }),
    ).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("removes a newly-created managed CLI config when add fails", () => {
    const { root, descriptor } = fixture();
    const target = path.join(root, ".codex", "config.toml");
    const spawn = vi.fn(() => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        [
          "[mcp_servers.cukii-memory]",
          `command = '${descriptor.nodePath}'`,
          `args = ['${descriptor.proxyPath.replace(/\\/g, "\\\\")}']`,
          "[mcp_servers.cukii-memory.env]",
          "CUKII_MEMORY_MANAGED = '1'",
        ].join("\n"),
        "utf8",
      );
      return { status: 1 };
    }) as never;
    expect(
      ensureCukiiMemoryVendorMcp("codex", descriptor, {
        userHome: root,
        spawn,
      }),
    ).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});
