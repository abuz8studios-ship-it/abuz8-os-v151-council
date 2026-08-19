# ABUZ8 OS — Cross-Platform Builds (Windows / macOS / Linux)
*v1.24.3 · pairs with `BUILD-TO-LAUNCH.md` (P1.5) and `LIFE-OS-VISION.md` (pillar 2).*

ABUZ8 OS is Electron + Node, so it is **cross-platform by construction**. Windows ships
today. This doc covers producing macOS and Linux installers.

## What's already portable (verified)
- **Boot:** `src/main.js` uses the standard macOS lifecycle (`window-all-closed` keeps the
  app alive on `darwin`).
- **CLI brains** (Claude / ChatGPT-Codex / Gemini / Grok): launched via `cliLaunch()` in
  `portable-core.js` — Windows routes through `cmd.exe` so npm `.cmd` shims resolve; macOS/Linux
  spawn the binary directly off `PATH`. Availability uses `onPath()` (a cached `which` lookup) on
  POSIX. **No behavior change on Windows** (verified end-to-end: Claude brain returns `PONG`).
- **Shell exec, file ops, git, model server:** already branch on `process.platform` (cmd.exe ↔ bash).
- **GPU / screen / screenshot probes:** guarded — they return empty/`1` on non-Windows instead of
  crashing. `nvidia-smi` GPU stats already work on Linux when present.

## What still degrades gracefully (Windows-only, by design — not crashes)
- Native TTS/STT helper scripts (Piper/Whisper are bundled Windows binaries; the loop falls back).
- The `.exe` auto-updater (`/api/update/apply`) — Mac/Linux update via the native installer instead.
- Desktop GUI control (mspaint/`start`) — Mac/Linux equivalents (`screencapture`, `xdg-open`) are
  a follow-up; the agent core, chat, brains, files, and web automation all work cross-platform now.

## Build the installers
Config lives in `src/package.json` under `"build"` (electron-builder). Targets:
- **Windows:** NSIS one-click `Setup.exe` + portable `.exe` (x64)
- **macOS:** `.dmg` + `.zip` (x64 + arm64)
- **Linux:** `AppImage` (x64 + arm64) + `.deb` (x64)

```bash
cd src
npm install                 # pulls electron + electron-builder (devDeps)
npm run dist                # build for the CURRENT OS → ../dist
# or target explicitly (only on a matching/cross-capable host):
npm run dist:win | dist:mac | dist:linux
```

> **Honest constraint:** electron-builder **cannot build (or sign) a macOS `.dmg` from Windows.**
> macOS artifacts must be built on macOS; Linux on Linux (or in Docker). That's why CI does it.

## CI does it the right way (native runners)
`.github/workflows/ci.yml` has a `release` job — a matrix over `windows-latest`, `macos-latest`,
`ubuntu-latest` that runs `npm run dist` on each and uploads the installers as artifacts.
- Trigger: a version tag (`v1.24.3`) or **Run workflow** (workflow_dispatch).
- Code signing: drop `CSC_LINK` + `CSC_KEY_PASSWORD` (and Apple notarization creds) into repo
  secrets and signed builds happen automatically; without them you still get working unsigned installers.

## Before a public Mac/Linux release
1. Add icons: `src/build/icon.icns` (mac), `src/build/icon.png` ≥512px (linux), `src/build/icon.ico` (win).
   Until then electron-builder uses the default Electron icon.
2. Code-signing certs (founder task): Windows OV/EV, Apple Developer ID + notarization.
3. Smoke-test each artifact on real hardware — the agent loop, a CLI brain (with that brain's CLI
   installed on the target), the Documents view, and voice fallback.
