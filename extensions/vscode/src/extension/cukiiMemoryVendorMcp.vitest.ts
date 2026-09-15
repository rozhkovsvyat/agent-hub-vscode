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
      const addArguments = calls[1]?.[1] as string[];
      expect(addArguments).toContain("cukii-memory");
      expect(addArguments).toContain(descriptor.proxyPath);
      expect(JSON.stringify(calls)).not.toContain("remote-box-token");
    },
  );
});
