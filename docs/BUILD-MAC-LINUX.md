# ABUZ8 OS — Exact Build Instructions for macOS & Linux
*v1.24.3 · run these on the matching machine. Pairs with `CROSS-PLATFORM.md`.*

You have a MacBook **and** a Linux box — perfect, because that's exactly what's needed:
**build Linux on Linux, build + sign macOS on the Mac.** (See the honesty note at the end
about why you can't fully ship a signed Mac app from Linux.)

The build config already lives in `src/package.json` under `"build"` (electron-builder).
You produce installers with three commands.

---

## 0. One-time prep (both machines)
```bash
# Node 20+ and git. Check:
node -v        # need v20+    (install via nvm if missing: https://github.com/nvm-sh/nvm)
git --version

# Get the code (from the USB bundle the handoff carries):
git clone /path/to/USB/ABUZ8_OS_HANDOFF/abuz8-os.bundle abuz8-os
cd abuz8-os/src
npm install            # pulls electron + electron-builder (devDependencies)
```

### Add icons before a public release (optional but recommended)
Drop these in `src/build/` (electron-builder picks them up automatically):
- `icon.icns` — macOS (1024×1024 source)
- `icon.png`  — Linux (≥512×512)
- `icon.ico`  — Windows
Until then it uses the default Electron icon (builds still succeed).

---

## 1. Linux build (run on your Linux box)
```bash
cd abuz8-os/src
npm run dist:linux
# → ../dist/ABUZ8-OS-1.24.3-x64.AppImage   (double-click to run, no install)
#   ../dist/ABUZ8-OS-1.24.3-arm64.AppImage
#   ../dist/abuz8-os_1.24.3_amd64.deb       (apt/dpkg install)
```
Test it:
```bash
chmod +x ../dist/ABUZ8-OS-1.24.3-x64.AppImage
../dist/ABUZ8-OS-1.24.3-x64.AppImage
# then open http://127.0.0.1:8900 health check or the app window
```

## 2. macOS build (run on your MacBook)
```bash
cd abuz8-os/src
npm run dist:mac
# → ../dist/ABUZ8-OS-1.24.3-arm64.dmg   (Apple Silicon)
#   ../dist/ABUZ8-OS-1.24.3-x64.dmg     (Intel)
#   + matching .zip (for auto-update)
```

### Signing + notarization (so Gatekeeper doesn't block it) — Mac only
You need an **Apple Developer account** ($99/yr) and a **Developer ID Application** cert.
```bash
# Sign with your Developer ID (electron-builder reads these env vars):
export CSC_LINK="/path/to/DeveloperID.p12"     # or it uses your login keychain
export CSC_KEY_PASSWORD="your-p12-password"
# Notarize (Apple's malware scan; required for distribution outside the App Store):
export APPLE_ID="you@icloud.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # appleid.apple.com → app passwords
export APPLE_TEAM_ID="YOURTEAMID"
npm run dist:mac
```
electron-builder signs, then submits to Apple's `notarytool` and staples the ticket — all on the Mac.

## 3. Windows build (FYI — already shipping; build on Windows)
```bash
cd abuz8-os/src && npm run dist:win
# → ../dist/ABUZ8-OS-1.24.3-Setup.exe (NSIS) + a portable .exe
```

## 4. Let CI do all three at once (no local builds)
Push a tag and GitHub builds Win + Mac + Linux on native runners, uploads installers as artifacts:
```bash
git tag v1.24.3 && git push origin v1.24.3
# or: Actions tab → ci → "Run workflow"
```
Put `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
into **repo → Settings → Secrets** and CI signs automatically. Without them you still get
working **unsigned** installers.

---

## Shipping it CLEAN (no personal data) — important
- **Installers (.dmg / .AppImage / .deb / Setup.exe) are clean by design.** They contain the
  app only. Each user gets a fresh, empty data folder on first launch — your chats, memory,
  keys, and accounts are never inside them.
- **Your AI logins never travel either.** The Claude/Grok/ChatGPT/Gemini CLIs store auth in the
  home dir (`~/.claude`, etc.), not in the app — so they're never bundled. The recipient signs
  into their own accounts.
- **Portable USB bundle** is the only path that copies a data folder. Use the clean switch:
  ```powershell
  # Windows (makes a personal-data-free USB):
  powershell -ExecutionPolicy Bypass -File scripts\make-portable-bundle.ps1 -Target "E:\ABUZ8-Portable" -Clean
  # or sanitize an existing data dir into a clean copy:
  powershell -ExecutionPolicy Bypass -File scripts\sanitize-dist.ps1 -Target "E:\ABUZ8_OS_Data_CLEAN"
  ```
  `-Clean` ships only the brain, voices, and skills; it omits config/chats/memory/goals/keys/exports
  and prints a `LEAK CHECK PASSED` confirmation.

---

## Honesty note: "I can do Apple from Linux"
Partly. electron-builder can produce an **unsigned** `.dmg` on Linux, but:
- **Code-signing + notarization require macOS** (`codesign`, `notarytool`/`xcrun` are Apple-only).
  An unsigned Mac app triggers Gatekeeper's "unidentified developer" / "damaged" warning.
- Since you **own a MacBook**, do the Mac build + sign + notarize there — it's the only way to
  ship a Mac app users can open without right-click-override. Linux build stays on Linux.
- The repo's CI matrix is the hands-off version of exactly this (each OS on its own runner).
