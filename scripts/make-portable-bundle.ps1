# Assemble a fully self-contained, USB-copyable ABUZ8 OS portable bundle.
# Includes the app, the bundled llama.cpp brain, the downloaded NVIDIA Nemotron
# model, all attachments (Piper voices, Whisper, Playwright + Chromium), config,
# soul, skills, memory, and a launcher that points the app at the bundled data.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make-portable-bundle.ps1 -Target "E:\ABUZ8-Portable"
#
param(
  [Parameter(Mandatory=$true)][string]$Target,
  # -Clean ships a personal-data-free bundle: only the binary assets (brain, voices,
  # skills) are copied; YOUR config, chats, memory, goals, keys, and exports are left
  # out and regenerate factory-fresh on the recipient's first launch. Use for sharing,
  # selling, or putting it on hardware. Omit to make a personal backup for yourself.
  [switch]$Clean
)
$ErrorActionPreference = 'Stop'
$install = "$env:LOCALAPPDATA\Programs\ABUZ8 OS"
$data    = "$env:APPDATA\abuz8-os"

if (-not (Test-Path $install)) { throw "ABUZ8 OS install not found at $install" }
Write-Host "Building lean portable bundle at $Target ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# 1. The app (Electron + resources). The LFM brains were removed; resources\brain
#    now holds only the small llama.cpp runtime that loads the NVIDIA model.
Write-Host "  - copying app (lean, ~0.45 GB)..."
# robocopy /MIR = clean mirror (overwrites changed, deletes extras) so re-runs into an
# existing target never nest/duplicate (the old Copy-Item -Force bug). Exit 0-7 = success.
robocopy "$install" "$Target\ABUZ8 OS" /MIR /XF "app.asar.bak-*" /NFL /NDL /NJH /NJS /NP | Out-Null
# 1b. GUARANTEE the sovereign brain ships (FR-01). Earlier builds shipped BRAINLESS because the GGUFs
#     are .gitignored out of the source tree and only the install's (empty) resources\brain was mirrored.
#     Copy the canonical, version-MATCHED runtime + GGUFs from build-assets\brain into resources\brain so
#     llama-server.exe and its ggml-cuda backend are the same build (a mismatch crashes Gemma-4 at warmup).
$repo     = Split-Path $PSScriptRoot -Parent
$brainSrc = Join-Path $repo 'build-assets\brain'
$brainDst = "$Target\ABUZ8 OS\resources\brain"
if (Test-Path $brainSrc) {
  Write-Host "  - bundling sovereign brain (Gemma 4 E4B omni + mmproj vision + nomic-embed + CUDA runtime)..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $brainDst | Out-Null
  robocopy "$brainSrc" "$brainDst" /E /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Write-Host "  ! build-assets\brain not found ($brainSrc) — bundle would be brainless" -ForegroundColor Red
}
# Fail-CLOSED gate: refuse to produce a brainless bundle (the exact FR-01 defect).
$ggufs = @(Get-ChildItem $brainDst -Filter *.gguf -ErrorAction SilentlyContinue)
if ($ggufs.Count -lt 1) { throw "Refusing to build a BRAINLESS bundle: no .gguf in $brainDst. Put the Gemma E4B GGUF in build-assets\brain (it is gitignored from source — keep it on disk)." }
Write-Host ("  - brain OK: {0} GGUF(s), {1:N1} GB (sovereign, GPU-accelerated)" -f $ggufs.Count, (($ggufs | Measure-Object Length -Sum).Sum/1GB)) -ForegroundColor Green

# 1c. GUARANTEE the offline VOICE engines ship (Piper neural TTS + voices + Whisper STT + model) so the OS can
#     TALK and HEAR out of the box. Without these resources\voice the app falls back to robotic SAPI. The app
#     seeds them into ABUZ8_OS_Data\attachments on first launch (seedBundledVoiceOnce). Same fail-closed gate.
$voiceSrc = Join-Path $repo 'build-assets\voice'
$voiceDst = "$Target\ABUZ8 OS\resources\voice"
if (Test-Path $voiceSrc) {
  Write-Host "  - bundling voice (Piper neural TTS + voices + Whisper STT + model)..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $voiceDst | Out-Null
  robocopy "$voiceSrc" "$voiceDst" /E /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Write-Host "  ! build-assets\voice not found ($voiceSrc) — bundle would be MUTE (SAPI fallback)" -ForegroundColor Red
}
# Fail-CLOSED gate: refuse to produce a MUTE bundle (no neural voice in/out).
if (-not (Test-Path (Join-Path $voiceDst 'piper\piper.exe')) -or -not (Test-Path (Join-Path $voiceDst 'whisper\whisper-cli.exe'))) {
  throw "Refusing to build a MUTE bundle: piper.exe or whisper-cli.exe missing in $voiceDst. Keep build-assets\voice populated (gitignored from source)."
}
$pvoices = @(Get-ChildItem (Join-Path $voiceDst 'piper\voices') -Filter *.onnx -ErrorAction SilentlyContinue)
$wmodels = @(Get-ChildItem (Join-Path $voiceDst 'whisper\models') -Filter *.bin -ErrorAction SilentlyContinue)
if ($pvoices.Count -lt 1 -or $wmodels.Count -lt 1) { throw "Refusing to build a MUTE bundle: no Piper voice (.onnx) or Whisper model (.bin) in $voiceDst." }
Write-Host ("  - voice OK: Piper + {0} voice(s), Whisper + {1} model(s) (neural TTS+STT, offline)" -f $pvoices.Count, $wmodels.Count) -ForegroundColor Green

# 2. The data the app reads at runtime (NVIDIA model, voices, config...). Cache and
#    logs are intentionally NOT copied.
$dataDest = "$Target\ABUZ8_OS_Data"
New-Item -ItemType Directory -Force -Path $dataDest | Out-Null
if ($Clean) {
  # ALLOWLIST only — no personal content. Mirrors scripts\sanitize-dist.ps1.
  Write-Host "  - copying data (CLEAN: brain, voices, skills - no personal content)..." -ForegroundColor Yellow
  foreach ($d in 'attachments','models','brain','bin','skills') {
    if (Test-Path "$data\$d") { robocopy "$data\$d" "$dataDest\$d" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
  }
  $cleanNote = "CLEAN bundle: no chats, memory, accounts, keys, or personal config. The app makes its own fresh config on first launch."
  Set-Content -Path "$dataDest\FRESH-INSTALL.txt" -Value $cleanNote -Encoding ASCII
} else {
  Write-Host "  - copying data (PERSONAL backup: includes your config/chats/memory)..."
  foreach ($d in 'config','soul','skills','mcp','memory','mission','attachments','models','exports') {
    if (Test-Path "$data\$d") { robocopy "$data\$d" "$dataDest\$d" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
  }
}

# 3. Launcher: point the app at the bundled data, then start it. Playwright uses
#    the target machine's Edge/Chrome, so no Chromium is bundled.
$bat = @'
@echo off
set "HERE=%~dp0"
set "ABUZ8_DATA_DIR=%HERE%ABUZ8_OS_Data"
start "" "%HERE%ABUZ8 OS\ABUZ8 OS.exe"
'@
Set-Content -Path "$Target\Launch-ABUZ8.bat" -Value $bat -Encoding ASCII

# 5. Readme
$readme = @'
ABUZ8 OS - Portable Bundle
==========================
Self-contained. Copy this whole folder to a USB drive or the target machine,
then double-click Launch-ABUZ8.bat.

Build (~9 GB) - ships the sovereign Gemma 4 E4B omni brain (text+vision+audio), GPU-accelerated.

Included and working offline anywhere:
  - The app + llama.cpp CUDA runtime (resources\brain)
  - Gemma 4 E4B omni brain + mmproj vision + nomic-embed RAG (resources\brain, GPU-accelerated)
  - Neural voice (Piper) + voices, offline hearing (Whisper)  -> ABUZ8_OS_Data\attachments
  - Playwright browser automation (drives the machine's Edge/Chrome - no Chromium bundled)
  - Your config, soul/personality/mission, skills, memory, mission board

Requires on the target machine:
  - Windows 10/11 x64 (Edge is built in, used by Playwright).
  - PyAutoGUI desktop control needs Python 3 + "pip install pyautogui pillow"
    on the target (everything else is bundled and standalone).

The launcher sets ABUZ8_DATA_DIR so the app uses the bundled data regardless of
the machine it runs on.
'@
Set-Content -Path "$Target\README.txt" -Value $readme -Encoding ASCII

$size = (Get-ChildItem -Recurse $Target | Measure-Object -Property Length -Sum).Sum / 1GB
Write-Host ("Done. Bundle is {0:N1} GB at {1}" -f $size, $Target) -ForegroundColor Green
Write-Host "Run it anywhere with: $Target\Launch-ABUZ8.bat"
