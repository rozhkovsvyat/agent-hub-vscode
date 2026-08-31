import { execFile, spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import {
  CUKII_VENDOR_REGISTRY,
  cukiiVendorLabel,
} from "core/cukiiVendorRegistry";
import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
  BrokerVendorId,
} from "core/protocol/ideWebview";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { alibabaIdentity } from "./alibabaTokenPlan";

const execFileAsync = promisify(execFile);
type ProcessTreeRunner = (program: string, args: string[]) => Promise<unknown>;
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
    if (
      typeof value === "string" &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.trim()
    ) {
      return value.trim();
    }
  }
  return undefined;
}

function decodeJwtPayload(
  token: unknown,
  allowExpired = false,
): Record<string, unknown> | undefined {
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
      (typeof exp === "number" &&
        !allowExpired &&
        exp < now - JWT_CLOCK_SKEW_SECONDS) ||
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
  if (/[\x00-\x1f\x7f]/.test(value)) return undefined;
  const email = value.trim();
  return email.length <= 254 && SAFE_EMAIL.test(email) ? email : undefined;
}

function jwtAccountLabel(
  token: unknown,
  allowExpired = false,
): string | undefined {
  const claims = decodeJwtPayload(token, allowExpired);
  if (!claims) return undefined;
  const profile = isRecord(claims.profile) ? claims.profile : undefined;
  return (
    safeEmail(stringAt(claims, "email")) ??
    safeEmail(stringAt(profile, "email"))
  );
}

/** Local CLI auth metadata only; no browser sessions, token text, or guessed email. */
export function accountLabelFromAuthMetadata(
  vendor: VendorWithCli,
  metadata: unknown,
): string | undefined {
  if (vendor === "codex") {
    const tokens = isRecord(metadata) ? metadata.tokens : undefined;
    return (
      safeEmail(stringAt(tokens, "email")) ??
      jwtAccountLabel(stringAt(tokens, "id_token"))
    );
  }
  if (vendor === "grok") {
    if (!isRecord(metadata)) return undefined;
    for (const entry of Object.values(metadata)) {
      const identity = safeEmail(stringAt(entry, "email"));
      if (identity) return identity;
    }
    return undefined;
  }
  if (vendor === "cursor") {
    return (
      safeEmail(
        stringAt(isRecord(metadata) ? metadata.userInfo : undefined, "email"),
      ) ?? safeEmail(stringAt(metadata, "email"))
    );
  }
  if (vendor === "kimi") {
    const credentials = isRecord(metadata) ? metadata.credentials : undefined;
    if (!Array.isArray(credentials)) return undefined;
    for (const credential of credentials) {
      const label =
        safeEmail(stringAt(credential, "email")) ??
        jwtAccountLabel(stringAt(credential, "access_token", "id_token"));
      if (label) return label;
    }
  }
  if (vendor === "qwen") {
    return (
      safeEmail(stringAt(metadata, "email", "accountLabel")) ??
      safeEmail(
        stringAt(isRecord(metadata) ? metadata.account : undefined, "email"),
      )
    );
  }
  return undefined;
}

/**
 * An expired Codex ID token is never authentication proof. Its email can still
 * be factual display metadata when the native CLI independently confirms that
 * the refresh-backed login is active.
 */
export function storedCodexAccountLabel(metadata: unknown): string | undefined {
  const tokens = isRecord(metadata) ? metadata.tokens : undefined;
  return jwtAccountLabel(stringAt(tokens, "id_token"), true);
}

function unknownIdentityLabel(): string {
  return "Not logged in";
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
    !safeEmail(value)
  ) {
    return undefined;
  }
  return safeEmail(value);
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

function qwenTokenPlanConnected(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata.credentialPresent === true) return true;
  const security = isRecord(metadata.security) ? metadata.security : undefined;
  const auth = isRecord(security?.auth) ? security.auth : undefined;
  return (
    isRecord(metadata.tokenPlan) &&
    (auth?.selectedType === "openai" || auth?.selectedType === "token-plan")
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
    identityFromNativeCliOutput(vendor, stdout) ??
    unknownIdentityLabel();
  const connected = (label: string, actions: BrokerVendorAuthAction[]) => {
    const email = safeEmail(label);
    return {
      state: "connected" as const,
      authenticated: true,
      // A verified native login is enough to report a connection. Some
      // providers do not expose an email on their local status route; never
      // turn that into a false "Not logged in" or invent an identity.
      accountLabel: email ?? "Connected",
      actions,
    };
  };
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
  return qwenTokenPlanConnected(parseJson(text))
    ? connected(accountLabel, ["logout"])
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
type KimiServerProbeFileSystem = {
  readdirSync(directory: string): string[];
  statSync(file: string): { isFile(): boolean; size: number };
  readFileSync(file: string, encoding: BufferEncoding): string;
};

type KimiServerRequest = (
  endpoint: URL,
  bearerToken: string,
  timeoutMs: number,
) => Promise<unknown>;
type KimiServerProbeOptions = {
  instancesDirectory?: string;
  /**
   * Retained for callers that provide a filesystem fixture.  A registry token
   * is deliberately never read: any local process could publish a registry
   * entry and receive it back over loopback.
   */
  tokenFile?: string;
  fileSystem?: KimiServerProbeFileSystem;
  request?: KimiServerRequest;
  timeoutMs?: number;
  executable?: string;
  cacheKey?: string;
  signal?: AbortSignal;
  launch?: (executable: string, port: number) => ChildProcess;
  reservePort?: () => Promise<number | undefined>;
  launchTimeoutMs?: number;
  stopEphemeral?: (
    child: ChildProcess,
    endpoint: URL | undefined,
    bearerToken: string | undefined,
    timeoutMs: number,
  ) => Promise<void>;
};

const KIMI_SERVER_TIMEOUT_MS = 800;
const KIMI_SERVER_LAUNCH_TIMEOUT_MS = 3_500;
const KIMI_MAX_STARTUP_OUTPUT_SIZE = 8 * 1024;
const KIMI_MAX_BEARER_TOKEN_LENGTH = 512;
const kimiEmailCache = new Map<string, string>();

type KimiWebStartup = {
  endpoint: URL;
  bearerToken: string;
};

function kimiUserInfoRequest(
  endpoint: URL,
  bearerToken: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!isExactKimiLoopbackEndpoint(endpoint)) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request(
      new URL("/api/v1/oauth/userinfo", endpoint),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(undefined);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            request.destroy();
            finish(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (size <= 64 * 1024) {
            finish(parseJson(Buffer.concat(chunks).toString("utf8")));
          }
        });
        response.once("error", () => finish(undefined));
      },
    );
    request.once("error", () => finish(undefined));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(undefined);
    });
    request.end();
  });
}

function kimiShutdownRequest(
  endpoint: URL,
  bearerToken: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const request = http.request(
      new URL("/api/v1/shutdown", endpoint),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
      (response) => {
        response.resume();
        resolve();
      },
    );
    request.once("error", () => resolve());
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve();
    });
    request.end();
  });
}

function reserveLoopbackPort(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close(() => resolve(port));
    });
  });
}

function launchKimiWeb(executable: string, port: number): ChildProcess {
  return spawn(
    executable,
    ["web", "--no-open", "--port", String(port), "--log-level", "info"],
    {
      shell: false,
      windowsHide: true,
      // The startup URL carries a bearer. Keep it private, bounded and in-memory.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function isExactKimiLoopbackEndpoint(endpoint: URL, port?: number): boolean {
  const endpointPort = Number(endpoint.port);
  return (
    endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.pathname === "/" &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.hash === "" &&
    endpoint.port !== "" &&
    Number.isInteger(endpointPort) &&
    endpointPort > 0 &&
    endpointPort <= 65535 &&
    (port === undefined || endpointPort === port)
  );
}

/**
 * Kimi 0.38 writes a local startup URL with the ephemeral bearer in its hash.
 * Older canaries used a sole `token` query member. Never generalize this into
 * a banner scraper: only the exact 127.0.0.1 URL for our reserved port is
 * accepted, and all output remains private to this bounded parser.
 */
function kimiStartupFromBanner(
  output: Buffer,
  port: number,
): KimiWebStartup | undefined {
  const prefixes = [
    { prefix: `http://127.0.0.1:${port}/#token=`, kind: "hash" as const },
    { prefix: `http://127.0.0.1:${port}/?token=`, kind: "query" as const },
  ];
  const text = output.toString("utf8");
  for (const { prefix, kind } of prefixes) {
    let offset = 0;
    while (offset < text.length) {
      const start = text.indexOf(prefix, offset);
      if (start < 0) break;
      const before = start === 0 ? "" : text[start - 1];
      const tokenStart = start + prefix.length;
      const tokenMatch = new RegExp(
        `^[A-Za-z0-9._~+\\/=-]{1,${KIMI_MAX_BEARER_TOKEN_LENGTH}}`,
      ).exec(text.slice(tokenStart));
      const token = tokenMatch?.[0];
      const after = token ? text[tokenStart + token.length] : undefined;
      if (
        (!before || /[\s\"'(]/.test(before)) &&
        token &&
        // A chunk boundary is not a token boundary: accepting there would
        // send a truncated bearer before a later chunk completes the banner.
        Boolean(after && /[\s\"')\]\r\n]/.test(after))
      ) {
        try {
          const endpoint = new URL(`${prefix}${token}`);
          const query = [...endpoint.searchParams.entries()];
          const validBearer =
            kind === "hash"
              ? endpoint.hash === `#token=${token}` && query.length === 0
              : endpoint.hash === "" &&
                query.length === 1 &&
                query[0][0] === "token" &&
                query[0][1] === token;
          endpoint.hash = "";
          endpoint.search = "";
          if (validBearer && isExactKimiLoopbackEndpoint(endpoint, port)) {
            return { endpoint, bearerToken: token };
          }
        } catch {
          // Continue checking a later complete startup URL in the bounded banner.
        }
      }
      offset = tokenStart;
    }
  }
  return undefined;
}

function waitForKimiStartup(
  child: ChildProcess,
  port: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<KimiWebStartup | undefined> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const finish = (result: KimiWebStartup | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onFailure);
      child.removeListener("exit", onFailure);
      signal?.removeEventListener("abort", onFailure);
      // Best-effort zeroization: neither stream nor bearer is ever logged.
      stdout.fill(0);
      stderr.fill(0);
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
      resolve(result);
    };
    const accept = (
      output: Buffer<ArrayBufferLike>,
    ): KimiWebStartup | undefined => kimiStartupFromBanner(output, port);
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: unknown,
    ): Buffer<ArrayBufferLike> | undefined => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (current.length + next.length > KIMI_MAX_STARTUP_OUTPUT_SIZE) {
        return undefined;
      }
      return Buffer.concat([current, next]);
    };
    const onStdout = (chunk: unknown) => {
      const next = append(stdout, chunk);
      if (!next) return finish(undefined);
      stdout = next;
      const startup = accept(stdout);
      if (startup) finish(startup);
    };
    const onStderr = (chunk: unknown) => {
      const next = append(stderr, chunk);
      if (!next) return finish(undefined);
      stderr = next;
      const startup = accept(stderr);
      if (startup) finish(startup);
    };
    const onFailure = () => finish(undefined);
    const timer = setTimeout(
      () => finish(undefined),
      Math.max(0, deadline - Date.now()),
    );
    if (signal?.aborted) return finish(undefined);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onFailure);
    child.once("exit", onFailure);
    signal?.addEventListener("abort", onFailure, { once: true });
  });
}

async function stopEphemeralKimiWeb(
  child: ChildProcess,
  endpoint: URL | undefined,
  bearerToken: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (endpoint && bearerToken) {
    try {
      await kimiShutdownRequest(endpoint, bearerToken, timeoutMs);
    } catch {
      // Cleanup must continue even if an invalidated bearer rejects locally.
    }
  }
  if (child.killed || !child.pid) return;
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 300);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (exited || child.killed) return;
  try {
    if (process.platform === "win32") {
      await terminateWindowsProcessTree(child.pid);
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The exact child already exited or could not be signalled.
    }
  }
}

/**
 * `taskkill /T` is the normal, atomic tree cleanup.  If it is unavailable or
 * races with a just-exited root process, retain the original parent PID and
 * explicitly terminate every remaining descendant.  The PID is numeric and
 * passed as an argv member, never interpolated into the PowerShell program.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  run: ProcessTreeRunner = (program, args) =>
    execFileAsync(program, args, { timeout: 1_000, windowsHide: true }),
): Promise<void> {
  try {
    await run("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  } catch {
    const powershell = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    await run(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$root = [int]$args[0]",
        "$all = @(Get-CimInstance Win32_Process)",
        "$pending = @($root); $seen = @{}",
        "while ($pending.Count) { $parent = [int]$pending[0]; $pending = @($pending | Select-Object -Skip 1); if ($seen.ContainsKey($parent)) { continue }; $seen[$parent] = $true; foreach ($process in $all) { if ($process.ParentProcessId -eq $parent) { $pending += [int]$process.ProcessId } } }",
        "$seen.Keys | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      ].join("; "),
      String(pid),
    ]);
  }
}

export function kimiCredentialFingerprint(
  userHome: string,
): string | undefined {
  const credentialsDirectory = path.join(userHome, ".kimi-code", "credentials");
  try {
    return fs
      .readdirSync(credentialsDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => {
        const file = path.join(credentialsDirectory, entry);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return "";
        // Metadata alone is mutable by an account switcher.  Keep only a
        // one-way digest in the cache key; credential text never enters it.
        const digest = createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
        return `${entry}:${stat.size}:${stat.mtimeMs}:${digest}`;
      })
      .filter(Boolean)
      .join("|");
  } catch {
    return undefined;
  }
}

/**
 * A Kimi registry is not an authorization boundary: another local process can
 * publish an exact-looking loopback endpoint and capture `server.token`.
 * Identity is therefore read only from an ephemeral child on the port this
 * process reserved, and its bearer never escapes this function.
 */
export async function localKimiServerEmail(
  options: KimiServerProbeOptions = {},
): Promise<string | undefined> {
  if (options.cacheKey) {
    const cached = kimiEmailCache.get(options.cacheKey);
    if (cached) return cached;
  }
  let ephemeral: ChildProcess | undefined;
  let ephemeralEndpoint: URL | undefined;
  let bearerToken: string | undefined;
  try {
    if (options.signal?.aborted) return undefined;
    if (options.executable) {
      const port = await (options.reservePort ?? reserveLoopbackPort)();
      if (!port || options.signal?.aborted) return undefined;
      ephemeral = (options.launch ?? launchKimiWeb)(options.executable, port);
      const startup = await waitForKimiStartup(
        ephemeral,
        port,
        options.signal,
        options.launchTimeoutMs ?? KIMI_SERVER_LAUNCH_TIMEOUT_MS,
      );
      if (!startup) return undefined;
      ephemeralEndpoint = startup.endpoint;
      bearerToken = startup.bearerToken;
      const response = await (options.request ?? kimiUserInfoRequest)(
        ephemeralEndpoint,
        bearerToken,
        options.timeoutMs ?? KIMI_SERVER_TIMEOUT_MS,
      );
      const data = isRecord(response) ? response.data : undefined;
      const userInfo =
        isRecord(data) && data.kind === "ok" ? data.userInfo : undefined;
      const email = safeEmail(stringAt(userInfo, "email"));
      if (email && options.cacheKey)
        kimiEmailCache.set(options.cacheKey, email);
      return email;
    }
  } catch {
    // Token and endpoint failures deliberately remain non-diagnostic.
  } finally {
    if (ephemeral) {
      try {
        await (options.stopEphemeral ?? stopEphemeralKimiWeb)(
          ephemeral,
          ephemeralEndpoint,
          bearerToken,
          options.timeoutMs ?? KIMI_SERVER_TIMEOUT_MS,
        );
      } catch {
        // A cleanup implementation must not surface a bearer-bearing error.
      }
    }
    bearerToken = undefined;
  }
  return undefined;
}

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
          const email =
            safeEmail(stringAt(credential, "email")) ??
            safeEmail(stringAt(claims, "email"));
          if (!email) return [];
          return [
            {
              credential: {
                email,
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
      return {
        tokens: {
          // `codex login status` is the authentication authority. Its active
          // refresh session can outlive the ID-token lifetime, so retain a
          // strictly validated email claim solely as display metadata. The
          // claim never authenticates a status on its own.
          email: storedCodexAccountLabel(raw),
        },
      };
    }
    if (vendor === "grok") {
      return Object.fromEntries(
        Object.entries(isRecord(raw) ? raw : {}).map(([issuer, entry]) => [
          issuer,
          {
            email: safeEmail(stringAt(entry, "email")),
          },
        ]),
      );
    }
    return undefined;
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
    accountLabel: "Coming soon",
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

async function qwenAuthProbePayload(metadata: unknown): Promise<{
  output: string;
  identity?: string;
}> {
  if (metadata !== undefined) {
    const identity = accountLabelFromAuthMetadata("qwen", metadata);
    return {
      output: JSON.stringify({
        ...(isRecord(metadata) ? metadata : {}),
        credentialPresent: qwenTokenPlanConnected(metadata),
      }),
      identity,
    };
  }
  const identity = await alibabaIdentity();
  return {
    output: JSON.stringify({
      credentialPresent: identity.authenticated,
      accountLabel: identity.accountLabel,
    }),
    identity: identity.authenticated ? identity.accountLabel : undefined,
  };
}

/** Exercise the production native-child probe against one known executable. */
export async function probeVendorExecutable(
  vendor: VendorWithCli,
  executable: string,
  options: VendorProbeOptions = {},
): Promise<BrokerVendorAuthStatus> {
  const metadata =
    vendor === "qwen" && !("metadata" in options)
      ? undefined
      : "metadata" in options
        ? options.metadata
        : localMetadata(vendor);
  const identity = accountLabelFromAuthMetadata(vendor, metadata);
  const spec = probeSpec(vendor, executable);
  if (!spec) return unavailableVendorStatus(vendor);
  const qwenProbe =
    vendor === "qwen" ? await qwenAuthProbePayload(metadata) : undefined;
  try {
    const { stdout, stderr } = await execFileAsync(spec.program, spec.args, {
      timeout: options.timeoutMs ?? 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const output = qwenProbe ? qwenProbe.output : `${stdout}\n${stderr}`;
    const kimiEmail =
      vendor === "kimi" &&
      !identity &&
      (/source=oauth/i.test(output) ||
        nativeCliJsonIndicatesAuthenticated("kimi", output))
        ? await localKimiServerEmail({
            executable,
            cacheKey: `${executable}:${kimiCredentialFingerprint(os.homedir()) ?? "missing"}`,
          })
        : undefined;
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(
        vendor,
        output,
        identity ?? qwenProbe?.identity ?? kimiEmail,
      ),
    };
  } catch (error) {
    // A wrapper that exists but fails internally is still installed. In
    // particular, Cursor's native Windows agent must not become “Not
    // installed” merely because its own command returned an error.
    if (isMissingCliError(error) && !fs.existsSync(executable)) {
      return notInstalledVendorStatus(vendor);
    }
    const output = qwenProbe ? qwenProbe.output : errorText(error);
    return {
      id: vendor,
      label: cukiiVendorLabel(vendor),
      installed: true,
      ...classifyVendorAuthOutput(
        vendor,
        output,
        identity ?? qwenProbe?.identity,
      ),
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
export function clearBrokerVendorAccountCache(): void {
  kimiEmailCache.clear();
}

export async function listBrokerVendorAccounts(): Promise<
  BrokerVendorAuthStatus[]
> {
  const live = await Promise.all(
    CUKII_VENDOR_REGISTRY.filter((vendor) => vendor.id !== "deepseek").map(
      (vendor) => probeVendor(vendor.id as VendorWithCli),
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
