import { execFile } from "child_process";
import { cukiiVendorLabel } from "core/cukiiVendorRegistry";
import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
  BrokerVendorId,
} from "core/protocol/ideWebview";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ProbeSpec = { program: string; args: string[] };

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
  };
  return [candidate.message, candidate.stdout, candidate.stderr, candidate.code]
    .filter((part) => part !== undefined)
    .map(String)
    .join("\n");
}

export function isMissingCliError(error: unknown): boolean {
  return /ENOENT|not recognized|not found|No such file|command not found/i.test(
    errorText(error),
  );
}

const WINDOWS_PROBES: Record<
  Exclude<BrokerVendorId, "deepseek" | "qwen">,
  string[]
> = {
  claude: ["claude", "auth", "status", "--json"],
  codex: ["codex", "login", "status"],
  grok: ["grok", "models"],
  cursor: ["agent", "status", "--format", "json"],
  kimi: ["kimi", "provider", "list"],
};

function probeSpec(vendor: BrokerVendorId): ProbeSpec | undefined {
  if (vendor === "deepseek" || vendor === "qwen") return undefined;
  return {
    program: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/c", ...WINDOWS_PROBES[vendor]],
  };
}

export function classifyVendorAuthOutput(
  vendor: Exclude<BrokerVendorId, "deepseek">,
  stdout: string,
): Pick<BrokerVendorAuthStatus, "state" | "accountLabel" | "actions"> {
  const text = stdout.trim();
  const exposedEmail = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  if (vendor === "claude") {
    try {
      const status = JSON.parse(text) as {
        loggedIn?: boolean;
        authMethod?: string;
        email?: string;
      };
      return status.loggedIn
        ? {
            state: "connected",
            accountLabel: status.email ?? "Account connected",
            actions: ["logout"],
          }
        : {
            state: "disconnected",
            accountLabel: "Not signed in",
            actions: ["login"],
          };
    } catch {
      return {
        state: "unknown",
        accountLabel: "Account status unavailable",
        actions: ["login"],
      };
    }
  }
  if (vendor === "codex") {
    const connected = /logged in/i.test(text) && !/not logged in/i.test(text);
    return connected
      ? {
          state: "connected",
          accountLabel: exposedEmail ?? "Account connected",
          actions: ["logout"],
        }
      : {
          state: "disconnected",
          accountLabel: "Not signed in",
          actions: ["login"],
        };
  }
  if (vendor === "grok") {
    const connected = /logged in with /i.test(text);
    return connected
      ? {
          state: "connected",
          accountLabel: exposedEmail ?? "Account connected",
          actions: ["logout"],
        }
      : {
          state: "disconnected",
          accountLabel: "Not signed in",
          actions: ["login"],
        };
  }
  if (vendor === "cursor") {
    try {
      const start = text.indexOf("{");
      const status = JSON.parse(start >= 0 ? text.slice(start) : text) as {
        isAuthenticated?: boolean;
        userInfo?: { email?: string };
      };
      return status.isAuthenticated
        ? {
            state: "connected",
            accountLabel: status.userInfo?.email ?? "Account connected",
            actions: ["logout"],
          }
        : {
            state: "disconnected",
            accountLabel: "Not signed in",
            actions: ["login"],
          };
    } catch {
      return {
        state: "unknown",
        accountLabel: "Account status unavailable",
        actions: ["login"],
      };
    }
  }
  if (vendor === "kimi") {
    const connected = /source=oauth/i.test(text);
    return connected
      ? {
          state: "connected",
          accountLabel: exposedEmail ?? "Account connected",
          // This installed Kimi build exposes logout as a TUI slash command.
          actions: ["logout"],
        }
      : {
          state: "disconnected",
          accountLabel: "Not signed in",
          actions: ["login"],
        };
  }
  const connected = /qwen-oauth/i.test(text);
  return connected
    ? {
        state: "connected",
        accountLabel: exposedEmail ?? "Account connected",
        // Qwen Code 0.22 removed auth/logout subcommands; the supported flow is
        // the interactive CLI auth selector.
        actions: [],
      }
    : {
        state: "disconnected",
        accountLabel: "Not signed in",
        actions: ["login"],
      };
}

async function probeVendor(
  vendor: Exclude<BrokerVendorId, "deepseek">,
): Promise<BrokerVendorAuthStatus> {
  let checkingAvailability = true;
  try {
    {
      await execFileAsync(
        process.env.ComSpec ?? "cmd.exe",
        [
          "/d",
          "/c",
          "where.exe",
          vendor === "claude"
            ? "claude"
            : vendor === "codex"
              ? "codex"
              : vendor === "grok"
                ? "grok"
                : vendor === "kimi"
                  ? "kimi"
                  : vendor === "cursor"
                    ? "agent"
                    : "qwen",
        ],
        {
          timeout: 10_000,
          windowsHide: true,
        },
      );
    }
    checkingAvailability = false;
    if (vendor === "qwen") {
      const settingsPath = path.join(os.homedir(), ".qwen", "settings.json");
      const settings = fs.existsSync(settingsPath)
        ? fs.readFileSync(settingsPath, "utf8")
        : "";
      return {
        id: vendor,
        label: cukiiVendorLabel(vendor),
        ...classifyVendorAuthOutput(vendor, settings),
      };
    }
    const spec = probeSpec(vendor);
    if (!spec) throw new Error("No probe available");
    const { stdout } = await execFileAsync(spec.program, spec.args, {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      ...classifyVendorAuthOutput(vendor, stdout),
    };
  } catch (error) {
    const missing = checkingAvailability || isMissingCliError(error);
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      state: missing ? "unavailable" : "disconnected",
      accountLabel: missing ? "CLI not installed" : "Not signed in",
      actions: missing ? ["install"] : ["login"],
    };
  }
}

export async function listBrokerVendorAccounts(): Promise<
  BrokerVendorAuthStatus[]
> {
  const live = await Promise.all(
    (["claude", "codex", "grok", "cursor", "kimi", "qwen"] as const).map(
      probeVendor,
    ),
  );
  return [
    ...live,
    {
      id: "deepseek",
      label: "DeepSeek",
      state: "postponed",
      accountLabel: "Setup postponed",
      actions: [],
    },
  ];
}

export function vendorAuthTerminalCommand(
  vendor: BrokerVendorId,
  action: BrokerVendorAuthAction,
): { name: string; command: string; followup?: string } | undefined {
  const login = action === "login";
  const install = action === "install";
  const commands: Partial<
    Record<
      BrokerVendorId,
      { install?: string; login?: string; logout?: string }
    >
  > = {
    claude: {
      install: "npm install -g @anthropic-ai/claude-code@latest",
      login: "claude auth login --claudeai",
      logout: "claude auth logout",
    },
    codex: {
      install: "npm install -g @openai/codex@latest",
      login: "codex login --device-auth",
      logout: "codex logout",
    },
    grok: {
      install: "npm install -g @xai-official/grok@latest",
      login: "grok login --oauth",
      logout: "grok logout",
    },
    cursor: {
      // Cursor primary docs: Windows native install and verification use
      // `irm 'https://cursor.com/install?win32=true' | iex` and `agent`.
      install: "irm 'https://cursor.com/install?win32=true' | iex",
      login: "agent login",
      logout: "agent logout",
    },
    kimi: {
      install: "npm install -g @moonshot-ai/kimi-code@latest",
      login: "kimi login --region global",
      logout: "kimi",
    },
    qwen: {
      install: "npm install -g @qwen-code/qwen-code@latest",
      login: "qwen --auth-type qwen-oauth",
    },
  };
  const command = install
    ? commands[vendor]?.install
    : login
      ? commands[vendor]?.login
      : commands[vendor]?.logout;
  if (!command) return undefined;
  return {
    name: `Cukii · ${vendor} ${action}`,
    command,
    ...(vendor === "kimi" && action === "logout"
      ? { followup: "/logout" }
      : {}),
  };
}
