# Build the ABUZ8 OS Windows release from HEAD via electron-builder, then package a DISTRIBUTABLE.
#
# WHY NOT a one-click NSIS by default: the sovereign Gemma brain (~5 GB) pushes the app payload past
# ~4 GB, and electron-builder's bundled 32-bit makensis cannot mmap a >4 GB embedded archive
# ("File: failed creating mmap"). So the brain-bundled artifact is a PORTABLE bundle + a single-file 7z
# (no size limit), per project doctrine. Use -Lean to instead ship a small LFM-350M brain in a real
# one-click NSIS (<4 GB) and let the big brain be a first-run add-on.
#
# Sign by EITHER (never commit the cert):
#   $env:CSC_LINK = 'C:\path\code-sign.pfx'; $env:CSC_KEY_PASSWORD = '***'
#   - or - drop build\code-sign.pfx + $env:ABUZ8_CSC_PASSWORD = '***'
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1            # fat portable (brain bundled) + 7z
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Lean      # one-click NSIS, small brain
param([switch]$Lean, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src  = Join-Path $root 'src'
$dist = Join-Path $root 'dist'
$ver  = (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version

# Fail-closed: a release must not ship brainless (FR-01) or mute (neural voice).
$brainGgufs = @(Get-ChildItem (Join-Path $root 'build-assets\brain') -Filter *.gguf -ErrorAction SilentlyContinue)
if ($brainGgufs.Count -lt 1) { throw "Refusing to build: no GGUF in build-assets\brain (would ship brainless)." }
if (-not (Test-Path (Join-Path $root 'build-assets\voice\piper\piper.exe')) -or -not (Test-Path (Join-Path $root 'build-assets\voice\whisper\whisper-cli.exe'))) {
  throw "Refusing to build: build-assets\voice missing piper.exe / whisper-cli.exe (would ship MUTE)."
}

# ── Code-signing discovery. Preferred: Azure Trusted Signing (~$10/mo, Microsoft-managed, real public
#    trust). Fallback: a local .pfx. Else: clean UNSIGNED (never grabs a random machine cert). ──
$signArgs = @()
$azureReady = $env:AZURE_TENANT_ID -and $env:AZURE_CLIENT_ID -and $env:AZURE_CLIENT_SECRET -and `
              $env:ABUZ8_SIGN_ENDPOINT -and $env:ABUZ8_SIGN_ACCOUNT -and $env:ABUZ8_SIGN_PROFILE
$pfx = $env:CSC_LINK
if (-not $pfx -and -not $azureReady) { $localPfx = Join-Path $root 'build\code-sign.pfx'; if (Test-Path $localPfx) { $pfx = $localPfx; if ($env:ABUZ8_CSC_PASSWORD) { $env:CSC_KEY_PASSWORD = $env:ABUZ8_CSC_PASSWORD } } }
if ($azureReady) {
  Write-Host "SIGNED build — Azure Trusted Signing (account: $env:ABUZ8_SIGN_ACCOUNT, profile: $env:ABUZ8_SIGN_PROFILE)" -ForegroundColor Green
  $signArgs = @(
    "-c.win.azureSignOptions.endpoint=$env:ABUZ8_SIGN_ENDPOINT",
    "-c.win.azureSignOptions.codeSigningAccount=$env:ABUZ8_SIGN_ACCOUNT",
    "-c.win.azureSignOptions.certificateProfile=$env:ABUZ8_SIGN_PROFILE"
  )
  if ($env:ABUZ8_SIGN_PUBLISHER) { $signArgs += "-c.win.azureSignOptions.publisherName=$env:ABUZ8_SIGN_PUBLISHER" }
} elseif ($pfx) {
  $env:CSC_LINK = $pfx; Write-Host "SIGNED build — local cert: $pfx" -ForegroundColor Green
} else {
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  Write-Host "UNSIGNED build (no Azure Trusted Signing / no .pfx) — SmartScreen will warn users." -ForegroundColor Yellow
  Write-Host "  Cheapest trusted path: Azure Trusted Signing (~`$10/mo). See RELEASE_SIGNING.md." -ForegroundColor Yellow
}

Push-Location $src
try {
  if ($Lean) {
    Write-Host "Building LEAN one-click NSIS v$ver (small brain; full NSIS installer)..." -ForegroundColor Cyan
    Write-Host "  NOTE: trim extraResources to the LFM-350M GGUF first, or this will exceed the NSIS 4GB limit." -ForegroundColor Yellow
    & npx --no-install electron-builder --win nsis @signArgs
    if ($LASTEXITCODE -ne 0) { throw "electron-builder (lean NSIS) failed (exit $LASTEXITCODE)" }
  } else {
    # Reliable: pack the full app (brain + neural voice) to win-unpacked — no NSIS mmap limit.
    if (-not $SkipBuild) {
      Write-Host "Packing ABUZ8 OS v$ver (full app: sovereign brain + neural voice) to win-unpacked..." -ForegroundColor Cyan
      & npx --no-install electron-builder --win --dir @signArgs
      if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir failed (exit $LASTEXITCODE)" }
    }
    $unpacked = Join-Path $dist 'win-unpacked'
    if (-not (Test-Path (Join-Path $unpacked 'ABUZ8 OS.exe'))) { throw "win-unpacked\ABUZ8 OS.exe missing — pack failed." }

    # Portable bundle: the unpacked app + a launcher = USB-copyable, runs in place (real-install doctrine).
    $q = [char]34
    $bat = "@echo off`r`nstart $q$q $q%~dp0ABUZ8 OS.exe$q`r`n"
    Set-Content -Path (Join-Path $unpacked 'Launch-ABUZ8.bat') -Value $bat -Encoding ASCII
    Write-Host "  portable bundle ready: $unpacked (run Launch-ABUZ8.bat or 'ABUZ8 OS.exe')" -ForegroundColor Green

    # Single-file distributable: a 7z of the unpacked app (no 4GB limit; GGUFs are incompressible -> store-fast).
    $sevenZ = @("C:\Program Files\7-Zip\7z.exe", (Join-Path $src 'node_modules\7zip-bin\win\x64\7za.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($sevenZ) {
      $out7z = Join-Path $dist ("ABUZ8-OS-$ver-Portable.7z")
      if (Test-Path $out7z) { Remove-Item $out7z -Force }
      Write-Host "  packing single-file distributable -> $out7z (this is large; ~minutes)..." -ForegroundColor Cyan
      & $sevenZ a -mx=1 -ms=on -bso0 -bsp0 "$out7z" "$unpacked\*" | Out-Null
      if ($LASTEXITCODE -gt 1) { throw "7z packaging failed (exit $LASTEXITCODE)" }
      $mb = (Get-Item $out7z).Length / 1MB
      $msg = "  distributable OK: {0} ({1:N0} MB)" -f (Split-Path $out7z -Leaf), $mb
      Write-Host $msg -ForegroundColor Green
    } else { Write-Host "  ! 7-Zip not found — skipped single-file packaging (portable folder still ready)." -ForegroundColor Yellow }
  }
  Write-Host "Done. dist\ = HEAD (v$ver)." -ForegroundColor Cyan
} finally { Pop-Location }
