import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 🔴 Grok does not only read its own `~/.grok/config.toml`: in claude-compat
 * mode it also adopts every server from `~/.claude.json`. A server there whose
 * program cannot be spawned does not degrade the session — it breaks tool use
 * outright. Measured on the owner's machine with the exact argv this adapter
 * builds (card d10fd9a0, 2026-09-20):
 *
 *   - before disabling: first output 13.1 s, `tool_use` printed, no
 *     `tool_result`, the run never finished and had to be killed;
 *   - after `grok mcp disable playwright chrome-devtools`: first output 5.3 s,
 *     `tool_result` present, finished with exit 0 in 102 s.
 *
 * Both offenders were declared as `npx -y ...@latest` while `npx` was not
 * spawnable from the vendor's environment. The failure mode is the worst kind:
 * grok prints `content_block_start` with a `tool_use`, then goes silent
 * forever, so the silence watchdog cannot call it a dead launch — the vendor
 * did speak. Two grok.exe processes sat waiting on this machine for two days.
 *
 * This module answers one question — which servers grok would pick up whose
 * program Cukii cannot find — so the failure receipt can name them instead of
 * telling the owner to go run a diagnostic themselves.
 */
export type GrokMcpServer = {
  name: string;
  command: string;
  args: string[];
  /** Which config declared it; the fix differs per source. */
  source: "grok" | "claude-compat";
};

/**
 * Launchers that download the package before running it. Measured on the
 * owner's machine, `npx` itself resolves fine — it sits in
 * `scoop/apps/nodejs/current`, which is on PATH — so an unresolvable-program
 * check alone would have stayed silent on the exact pair that hung. What these
 * two servers have in common is not a missing binary but a fetch on every
 * start: `npx -y <pkg>@latest` reaches the registry before it can answer the
 * handshake, and a fetch that stalls is indistinguishable from a server that
 * is merely slow.
 *
 * This is weaker evidence than an unresolvable program, so it is only offered
 * once a run has actually stalled — never as a reason to fail a launch.
 */
const PACKAGE_FETCHING_LAUNCHERS = new Set(["npx", "pnpx", "bunx", "uvx"]);

export function fetchesPackageOnStart(server: GrokMcpServer): boolean {
  const base = server.command
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(cmd|bat|exe|ps1)$/, "");
  return PACKAGE_FETCHING_LAUNCHERS.has(base);
}

/** Strips one layer of TOML quoting from a scalar value. */
function tomlString(raw: string): string | undefined {
  const value = raw.trim().replace(/\s*#.*$/, "").trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return undefined;
}

/**
 * `grok mcp disable <name>` records the name in a top-level
 * `disabled_mcp_servers` array. A server listed there is never started, so
 * warning about it would be noise — and worse, it would keep nagging after the
 * owner has already applied the advice.
 */
export function parseDisabledGrokMcpServers(configToml: string): string[] {
  const match = configToml.match(/^\s*disabled_mcp_servers\s*=\s*\[([^\]]*)\]/ms);
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

/**
 * Reads `[mcp_servers.<name>]` blocks. Sub-tables such as
 * `[mcp_servers.<name>.env]` carry no command of their own and must not be
 * mistaken for a server — an `env` entry named after a credential would
 * otherwise be reported to the owner as a broken server.
 */
export function parseGrokTomlMcpServers(configToml: string): GrokMcpServer[] {
  const servers: GrokMcpServer[] = [];
  let current:
    | { name: string; command?: string; args: string[]; enabled: boolean }
    | undefined;
  const flush = () => {
    if (current && current.enabled && current.command) {
      servers.push({
        name: current.name,
        command: current.command,
        args: current.args,
        source: "grok",
      });
    }
  };
  for (const line of configToml.split(/\r?\n/)) {
    const table = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (table) {
      flush();
      const parts = table[1].split(".");
      current =
        parts.length === 2 && parts[0] === "mcp_servers"
          ? {
              name: parts[1].replace(/^["']|["']$/g, ""),
              args: [],
              enabled: true,
            }
          : undefined;
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^\s*(command|enabled|args)\s*=\s*(.+)$/);
    if (!pair) continue;
    if (pair[1] === "enabled") {
      current.enabled = pair[2].trim().startsWith("true");
    } else if (pair[1] === "args") {
      // Args are cosmetic here — they name the package in the receipt. Only a
      // single-line array is read; a wrapped one simply yields no package name.
      current.args = [...pair[2].matchAll(/["']([^"']*)["']/g)].map(
        (entry) => entry[1],
      );
    } else {
      current.command = tomlString(pair[2]);
    }
  }
  flush();
  return servers;
}

/**
 * Servers grok adopts from Claude's config. Only stdio servers spawn a
 * program; an `http`/`sse` server has a URL and nothing for us to resolve.
 */
export function parseClaudeCompatMcpServers(claudeJson: string): GrokMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(claudeJson);
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })
    ?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out: GrokMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const spec = raw as { type?: string; command?: unknown; args?: unknown };
    if (spec?.type && spec.type !== "stdio") continue;
    if (typeof spec?.command !== "string" || !spec.command) continue;
    out.push({
      name,
      command: spec.command,
      args: Array.isArray(spec.args)
        ? spec.args.filter((arg): arg is string => typeof arg === "string")
        : [],
      source: "claude-compat",
    });
  }
  return out;
}

/**
 * Every server grok would actually try to start. A name disabled in
 * `disabled_mcp_servers` is dropped from both sources, and a name declared in
 * both configs is reported once — grok starts one server per name.
 */
export function collectGrokMcpServers(config: {
  grokToml?: string;
  claudeJson?: string;
}): GrokMcpServer[] {
  const disabled = new Set(
    config.grokToml ? parseDisabledGrokMcpServers(config.grokToml) : [],
  );
  const seen = new Set<string>();
  const all = [
    ...(config.grokToml ? parseGrokTomlMcpServers(config.grokToml) : []),
    ...(config.claudeJson
      ? parseClaudeCompatMcpServers(config.claudeJson)
      : []),
  ];
  return all.filter((server) => {
    if (disabled.has(server.name) || seen.has(server.name)) return false;
    seen.add(server.name);
    return true;
  });
}

export type CommandResolver = (command: string) => boolean;

export function unresolvableGrokMcpServers(
  servers: readonly GrokMcpServer[],
  canResolve: CommandResolver,
): GrokMcpServer[] {
  return servers.filter((server) => !canResolve(server.command));
}

/**
 * Mirrors what a `spawn` without a shell can actually launch: an absolute or
 * relative path must exist, and a bare name must be on PATH under one of the
 * executable extensions. A program Cukii can find but grok cannot is not
 * reported — a false alarm here would send the owner to disable a working
 * server.
 */
export function canSpawnCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        return fs.existsSync(path.join(dir, `${command}${ext}`));
      } catch {
        return false;
      }
    }),
  );
}

/**
 * The receipt the owner reads. Naming the server and the program it wanted is
 * the whole point: "run `grok mcp doctor`" asks them to repeat work Cukii has
 * already done.
 */
export function grokMcpPreflightAdvice(
  broken: readonly GrokMcpServer[],
): string | undefined {
  if (broken.length === 0) return undefined;
  const named = broken
    .map((server) => `${server.name} (wants \`${server.command}\`)`)
    .join(", ");
  const names = broken.map((server) => server.name).join(" ");
  const adopted = broken.some((server) => server.source === "claude-compat")
    ? " Grok adopts servers from `~/.claude.json` too, so a server you never configured for Grok can still break it."
    : "";
  return (
    `Cukii cannot find the program for ${broken.length === 1 ? "this MCP server" : "these MCP servers"} Grok starts: ${named}. ` +
    `A server that will not start makes Grok print a tool call and then wait forever, so the turn never finishes.${adopted} ` +
    `Run \`grok mcp disable ${names}\`, or make the program reachable, then send the message again.`
  );
}

/** The package a fetch-on-start launcher would download, when it is evident. */
function packageArgument(server: GrokMcpServer): string | undefined {
  return server.args.find((arg) => arg && !arg.startsWith("-"));
}

/**
 * Said only after a run has already stalled. A fetch-on-start server is not
 * proof of anything — plenty of them work — so it must never fail a launch.
 * But once Grok has printed a tool call and gone quiet, the owner needs the
 * list of servers that reach the network before they can answer, because that
 * is the shape the fault took on this machine.
 */
export function grokMcpStallAdvice(
  broken: readonly GrokMcpServer[],
  fetching: readonly GrokMcpServer[],
): string | undefined {
  const hard = grokMcpPreflightAdvice(broken);
  if (fetching.length === 0) return hard;
  const named = fetching
    .map((server) => {
      const pkg = packageArgument(server);
      return pkg ? `${server.name} (downloads \`${pkg}\`)` : server.name;
    })
    .join(", ");
  const soft =
    `A tool call that never returns is usually an MCP server that never finished starting. ` +
    `${fetching.length === 1 ? "This server fetches" : "These servers fetch"} a package before answering, so a slow or blocked registry hangs the whole turn: ${named}. ` +
    `Check them with \`grok mcp doctor\`, or take them out of the way with \`grok mcp disable ${fetching.map((server) => server.name).join(" ")}\`.`;
  return hard ? `${hard} ${soft}` : soft;
}

export type GrokMcpFaults = {
  /** Proof-grade: the program cannot be spawned at all. */
  failed?: string;
  /** Offered only once a turn has stalled; includes the proof-grade text. */
  stalled?: string;
};

/**
 * Filesystem-backed entry point. Reads both configs and returns what can be
 * said about Grok's MCP servers. Never throws: a missing or malformed config
 * must not take down a bridge run that was only being explained.
 */
export function describeGrokMcpFaults(
  userHome: string = os.homedir(),
  canResolve: CommandResolver = (command) => canSpawnCommand(command),
): GrokMcpFaults {
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  try {
    const servers = collectGrokMcpServers({
      grokToml: read(path.join(userHome, ".grok", "config.toml")),
      claudeJson: read(path.join(userHome, ".claude.json")),
    });
    const broken = unresolvableGrokMcpServers(servers, canResolve);
    const brokenNames = new Set(broken.map((server) => server.name));
    const fetching = servers.filter(
      (server) => !brokenNames.has(server.name) && fetchesPackageOnStart(server),
    );
    return {
      failed: grokMcpPreflightAdvice(broken),
      stalled: grokMcpStallAdvice(broken, fetching),
    };
  } catch {
    return {};
  }
}
