# ABUZ8 OS — Handoff to the Home-Server Claude
*2026-06-20 · build v1.24.3 · local branch `master` (HEAD `5a5d557`) · GitHub owner: `abuz8studios-ship-it` (ABUZ8 LLC / abuz8ai) · site: abuz8ai.com*

**GitHub owner verified:** `github.com/abuz8studios-ship-it`. Existing repos (`soloman`, `qadir-core`, `zait`/OpenClaw, `mythos-supervisor`, `splat-viewer`) are **legacy/parallel and need CLEANUP/consolidation** — a task for you. **Do NOT push this build over `soloman`.** Push this v1.24.3 build to a **fresh `abuz8-os` repo** under the owner.

## Why this handoff exists
This session's Claude built + verified everything below but is **not connected** to GitHub (no remote/auth) or deploy. You (the home-server Claude) **are** connected. Pick this up and execute. The repo `abuz8studios-ship-it` appears **private** (not publicly indexed) — that's expected; use your GitHub auth.

## Verified state (checked live)
- **Site:** `abuz8ai.com` is **live** — "Sovereign AI Infrastructure / Build With AI That You Actually Own," 100+ tools, agents, **ABUZ8 OS sold at $99 (4.8 GB portable EXE)**, Malki OS enterprise. (Founder wants it **rebuilt** sleeker — OpenRouter/Ollama/HF-class: per-platform downloads + model catalog + a see-through demo.)
- **Repo:** `abuz8studios-ship-it` — private; not readable from the build session.
- **Build:** v1.24.3, fully committed locally (tree clean, HEAD `5a5d557`).

## USB contents (this handoff)
- `ABUZ8_OS_HANDOFF/abuz8-os.bundle` — **full git history, all commits, HEAD `5a5d557`** (clone + push from this).
- `ABUZ8_OS_HANDOFF/HANDOFF.md` — this file.
- `ABUZ8_OS_1.24_PORTABLE/` — the **runnable build** (`Launch-ABUZ8.bat`); v1.24.3 app.asar (operator spine + avatar + Mind cockpit + Document Center + cross-platform CLI + **Hermes-parity context refs + Gallery + mobile app**).

## New since v1.24.0 (built + verified, v1.24.1 → v1.24.3)
- **Mind cockpit** (`view-mind`) — see-through glass engine (live brain/mood, CPU/RAM/GPU gauges, live-thinking feed, tool calls). *Roadmap item 3 — DONE.*
- **Document Center** (`view-docs`) — local browse/preview of photos/PDFs/text/code via `/api/fs/read`. *Roadmap item 4 — DONE.*
- **Cross-platform foundation** — `cliLaunch()`/`onPath()` POSIX CLI-brain shims, electron-builder config (`src/package.json`: win/mac/linux), CI `release` matrix. *Roadmap item 5 — foundation DONE; needs native build + signing.* See `docs/CROSS-PLATFORM.md` + `docs/BUILD-MAC-LINUX.md`.
- **Open-core licensing** — `LICENSE` (MIT core), `EULA-PRO.md` (commercial Pro), `LICENSING.md` (dual-model + third-party notices; default local brain is **Gemma 3 — Google Gemma Terms of Use**, not LFM2). *License decision — DONE (MIT core + Pro).*
- **Clean distribution** — `scripts/sanitize-dist.ps1` + `make-portable-bundle.ps1 -Clean` ship a personal-data-free bundle (allowlist; built-in leak check). Installers are clean by design; CLI logins never bundled.
- **Hermes-parity context refs** — typed `@file/@folder/@line/@url/@diff/@staged/@git/@terminal` expand server-side via `/api/context/expand` with a soft/hard **token budget**; `@`-popover + picker; in-app drag + line-range refs; terminal→chat; searchable **Gallery** (`view-gallery`). Closed every document/context gap vs the newest Hermes desktop.
- **Mobile app** (`/m`) — streaming, Manus-style PWA that connects to this server (connection screen + key, live thinking/tool strip over `/api/chat/live`, session history, installable). *Mobile thin-client — DONE (PWA); store-wrapper optional.*

## STEP 1 — Restore the repo on the home server + push to GitHub
```bash
git clone /path/to/USB/ABUZ8_OS_HANDOFF/abuz8-os.bundle abuz8-os
cd abuz8-os
# Create a FRESH repo for this v1.24.3 build (do NOT push over soloman):
gh repo create abuz8studios-ship-it/abuz8-os --private --source=. --remote=origin --push
```
- The bundle carries every commit + the CI workflow (`.github/workflows/ci.yml`). After push, CI runs syntax + mirror + mojibake checks.
- **Repo cleanup task (founder's request):** review/consolidate the legacy repos (`soloman`, `qadir-core`, `zait`, `mythos-supervisor`) — archive or fold the still-useful bits into `abuz8-os`; soloman is *not* the live OS lineage.

## STEP 2 — Install / run on the server
- **Fast:** copy `ABUZ8_OS_1.24_PORTABLE/` to the server and run `Launch-ABUZ8.bat` (sets `ABUZ8_DATA_DIR` to the bundled data; API on `:8900`).
- **From source:** `bash scripts/rebuild.sh` (packs `src/` → app.asar → swaps into the install → relaunches). **Build rule:** edit `src/`; keep root↔`src` `portable-core.js` in sync (CI enforces it; the build packs `src/`).
- Headless/always-on: launch `ABUZ8 OS.exe --server` (no window) or `scripts/install-autostart.ps1 -Headless`.

## STEP 3 — The roadmap (read these in the repo)
- `docs/BUILD-TO-LAUNCH.md` — phased, costed plan (GitHub→signing→site→mobile→cloud→compliance→C-suite).
- `docs/LIFE-OS-VISION.md` — the founder's full vision + honest feasibility per pillar.
- `docs/competitive/HERMES-RECHECK-2026-06-19.md` — grep-verified parity vs Hermes (what's closed / still missing).
- `CHANGELOG.md` `[1.24.1]` → `[1.24.3]` — everything shipped since the last handoff.

## Status of the founder's roadmap
- ✅ **Licensing** — MIT core + Pro EULA shipped (`LICENSE`, `EULA-PRO.md`, `LICENSING.md`).
- ✅ **Mind cockpit** — shipped (`view-mind`).
- ✅ **Document Center** — shipped (`view-docs`).
- ✅ **Cross-platform** — foundation + builder config + CI matrix shipped (needs native build/signing — `docs/BUILD-MAC-LINUX.md`).
- ✅ **Mobile thin-client** — shipped as the streaming PWA (`/m`); store-wrapper optional.
- ✅ **Hermes document/context gaps** — all closed (`/api/context/expand`, Gallery).

### Remaining (do in order)
1. **Push to GitHub** (Step 1) — the only blocker is connectivity, which YOU have. Tag `v1.24.3` to trigger the CI release matrix (Win/Mac/Linux installers).
2. **Rebuild `abuz8ai.com`** sleeker (per-platform downloads + Ollama-style model catalog + see-through demo) AND/OR stand up a **dedicated OS download site** (founder wants the OS on its own site, with abuz8ai.com as the hub). ABUZ8 can self-deploy via `/api/deploy/run` (Vercel/Cloudflare).
3. **Repo cleanup** — consolidate/archive the legacy repos (not `soloman` as the OS lineage).
4. **Optional:** native build + code-signing (certs), store-wrapper for the mobile PWA (TWA/Capacitor), icons in `src/build/`.

## Needs the founder (not code)
- **Code-signing cert** (OV/EV, ~$200–400/yr) — the #1 desktop-trust blocker (kanban backlog).
- **Store accounts** for mobile (Google Play $25 once, Apple $99/yr). Domain `abuz8ai.com` already owned.

## Honesty guardrails (keep these — they keep us shippable + legal)
- **Banking:** consented APIs (Plaid read-only + Stripe), **never** scrape bank logins.
- **OSINT / deep-web / tools:** authorized security testing, CTF, research, defensive use only — refuse mass-targeting / unauthorized intrusion.
- **Hardware:** no magic "GPU USB stick" — it's host compute or a cheap $60–150 SBC dock + thin-client phones. No $15k rig, no fees.

## One caution
Don't try to ship all 11 vision pillars before launch. Ship the wedge — **sovereign desktop + rebuilt site + Mind cockpit + Document Center** — then open-source it and let the community compound the tool catalog (the Kali/Ollama path).
