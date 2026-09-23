import { describe, expect, it } from "vitest";

import {
  canSpawnCommand,
  collectGrokMcpServers,
  fetchesPackageOnStart,
  grokMcpPreflightAdvice,
  grokMcpStallAdvice,
  parseClaudeCompatMcpServers,
  parseDisabledGrokMcpServers,
  parseGrokTomlMcpServers,
  unresolvableGrokMcpServers,
} from "./grokMcpPreflight";

// The shapes below are the ones actually on the owner's machine (card
// d10fd9a0): a multi-line `disabled_mcp_servers` written by `grok mcp
// disable`, servers with an `env` sub-table, and the two offenders declared in
// `~/.claude.json` as `npx`.
const GROK_TOML = `disabled_mcp_servers = [
  "playwright",
  "chrome-devtools",
]

[cli]
installer = "npm"

[memory]
enabled = true

[mcp_servers.cukii-memory]
command = 'C:\\Users\\Свят\\AppData\\Local\\Programs\\Python\\Python312\\pythonw.exe'
args = ["-m", "agent_hub.memory"]
enabled = true

[mcp_servers.cukii-memory.env]
AGENT_HUB_FALLBACK = "1"
PYTHONUTF8 = "1"
command = "leaked-from-env"

[mcp_servers.retired-thing]
command = "never-installed"
enabled = false
`;

const CLAUDE_JSON = JSON.stringify({
  mcpServers: {
    playwright: { type: "stdio", command: "npx", args: ["-y", "pw@latest"] },
    "chrome-devtools": { command: "npx", args: ["-y", "cdp@latest"] },
    reaper: { type: "stdio", command: "C:\\Python312\\pythonw.exe", args: ["x"] },
    hosted: { type: "http", url: "https://example.invalid/mcp" },
  },
});

describe("grok MCP preflight", () => {
  it("reads the disable list `grok mcp disable` writes", () => {
    expect(parseDisabledGrokMcpServers(GROK_TOML)).toEqual([
      "playwright",
      "chrome-devtools",
    ]);
    expect(parseDisabledGrokMcpServers("[cli]\ninstaller = \"npm\"\n")).toEqual(
      [],
    );
  });

  it("does not mistake an env sub-table for a server", () => {
    const servers = parseGrokTomlMcpServers(GROK_TOML);
    expect(servers.map((server) => server.name)).toEqual(["cukii-memory"]);
    // `enabled = false` is a server grok will not start, and `[memory]` is not
    // an MCP table at all.
    expect(servers.map((server) => server.name)).not.toContain("retired-thing");
    expect(servers[0].command).toContain("pythonw.exe");
    expect(servers[0].source).toBe("grok");
  });

  it("adopts stdio servers from .claude.json and ignores hosted ones", () => {
    const servers = parseClaudeCompatMcpServers(CLAUDE_JSON);
    expect(servers.map((server) => server.name).sort()).toEqual([
      "chrome-devtools",
      "playwright",
      "reaper",
    ]);
    expect(servers.every((server) => server.source === "claude-compat")).toBe(
      true,
    );
    expect(parseClaudeCompatMcpServers("not json")).toEqual([]);
  });

  it("drops names the owner already disabled, from either config", () => {
    const names = collectGrokMcpServers({
      grokToml: GROK_TOML,
      claudeJson: CLAUDE_JSON,
    }).map((server) => server.name);
    // Both offenders are listed in `disabled_mcp_servers`, so re-reporting
    // them would nag after the advice was already applied.
    expect(names).not.toContain("playwright");
    expect(names).not.toContain("chrome-devtools");
    expect(names.sort()).toEqual(["cukii-memory", "reaper"]);
  });

  it("reports a name declared in both configs once", () => {
    const both = collectGrokMcpServers({
      grokToml: "[mcp_servers.reaper]\ncommand = \"py\"\nenabled = true\n",
      claudeJson: JSON.stringify({
        mcpServers: { reaper: { command: "py" } },
      }),
    });
    expect(both).toHaveLength(1);
    expect(both[0].source).toBe("grok");
  });

  it("names the offender and the program it wanted", () => {
    const servers = collectGrokMcpServers({ claudeJson: CLAUDE_JSON });
    const broken = unresolvableGrokMcpServers(
      servers,
      (command) => command !== "npx",
    );
    expect(broken.map((server) => server.name).sort()).toEqual([
      "chrome-devtools",
      "playwright",
    ]);

    const advice = grokMcpPreflightAdvice(broken);
    expect(advice).toContain("playwright");
    expect(advice).toContain("chrome-devtools");
    expect(advice).toContain("npx");
    // The whole point of the card: an actionable command, not "go diagnose it".
    expect(advice).toMatch(/grok mcp disable .*playwright/);
    expect(advice).toMatch(/\.claude\.json/);
  });

  it("says nothing when every server resolves", () => {
    const servers = collectGrokMcpServers({ claudeJson: CLAUDE_JSON });
    expect(
      grokMcpPreflightAdvice(unresolvableGrokMcpServers(servers, () => true)),
    ).toBeUndefined();
  });

  // 🔴 Measured on the owner's machine: `npx` resolves — it sits in
  // `scoop/apps/nodejs/current`, which is on PATH — so the unresolvable-program
  // check alone stays silent on the exact pair that hung. What the two
  // offenders share is a package fetch at every start.
  it("still names a fetch-on-start server whose launcher does resolve", () => {
    const servers = collectGrokMcpServers({ claudeJson: CLAUDE_JSON });
    const broken = unresolvableGrokMcpServers(servers, () => true);
    expect(broken).toEqual([]);

    const fetching = servers.filter(fetchesPackageOnStart);
    expect(fetching.map((server) => server.name).sort()).toEqual([
      "chrome-devtools",
      "playwright",
    ]);
    // A plain interpreter is not a fetch-on-start launcher.
    expect(fetching.map((server) => server.name)).not.toContain("reaper");

    const advice = grokMcpStallAdvice(broken, fetching);
    expect(advice).toContain("playwright");
    expect(advice).toContain("pw@latest");
    expect(advice).toMatch(/grok mcp disable .*playwright/);
  });

  it("offers the weak evidence only on a stall, never to fail a launch", () => {
    const servers = collectGrokMcpServers({ claudeJson: CLAUDE_JSON });
    const faults = {
      failed: grokMcpPreflightAdvice(
        unresolvableGrokMcpServers(servers, () => true),
      ),
      stalled: grokMcpStallAdvice(
        unresolvableGrokMcpServers(servers, () => true),
        servers.filter(fetchesPackageOnStart),
      ),
    };
    // A server that merely downloads a package is not a reason to call a
    // launch dead — plenty of them work.
    expect(faults.failed).toBeUndefined();
    expect(faults.stalled).toContain("chrome-devtools");
  });

  it("recognises a fetching launcher through its Windows extension", () => {
    const base = { name: "x", args: ["-y", "p@latest"], source: "grok" as const };
    expect(fetchesPackageOnStart({ ...base, command: "npx" })).toBe(true);
    expect(fetchesPackageOnStart({ ...base, command: "npx.cmd" })).toBe(true);
    expect(
      fetchesPackageOnStart({ ...base, command: "C:\\node\\npx.CMD" }),
    ).toBe(true);
    expect(fetchesPackageOnStart({ ...base, command: "uvx" })).toBe(true);
    expect(fetchesPackageOnStart({ ...base, command: "node" })).toBe(false);
    expect(
      fetchesPackageOnStart({ ...base, command: "C:\\py\\pythonw.exe" }),
    ).toBe(false);
  });

  it("resolves a bare name only through PATH and PATHEXT", () => {
    const env = { PATH: "", PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv;
    expect(canSpawnCommand("npx", env, "win32")).toBe(false);
    expect(canSpawnCommand("", env, "win32")).toBe(false);
    // An explicit path is checked as a path, not searched on PATH.
    expect(canSpawnCommand("C:\\nope\\missing.exe", env, "win32")).toBe(false);
  });
});
