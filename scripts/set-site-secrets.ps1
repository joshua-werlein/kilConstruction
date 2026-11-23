<#
Sets ADMIN_USER, ADMIN_PASS and ADMIN_SECRET on the kilcon-site Worker ONLY,
from hidden prompts. The owner runs this in their own PowerShell window.

  .\scripts\set-site-secrets.ps1                    # all three
  .\scripts\set-site-secrets.ps1 -Only ADMIN_SECRET  # just one

- Values are the EXISTING production values (unchanged on Pages and the Gallery
  Worker; ADMIN_SECRET must match both, and SESSION_VERSION stays "3").
- Each value is typed twice (hidden), never echoed, logged, or put on a command
  line: it is piped to Wrangler on stdin.
- It targets `--name kilcon-site` only. It never touches Pages, the Gallery
  Worker or the Contact Worker.
#>
param(
  [ValidateSet("ADMIN_USER", "ADMIN_PASS", "ADMIN_SECRET")][string]$Only
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:CLOUDFLARE_ACCOUNT_ID = "8481dbc471ac3a4aa14cc26ea366f956"
$npx = "C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64\npx.cmd"

function Read-Twice([string]$name) {
  $a = Read-Host "$name (hidden)" -AsSecureString
  $b = Read-Host "Repeat $name (hidden)" -AsSecureString
  $pa = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($a)
  $pb = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($b)
  try {
    $va = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pa)
    $vb = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pb)
    if ($va -ne $vb) { throw "$name entries differ. Nothing was set for $name." }
    if ([string]::IsNullOrEmpty($va)) { throw "$name is empty. Nothing was set for $name." }
    return $va
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pa)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pb)
  }
}

$names = if ($Only) { @($Only) } else { @("ADMIN_USER", "ADMIN_PASS", "ADMIN_SECRET") }
foreach ($name in $names) {
  $value = Read-Twice $name
  try {
    $value | & $npx wrangler secret put $name --name kilcon-site
    if ($LASTEXITCODE -ne 0) { throw "Wrangler failed for $name (exit $LASTEXITCODE)." }
    Write-Host "$name set on kilcon-site."
  } finally {
    Remove-Variable value -ErrorAction SilentlyContinue
  }
}
Write-Host "Done. Tell Claude 'site secrets set' (never the values)."
