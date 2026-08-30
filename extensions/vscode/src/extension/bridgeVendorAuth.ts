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

type VendorWithCli = Exclude<BrokerVendorId, "deepseek">;
type ProbeSpec = { program: string; args: string[] };
type AuthClassification = Pick<
  BrokerVendorAuthStatus,
  "state" | "authenticated" | "accountLabel" | "actions"
>;

const CLI_PROGRAMS: Record<VendorWithCli, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "agent",
  kimi: "kimi",
  qwen: "qwen",
};

const WINDOWS_PROBE_ARGS: Record<VendorWithCli, string[]> = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
  grok: ["models"],
  cursor: ["status", "--format", "json"],
  kimi: ["provider", "list"],
  qwen: ["--version"],
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringAt(record: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function accountIdLabel(identifier: string | undefined): string | undefined {
  return identifier ? `Account ${identifier}` : undefined;
}

/** Local CLI auth metadata only; no browser sessions, token text, or guessed email. */
export function accountLabelFromAuthMetadata(
  vendor: VendorWithCli,
  metadata: unknown,
): string | undefined {
  if (vendor === "codex") {
    const tokens = isRecord(metadata) ? metadata.tokens : undefined;
    const claims = decodeJwtPayload(stringAt(tokens, "id_token"));
    return (
      stringAt(tokens, "email") ??
      stringAt(claims, "email") ??
      accountIdLabel(stringAt(tokens, "account_id", "accountId"))
    );
  }
  if (vendor === "grok") {
    if (!isRecord(metadata)) return undefined;
    for (const entry of Object.values(metadata)) {
      const email = stringAt(entry, "email");
      if (email) return email;
      const identifier = accountIdLabel(stringAt(entry, "user_id", "userId"));
      if (identifier) return identifier;
    }
    return undefined;
  }
  if (vendor === "cursor") {
    return (
      stringAt(isRecord(metadata) ? metadata.userInfo : undefined, "email") ??
      stringAt(metadata, "email") ??
      accountIdLabel(stringAt(metadata, "accountId", "userId", "id"))
    );
  }
  return undefined;
}

function unknownIdentityLabel(): string {
  return "Logged in • Identity unavailable";
}

function qwenOauthSelected(metadata: unknown): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.security)) return false;
  return (
    isRecord(metadata.security.auth) &&
    metadata.security.auth.selectedType === "qwen-oauth"
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function classifyVendorAuthOutput(
  vendor: VendorWithCli,
  stdout: string,
  identityLabel?: string,
): AuthClassification {
  const text = stdout.trim();
  const accountLabel = identityLabel ?? unknownIdentityLabel();
  const exposedEmail = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  const connected = (label: string, actions: BrokerVendorAuthAction[]) => ({
    state: "connected" as const,
    authenticated: true,
    accountLabel: label,
    actions,
  });
  const disconnected = (): AuthClassification => ({
    state: "disconnected",
    authenticated: false,
    accountLabel: "Not logged in",
    actions: ["login"],
  });
  const unknown = (): AuthClassification => ({
    state: "unknown",
    authenticated: false,
    accountLabel: "Account status unavailable",
    actions: ["login"],
  });

  if (
    /not logged in|not signed in|unauthenticated|authentication required/i.test(
      text,
    )
  ) {
    return disconnected();
  }

  if (vendor === "claude") {
    try {
      const status = JSON.parse(text) as { loggedIn?: boolean; email?: string };
      return status.loggedIn
        ? connected(status.email ?? accountLabel, ["logout"])
        : disconnected();
    } catch {
      return unknown();
    }
  }
  if (vendor === "codex") {
    return /logged in/i.test(text)
      ? connected(exposedEmail ?? accountLabel, ["logout"])
      : unknown();
  }
  if (vendor === "grok") {
    return /logged in with/i.test(text)
      ? connected(exposedEmail ?? accountLabel, ["logout"])
      : unknown();
  }
  if (vendor === "cursor") {
    try {
      const start = text.indexOf("{");
      const status = JSON.parse(start >= 0 ? text.slice(start) : text) as {
        isAuthenticated?: boolean;
        userInfo?: { email?: string };
      };
      return status.isAuthenticated
        ? connected(status.userInfo?.email ?? accountLabel, ["logout"])
        : disconnected();
    } catch {
      return unknown();
    }
  }
  if (vendor === "kimi") {
    return /source=oauth/i.test(text)
      ? connected(exposedEmail ?? accountLabel, ["logout"])
      : unknown();
  }
  return qwenOauthSelected(parseJson(text))
    ? connected(exposedEmail ?? accountLabel, [])
    : disconnected();
}

function existingCodexExtensionPaths(userHome: string): string[] {
  const extensions = path.join(userHome, ".vscode", "extensions");
  try {
    return fs
      .readdirSync(extensions)
      .filter((entry) => /^openai\.chatgpt-/i.test(entry))
      .map((entry) =>
        path.join(extensions, entry, "bin", "windows-x86_64", "codex.exe"),
      );
  } catch {
    return [];
  }
}

/**
 * Only known Windows product locations are probed.  In particular, do not use
 * a bare command on Windows: it could resolve to a WSL/Cygwin shim rather than
 * the installed Windows product we are describing in the UI.
 */
export function nativeCliCandidates(
  vendor: VendorWithCli,
  userHome = os.homedir(),
  platform = process.platform,
  windowsEnv: Pick<
    NodeJS.ProcessEnv,
    "LOCALAPPDATA" | "ProgramFiles" | "ProgramFiles(x86)"
  > = process.env,
): string[] {
  const program = CLI_PROGRAMS[vendor];
  if (platform !== "win32") return [program];
  const paths = path.win32;
  const localAppData =
    windowsEnv.LOCALAPPDATA ?? paths.join(userHome, "AppData", "Local");
  const programFiles = windowsEnv.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 =
    windowsEnv["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vendorPaths: Partial<Record<VendorWithCli, string[]>> = {
    codex: [
      ...existingCodexExtensionPaths(userHome),
      paths.join(userHome, ".codex", "bin", "codex.exe"),
    ],
    grok: [paths.join(userHome, ".grok", "bin", "grok.exe")],
    cursor: [
      paths.join(userHome, ".cursor", "bin", "agent.exe"),
      paths.join(
        localAppData,
        "Programs",
        "Cursor",
        "resources",
        "app",
        "bin",
        "agent.exe",
      ),
      paths.join(localAppData, "Cursor", "resources", "app", "bin", "agent.exe"),
      paths.join(programFiles, "Cursor", "resources", "app", "bin", "agent.exe"),
      paths.join(
        programFilesX86,
        "Cursor",
        "resources",
        "app",
        "bin",
        "agent.exe",
      ),
    ],
    kimi: [paths.join(userHome, ".kimi-code", "bin", "kimi.exe")],
  };
  return [
    ...(vendorPaths[vendor] ?? []),
    paths.join(
      userHome,
      "scoop",
      "apps",
      "nodejs",
      "current",
      "bin",
      `${program}.cmd`,
    ),
    paths.join(userHome, "scoop", "persist", "nodejs", "bin", `${program}.cmd`),
    paths.join(userHome, "AppData", "Roaming", "npm", `${program}.cmd`),
    ...(platform === "win32" ? [] : [program]),
  ];
}

function resolveNativeCli(vendor: VendorWithCli): string | undefined {
  return nativeCliCandidates(vendor).find(
    (candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate),
  );
}

function quoteCmdToken(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function probeSpec(vendor: VendorWithCli, executable: string): ProbeSpec {
  const args = WINDOWS_PROBE_ARGS[vendor];
  if (process.platform === "win32") {
    const command = [quoteCmdToken(executable), ...args.map(quoteCmdToken)].join(" ");
    return {
      program: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `call ${command}`],
    };
  }
  return { program: executable, args };
}

function localMetadata(vendor: VendorWithCli): unknown {
  const userHome = os.homedir();
  const file =
    vendor === "codex"
      ? path.join(userHome, ".codex", "auth.json")
      : vendor === "grok"
        ? path.join(userHome, ".grok", "auth.json")
        : vendor === "qwen"
          ? path.join(userHome, ".qwen", "settings.json")
          : undefined;
  try {
    if (!file || !fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (vendor === "codex") {
      const tokens = isRecord(raw) ? raw.tokens : undefined;
      const claims = decodeJwtPayload(stringAt(tokens, "id_token"));
      return {
        tokens: {
          email: stringAt(claims, "email"),
          account_id: stringAt(tokens, "account_id", "accountId"),
        },
      };
    }
    if (vendor === "grok") {
      return Object.fromEntries(
        Object.entries(isRecord(raw) ? raw : {}).map(([issuer, entry]) => [
          issuer,
          {
            email: stringAt(entry, "email"),
            user_id: stringAt(entry, "user_id", "userId"),
          },
        ]),
      );
    }
    const security = isRecord(raw) ? raw.security : undefined;
    const auth = isRecord(security) ? security.auth : undefined;
    return {
      security: {
        auth: { selectedType: stringAt(auth, "selectedType") },
      },
    };
  } catch {
    return undefined;
  }
}

export function notInstalledVendorStatus(
  vendor: VendorWithCli,
): BrokerVendorAuthStatus {
  return {
    id: vendor,
    label: cukiiVendorLabel(vendor),
    installed: false,
    authenticated: false,
    state: "unavailable",
    accountLabel: "Not installed",
    actions: ["install"],
  };
}

export function notSupportedVendorStatus(): BrokerVendorAuthStatus {
  return {
    id: "deepseek",
    label: "DeepSeek",
    installed: false,
    authenticated: false,
    state: "postponed",
    accountLabel: "Not configured / not yet supported",
    actions: [],
  };
}

async function probeVendor(
  vendor: VendorWithCli,
): Promise<BrokerVendorAuthStatus> {
  const executable = resolveNativeCli(vendor);
  if (!executable) return notInstalledVendorStatus(vendor);
  const metadata = localMetadata(vendor);
  const identity = accountLabelFromAuthMetadata(vendor, metadata);
  const spec = probeSpec(vendor, executable);
  try {
    const { stdout, stderr } = await execFileAsync(spec.program, spec.args, {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const output =
      vendor === "qwen" ? JSON.stringify(metadata ?? {}) : `${stdout}\n${stderr}`;
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(vendor, output, identity),
    };
  } catch (error) {
    if (isMissingCliError(error)) return notInstalledVendorStatus(vendor);
    const output = vendor === "qwen" ? JSON.stringify(metadata ?? {}) : errorText(error);
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(vendor, output, identity),
    };
  }
}

// No state is retained between requests: after a terminal login/logout every
// modal refresh launches fresh native probes. Kept explicit for the action path.
export function clearBrokerVendorAccountCache(): void {}

export async function listBrokerVendorAccounts(): Promise<BrokerVendorAuthStatus[]> {
  const live = await Promise.all(
    (["claude", "codex", "grok", "cursor", "kimi", "qwen"] as const).map(
      probeVendor,
    ),
  );
  return [
    ...live,
    notSupportedVendorStatus(),
  ];
}

export function vendorAuthTerminalCommand(
  vendor: BrokerVendorId,
  action: BrokerVendorAuthAction,
): { name: string; command: string; followup?: string } | undefined {
  const install = action === "install";
  const commands: Partial<
    Record<BrokerVendorId, { install?: string; login?: string; logout?: string }>
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
      // Qwen Code 0.22 uses the interactive auth command in a live terminal.
      login: "qwen /auth",
    },
  };
  const command = install
    ? commands[vendor]?.install
    : action === "login"
      ? commands[vendor]?.login
      : commands[vendor]?.logout;
  if (!command) return undefined;
  return {
    name: `Cukii · ${vendor} ${action}`,
    command,
    ...(vendor === "kimi" && action === "logout" ? { followup: "/logout" } : {}),
  };
}
