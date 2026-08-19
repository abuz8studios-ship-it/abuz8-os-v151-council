# ABUZ8 OS — Deploy Anywhere (#6 / #7)

ABUZ8 OS runs on far more than a Windows desktop. The engine (`src/portable-core.js`) is **pure
Node.js, zero Electron**, so anywhere there's a `node` binary it runs headless.

## 1. Linux VPS / cloud / $5-tier (headless, no GUI)
```bash
node scripts/headless.js          # or: npm run headless
# API on http://127.0.0.1:8900 — health, chat, tools, OSINT, chain, connectors, scheduler
```
- **Brain on Linux:** drop a Linux `llama.cpp` `llama-server` (+ a GGUF) into the brain dir or set
  `ABUZ8_BRAIN_DIR`. The runtime now resolves the platform binary (`llama-server` on Linux/mac,
  `llama-server.exe` on Windows). No GPU needed — it defaults to CPU (`-ngl 0`).
- **Or no local brain:** connect a cloud provider / OpenRouter and it runs frontier-brained.
- **RAM, honest:** ~3–4 GB for the small (LFM2-350M) brain CPU-only; ~8 GB for the Gemma-4-E4B omni
  brain. A literal **1 GB** box throws "Illegal instruction" — use a 3–4 GB droplet (~$12–24/mo) or
  run brainless+cloud on a $5 box.

## 2. Docker (one-command VPS deploy)
```bash
docker build -t abuz8-os .
docker run -d -p 8900:8900 -v abuz8-data:/data --name abuz8 abuz8-os
```
Small image (engine only, no Electron/Chromium/brain). Mount a brain at `/app/src/brain` or use cloud.

## 3. Android (Termux) — runs natively on the phone
```bash
pkg install nodejs git
git clone <repo> && cd abuz8-os
node scripts/headless.js
```
The same pure-node server runs on an ARM phone. Add a Linux-aarch64 `llama-server` for an on-device
brain, or connect cloud. (Electron can't run on Android — this headless path is how the phone runs it.)

## 4. iPhone / any device — reach it remotely
- **Cloudflare tunnel + PWA:** `tool: connector none` → the app's tunnel gives an `https://*.trycloudflare.com`
  URL; open `/m` on the phone (installable PWA). Key-gated.
- **Tor .onion (private):** `tor_browse {action:"onion"}` publishes a v3 `.onion` for the OS — open it
  in **Tor Browser on iPhone/Android**. Opt-in (it exposes the OS; inbound still needs the LAN key).

## 5. USB / all-in-one micro-PC (portable, data-on-stick)
- Copy `dist/win-unpacked/` to a USB drive, drop `scripts/Launch-ABUZ8-USB.bat` next to `ABUZ8 OS.exe`,
  run it — all data lives in `ABUZ8_OS_Data` on the stick (`ABUZ8_DATA_DIR` relocation, verified).
- The brain GGUF + voice + llama.cpp travel with it → fully offline, nothing written to the host.

## Honest status
- ✅ Headless pure-node server — verified (0 Electron processes).
- ✅ Platform-aware brain binary resolution (Linux/mac/Windows).
- ✅ Dockerfile + USB launcher.
- 🟡 A **prebuilt Linux/ARM `llama-server`** is not bundled in this Windows build — provide one (standard
  llama.cpp release) for an on-device Linux/Android brain, or run cloud-brained. The orchestrator itself
  runs anywhere node runs.
