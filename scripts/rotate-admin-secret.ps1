<#
Coordinated ADMIN_SECRET rotation. The owner runs this in their own PowerShell
window:

  .\scripts\rotate-admin-secret.ps1

What it does:
  1. Generates a new 64-character secret from 48 bytes of the OS cryptographic RNG
     (base64url). It exists only in this process's memory: it is never displayed,
     logged, written to disk, put on a command line, or copied to the clipboard.
     It is piped to Wrangler on stdin.
  2. Sets it on kilcon-site (the Astro 7 site Worker, which signs admin sessions).
  3. Sets it on kilcon-gallery-worker (which verifies them for the admin API).

Each `secret put` creates a new version of that Worker with the same code,
bindings, routes and cron; only ADMIN_SECRET changes. Between steps 2 and 3
(a few seconds) admin API calls fail; nothing else is affected.

Unchanged: ADMIN_USER, ADMIN_PASS, SESSION_VERSION ("3"), and every other secret.
Every admin session ends; sign in again afterwards.

If it stops after step 2: run it again from the start. It generates a fresh
secret and sets both Workers again.

(The Cloudflare Pages project and its pause step were retired on 2026-11-25.)
#>
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:CLOUDFLARE_ACCOUNT_ID = "8481dbc471ac3a4aa14cc26ea366f956"
$npx = "C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64\npx.cmd"
$galleryConfig = "workers/kilcon-gallery-worker/wrangler.toml"
if (-not (Test-Path $galleryConfig)) { throw "Run from the kilConstruction repository." }

function Put-Secret([string]$label, [string[]]$wranglerArgs, [string]$value) {
  Write-Host ""
  Write-Host "== $label" -ForegroundColor Cyan
  $value | & $npx wrangler @wranglerArgs
  if ($LASTEXITCODE -ne 0) { throw "Wrangler failed on $label (exit $LASTEXITCODE). Run the script again." }
  Write-Host "ADMIN_SECRET set on $label." -ForegroundColor Green
}

Write-Host "This rotates ADMIN_SECRET on kilcon-site and kilcon-gallery-worker,"
Write-Host "in account $env:CLOUDFLARE_ACCOUNT_ID. Existing admin sessions will end."
$go = Read-Host "Type ROTATE to begin"
if ($go -ne "ROTATE") { Write-Host "Nothing changed."; exit 1 }

# 1) Generate in memory only.
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
  $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
} finally {
  $rng.Dispose()
  [Array]::Clear($bytes, 0, $bytes.Length)
}
if ($secret.Length -ne 64) { throw "Unexpected secret length. Nothing changed." }
Write-Host "New secret generated in memory (64 characters, not shown)."

try {
  # 2) The site Worker, which issues admin sessions.
  Put-Secret "kilcon-site" @("secret", "put", "ADMIN_SECRET", "--name", "kilcon-site") $secret

  # 3) The Gallery Worker, which verifies them.
  Put-Secret "kilcon-gallery-worker" @("secret", "put", "ADMIN_SECRET", "--config", $galleryConfig) $secret

  Write-Host ""
  Write-Host "Done: the same new ADMIN_SECRET is on both Workers." -ForegroundColor Green
  Write-Host "Sign in again at https://kilcon.work/admin."
} finally {
  Remove-Variable secret -ErrorAction SilentlyContinue
  [GC]::Collect()
}
