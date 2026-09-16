import type { BrokerVendorId } from "core/protocol/ideWebview";
import * as path from "path";

export type VendorInstallTerminalSpec = {
  name: string;
  command: string;
  shellPath: string;
  shellArgs: string[];
  /** The command exits its shell on both success and failure. */
  closesTerminal: true;
};

type InstallEnvironment = NodeJS.ProcessEnv & {
  SystemRoot?: string;
};

const NPM_VENDOR_PACKAGES: Partial<Record<BrokerVendorId, string>> = {
  claude: "@anthropic-ai/claude-code@latest",
  codex: "@openai/codex@latest",
  grok: "@xai-official/grok@latest",
  kimi: "@moonshot-ai/kimi-code@latest",
  qwen: "@qwen-code/qwen-code@latest",
};

const NPM_VENDOR_PROGRAMS: Partial<Record<BrokerVendorId, string>> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  kimi: "kimi",
  qwen: "qwen",
};

/**
 * Where a Unix install puts things, as path segments under the user's home.
 *
 * 🔴 Exported because `nativeCliCandidates` has to look exactly here. A second
 * copy of these literals is how "installed successfully, still shows Not
 * installed" happens: the installer writes one path and the probe searches
 * another, and nothing in either file looks wrong on its own.
 */
export const CUKII_UNIX_NPM_PREFIX_SEGMENTS = [".local"] as const;
export const CUKII_UNIX_NODE_HOME_SEGMENTS = [
  ".local",
  "share",
  "cukii",
  "node",
] as const;

/**
 * Pinned only as a fallback for when nodejs.org cannot be asked which release
 * is current. The live lookup is preferred so this constant going stale costs
 * an older Node, never a failed install.
 */
const NODE_LTS_FALLBACK_VERSION = "v24.21.0";

const NO_ADMIN_NOTICE =
  "Cukii: installing into your home directory. No administrator rights are required.";

const SUDO_REFUSAL_NOTICE =
  "Cukii: do not run this installer with sudo. Everything goes into $HOME, " +
  "which under sudo is the home of root — your own shell would not see the " +
  "result. Close this terminal and select Install again without elevation.";

/**
 * Said before anything is downloaded, because the owner asked to be told up
 * front rather than after a terminal has already opened.
 *
 * The warning is about elevation being *wrong* here, not required: refusing
 * sudo is the same stance Anthropic's own installer takes, and for the same
 * reason — an elevated run puts the binary somewhere the user cannot reach.
 * Plain root with no SUDO_USER is a legitimate container case and is allowed.
 */
function unixPreflight(): string[] {
  return [
    "set -e",
    `echo ${shellLiteral(NO_ADMIN_NOTICE)}`,
    // Everything below is addressed relative to $HOME, including an `rm -rf`.
    // An empty HOME would rebase those paths onto the filesystem root.
    "[ -n \"${HOME:-}\" ] || { echo 'Cukii: HOME is not set, so there is no home directory to install into.' >&2; exit 28; }",
    'if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then',
    `  echo ${shellLiteral(SUDO_REFUSAL_NOTICE)} >&2`,
    "  exit 27",
    "fi",
  ];
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function windowsNpmInstallScript(packageName: string): string {
  const packageLiteral = powershellLiteral(packageName);
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $programFiles = $env:ProgramFiles",
    "  if (-not $programFiles) { $programFiles = 'C:\\Program Files' }",
    "  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
    "  $npmPath = if ($npmCommand) { $npmCommand.Source } else { $null }",
    "  if (-not $npmPath) {",
    "    $fallbackNpm = Join-Path $programFiles 'nodejs\\npm.cmd'",
    "    if (Test-Path -LiteralPath $fallbackNpm) { $npmPath = $fallbackNpm }",
    "  }",
    "  if (-not $npmPath) {",
    "    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "    $principal = [Security.Principal.WindowsPrincipal]::new($identity)",
    "    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue",
    "    if (-not $winget) { throw 'Node.js LTS is missing and Windows Package Manager (winget) is unavailable. Install App Installer, then select Install again.' }",
    "    $wingetArgs = @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget', '--scope', 'machine', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')",
    "    if ($isAdmin) {",
    "      & $winget.Source @wingetArgs",
    '      if ($LASTEXITCODE -ne 0) { throw "winget could not install Node.js LTS (exit $LASTEXITCODE)." }',
    "    } else {",
    "      [Console]::Error.WriteLine('Cukii: Node.js LTS is missing. Windows administrator approval is required for this installer only; approve the UAC prompt to continue.')",
    "      $installer = Start-Process -FilePath $winget.Source -ArgumentList $wingetArgs -Verb RunAs -Wait -PassThru",
    '      if ($installer.ExitCode -ne 0) { throw "elevated winget could not install Node.js LTS (exit $($installer.ExitCode))." }',
    "    }",
    "    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
    "    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
    "    $npmPath = if ($npmCommand) { $npmCommand.Source } else { $null }",
    "    if (-not $npmPath) {",
    "      $fallbackNpm = Join-Path $programFiles 'nodejs\\npm.cmd'",
    "      if (Test-Path -LiteralPath $fallbackNpm) { $npmPath = $fallbackNpm }",
    "    }",
    "    if (-not $npmPath) { throw 'Node.js LTS was installed, but npm.cmd is not discoverable. Restart the Cukii terminal flow, then select Install again.' }",
    "  }",
    "  & $npmPath install -g " + packageLiteral,
    '  if ($LASTEXITCODE -ne 0) { throw "npm.cmd failed with exit $LASTEXITCODE." }',
    "  exit 0",
    "} catch {",
    "  [Console]::Error.WriteLine('Cukii: ' + $_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\r\n");
}

/**
 * Install Node into the user's own home instead of asking a package manager
 * for it.
 *
 * 🔴 The previous bootstrap installed Homebrew on macOS and used
 * apt/dnf/yum/zypper/pacman behind `sudo` on Linux. Both ask for the account
 * password, and Homebrew's own installer needs administrator rights to create
 * its prefix — which is exactly how a first run on the owner's Mac died:
 * two password prompts and `/bin/bash --noprofile --norc` exiting 1 (owner
 * report with screenshot, 2026-09-16).
 *
 * The official tarball needs no rights at all, so the same code path works on
 * macOS and Linux, on x64 and arm64, with or without a package manager, and
 * identically for an owner who cannot become an administrator on a managed
 * machine.
 */
function unixNodeBootstrap(): string[] {
  const nodeHome = `$HOME/${CUKII_UNIX_NODE_HOME_SEGMENTS.join("/")}`;
  return [
    "command -v curl >/dev/null 2>&1 || { echo 'Cukii: curl is required to install Node.js.' >&2; exit 20; }",
    "command -v tar >/dev/null 2>&1 || { echo 'Cukii: tar is required to install Node.js.' >&2; exit 21; }",
    'case "$(uname -s)" in',
    "  Darwin) cukii_os='darwin' ;;",
    "  Linux) cukii_os='linux' ;;",
    '  *) echo "Cukii: unsupported operating system $(uname -s)." >&2; exit 24 ;;',
    "esac",
    'case "$(uname -m)" in',
    "  x86_64|amd64) cukii_arch='x64' ;;",
    "  arm64|aarch64) cukii_arch='arm64' ;;",
    '  *) echo "Cukii: unsupported CPU architecture $(uname -m)." >&2; exit 25 ;;',
    "esac",
    // Ask nodejs.org which release is current; the pinned version is only the
    // answer for a machine that cannot reach the index.
    "cukii_node_version=$(curl -fsSL https://nodejs.org/dist/index.tab 2>/dev/null " +
      "| awk -F'\\t' 'NR > 1 && $10 != \"-\" { print $1; exit }') || cukii_node_version=''",
    `if [ -z "$cukii_node_version" ]; then cukii_node_version='${NODE_LTS_FALLBACK_VERSION}'; fi`,
    `echo "Cukii: installing Node.js $cukii_node_version into ${nodeHome}"`,
    `rm -rf "${nodeHome}"`,
    `mkdir -p "${nodeHome}"`,
    'cukii_node_url="https://nodejs.org/dist/$cukii_node_version/node-$cukii_node_version-$cukii_os-$cukii_arch.tar.gz"',
    `curl -fsSL "$cukii_node_url" | tar -xz -C "${nodeHome}" --strip-components 1 || ` +
      `{ echo "Cukii: could not install Node.js from $cukii_node_url. Check network access, then select Install again." >&2; exit 26; }`,
    `PATH="${nodeHome}/bin:$PATH"`,
    "export PATH",
  ];
}

function unixNpmInstallScript(
  packageName: string,
  programName: string,
): string {
  const bootstrap = unixNodeBootstrap();
  const nodeHome = `$HOME/${CUKII_UNIX_NODE_HOME_SEGMENTS.join("/")}`;
  const npmPrefix = `$HOME/${CUKII_UNIX_NPM_PREFIX_SEGMENTS.join("/")}`;
  const installedProgram = `${npmPrefix}/bin/${programName}`;
  // Keep compound shell constructs on real line boundaries. Joining with
  // semicolons turns `then` / `else` / `fi` into invalid `then;` tokens.
  return [
    ...unixPreflight(),
    // A Node installed by an earlier run lives outside the PATH a GUI VS Code
    // inherits, so it has to be put back before deciding npm is missing —
    // otherwise every install re-downloads Node.
    `if [ -x "${nodeHome}/bin/npm" ]; then`,
    `  PATH="${nodeHome}/bin:$PATH"`,
    "  export PATH",
    "fi",
    "if ! command -v npm >/dev/null 2>&1; then",
    ...bootstrap.map((line) => `  ${line}`),
    "fi",
    "command -v npm >/dev/null 2>&1 || { echo 'Cukii: Node.js was installed, but npm is not discoverable. Restart VS Code, then select Install again.' >&2; exit 23; }",
    // A deterministic user-owned prefix is critical. Reading npm's current
    // global prefix reintroduces the exact failure from 2.0.130: on a Mac with
    // Homebrew it can point outside $HOME and ask for administrator approval.
    `mkdir -p "${npmPrefix}"`,
    `npm install -g --prefix "${npmPrefix}" ${shellLiteral(packageName)}`,
    `[ -x "${installedProgram}" ] || { echo 'Cukii: npm finished, but ${programName} was not installed at ${installedProgram}.' >&2; exit 29; }`,
    `"${installedProgram}" --version >/dev/null 2>&1 || { echo 'Cukii: ${programName} was installed but cannot start.' >&2; exit 30; }`,
    `echo 'Cukii: ${programName} installed successfully at ${installedProgram}.'`,
    "exit 0",
  ].join("\n");
}

/**
 * Vendors whose own installer is the only supported non-package-manager path.
 *
 * Claude intentionally uses the deterministic npm path above. In 2.0.131 its
 * downloaded installer returned exit 1 on the owner's Mac while the terminal
 * closed before preserving the reason. The npm package is published by
 * Anthropic, and the Cukii-owned Node and prefix keep it user-local and
 * observable.
 */
function nativeUnixInstallScript(vendor: BrokerVendorId): string | undefined {
  if (vendor === "cursor") {
    return [
      ...unixPreflight(),
      "command -v curl >/dev/null 2>&1 || { echo 'Cukii: curl is required to install the Cursor agent.' >&2; exit 20; }",
      "curl https://cursor.com/install -fsS | bash",
      "exit 0",
    ].join("\n");
  }
  return undefined;
}

function windowsCursorInstallScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try { irm 'https://cursor.com/install?win32=true' | iex; exit 0 }",
    "catch { [Console]::Error.WriteLine('Cukii: ' + $_.Exception.Message); exit 1 }",
  ].join("; ");
}

export function vendorInstallTerminalSpec(
  vendor: BrokerVendorId,
  platform: NodeJS.Platform = process.platform,
  env: InstallEnvironment = process.env,
): VendorInstallTerminalSpec | undefined {
  if (vendor === "deepseek") return undefined;
  const packageName = NPM_VENDOR_PACKAGES[vendor];
  if (!packageName && vendor !== "cursor") return undefined;

  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? "C:\\Windows";
    return {
      name: `Cukii · ${vendor} install`,
      command:
        vendor === "cursor"
          ? windowsCursorInstallScript()
          : windowsNpmInstallScript(packageName!),
      shellPath: path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      shellArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"],
      closesTerminal: true,
    };
  }

  const programName = NPM_VENDOR_PROGRAMS[vendor];
  return {
    name: `Cukii · ${vendor} install`,
    command:
      nativeUnixInstallScript(vendor) ??
      unixNpmInstallScript(packageName!, programName!),
    shellPath: "/bin/bash",
    shellArgs: ["--noprofile", "--norc"],
    closesTerminal: true,
  };
}
