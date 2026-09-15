#requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$VsixPath,
    [Parameter(Mandatory)][string]$SourceManifestPath,
    [string]$CodeCli,
    [string]$ScratchParent = 'D:\Scratch',
    [ValidateRange(20, 300)][int]$TimeoutSeconds = 90,
    [switch]$KeepOnSuccess
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib-cukii-release-capacity.ps1')
$releaseLease = New-CukiiReleaseLease -AllowMatrixParent
try { Assert-CukiiReleaseCapacity } catch { Close-CukiiReleaseLease $releaseLease; throw }

function Fail([string]$Message) { throw "CUKII-ACTIVATION-SMOKE-REJECTED: $Message" }

function Get-StreamSha256([IO.Stream]$Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($sha.ComputeHash($Stream))).ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-ZipEntrySha256([IO.Compression.ZipArchiveEntry]$Entry) {
    $stream = $Entry.Open()
    try { return Get-StreamSha256 $stream }
    finally { $stream.Dispose() }
}

function Assert-NoLivePackagers {
    try {
        $processInventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        Fail "[PROCESS_INVENTORY] не удалось получить process inventory: $($_.Exception.Message)"
    }
    $packagerPattern = '(?i)(?:\bvsce(?:\.cmd)?\b.{0,120}\bpackage\b|\bvscode:prepublish\b|\bprepackage\.js\b|\bnpm(?:\.cmd)?\b.{0,80}\brun\s+(?:package|vscode:prepublish|prepackage)\b|\bpnpm(?:\.cmd)?\b.{0,80}\b(?:run\s+)?(?:package|vscode:prepublish|prepackage)\b)'
    $livePackagers = @($processInventory | Where-Object {
        $_.Name -match '^(?:node|npm|pnpm|yarn|cmd|pwsh|powershell)(?:\.exe)?$' -and
        [string]$_.CommandLine -match $packagerPattern
    })
    if ($livePackagers.Count -gt 0) {
        Fail "[LIVE_PACKAGER] живой build/package процесс на машине: PID $($livePackagers.ProcessId -join ', ')"
    }
}

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Stop-SmokeCode([string]$ProfileRoot) {
    $owned = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            [string]$_.CommandLine -and
            ([string]$_.CommandLine).Contains($ProfileRoot, [StringComparison]::OrdinalIgnoreCase)
        })
    foreach ($process in $owned) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F *> $null
    }
    $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            [string]$_.CommandLine -and
            ([string]$_.CommandLine).Contains($ProfileRoot, [StringComparison]::OrdinalIgnoreCase)
        })
    if ($remaining.Count -gt 0) {
        Fail "[OWNED_PROCESS_LEAK] после teardown живы PID $($remaining.ProcessId -join ', ') profile=$ProfileRoot"
    }
}

$vsix = (Resolve-Path -LiteralPath $VsixPath).Path
$sourceManifestFile = (Resolve-Path -LiteralPath $SourceManifestPath).Path
$sourceManifest = Get-Content -LiteralPath $sourceManifestFile -Raw | ConvertFrom-Json
$extensionRoot = Split-Path $sourceManifestFile
$repoRoot = (& git -C $extensionRoot rev-parse --show-toplevel 2>$null).Trim()
if (-not $repoRoot) { Fail 'SourceManifestPath не принадлежит git-worktree' }
$repoRoot = [IO.Path]::GetFullPath($repoRoot)
if (@(& git -C $repoRoot status --porcelain=v1 --untracked-files=all).Count -ne 0) {
    Fail "[DIRTY_WORKTREE] release-worktree dirty: $repoRoot"
}

Assert-NoLivePackagers

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($vsix)
try {
    $manifestEntry = $zip.Entries | Where-Object FullName -eq 'extension/package.json'
    if (-not $manifestEntry) { Fail 'VSIX не содержит extension/package.json' }
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try {
        $packedManifestText = $reader.ReadToEnd()
        $packedManifest = $packedManifestText | ConvertFrom-Json
    }
    finally { $reader.Dispose() }

    if ([string]$packedManifest.version -cne [string]$sourceManifest.version) {
        Fail "[VERSION_MISMATCH] версия VSIX $($packedManifest.version) не совпадает с source $($sourceManifest.version)"
    }
    if ([string]$packedManifest.publisher -cne 'cukii' -or [string]$packedManifest.name -cne 'cukii-vscode') {
        Fail 'в VSIX другой extension identity'
    }
    $vsixManifestEntry = $zip.Entries | Where-Object FullName -eq 'extension.vsixmanifest'
    if (-not $vsixManifestEntry) { Fail '[VSIX_METADATA] VSIX не содержит extension.vsixmanifest' }
    $vsixReader = [IO.StreamReader]::new($vsixManifestEntry.Open())
    try { [xml]$vsixManifest = $vsixReader.ReadToEnd() }
    finally { $vsixReader.Dispose() }
    $identity = $vsixManifest.PackageManifest.Metadata.Identity
    if ([string]$identity.Id -cne 'cukii-vscode' -or
        [string]$identity.Publisher -cne 'cukii' -or
        [string]$identity.Version -cne [string]$packedManifest.version) {
        Fail "[VSIX_METADATA] extension.vsixmanifest не совпадает с package.json: id=$($identity.Id) publisher=$($identity.Publisher) version=$($identity.Version)"
    }
    $kinds = @($packedManifest.extensionKind)
    if ($kinds.Count -ne 1 -or [string]$kinds[0] -cne 'workspace') {
        Fail "[EXTENSION_KIND] extensionKind обязан быть ровно ['workspace']; фактически: $($kinds -join ',')"
    }
    $mainEntryName = 'extension/' + ([string]$packedManifest.main).TrimStart('.', '/')
    $mainEntry = $zip.Entries | Where-Object FullName -eq $mainEntryName
    if (-not $mainEntry -or $mainEntry.Length -le 0) { Fail "[EMPTY_MAIN] main bundle отсутствует/пуст: $mainEntryName" }

    $sourceMain = Join-Path $extensionRoot ([string]$packedManifest.main).TrimStart('.', '/')
    if (-not (Test-Path -LiteralPath $sourceMain -PathType Leaf)) {
        Fail "[SOURCE_BINDING] source main bundle отсутствует: $sourceMain"
    }
    $packedMainHash = Get-ZipEntrySha256 $mainEntry
    $sourceMainHash = (Get-FileHash -LiteralPath $sourceMain -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($packedMainHash -cne $sourceMainHash) {
        Fail "[SOURCE_BINDING] VSIX main bundle не совпадает с SourceManifestPath worktree"
    }

    $requiredFiles = @(
        'extension/gui/assets/index.js',
        'extension/gui/assets/index.css',
        'extension/config_schema.json',
        'extension/config-yaml-schema.json',
        'extension/out/tree-sitter.wasm',
        'extension/out/xhr-sync-worker.js',
        'extension/out/build/Release/node_sqlite3.node',
        'extension/out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.node',
        'extension/out/node_modules/@vscode/ripgrep/bin/rg.exe',
        'extension/out/node_modules/sharp/build/Release/sharp-win32-x64.node',
        'extension/out/runtime/ffmpeg.exe',
        'extension/bin/napi-v3/win32/x64/onnxruntime_binding.node',
        'extension/bin/napi-v3/win32/x64/onnxruntime.dll',
        'extension/models/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
        'extension/tree-sitter/code-snippet-queries/c_sharp.scm',
        'extension/tag-qry/tree-sitter-c_sharp-tags.scm'
    )
    $entryByName = @{}
    foreach ($entry in $zip.Entries) { $entryByName[$entry.FullName] = $entry }
    $missingRequired = @($requiredFiles | Where-Object {
        -not $entryByName.ContainsKey($_) -or $entryByName[$_].Length -le 0
    })
    if ($missingRequired.Count -gt 0) {
        Fail "[REQUIRED_FILES] обязательные runtime-файлы отсутствуют/пусты: $($missingRequired -join ', ')"
    }

    foreach ($entryName in $requiredFiles) {
        $relative = $entryName.Substring('extension/'.Length)
        $sourceAsset = Join-Path $extensionRoot $relative
        if (-not (Test-Path -LiteralPath $sourceAsset -PathType Leaf)) {
            Fail "[SOURCE_BINDING] source asset отсутствует: $sourceAsset"
        }
        $packedAssetHash = Get-ZipEntrySha256 $entryByName[$entryName]
        $sourceAssetHash = (Get-FileHash -LiteralPath $sourceAsset -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($packedAssetHash -cne $sourceAssetHash) {
            Fail "[SOURCE_BINDING] VSIX $relative не совпадает с SourceManifestPath worktree"
        }
    }
    $zeroCritical = @($zip.Entries | Where-Object {
        $_.FullName -match '\.(node|dll|exe)$' -and $_.Length -le 0
    })
    if ($zeroCritical.Count -gt 0) {
        Fail "пустые runtime-бинарники: $($zeroCritical.FullName -join ', ')"
    }
    $sourceCritical = @(
        foreach ($relativeRoot in @('bin', 'out')) {
            $criticalRoot = Join-Path $extensionRoot $relativeRoot
            if (-not (Test-Path -LiteralPath $criticalRoot -PathType Container)) { continue }
            Get-ChildItem -LiteralPath $criticalRoot -Recurse -File |
                Where-Object Extension -in '.node', '.dll', '.exe' |
                ForEach-Object {
                    [pscustomobject]@{
                        Relative = [IO.Path]::GetRelativePath($extensionRoot, $_.FullName).Replace('\', '/')
                        FullName = $_.FullName
                    }
                }
        }
    )
    $packedCritical = @($zip.Entries | Where-Object {
        $_.FullName -match '^extension/(bin|out)/.+\.(node|dll|exe)$'
    })
    $inventoryDelta = @(Compare-Object @($sourceCritical.Relative | Sort-Object) @(
        $packedCritical.FullName | ForEach-Object { $_.Substring('extension/'.Length) } | Sort-Object
    ))
    if ($sourceCritical.Count -eq 0 -or $inventoryDelta.Count -gt 0) {
        Fail "[CRITICAL_INVENTORY] runtime-бинарники source/VSIX расходятся: $($inventoryDelta | Out-String)"
    }
    foreach ($sourceFile in $sourceCritical) {
        $entryName = 'extension/' + $sourceFile.Relative
        $entry = $packedCritical | Where-Object FullName -eq $entryName
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $packedHash = Get-ZipEntrySha256 $entry
        if ($sourceHash -cne $packedHash) {
            Fail "[CRITICAL_HASH_MISMATCH] runtime-бинарник не совпадает с source output: $($sourceFile.Relative)"
        }
    }
} finally {
    $zip.Dispose()
}

if (-not $CodeCli) {
    # The server remote-cli on PATH ignores --user-data-dir/--extensions-dir
    # ("not supported for code.cmd") and would launch a window without the
    # isolated profile. Prefer the local VS Code wrapper when present.
    $localCode = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
    if (Test-Path -LiteralPath $localCode) {
        $CodeCli = $localCode
    } else {
        $resolvedCode = Get-Command code.cmd -ErrorAction SilentlyContinue
        if (-not $resolvedCode) { Fail 'code.cmd не найден' }
        $CodeCli = $resolvedCode.Source
    }
}
$codeCliFile = (Resolve-Path -LiteralPath $CodeCli).Path
if (-not (Test-Path -LiteralPath $ScratchParent -PathType Container)) {
    Fail "ScratchParent не существует: $ScratchParent"
}

$runRoot = Join-Path $ScratchParent ('cukii-vsix-smoke-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $runRoot 'user-data'
$extensions = Join-Path $runRoot 'extensions'
$workspace = Join-Path $runRoot 'workspace'
$settings = Join-Path $profile 'User\settings.json'
$probe = Join-Path $extensions 'cukii.release-probe-0.0.0'
$probeReceipt = Join-Path $runRoot 'activation-receipt.json'
$probeNonce = [Guid]::NewGuid().ToString('N')
$port = Get-FreeTcpPort
$succeeded = $false

try {
    foreach ($dir in @($profile, $extensions, $workspace, (Split-Path $settings), $probe)) {
        [void](New-Item -ItemType Directory -Force -Path $dir)
    }
    [IO.File]::WriteAllText((Join-Path $profile '.cukii-release-owned.json'),
        (@{ ownerPid = $PID; runRoot = $runRoot; createdAt = [DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($settings, @'
{
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none"
}
'@, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $probe 'package.json'), @'
{
  "name": "release-probe",
  "publisher": "cukii",
  "version": "0.0.0",
  "engines": { "vscode": "^1.90.0" },
  "main": "./extension.js",
  "activationEvents": ["*"]
}
'@, [Text.UTF8Encoding]::new($false))
    $receiptLiteral = $probeReceipt | ConvertTo-Json -Compress
    $nonceLiteral = $probeNonce | ConvertTo-Json -Compress
    $probeTimeoutMs = $TimeoutSeconds * 1000
    [IO.File]::WriteAllText((Join-Path $probe 'extension.js'), @"
const vscode = require('vscode');
const fs = require('fs');
const receiptPath = $receiptLiteral;
const nonce = $nonceLiteral;
exports.activate = async function activate() {
  const target = vscode.extensions.getExtension('cukii.cukii-vscode');
  try {
    if (!target) throw new Error('Cukii extension is absent');
    await Promise.race([
      target.activate(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('activate timeout after $probeTimeoutMs ms')), $probeTimeoutMs)),
    ]);
    fs.writeFileSync(receiptPath, JSON.stringify({
      nonce, status: 'complete', version: target.packageJSON.version, isActive: target.isActive,
    }));
  } catch (error) {
    fs.writeFileSync(receiptPath, JSON.stringify({ nonce, status: 'error', error: String(error && error.stack || error) }));
  }
};
"@, [Text.UTF8Encoding]::new($false))

    $install = Start-Process -FilePath $codeCliFile -ArgumentList @(
        '--user-data-dir', $profile,
        '--extensions-dir', $extensions,
        '--install-extension', $vsix,
        '--force'
    ) -PassThru -WindowStyle Hidden
    if (-not $install.WaitForExit(60000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $install.Id /T /F *> $null
        Fail 'isolated code --install-extension превысил 60 с'
    }
    if ($install.ExitCode -ne 0) { Fail "isolated code --install-extension завершился $($install.ExitCode)" }

    # Elevated (run-as-Admin) shells make Chromium's sandbox init fail with
    # renderer launch-failed code 18; the throwaway smoke profile does not
    # need a sandbox, so disable it explicitly (2026-09-03 incident).
    $launch = Start-Process -FilePath $codeCliFile -ArgumentList @(
        '--user-data-dir', $profile,
        '--extensions-dir', $extensions,
        "--remote-debugging-port=$port",
        '--no-sandbox',
        '--disable-gpu',
        '--new-window', $workspace
    ) -PassThru -WindowStyle Hidden
    if (-not $launch.WaitForExit(30000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $launch.Id /T /F *> $null
        Fail 'isolated VS Code launch CLI превысил 30 с'
    }
    if ($launch.ExitCode -ne 0) { Fail "isolated VS Code launch завершился $($launch.ExitCode)" }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $activated = $false
    $lastLog = $null
    do {
        $lastLog = Get-ChildItem -LiteralPath (Join-Path $profile 'logs') -Recurse -File -Filter 'exthost.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($lastLog) {
            $logText = Get-Content -LiteralPath $lastLog.FullName -Raw -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $probeReceipt -PathType Leaf) {
            $receipt = Get-Content -LiteralPath $probeReceipt -Raw | ConvertFrom-Json
            if ([string]$receipt.nonce -cne $probeNonce) { Fail '[PROBE_NONCE] activation receipt nonce не совпал' }
            if ([string]$receipt.status -cne 'complete' -or -not [bool]$receipt.isActive) {
                Fail "[ACTIVATION_INCOMPLETE] activate() не завершился успешно: $($receipt.error)"
            }
            if ([string]$receipt.version -cne [string]$packedManifest.version) {
                Fail "[ACTIVATED_VERSION] загружена версия $($receipt.version), ожидалась $($packedManifest.version)"
            }
            $activated = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if (-not $activated) { Fail "[PROBE_TIMEOUT] Cukii activate() не завершился за $TimeoutSeconds с; logs=$profile\logs" }

    # Log flushing after activation is lazy: a swallowed activation failure can
    # reach exthost.log a few seconds after the receipt, so scan in short
    # retries instead of trusting a single snapshot.
    $activationErrors = @()
    for ($scanAttempt = 0; $scanAttempt -lt 6; $scanAttempt++) {
        Start-Sleep -Seconds 2
        $lastLog = Get-ChildItem -LiteralPath (Join-Path $profile 'logs') -Recurse -File -Filter 'exthost.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $logFiles = @(Get-ChildItem -LiteralPath (Join-Path $profile 'logs') -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object Name -match '^(?:exthost|window|renderer|sharedprocess)\.log$')
        $activationErrors = @(foreach ($logFile in $logFiles) {
            $candidateLog = Get-Content -LiteralPath $logFile.FullName -Raw -ErrorAction SilentlyContinue
            if ($candidateLog -match '(?im)^.*(?:Error activating (?:the )?(?:Continue|Cukii) extension|Error activating extension:|Activating extension [''"]cukii\.cukii-vscode[''"] failed|\[(?:error|err)\].*cukii\.cukii-vscode.*(?:failed|error|exception)).*$') {
                $logFile.FullName
            }
        })
        if ($activationErrors.Count -gt 0) { break }
    }
    if (@($activationErrors).Count -gt 0) {
        Fail "[ACTIVATION_ERROR] VS Code записал Cukii activation error: $(@($activationErrors) -join ', ')"
    }
    $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
    if (@($targets | Where-Object type -eq 'page').Count -ne 1) {
        Fail "isolated CDP controller не имеет ровно одной page-цели; port=$port"
    }

    Assert-NoLivePackagers
    $sha = (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "ACTIVATION-SMOKE-PASS version=$($packedManifest.version) vsix_sha256=$sha log=$($lastLog.FullName)"
    $succeeded = $true
} finally {
    try {
        Stop-SmokeCode $profile
        if ($succeeded -and -not $KeepOnSuccess) {
            Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
        } elseif (-not $succeeded) {
            Write-Warning "Smoke evidence сохранён: $runRoot"
        }
    } finally { Close-CukiiReleaseLease $releaseLease }
}

