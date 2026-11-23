<#
Sets ADMIN_SECRET on ONE target from a hidden prompt (docs/admin-secret-rotation.md).
The owner runs this; the value is never echoed, logged, or put on a command line
(it is piped to Wrangler on stdin). Run it once per target, in the approved order,
pasting the same value each time (keep it in your password manager).

  .\scripts\set-admin-secret.ps1 -Target site      # kilcon-site Worker (unrouted staging)
  .\scripts\set-admin-secret.ps1 -Target pages     # Pages project (applies on its next deployment)
  .\scripts\set-admin-secret.ps1 -Target gallery   # Gallery Worker (takes effect immediately)

SESSION_VERSION is not changed: the new secret alone invalidates old sessions.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("site", "pages", "gallery")][string]$Target
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:CLOUDFLARE_ACCOUNT_ID = "8481dbc471ac3a4aa14cc26ea366f956"
$npx = "C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64\npx.cmd"

switch ($Target) {
  "site"    { $wranglerArgs = @("secret", "put", "ADMIN_SECRET", "--name", "kilcon-site") }
  "pages"   { $wranglerArgs = @("pages", "secret", "put", "ADMIN_SECRET", "--project-name", "kilconstruction") }
  "gallery" { $wranglerArgs = @("secret", "put", "ADMIN_SECRET", "--config", "workers/kilcon-gallery-worker/wrangler.toml") }
}

$s1 = Read-Host "New ADMIN_SECRET (hidden, at least 32 characters)" -AsSecureString
$s2 = Read-Host "Repeat it (hidden)" -AsSecureString
$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)
try {
  $v1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
  $v2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
  if ($v1 -ne $v2) { throw "The two entries differ. Nothing was changed." }
  if ($v1.Length -lt 32) { throw "Use at least 32 characters. Nothing was changed." }
  if ($v1 -match '\s') { throw "No spaces or line breaks. Nothing was changed." }
  $v1 | & $npx wrangler @wranglerArgs
  if ($LASTEXITCODE -ne 0) { throw "Wrangler failed (exit $LASTEXITCODE)." }
  Write-Host "ADMIN_SECRET set on target '$Target'. Tell Claude 'done: $Target' (never the value)."
} finally {
  if ($b1 -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1) }
  if ($b2 -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2) }
  Remove-Variable v1, v2, s1, s2 -ErrorAction SilentlyContinue
}
