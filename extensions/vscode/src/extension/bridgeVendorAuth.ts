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
// A short allowance avoids hiding a valid local session when the workstation
// clock is only slightly behind the identity provider.
const JWT_CLOCK_SKEW_SECONDS = 60;

type VendorWithCli = Exclude<BrokerVendorId, "deepseek">;
type ProbeSpec = {
  program: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};
type WindowsEnvironment = {
  LOCALAPPDATA?: string;
  ProgramFiles?: string;
  "ProgramFiles(x86)"?: string;
};
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
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const [header, payload] = parts;
  try {
    const decodePart = (part: string): unknown => {
      const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "=",
      );
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    };
    if (!isRecord(decodePart(header))) return undefined;
    const parsed = decodePart(payload);
    if (!isRecord(parsed)) return undefined;
    const exp = parsed.exp;
    const nbf = parsed.nbf;
    if (
      (exp !== undefined &&
        (typeof exp !== "number" || !Number.isFinite(exp))) ||
      (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf)))
    ) {
      return undefined;
    }
    const now = Date.now() / 1_000;
    if (
      (typeof exp === "number" && exp < now - JWT_CLOCK_SKEW_SECONDS) ||
      (typeof nbf === "number" && nbf > now + JWT_CLOCK_SKEW_SECONDS)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

const SAFE_EMAIL =
  /^[a-z0-9.!#$%&'*+/^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function safeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 && SAFE_EMAIL.test(email) ? email : undefined;
}

/**
 * Names are display-only fallbacks. In particular, opaque ids must not become
 * an account label merely because a provider puts one in a friendly-looking
 * claim. Keep this stricter than a general username validator.
 */
function safeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (
    !name ||
    name.length > 100 ||
    /[=\x00-\x1f\x7f]/.test(name) ||
    (name.includes("@") && !/^@[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name)) ||
    /(?:api[-_]?key|access[-_]?token|id[-_]?token|refresh[-_]?token|token|secret|password|bearer)/i.test(
      name,
    ) ||
    /^(?:account|acct|user|usr|org|uuid|guid|id|sub|sha(?:1|256|512)?|md5)(?:\b|[_:-])/i.test(
      name,
    ) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      name,
    ) ||
    /^[0-9a-f]{24,}$/i.test(name) ||
    /^[A-Za-z0-9_-]{20,}$/.test(name) ||
    /^eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}$/.test(name)
  ) {
    return undefined;
  }
  return name;
}

function safeIdentityFromRecord(record: unknown): string | undefined {
  const email = safeEmail(stringAt(record, "email"));
  if (email) return email;
  return safeDisplayName(
    stringAt(record, "name", "preferred_username", "nickname", "username"),
  );
}

function jwtAccountLabel(token: unknown): string | undefined {
  const claims = decodeJwtPayload(token);
  if (!claims) return undefined;
  const profile = isRecord(claims.profile) ? claims.profile : undefined;
  return safeIdentityFromRecord(claims) ?? safeIdentityFromRecord(profile);
}

/** Local CLI auth metadata only; no browser sessions, token text, or guessed email. */
export function accountLabelFromAuthMetadata(
  vendor: VendorWithCli,
  metadata: unknown,
): string | undefined {
  if (vendor === "codex") {
    const tokens = isRecord(metadata) ? metadata.tokens : undefined;
    return (
      safeIdentityFromRecord(tokens) ??
      jwtAccountLabel(stringAt(tokens, "id_token"))
    );
  }
  if (vendor === "grok") {
    if (!isRecord(metadata)) return undefined;
    for (const entry of Object.values(metadata)) {
      const identity = safeIdentityFromRecord(entry);
      if (identity) return identity;
    }
    return undefined;
  }
  if (vendor === "cursor") {
    return (
      safeIdentityFromRecord(
        isRecord(metadata) ? metadata.userInfo : undefined,
      ) ?? safeIdentityFromRecord(metadata)
    );
  }
  if (vendor === "kimi") {
    const credentials = isRecord(metadata) ? metadata.credentials : undefined;
    if (!Array.isArray(credentials)) return undefined;
    for (const credential of credentials) {
      const label =
        safeIdentityFromRecord(credential) ??
        jwtAccountLabel(stringAt(credential, "access_token", "id_token"));
      if (label) return label;
    }
  }
  return undefined;
}

function unknownIdentityLabel(): string {
  return "Account connected";
}

/**
 * Native CLI output is untrusted process output. Keep this deliberately
 * narrower than RFC email: account labels must never be token-shaped or carry
 * shell/control syntax, even when a CLI happened to print it next to an email.
 */
function sanitizedNativeCliIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254) return undefined;
  if (
    /[=\x00-\x1f\x7f]/.test(value) ||
    /(?:api[-_]?key|access[-_]?token|id[-_]?token|refresh[-_]?token|token|secret|password|bearer|(?:^|[-_])sk[-_])/i.test(
      value,
    ) ||
    !(safeEmail(value) ?? safeDisplayName(value))
  ) {
    return undefined;
  }
  return safeEmail(value) ?? safeDisplayName(value);
}

function identityFromNativeCliJson(
  vendor: "grok" | "kimi",
  text: string,
): string | undefined {
  const status = parseJson(text);
  if (!isRecord(status)) return undefined;

  // These are the only JSON status schemas accepted from the respective
  // native CLIs. Do not fall back to a recursive/email-shaped value search.
  if (vendor === "grok" && status.authenticated === true) {
    return sanitizedNativeCliIdentity(stringAt(status.user, "email"));
  }
  if (vendor === "kimi" && status.source === "oauth") {
    return sanitizedNativeCliIdentity(stringAt(status.account, "email"));
  }
  return undefined;
}

function nativeCliJsonIndicatesAuthenticated(
  vendor: "grok" | "kimi",
  text: string,
): boolean {
  const status = parseJson(text);
  if (!isRecord(status)) return false;
  return vendor === "grok"
    ? status.authenticated === true
    : status.source === "oauth";
}

/**
 * Native CLI stdout is untrusted. Permit terminal CR/LF framing only, then
 * reject every other control character before attempting strict identity
 * parsing. The probe's stdout/stderr separator can make a CLI's CRLF appear as
 * CRLF + LF. In particular, do not use String#trim here: it would erase
 * framing such as vertical tabs before the guard can inspect it.
 */
function withoutTerminalLineEnding(text: string): string | undefined {
  const terminalLineEndings = text.match(/(?:\r\n|\n)*$/)?.[0] ?? "";
  const body = text.slice(0, text.length - terminalLineEndings.length);
  return /[\x00-\x1f\x7f]/.test(body) ? undefined : body;
}

function identityFromNativeCliOutput(
  vendor: VendorWithCli,
  text: string,
): string | undefined {
  if (vendor !== "grok" && vendor !== "kimi") return undefined;
  const terminalFramedText = withoutTerminalLineEnding(text);
  if (terminalFramedText === undefined) return undefined;

  const jsonIdentity = identityFromNativeCliJson(vendor, terminalFramedText);
  if (jsonIdentity) return jsonIdentity;

  // Anchor each vendor's documented human-readable status line. In
  // particular, never infer an identity from arbitrary diagnostics/stdout.
  const match =
    vendor === "grok"
      ? terminalFramedText.match(
          /^You are logged in with grok\.com as ([^\s\r\n]+)$/i,
        )
      : terminalFramedText.match(
          /^managed:kimi-code source=oauth account=([^\s\r\n]+)$/i,
        );
  const candidate =
    vendor === "grok" ? match?.[1]?.replace(/\.$/, "") : match?.[1];
  return sanitizedNativeCliIdentity(candidate);
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
  const accountLabel =
    safeEmail(identityLabel) ??
    safeDisplayName(identityLabel) ??
    identityFromNativeCliOutput(vendor, stdout) ??
    unknownIdentityLabel();
  const connected = (label: string, actions: BrokerVendorAuthAction[]) => ({
    state: "connected" as const,
    authenticated: true,
    accountLabel: label,
    actions,
  });
  const disconnected = (): AuthClassification => ({
    state: "disconnected",
    authenticated: false,
    accountLabel: "Not signed in",
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
        ? connected(safeEmail(status.email) ?? accountLabel, ["logout"])
        : disconnected();
    } catch {
      return unknown();
    }
  }
  if (vendor === "codex") {
    return /logged in/i.test(text)
      ? connected(accountLabel, ["logout"])
      : unknown();
  }
  if (vendor === "grok") {
    return /logged in with/i.test(text) ||
      nativeCliJsonIndicatesAuthenticated("grok", text)
      ? connected(accountLabel, ["logout"])
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
        ? connected(safeEmail(status.userInfo?.email) ?? accountLabel, [
            "logout",
          ])
        : disconnected();
    } catch {
      return unknown();
    }
  }
  if (vendor === "kimi") {
    return /source=oauth/i.test(text) ||
      nativeCliJsonIndicatesAuthenticated("kimi", text)
      ? connected(accountLabel, ["logout"])
      : unknown();
  }
  return qwenOauthSelected(parseJson(text))
    ? connected(accountLabel, [])
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
  windowsEnv: WindowsEnvironment = process.env as WindowsEnvironment,
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
      paths.join(localAppData, "cursor-agent", "agent.cmd"),
      paths.join(localAppData, "cursor-agent", "agent.ps1"),
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
      paths.join(
        localAppData,
        "Cursor",
        "resources",
        "app",
        "bin",
        "agent.exe",
      ),
      paths.join(
        programFiles,
        "Cursor",
        "resources",
        "app",
        "bin",
        "agent.exe",
      ),
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

/**
 * `cmd.exe` expands `%VAR%` even inside quoted tokens. Do not attempt to
 * escape that grammar: a route with control characters is unavailable rather
 * than becoming a command line. `!` remains denied with delayed expansion off
 * as defense in depth.
 */
function isSafeCmdProbeRoute(route: string): boolean {
  return !/[%!"\r\n]/.test(route);
}

export function probeSpec(
  vendor: VendorWithCli,
  executable: string,
): ProbeSpec | undefined {
  const args = WINDOWS_PROBE_ARGS[vendor];
  if (process.platform === "win32") {
    if (executable.toLowerCase().endsWith(".ps1")) {
      const powershell = path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      return {
        program: powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          executable,
          ...args,
        ],
      };
    }
    if (executable.toLowerCase().endsWith(".cmd")) {
      if (!isSafeCmdProbeRoute(executable)) return undefined;
      const command = [
        quoteCmdToken(executable),
        ...args.map(quoteCmdToken),
      ].join(" ");
      return {
        program: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/v:off", "/s", "/c", `call ${command}`],
        // Node otherwise quotes the complete /c command and cmd receives the
        // script's route with literal backslashes before its quotes.
        windowsVerbatimArguments: true,
      };
    }
  }
  return { program: executable, args };
}

type KimiCredential = {
  email?: string;
  name?: string;
  preferred_username?: string;
  nickname?: string;
  username?: string;
};
type KimiCredentialFileSystem = {
  readdirSync(directory: string): string[];
  statSync(file: string): {
    isFile(): boolean;
    size: number;
    mtimeMs: number;
  };
  readFileSync(file: string, encoding: BufferEncoding): string;
};

/**
 * Credentials are ordered newest-first, then by filename, so a current
 * credential wins predictably. A bad sibling must not hide a usable one.
 */
export function localKimiCredentials(
  credentialsDirectory: string,
  fileSystem: KimiCredentialFileSystem = fs,
): KimiCredential[] {
  try {
    return fileSystem
      .readdirSync(credentialsDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .flatMap((entry) => {
        try {
          const credentialFile = path.join(credentialsDirectory, entry);
          const stat = fileSystem.statSync(credentialFile);
          // Native credential files are small. Never load an unexpected bulk file.
          if (!stat.isFile() || stat.size > 64 * 1024) return [];
          const credential = JSON.parse(
            fileSystem.readFileSync(credentialFile, "utf8"),
          );
          const claims =
            decodeJwtPayload(stringAt(credential, "access_token")) ??
            decodeJwtPayload(stringAt(credential, "id_token"));
          const identity =
            safeIdentityFromRecord(credential) ??
            safeIdentityFromRecord(claims);
          if (!identity) return [];
          return [
            {
              credential: {
                email: safeEmail(identity),
                name: safeDisplayName(identity),
              },
              modifiedAt: stat.mtimeMs,
              filename: entry,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          left.filename.localeCompare(right.filename),
      )
      .map(({ credential }) => credential);
  } catch {
    return [];
  }
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
    if (vendor === "kimi") {
      const credentialsDirectory = path.join(
        userHome,
        ".kimi-code",
        "credentials",
      );
      return { credentials: localKimiCredentials(credentialsDirectory) };
    }
    if (!file || !fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (vendor === "codex") {
      const tokens = isRecord(raw) ? raw.tokens : undefined;
      const claims = decodeJwtPayload(stringAt(tokens, "id_token"));
      return {
        tokens: {
          email: safeEmail(stringAt(claims, "email")),
          name: safeDisplayName(
            stringAt(
              claims,
              "name",
              "preferred_username",
              "nickname",
              "username",
            ),
          ),
        },
      };
    }
    if (vendor === "grok") {
      return Object.fromEntries(
        Object.entries(isRecord(raw) ? raw : {}).map(([issuer, entry]) => [
          issuer,
          {
            email: safeEmail(stringAt(entry, "email")),
            name: safeDisplayName(
              stringAt(
                entry,
                "name",
                "preferred_username",
                "nickname",
                "username",
              ),
            ),
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

type VendorProbeOptions = {
  metadata?: unknown;
  timeoutMs?: number;
};

function unavailableVendorStatus(
  vendor: VendorWithCli,
): BrokerVendorAuthStatus {
  return {
    id: vendor,
    label: cukiiVendorLabel(vendor),
    installed: true,
    state: "unknown",
    authenticated: false,
    accountLabel: "Account status unavailable",
    actions: ["login"],
  };
}

/** Exercise the production native-child probe against one known executable. */
export async function probeVendorExecutable(
  vendor: VendorWithCli,
  executable: string,
  options: VendorProbeOptions = {},
): Promise<BrokerVendorAuthStatus> {
  const metadata =
    "metadata" in options ? options.metadata : localMetadata(vendor);
  const identity = accountLabelFromAuthMetadata(vendor, metadata);
  const spec = probeSpec(vendor, executable);
  if (!spec) return unavailableVendorStatus(vendor);
  try {
    const { stdout, stderr } = await execFileAsync(spec.program, spec.args, {
      timeout: options.timeoutMs ?? 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const output =
      vendor === "qwen"
        ? JSON.stringify(metadata ?? {})
        : `${stdout}\n${stderr}`;
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(vendor, output, identity),
    };
  } catch (error) {
    // A wrapper that exists but fails internally is still installed. In
    // particular, Cursor's native Windows agent must not become “Not
    // installed” merely because its own command returned an error.
    if (isMissingCliError(error) && !fs.existsSync(executable)) {
      return notInstalledVendorStatus(vendor);
    }
    const output =
      vendor === "qwen" ? JSON.stringify(metadata ?? {}) : errorText(error);
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(vendor, output, identity),
    };
  }
}

async function probeVendor(
  vendor: VendorWithCli,
): Promise<BrokerVendorAuthStatus> {
  const executable = resolveNativeCli(vendor);
  if (!executable) return notInstalledVendorStatus(vendor);
  return probeVendorExecutable(vendor, executable);
}

// No state is retained between requests: after a terminal login/logout every
// modal refresh launches fresh native probes. Kept explicit for the action path.
export function clearBrokerVendorAccountCache(): void {}

export async function listBrokerVendorAccounts(): Promise<
  BrokerVendorAuthStatus[]
> {
  const live = await Promise.all(
    (["claude", "codex", "grok", "cursor", "kimi", "qwen"] as const).map(
      probeVendor,
    ),
  );
  return [...live, notSupportedVendorStatus()];
}

export function vendorAuthTerminalCommand(
  vendor: BrokerVendorId,
  action: BrokerVendorAuthAction,
): { name: string; command: string; followup?: string } | undefined {
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
    ...(vendor === "kimi" && action === "logout"
      ? { followup: "/logout" }
      : {}),
  };
}
