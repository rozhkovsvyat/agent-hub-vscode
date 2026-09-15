#requires -Version 7

function New-CukiiReleaseLease([switch]$AllowMatrixParent) {
    if ($AllowMatrixParent) {
        $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($parent -and [string]$parent.CommandLine -match '(?i)test-cukii-release-gate\.ps1') {
            return $null
        }
    }
    $mutex = [Threading.Mutex]::new($false, 'Global\CukiiReleaseAcceptance')
    try {
        if (-not $mutex.WaitOne(0)) {
            throw 'CUKII-RELEASE-CAPACITY-REJECTED: [LEASE_BUSY] другой smoke/release-matrix уже держит глобальную lease'
        }
        return $mutex
    } catch {
        $mutex.Dispose()
        throw
    }
}

function Close-CukiiReleaseLease($Lease) {
    if (-not $Lease) { return }
    try { $Lease.ReleaseMutex() } finally { $Lease.Dispose() }
}

function Get-CukiiOwnedProfile([string]$CommandLine) {
    if (-not $CommandLine) { return $null }
    $match = [regex]::Match($CommandLine, '(?i)--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) { return $null }
    $path = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    try { $path = [IO.Path]::GetFullPath($path) } catch { return $null }
    if (Test-Path -LiteralPath (Join-Path $path '.cukii-release-owned.json') -PathType Leaf) { return $path }
    if ($path -match '(?i)^D:\\Scratch\\(?:cukii-vsix-smoke-|test-cukii-release-gate-|audit-instance)') { return $path }
    return $null
}

function Assert-CukiiReleaseCapacity {
    [CmdletBinding()]
    param(
        [ValidateRange(1024, 65536)][int]$MinFreeMemoryMB = 6144,
        [Nullable[int]]$ObservedFreeMemoryMB,
        [object[]]$ProcessInventory
    )
    if ($null -ne $ObservedFreeMemoryMB) {
        $freeMemoryMB = [int]$ObservedFreeMemoryMB
    } else {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $freeMemoryMB = [math]::Floor([double]$os.FreePhysicalMemory / 1024)
    }
    if ($null -eq $ProcessInventory) {
        $ProcessInventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    }
    if ($freeMemoryMB -lt $MinFreeMemoryMB) {
        throw "CUKII-RELEASE-CAPACITY-REJECTED: [LOW_MEMORY] свободно ${freeMemoryMB} MiB, требуется минимум ${MinFreeMemoryMB} MiB"
    }
    $owned = @($ProcessInventory | ForEach-Object {
        $profile = Get-CukiiOwnedProfile ([string]$_.CommandLine)
        if ($profile) { [pscustomobject]@{ ProcessId = $_.ProcessId; Profile = $profile } }
    })
    if ($owned.Count -gt 0) {
        throw "CUKII-RELEASE-CAPACITY-REJECTED: [LIVE_TEST_VSCODE] уже живёт owned test process: PID $($owned.ProcessId -join ', ')"
    }
    $remoteHosts = @($ProcessInventory | Where-Object {
        $_.Name -match '^(?:node|node\.exe)$' -and
        [string]$_.CommandLine -match '(?i)\.vscode-server.*bootstrap-fork\s+--type=(?:extensionHost|agentHost)'
    })
    if ($remoteHosts.Count -gt 0) {
        throw "CUKII-RELEASE-CAPACITY-REJECTED: [REMOTE_SSH_OPEN] Remote-SSH host открыт: PID $($remoteHosts.ProcessId -join ', '); закрой Remote-SSH окно перед тяжёлой локальной приёмкой"
    }
    "CUKII-RELEASE-CAPACITY-PASS free=${freeMemoryMB}MiB"
}

