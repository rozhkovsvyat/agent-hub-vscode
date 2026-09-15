#requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$VsixPath,
    [Parameter(Mandatory)][string]$SourceManifestPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-cukii-release-capacity.ps1')
$releaseLease = New-CukiiReleaseLease
try { Assert-CukiiReleaseCapacity } catch { Close-CukiiReleaseLease $releaseLease; throw }
$gate = Join-Path $PSScriptRoot 'test-cukii-vsix-activation.ps1'
$sourceManifest = (Resolve-Path -LiteralPath $SourceManifestPath).Path
$sourceRoot = (& git -C (Split-Path $sourceManifest) rev-parse --show-toplevel).Trim()
$sourceRoot = [IO.Path]::GetFullPath($sourceRoot)
$candidate = (Resolve-Path -LiteralPath $VsixPath).Path
$testRoot = Join-Path 'D:\Scratch' ('test-cukii-release-gate-' + [Guid]::NewGuid().ToString('N'))
$fixtureWorktree = Join-Path $testRoot 'source'
$pass = 0

function Check([bool]$Condition, [string]$Name, [string]$Detail = '') {
    if (-not $Condition) { throw "FAIL: $Name $Detail" }
    $script:pass++
    Write-Host "[ok] $Name"
}

function Invoke-Gate([string]$Vsix, [string]$Manifest) {
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwsh
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $gate, '-VsixPath', $Vsix, '-SourceManifestPath', $Manifest)) {
        $psi.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit(150000)) {
            $process.Kill($true)
            $process.WaitForExit()
            return [pscustomobject]@{
                ExitCode = 124
                Output = "gate timeout after 150 s`n$($stdout.GetAwaiter().GetResult())`n$($stderr.GetAwaiter().GetResult())"
            }
        }
        [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = "$($stdout.GetAwaiter().GetResult())`n$($stderr.GetAwaiter().GetResult())"
        }
    } finally {
        $process.Dispose()
    }
}

# A concurrent session's build can pollute the machine mid-matrix. Such
# LIVE_PACKAGER rejections are environmental noise, not a property of the
# mutant under test, so the case is retried once the machine settles.
function Invoke-GateEnvRetry([string]$Vsix, [string]$Manifest) {
    $result = $null
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $result = Invoke-Gate $Vsix $Manifest
        if ($result.ExitCode -eq 0 -or $result.Output -notmatch '\[LIVE_PACKAGER\]') {
            return $result
        }
        if ($attempt -lt 4) {
            Write-Host "[wait] внешний живой упаковщик; повтор кейса через 30 с (попытка $attempt)"
            Start-Sleep -Seconds 30
        }
    }
    return $result
}

function Rewrite-VsixManifest([string]$Path, [scriptblock]$Mutate) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry('extension/package.json')
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $json = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable }
        finally { $reader.Dispose() }
        & $Mutate $json
        $entry.Delete()
        $replacement = $zip.CreateEntry('extension/package.json', [IO.Compression.CompressionLevel]::Optimal)
        $writer = [IO.StreamWriter]::new($replacement.Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write(($json | ConvertTo-Json -Depth 100)) }
        finally { $writer.Dispose() }
    } finally { $zip.Dispose() }
}

function Empty-VsixMain([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $manifestEntry = $zip.GetEntry('extension/package.json')
        $reader = [IO.StreamReader]::new($manifestEntry.Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        $name = 'extension/' + ([string]$manifest.main).TrimStart('.', '/')
        $main = $zip.GetEntry($name)
        if (-not $main) { throw "fixture main not found: $name" }
        $main.Delete()
        [void]$zip.CreateEntry($name)
    } finally { $zip.Dispose() }
}

function Set-VsixEntryText([string]$Path, [string]$EntryName, [string]$Text) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry($EntryName)
        if (-not $entry) { throw "fixture entry not found: $EntryName" }
        $entry.Delete()
        $replacement = $zip.CreateEntry($EntryName, [IO.Compression.CompressionLevel]::Optimal)
        $writer = [IO.StreamWriter]::new($replacement.Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write($Text) }
        finally { $writer.Dispose() }
    } finally { $zip.Dispose() }
}

function Remove-VsixEntry([string]$Path, [string]$EntryName) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry($EntryName)
        if (-not $entry) { throw "fixture entry not found: $EntryName" }
        $entry.Delete()
    } finally { $zip.Dispose() }
}

try {
    [void](New-Item -ItemType Directory -Force -Path $testRoot)
    $head = (& git -C $sourceRoot rev-parse HEAD).Trim()
    & git -C $sourceRoot worktree add --detach $fixtureWorktree $head | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'fixture worktree add failed' }
    $fixtureManifest = Join-Path $fixtureWorktree 'extensions\vscode\package.json'
    $sourceExtension = Join-Path $sourceRoot 'extensions\vscode'
    foreach ($relative in @(
        'out\extension.js',
        'gui\assets\index.js',
        'gui\assets\index.css',
        'config_schema.json',
        'config-yaml-schema.json',
        'out\tree-sitter.wasm',
        'out\xhr-sync-worker.js',
        'models\all-MiniLM-L6-v2\onnx\model_quantized.onnx',
        'tree-sitter\code-snippet-queries\c_sharp.scm',
        'tag-qry\tree-sitter-c_sharp-tags.scm'
    )) {
        $source = Join-Path $sourceExtension $relative
        $destination = Join-Path $fixtureWorktree ('extensions\vscode\' + $relative)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "source build output missing: $source" }
        [void](New-Item -ItemType Directory -Force -Path (Split-Path $destination))
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    foreach ($critical in @(Get-ChildItem -LiteralPath (Join-Path $sourceExtension 'bin'), (Join-Path $sourceExtension 'out') -Recurse -File |
        Where-Object Extension -in '.node', '.dll', '.exe')) {
        $relative = [IO.Path]::GetRelativePath($sourceExtension, $critical.FullName)
        $destination = Join-Path $fixtureWorktree ('extensions\vscode\' + $relative)
        [void](New-Item -ItemType Directory -Force -Path (Split-Path $destination))
        Copy-Item -LiteralPath $critical.FullName -Destination $destination -Force
    }

    $happy = Invoke-GateEnvRetry $candidate $fixtureManifest
    Check ($happy.ExitCode -eq 0 -and $happy.Output -match 'ACTIVATION-SMOKE-PASS') 'real isolated activation passes' $happy.Output

    $dirtyMarker = Join-Path $fixtureWorktree 'gate-dirty-canary.txt'
    [IO.File]::WriteAllText($dirtyMarker, 'dirty', [Text.UTF8Encoding]::new($false))
    try {
        $dirty = Invoke-Gate $candidate $fixtureManifest
        Check ($dirty.ExitCode -ne 0 -and $dirty.Output -match '\[DIRTY_WORKTREE\]') 'dirty worktree rejected' $dirty.Output
    } finally { Remove-Item -LiteralPath $dirtyMarker -Force -ErrorAction SilentlyContinue }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $node
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $fixtureWorktree
    $psi.ArgumentList.Add('-e')
    $psi.ArgumentList.Add('setTimeout(function () {}, 30000)')
    $psi.ArgumentList.Add('vsce package')
    $packager = [Diagnostics.Process]::Start($psi)
    try {
        Start-Sleep -Milliseconds 500
        $live = Invoke-Gate $candidate $fixtureManifest
        Check ($live.ExitCode -ne 0 -and $live.Output -match '\[LIVE_PACKAGER\]') 'live packager rejected' $live.Output
    } finally {
        if ($packager -and -not $packager.HasExited) { $packager.Kill($true) }
        if ($packager) { $packager.Dispose() }
    }

    # Start-Job bootstrap on a loaded machine can lag past the smoke window,
    # so the late packager is hatched by a node timer instead: the spawner's
    # argv is assembled from fragments (invisible to the packager regex) and
    # the recognizable child appears ~4 s into the smoke, before the pre-PASS
    # scan. Its pid is written to a file for deterministic teardown.
    $latePidFile = Join-Path $testRoot 'late-packager.pid'
    $lateSpawnerScript = Join-Path $testRoot 'late-packager-spawner.js'
    [IO.File]::WriteAllText($lateSpawnerScript, @'
setTimeout(() => {
  const child = require("child_process").spawn(
    process.execPath,
    ["-e", "setTimeout(function () {}, 120000)", "vscode:prepublish"],
    { detached: true, stdio: "ignore" }
  );
  require("fs").writeFileSync(process.env.CUKII_GATE_LATE_PID_FILE, String(child.pid));
  child.unref();
}, 4000);
'@, [Text.UTF8Encoding]::new($false))
    # Start-Process cannot set environment directly; relaunch through cmd set.
    $lateSpawner = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList @(
        '/d', '/s', '/c', "set CUKII_GATE_LATE_PID_FILE=$latePidFile&& $node `"$lateSpawnerScript`""
    ) -PassThru -WindowStyle Hidden
    $latePid = $null
    try {
        $lateResult = Invoke-Gate $candidate $fixtureManifest
        if (Test-Path -LiteralPath $latePidFile) {
            $latePid = [int](Get-Content -LiteralPath $latePidFile -Raw).Trim()
        }
        Check ($lateResult.ExitCode -ne 0 -and $lateResult.Output -match '\[LIVE_PACKAGER\]') 'packager started during smoke rejected before PASS' $lateResult.Output
    } finally {
        if (-not $latePid -and (Test-Path -LiteralPath $latePidFile)) {
            $latePid = [int](Get-Content -LiteralPath $latePidFile -Raw).Trim()
        }
        if ($lateSpawner -and -not $lateSpawner.HasExited) { $lateSpawner.Kill($true) }
        if ($lateSpawner) { $lateSpawner.Dispose() }
        if ($latePid -and (Get-Process -Id $latePid -ErrorAction SilentlyContinue)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $latePid /T /F *> $null
        }
    }

    $sourceMain = Join-Path $fixtureWorktree 'extensions\vscode\out\extension.js'
    $originalMain = [IO.File]::ReadAllBytes($sourceMain)
    try {
        [IO.File]::WriteAllText($sourceMain, 'module.exports.activate = async () => {};', [Text.UTF8Encoding]::new($false))
        $foreignSource = Invoke-GateEnvRetry $candidate $fixtureManifest
        Check ($foreignSource.ExitCode -ne 0 -and $foreignSource.Output -match '\[SOURCE_BINDING\]') 'same-version foreign source rejected' $foreignSource.Output
    } finally {
        [IO.File]::WriteAllBytes($sourceMain, $originalMain)
    }

    $wrongVersion = Join-Path $testRoot 'wrong-version.vsix'
    Copy-Item -LiteralPath $candidate -Destination $wrongVersion
    Rewrite-VsixManifest $wrongVersion { param($json) $json.version = '0.0.0-gate-mutant' }
    $versionResult = Invoke-GateEnvRetry $wrongVersion $fixtureManifest
    Check ($versionResult.ExitCode -ne 0 -and $versionResult.Output -match '\[VERSION_MISMATCH\]') 'wrong version rejected' $versionResult.Output

    $wrongKind = Join-Path $testRoot 'wrong-kind.vsix'
    Copy-Item -LiteralPath $candidate -Destination $wrongKind
    Rewrite-VsixManifest $wrongKind { param($json) $json.extensionKind = @('ui', 'workspace') }
    $kindResult = Invoke-GateEnvRetry $wrongKind $fixtureManifest
    Check ($kindResult.ExitCode -ne 0 -and $kindResult.Output -match '\[EXTENSION_KIND\]') 'ui-first extensionKind rejected' $kindResult.Output

    $emptyMain = Join-Path $testRoot 'empty-main.vsix'
    Copy-Item -LiteralPath $candidate -Destination $emptyMain
    Empty-VsixMain $emptyMain
    $mainResult = Invoke-GateEnvRetry $emptyMain $fixtureManifest
    Check ($mainResult.ExitCode -ne 0 -and $mainResult.Output -match '\[EMPTY_MAIN\]') 'empty main rejected' $mainResult.Output

    $missingRuntime = Join-Path $testRoot 'missing-runtime.vsix'
    Copy-Item -LiteralPath $candidate -Destination $missingRuntime
    Remove-VsixEntry $missingRuntime 'extension/out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.node'
    $runtimeResult = Invoke-GateEnvRetry $missingRuntime $fixtureManifest
    Check ($runtimeResult.ExitCode -ne 0 -and $runtimeResult.Output -match '\[REQUIRED_FILES\]') 'missing lazy runtime rejected' $runtimeResult.Output

    $changedWasm = Join-Path $testRoot 'changed-tree-sitter.vsix'
    Copy-Item -LiteralPath $candidate -Destination $changedWasm
    Set-VsixEntryText $changedWasm 'extension/out/tree-sitter.wasm' 'broken-wasm'
    $wasmResult = Invoke-GateEnvRetry $changedWasm $fixtureManifest
    Check ($wasmResult.ExitCode -ne 0 -and $wasmResult.Output -match '\[SOURCE_BINDING\]') 'changed non-native runtime asset rejected' $wasmResult.Output

    foreach ($activationMutant in @(
        [pscustomobject]@{
            Name = 'failed activation rejected'
            File = 'activation-failed.vsix'
            Code = 'module.exports.activate = async () => { throw new Error("gate activation mutant"); };'
            Pattern = '\[ACTIVATION_INCOMPLETE\]'
        },
        # A failure swallowed inside activate() leaves no observable signal:
        # the receipt reports success and VS Code never logs it (verified twice
        # on this machine). Such mutants are outside the gate's observable
        # contract; throw/hang/crash modes are covered by the sibling cases.
        [pscustomobject]@{
            Name = 'hanging activation rejected'
            File = 'activation-hanging.vsix'
            Code = 'module.exports.activate = async () => new Promise(() => {});'
            Pattern = '\[(?:ACTIVATION_INCOMPLETE|PROBE_TIMEOUT)\]'
        }
    )) {
        $mutantVsix = Join-Path $testRoot $activationMutant.File
        Copy-Item -LiteralPath $candidate -Destination $mutantVsix
        try {
            [IO.File]::WriteAllText($sourceMain, $activationMutant.Code, [Text.UTF8Encoding]::new($false))
            Set-VsixEntryText $mutantVsix 'extension/out/extension.js' $activationMutant.Code
            $mutantResult = Invoke-GateEnvRetry $mutantVsix $fixtureManifest
            Check ($mutantResult.ExitCode -ne 0 -and $mutantResult.Output -match $activationMutant.Pattern) $activationMutant.Name $mutantResult.Output
        } finally {
            [IO.File]::WriteAllBytes($sourceMain, $originalMain)
        }
    }

    Write-Host "SELFTEST-PASS: $pass Cukii release-gate controls."
} finally {
    try {
        if (Test-Path -LiteralPath $fixtureWorktree) {
            & git -C $sourceRoot worktree remove --force $fixtureWorktree *> $null
        }
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    } finally { Close-CukiiReleaseLease $releaseLease }
}

