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
    "    if (-not $isAdmin) { throw 'Node.js LTS and npm are missing. Restart VS Code as Administrator, then select Install again.' }",
    "    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue",
    "    if (-not $winget) { throw 'Node.js LTS is missing and Windows Package Manager (winget) is unavailable. Install App Installer, then select Install again.' }",
    "    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity",
    "    if ($LASTEXITCODE -ne 0) { throw \"winget could not install Node.js LTS (exit $LASTEXITCODE).\" }",
    "    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
    "    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
    "    $npmPath = if ($npmCommand) { $npmCommand.Source } else { $null }",
    "    if (-not $npmPath) {",
    "      $fallbackNpm = Join-Path $programFiles 'nodejs\\npm.cmd'",
    "      if (Test-Path -LiteralPath $fallbackNpm) { $npmPath = $fallbackNpm }",
    "    }",
    "    if (-not $npmPath) { throw 'Node.js LTS was installed, but npm.cmd is not discoverable. Restart VS Code, then select Install again.' }",
    "  }",
    "  & $npmPath install -g " + packageLiteral,
    "  if ($LASTEXITCODE -ne 0) { throw \"npm.cmd failed with exit $LASTEXITCODE.\" }",
    "  exit 0",
    "} catch {",
    "  [Console]::Error.WriteLine('Cukii: ' + $_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\r\n");
}

function unixNodeBootstrap(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "if ! command -v brew >/dev/null 2>&1; then",
      "  command -v curl >/dev/null 2>&1 || { echo 'Cukii: curl is required to install Homebrew and Node.js LTS.' >&2; exit 20; }",
      "  /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
      "  if [ -x /opt/homebrew/bin/brew ]; then eval \"$(/opt/homebrew/bin/brew shellenv)\"; elif [ -x /usr/local/bin/brew ]; then eval \"$(/usr/local/bin/brew shellenv)\"; fi",
      "fi",
      "brew install node",
    ];
  }
  return [
    "cukii_as_root() { if [ \"$(id -u)\" -eq 0 ]; then \"$@\"; elif command -v sudo >/dev/null 2>&1; then sudo \"$@\"; else echo 'Cukii: installing Node.js LTS requires root or sudo.' >&2; return 21; fi; }",
    "if command -v apt-get >/dev/null 2>&1; then cukii_as_root apt-get update && cukii_as_root apt-get install -y nodejs npm",
    "elif command -v dnf >/dev/null 2>&1; then cukii_as_root dnf install -y nodejs npm",
    "elif command -v yum >/dev/null 2>&1; then cukii_as_root yum install -y nodejs npm",
    "elif command -v zypper >/dev/null 2>&1; then cukii_as_root zypper --non-interactive install nodejs npm",
    "elif command -v pacman >/dev/null 2>&1; then cukii_as_root pacman -S --needed --noconfirm nodejs npm",
    "else echo 'Cukii: no supported system package manager found (apt, dnf, yum, zypper, pacman).' >&2; exit 22; fi",
  ];
}

function unixNpmInstallScript(
  packageName: string,
  platform: NodeJS.Platform,
): string {
  const bootstrap = unixNodeBootstrap(platform);
  return [
    "set -e",
    "if ! command -v npm >/dev/null 2>&1; then",
    ...bootstrap.map((line) => `  ${line}`),
    "fi",
    "command -v npm >/dev/null 2>&1 || { echo 'Cukii: Node.js was installed, but npm is not discoverable. Restart VS Code, then select Install again.' >&2; exit 23; }",
    "cukii_prefix=$(npm config get prefix)",
    "if [ ! -w \"$cukii_prefix\" ]; then npm config set prefix \"$HOME/.local\"; export PATH=\"$HOME/.local/bin:$PATH\"; fi",
    `npm install -g ${shellLiteral(packageName)}`,
    "exit 0",
  ].join("; ");
}

function cursorInstallScript(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return [
      "$ErrorActionPreference = 'Stop'",
      "try { irm 'https://cursor.com/install?win32=true' | iex; exit 0 }",
      "catch { [Console]::Error.WriteLine('Cukii: ' + $_.Exception.Message); exit 1 }",
    ].join("; ");
  }
  return "set -e; curl https://cursor.com/install -fsS | bash; exit 0";
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
          ? cursorInstallScript(platform)
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

  return {
    name: `Cukii · ${vendor} install`,
    command:
      vendor === "cursor"
        ? cursorInstallScript(platform)
        : unixNpmInstallScript(packageName!, platform),
    shellPath: "/bin/bash",
    shellArgs: ["--noprofile", "--norc"],
    closesTerminal: true,
  };
}
