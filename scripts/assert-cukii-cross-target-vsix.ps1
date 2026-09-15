<#
.SYNOPSIS
  Prove a Cukii VSIX actually carries the native binaries of the platform it claims.

.DESCRIPTION
  A cross-built VSIX fails silently: `vsce package --target darwin-arm64` stamps the
  manifest from the flag alone, so a package whose binaries all came from the Windows
  build host installs happily and then fails at the first `dlopen` on the user's Mac.
  Nothing in the build detects that - the VSIX is well-formed, correctly named, the
  right size, and installs without a warning.

  This script reads the architecture out of every native file in the archive and
  compares it with the declared TargetPlatform, then fails on any binary belonging to
  another platform. It is the only check in the pipeline performed at the level the
  defect lives at: the machine code inside the package.

.PARAMETER VsixPath
  The .vsix to inspect.

.PARAMETER ExpectedTarget
  VS Code target platform, e.g. darwin-arm64. Defaults to the one in the file name.

.PARAMETER ExpectedVersion
  Optional version the manifest must declare.

.OUTPUTS
  CUKII-CROSS-TARGET-VSIX-PASS on success; a non-zero exit and CUKII-CROSS-TARGET-VSIX-FAIL otherwise.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [string]$ExpectedTarget,
    [string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Checks = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$Message) { $script:Failures.Add($Message) | Out-Null }
function Add-Check([string]$Message) { $script:Checks.Add($Message) | Out-Null }

# --- architecture decoding -------------------------------------------------

# Mach-O cpu types, as used in the 64-bit header (little endian).
$MachOCpuTypes = @{ 0x0100000C = 'arm64'; 0x01000007 = 'x64' }
# ELF e_machine values.
$ElfMachines = @{ 0x3E = 'x64'; 0xB7 = 'arm64' }
# PE IMAGE_FILE_MACHINE values.
$PeMachines = @{ 0x8664 = 'x64'; 0xAA64 = 'arm64'; 0x14C = 'ia32' }

function Get-BinaryIdentity([byte[]]$Head, [System.IO.Stream]$Stream) {
    if ($Head.Length -lt 8) { return @{ platform = 'unknown'; arch = 'unknown' } }

    # Mach-O 64-bit, little endian (0xfeedfacf on disk as cf fa ed fe).
    if ($Head[0] -eq 0xCF -and $Head[1] -eq 0xFA -and $Head[2] -eq 0xED -and $Head[3] -eq 0xFE) {
        $cpu = [BitConverter]::ToInt32($Head, 4)
        $arch = if ($MachOCpuTypes.ContainsKey($cpu)) { $MachOCpuTypes[$cpu] } else { "cpu:0x{0:x}" -f $cpu }
        return @{ platform = 'darwin'; arch = $arch }
    }
    # Mach-O universal binary.
    if ($Head[0] -eq 0xCA -and $Head[1] -eq 0xFE -and $Head[2] -eq 0xBA -and $Head[3] -eq 0xBE) {
        return @{ platform = 'darwin'; arch = 'universal' }
    }
    # ELF.
    if ($Head[0] -eq 0x7F -and $Head[1] -eq 0x45 -and $Head[2] -eq 0x4C -and $Head[3] -eq 0x46) {
        if ($Head.Length -lt 20) { return @{ platform = 'linux'; arch = 'unknown' } }
        $machine = [BitConverter]::ToUInt16($Head, 18)
        $arch = if ($ElfMachines.ContainsKey([int]$machine)) { $ElfMachines[[int]$machine] } else { "em:0x{0:x}" -f $machine }
        return @{ platform = 'linux'; arch = $arch }
    }
    # PE/COFF: MZ, then the machine field at the PE header offset stored at 0x3C.
    if ($Head[0] -eq 0x4D -and $Head[1] -eq 0x5A) {
        $arch = 'unknown'
        if ($Head.Length -ge 0x40) {
            $peOffset = [BitConverter]::ToInt32($Head, 0x3C)
            if ($peOffset -gt 0 -and $peOffset + 6 -le $Head.Length) {
                $machine = [BitConverter]::ToUInt16($Head, $peOffset + 4)
                if ($PeMachines.ContainsKey([int]$machine)) { $arch = $PeMachines[[int]$machine] }
            }
        }
        return @{ platform = 'win32'; arch = $arch }
    }
    return @{ platform = 'unknown'; arch = 'unknown' }
}

function Read-EntryHead([System.IO.Compression.ZipArchiveEntry]$Entry, [int]$Count = 1024) {
    $stream = $Entry.Open()
    try {
        $buffer = New-Object byte[] $Count
        $read = 0
        while ($read -lt $Count) {
            $chunk = $stream.Read($buffer, $read, $Count - $read)
            if ($chunk -le 0) { break }
            $read += $chunk
        }
        if ($read -lt $Count) { return $buffer[0..([Math]::Max($read - 1, 0))] }
        return $buffer
    } finally { $stream.Dispose() }
}

# --- inspection ------------------------------------------------------------

if (-not (Test-Path -LiteralPath $VsixPath)) { throw "VSIX not found: $VsixPath" }
$VsixPath = (Resolve-Path -LiteralPath $VsixPath).Path

if (-not $ExpectedTarget) {
    if ((Split-Path -Leaf $VsixPath) -match '(win32|darwin|linux|alpine)-(x64|arm64|ia32|armhf)') {
        $ExpectedTarget = $Matches[0]
    } else {
        throw "Cannot infer target from file name; pass -ExpectedTarget"
    }
}
$expectedPlatform, $expectedArch = $ExpectedTarget.Split('-')

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($VsixPath)
try {
    $entries = $zip.Entries
    Add-Check ("archive entries: {0}" -f $entries.Count)

    # 1. Declared target and version.
    $manifestEntry = $entries | Where-Object { $_.FullName -eq 'extension.vsixmanifest' }
    if (-not $manifestEntry) { Add-Failure 'extension.vsixmanifest missing' }
    else {
        $reader = New-Object System.IO.StreamReader($manifestEntry.Open())
        try { $manifestXml = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($manifestXml -match 'TargetPlatform="([^"]+)"') {
            $declared = $Matches[1]
            if ($declared -ne $ExpectedTarget) { Add-Failure "manifest TargetPlatform=$declared, expected $ExpectedTarget" }
            else { Add-Check "manifest TargetPlatform=$declared" }
        } else { Add-Failure 'manifest declares no TargetPlatform' }
    }

    $pkgEntry = $entries | Where-Object { $_.FullName -eq 'extension/package.json' }
    if (-not $pkgEntry) { Add-Failure 'extension/package.json missing' }
    elseif ($ExpectedVersion) {
        $reader = New-Object System.IO.StreamReader($pkgEntry.Open())
        try { $pkg = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($pkg.version -ne $ExpectedVersion) { Add-Failure "package.json version=$($pkg.version), expected $ExpectedVersion" }
        else { Add-Check "package.json version=$($pkg.version)" }
    }

    # 2. Every native file must belong to the declared platform.
    $nativePattern = '\.(node|dylib|so|so\.[0-9.]+|dll)$'
    $nativeEntries = $entries | Where-Object { $_.FullName -match $nativePattern }
    # Executables carry no extension outside Windows; check them by known name.
    $executableNames = @('rg', 'rg.exe', 'ffmpeg', 'ffmpeg.exe')
    $executableEntries = $entries | Where-Object { $executableNames -contains (Split-Path -Leaf $_.FullName) }
    $executablePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entry in $executableEntries) { $executablePaths.Add($entry.FullName) | Out-Null }

    # `win-ca` disables itself off Windows (`api.disabled = process.platform !== 'win32'`)
    # and never dlopens these bindings there, but esbuild resolves them statically into
    # the bundle, so they cannot be dropped without breaking the Windows build. They are
    # ~0.2 MB of inert bytes; allow them by exact name so any *other* stray still fails.
    $inertWindowsBindings = '^extension/out/crypt32-(ia32|x64)-[A-Z0-9]+\.node$'

    $inspected = 0
    $foreign = 0
    $inert = 0
    foreach ($entry in @($nativeEntries) + @($executableEntries)) {
        if ($entry.Length -le 0) {
            Add-Failure "empty native/runtime executable: $($entry.FullName)"
            $foreign++
            continue
        }
        $identity = Get-BinaryIdentity (Read-EntryHead $entry) $null
        $inspected++
        if ($entry.FullName -match $inertWindowsBindings) { $inert++; continue }
        if ($identity.platform -eq 'unknown') {
            Add-Failure "unrecognized native/runtime executable format in $($entry.FullName)"
            $foreign++
        } elseif ($identity.arch -eq 'universal') {
            # A fat Mach-O needs slice-level parsing before it can prove the target
            # CPU is present. Target-specific packages do not need fat binaries, so
            # fail closed instead of treating an uninspected container as a match.
            Add-Failure "unverified universal binary in target-specific package: $($entry.FullName)"
            $foreign++
        } elseif ($identity.platform -ne $expectedPlatform) {
            Add-Failure ("foreign platform {0} ({1}) in {2}" -f $identity.platform, $identity.arch, $entry.FullName)
            $foreign++
        } elseif ($identity.arch -ne $expectedArch) {
            Add-Failure ("wrong arch {0} in {1}" -f $identity.arch, $entry.FullName)
            $foreign++
        }

        if ($expectedPlatform -ne 'win32' -and $executablePaths.Contains($entry.FullName)) {
            $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xFFFF
            if (($unixMode -band 0x49) -eq 0) {
                Add-Failure ("Unix executable has no execute bits (mode {0}): {1}" -f [Convert]::ToString($unixMode, 8), $entry.FullName)
                $foreign++
            }
        }
    }
    Add-Check ("native binaries inspected: {0}, foreign: {1}, inert win-ca bindings allowed: {2}" -f $inspected, $foreign, $inert)

    # 3. The pieces the extension loads at runtime must be present for this target.
    $exe = if ($expectedPlatform -eq 'win32') { '.exe' } else { '' }
    $sharpArch = switch ($expectedArch) { 'arm64' { 'arm64v8' } default { $expectedArch } }
    $lancedbSuffix = switch ($expectedPlatform) { 'win32' { '-msvc' } 'linux' { '-gnu' } default { '' } }
    $onnxSharedLibrary = switch ($expectedPlatform) {
        'darwin' { "extension/bin/napi-v3/$expectedPlatform/$expectedArch/libonnxruntime.1.14.0.dylib" }
        'linux' { "extension/bin/napi-v3/$expectedPlatform/$expectedArch/libonnxruntime.so.1.14.0" }
        default { "extension/bin/napi-v3/$expectedPlatform/$expectedArch/onnxruntime.dll" }
    }
    $voiceOnnxBase = "extension/out/node_modules/onnxruntime-node/bin/napi-v3/$expectedPlatform/$expectedArch"
    $voiceOnnxSharedLibrary = switch ($expectedPlatform) {
        'darwin' { "$voiceOnnxBase/libonnxruntime.1.14.0.dylib" }
        'linux' { "$voiceOnnxBase/libonnxruntime.so.1.14.0" }
        default { "$voiceOnnxBase/onnxruntime.dll" }
    }
    $sharpVendorPlatform = if ($expectedArch -eq 'arm64') { "$expectedPlatform-arm64v8" } else { "$expectedPlatform-$expectedArch" }
    $sharpVendorLibrary = switch ($expectedPlatform) {
        'darwin' { "extension/out/node_modules/sharp/vendor/8.14.5/$sharpVendorPlatform/lib/libvips-cpp.42.dylib" }
        'linux' { "extension/out/node_modules/sharp/vendor/8.14.5/$sharpVendorPlatform/lib/libvips-cpp.so.42" }
        default { "extension/out/node_modules/sharp/vendor/8.14.5/$sharpVendorPlatform/lib/libvips-42.dll" }
    }
    $required = @(
        "extension/out/node_modules/@vscode/ripgrep/bin/rg$exe",
        "extension/out/node_modules/@lancedb/vectordb-$ExpectedTarget$lancedbSuffix/index.node",
        "extension/out/node_modules/sharp/build/Release/sharp-$expectedPlatform-$sharpArch.node",
        "extension/out/runtime/ffmpeg$exe",
        "extension/out/build/Release/node_sqlite3.node",
        "extension/bin/napi-v3/$expectedPlatform/$expectedArch/onnxruntime_binding.node",
        $onnxSharedLibrary,
        "$voiceOnnxBase/onnxruntime_binding.node",
        $voiceOnnxSharedLibrary,
        $sharpVendorLibrary,
        "extension/out/extension.js",
        "extension/gui/assets/index.js",
        "extension/gui/assets/index.css"
    )
    if ($expectedPlatform -eq 'win32') {
        $required += "$voiceOnnxBase/onnxruntime_providers_shared.dll"
    }
    $entriesByName = @{}
    foreach ($entry in $entries) { $entriesByName[$entry.FullName] = $entry }
    foreach ($path in $required) {
        if (-not $entriesByName.ContainsKey($path)) {
            Add-Failure "required file missing: $path"
        } elseif ($entriesByName[$path].Length -le 0) {
            Add-Failure "required file empty: $path"
        }
    }
    Add-Check ("required runtime files checked: {0}" -f $required.Count)

    # 4. No other platform's directories may survive the prune.
    foreach ($other in @('win32', 'darwin', 'linux') | Where-Object { $_ -ne $expectedPlatform }) {
        $strays = $entries | Where-Object {
            $_.FullName -like "extension/bin/napi-v3/$other/*" -or
            $_.FullName -like "extension/out/node_modules/onnxruntime-node/bin/napi-v3/$other/*"
        }
        if ($strays) { Add-Failure ("{0} onnxruntime binaries still present ({1} entries)" -f $other, @($strays).Count) }
    }
    $strayLance = $entries | Where-Object {
        $_.FullName -like 'extension/out/node_modules/@lancedb/*' -and
        $_.FullName -notlike "extension/out/node_modules/@lancedb/vectordb-$ExpectedTarget$lancedbSuffix/*"
    }
    if ($strayLance) { Add-Failure ("foreign LanceDB entries present: {0}" -f @($strayLance).Count) }

    # 5. Source maps must never ship.
    $maps = $entries | Where-Object { $_.FullName -like '*.js.map' }
    if ($maps) { Add-Failure ("source maps present: {0}" -f @($maps).Count) }
    Add-Check 'source maps: 0'
} finally { $zip.Dispose() }

foreach ($check in $script:Checks) { Write-Output "[ok] $check" }
if ($script:Failures.Count -gt 0) {
    foreach ($failure in $script:Failures) { Write-Output "[fail] $failure" }
    Write-Output "CUKII-CROSS-TARGET-VSIX-FAIL: $ExpectedTarget"
    exit 1
}
Write-Output "CUKII-CROSS-TARGET-VSIX-PASS: $ExpectedTarget"
exit 0
