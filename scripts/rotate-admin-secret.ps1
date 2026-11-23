<#
Coordinated ADMIN_SECRET rotation (owner-approved 2026-11-23). The owner runs this
in their own PowerShell window; Claude redeploys Pages and verifies in between.

  .\scripts\rotate-admin-secret.ps1

What it does:
  1. Generates a new 64-character secret from 48 bytes of the OS cryptographic RNG
     (base64url). It exists only in this process's memory: it is never displayed,
     logged, written to disk, put on a command line, or copied to the clipboard.
     It is piped to Wrangler on stdin.
  2. Sets it on kilcon-site (Astro 7 Worker, no production route).
  3. Sets it on the Pages project kilconstruction (production). This takes effect
     only on the next Pages deployment, so nothing changes yet.
  4. PAUSES. Claude rebuilds the exact Astro 5 hotfix commit on Pages and verifies it.
     Only type CONTINUE after Claude confirms.
  5. Sets it on kilcon-gallery-worker (a new version with the same code, bindings,
     routes and cron; only ADMIN_SECRET changes).

Unchanged: ADMIN_USER, ADMIN_PASS, SESSION_VERSION ("3"), and every other secret.
Every admin session ends; sign in again afterwards.

If you stop before step 5: nothing is lost. Run the script again from the start;
it generates a fresh secret and sets all three targets again.
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
  if ($LASTEXITCODE -ne 0) { throw "Wrangler failed on $label (exit $LASTEXITCODE). Stop and tell Claude." }
  Write-Host "ADMIN_SECRET set on $label." -ForegroundColor Green
}

Write-Host "This rotates ADMIN_SECRET on kilcon-site, Pages (kilconstruction) and kilcon-gallery-worker,"
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
  # 2) kilcon-site first: it has no production route.
  Put-Secret "kilcon-site" @("secret", "put", "ADMIN_SECRET", "--name", "kilcon-site") $secret

  # 3) Pages production (applies on the next deployment).
  Put-Secret "Pages kilconstruction (production)" @("pages", "secret", "put", "ADMIN_SECRET", "--project-name", "kilconstruction") $secret

  # 4) Pause for Claude's exact Astro 5 redeploy.
  Write-Host ""
  Write-Host "PAUSED. Tell Claude: 'pages secret set'." -ForegroundColor Yellow
  Write-Host "Claude will rebuild the Astro 5 hotfix commit on Pages and confirm it is live."
  Write-Host "Keep this window open: the new secret exists only in this window's memory."
  do {
    $answer = Read-Host "After Claude confirms, type CONTINUE (or ABORT)"
  } until ($answer -eq "CONTINUE" -or $answer -eq "ABORT")
  if ($answer -eq "ABORT") {
    Write-Host "Stopped before the Gallery Worker. Tell Claude 'rotation aborted'." -ForegroundColor Yellow
    exit 2
  }

  # 5) Gallery Worker last.
  Put-Secret "kilcon-gallery-worker" @("secret", "put", "ADMIN_SECRET", "--config", $galleryConfig) $secret

  Write-Host ""
  Write-Host "Done: the same new ADMIN_SECRET is on all three. Tell Claude 'rotation done'." -ForegroundColor Green
  Write-Host "Then sign in again at https://kilcon.work/admin."
} finally {
  Remove-Variable secret -ErrorAction SilentlyContinue
  [GC]::Collect()
}
