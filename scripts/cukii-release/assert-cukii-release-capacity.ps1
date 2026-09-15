#requires -Version 7
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-cukii-release-capacity.ps1')
$lease = New-CukiiReleaseLease
try { Assert-CukiiReleaseCapacity } finally { Close-CukiiReleaseLease $lease }

