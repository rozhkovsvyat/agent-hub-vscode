param(
  [Parameter(Mandatory = $true)]
  [string]$CodeCli,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodeArgs
)

& $CodeCli @CodeArgs
exit $LASTEXITCODE
