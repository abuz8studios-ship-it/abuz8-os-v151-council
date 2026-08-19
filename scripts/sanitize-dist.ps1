# Produce a CLEAN, personal-data-free copy of the ABUZ8 OS data dir for distribution.
#
# Why: the portable USB bundle copies the runtime data dir, which holds YOUR chats,
# memory, goals, config (API keys/email), and exports. This script copies ONLY the
# binary asset folders that cannot contain personal data (an ALLOWLIST). Everything
# else — config, soul, sessions, memory, mission, vault, logs, exports, MCP creds,
# profiles, caches — is left out and the app regenerates factory defaults on first run.
#
# Your CLI logins (~/.claude, ~/.grok, ~/.codex, ~/.gemini) live in the home dir, NOT
# here, so they were never in the data dir to begin with.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\sanitize-dist.ps1 -Target "D:\ABUZ8_OS_Data_CLEAN"
#   (optional) -Source "C:\path\to\abuz8-os"   # defaults to %APPDATA%\abuz8-os
param(
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$Source = "$env:APPDATA\abuz8-os"
)
$ErrorActionPreference = 'Stop'

# Only these may ship — pure binary/runtime assets, no user content.
$keep = @('attachments','models','brain','bin','skills')
# These are personal/runtime and must NEVER ship (used to verify the result).
$personal = @('config','soul','sessions','memory','mission','vault','logs','exports',
              'profiles','autonomy','goals','jobs','pairing','checkpoints','codeindex',
              'workspaces','shots','art','ac4','Local Storage','Session Storage','Network',
              'Cache','Code Cache','GPUCache','Preferences','Local State','mcp','blob_storage')

if (-not (Test-Path $Source)) { throw "Source data dir not found: $Source" }
Write-Host "Sanitizing $Source -> $Target (allowlist only)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Target | Out-Null

foreach ($d in $keep) {
  if (Test-Path "$Source\$d") {
    Write-Host "  + keeping $d"
    robocopy "$Source\$d" "$Target\$d" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}

# First-run marker so the recipient knows it starts clean.
$note = @'
This is a CLEAN ABUZ8 OS data folder. It contains only the offline AI brain, voices,
hearing, browser automation, and default skills. No chats, memory, accounts, keys, or
personal config. On first launch the app creates its own fresh config/soul/sessions.
Sign in to your own AI accounts (Claude/Grok/ChatGPT/Gemini CLIs) on this machine to
enable the frontier brains.
'@
Set-Content -Path "$Target\FRESH-INSTALL.txt" -Value $note -Encoding ASCII

# Verify: assert no personal folder leaked into the clean output.
$leaks = @()
foreach ($p in $personal) { if (Test-Path "$Target\$p") { $leaks += $p } }
$kept = (Get-ChildItem -Directory $Target -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '
$size = if (Test-Path $Target) { (Get-ChildItem -Recurse $Target -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB } else { 0 }
Write-Host ""
Write-Host ("Kept: {0}" -f $kept) -ForegroundColor Green
if ($leaks.Count -gt 0) {
  Write-Host ("LEAK CHECK FAILED - personal folders present: {0}" -f ($leaks -join ', ')) -ForegroundColor Red
  exit 1
} else {
  Write-Host "LEAK CHECK PASSED - no personal data in the clean folder." -ForegroundColor Green
}
Write-Host ("Clean data is {0:N1} GB at {1}" -f $size, $Target)
