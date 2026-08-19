# ABUZ8 OS — MASTER BUILD PLAN (the "every phase" roadmap)

Created 2026-06-25. Source of truth for the multi-session build toward the full
capability wishlist (rival Replit/Cursor/Claude-Desktop/Manus/HeyGen/CapCut/
DaVinci/Blender/CrewAI/LangGraph/Docker + AI avatar/UGC + 360 home & car 3D +
PDF→studio cinematic pipeline + mobile edge-brain app + white/red-hat org).

## GROUND TRUTH (verified from disk 2026-06-25)
- ABUZ8 OS = **v1.34.1**, branch `harden/v1.32.0-security-sovereignty`. Baseline GREEN:
  `node --check` OK · route-lint 408/0-dup · smoke 14/14 · sec-smoke 28/28.
- Backend = `src/portable-core.js` (~10.5k LOC, 408 routes, 13 route groups).
- **Key strategic finding:** the strongest engines already exist as REAL code in
  `E:\ABU\QADIR_CORE` (Python) and `E:\ABU\ABUZ8_AGENT_OS` (Python) — they are NOT
  bolted onto the shipped OS. **The play is PORT + UNIFY, not rebuild.**

## THE PRIMITIVES (Ahmad's crisply-organized system) — now first-class in the Spine
agent · soul · heartbeat · threads · concepts · skills · memories · lessons ·
teams · library · migration · tools · mcp · api · sdk · providers
Provider "full works" stack: NVIDIA · Google · Anthropic · OpenAI(ChatGPT) ·
DeepSeek · Hermes · Gemma · Fable · Nemo Ultra · Ollama.

## PHASES
- [x] **P1 — Spine unify layer** (`/api/spine/*`): 13 JSON collections + CRUD +
      heartbeat + migration importer (imports REAL QADIR souls/skills + AGENT_OS
      minds — verified 44 assets) + seeded 10-provider registry. smoke +5 (14/14).
- [ ] **P2 — Autonomy engine** (highest leverage): port QADIR `brains/agent/loop.py`
      behind `/api/missions/run` + `/api/autonomy`; mount AGENT_OS `mercury.py` `/v1`.
- [x] **P3 — Studio pipeline** DONE + VERIFIED LIVE on Pegasus: `/api/spine/studio/storyboard`
      (script/PDF → scene-by-scene shots: action/dialogue/camera/vfx/image_prompt/music/SFX via brain),
      `/api/spine/studio/departments` (10 Pixar-style depts as Spine teams), `/api/spine/studio/movie`
      (storyboard → render each shot via the proven local FLUX/Wan engine). PROOF: "The Last Lighthouse"
      2 scenes/6 shots from Grok + real FLUX render → 1.4 MB PNG on disk on the 5090. TODO: 1-min 4K
      video assembly + per-shot t2v + music/SFX + voice.
- [x] **P4 — Avatar** DONE (wired, engine proven): `/api/spine/studio/avatar` wraps the proven local
      talking-head (`generateTalkingAvatar`: XTTS voice-clone + Wav2Lip GPU). Full render needs a face
      image + AvatarStack (present on Pegasus). Cloud HeyGen/D-ID path also available.
- [x] **P5 — Sign self-update** DONE (verified in code): `applyUpdate()` enforces https + host-pin + SHA-256 match + REQUIRED Ed25519 signature before launching any installer. EXISTENTIAL-6 RCE closed.
- [x] **P6 — Computer-use** DONE (Windows, no new deps): `/api/spine/computer/info|screenshot|move|click|type|key`
      via .NET P/Invoke. VERIFIED LIVE: read the real desktop (cursor + 4480×1440 dual-monitor span). linux/mac = ROADMAP.
- [x] **P7 — Replit-style** DONE: `/api/spine/project/create` + `/api/spine/preview/*` (live file server, verified HTTP 200 live). TODO: inline diff-apply on the open buffer.
- [~] **P8 — Spine dashboard** DONE: `/spine` light-palette command page (#FAF8F5/#C8A55C/DM Sans) —
      primitives, providers, live studio (storyboard+render), neocortex decide, audit. Serves HTTP 200 live.
      TODO: full re-skin of the 363 KB main index.html (needs Ahmad's visual sign-off).
- [x] **P9 — Earn-loop + license** DONE: `/api/spine/earn/link|click|ledger` (UTM-tagged, verified live) + `/api/spine/license/check` + `/api/spine/pro/feature` (enforceLicense gate). Self-update already signed (P5).
- [~] **P10 — Mobile control client** DONE (code): `/api/spine/mobile/client` writes a real Expo/RN
      master-control App.js (hits OS API: overview + chat). Verified written live. TODO: bundle the 350M
      edge brain + EAS/Gradle build to an APK/iOS binary.
- [~] **P11 — Net-new XL** (in progress): PDF→studio DONE (P3 storyboard+departments). **360 viewer MVP DONE**:
      `/360` canvas turntable + `/api/spine/studio/360` frame manifest (verified live). **Tripo photogrammetry DONE**:
      `/api/spine/photogrammetry/reconstruct` (multiview front/left/back/right photos → real .glb mesh via Tripo,
      poll-to-completion) + `/360?model=<glb>` 3D orbit viewer (model-viewer). Pipeline verified live (reaches
      Tripo API); a real run is GATED on a valid Tripo key (platform.tripo3d.ai) — Ahmad's to add. **Local TripoSR DONE + VERIFIED LIVE
      (sovereign, zero cloud key)**: `/api/spine/photogrammetry/local` runs TripoSR on the 5090 (CUDA) →
      real .glb (proof: 51,550-vert / 2 MB mesh from a render, served at `/api/spine/model/<id>`, orbits at
      `/360?model=...`). CPU-marching-cubes shim (PyMCubes) in the runner sidesteps the torchmcubes CUDA13/MSVC
      compile failure. Setup: `scripts/setup_triposr.ps1`. **CapCut timeline editor DONE + VERIFIED LIVE**:
      `/editor` UI + `/api/spine/editor/save|render|list` — timeline (clips: image/video/color + per-clip
      duration + text overlay) → ffmpeg assemble → mp4 (proof: 2-clip timeline → real mp4, served at
      `/api/spine/render/<id>`). ffmpeg at `E:\ABU\AI\ffmpeg`. TODO: DaVinci grade · Blender 3D · security-org product (multi-turn each).

## ENTERPRISE TRACK (Ahmad's expanded spec 2026-06-25)
- [x] **E2 (core) — Multi-model adjudication swarm** `/api/spine/swarm/solve`: N candidates
      run in parallel (real runTask, optional per-candidate provider) → adversarial judge
      (bias-to-action/revenue) picks the winner → winner persisted as a Spine lesson.
      Verified live on :8900 (judge produced a genuine critique). smoke 16/16.
- [x] **E1** Full SDLC pipeline `/api/spine/sdlc/run` (plan→design→code→review[swarm]→test→deploy→monitor),
      selectable stages, persisted as a Spine mission. Verified LIVE: plan+design ran on Grok·SuperGrok,
      monitor ok, mission persisted. smoke 18/18. NOTE: a brain endpoint hit ~2s after app restart (cold
      brain) crashed the in-process/CLI brain — REDEPLOY RULE: after relaunch, wait for a successful
      /api/chat (warm brain) before calling heavy brain endpoints.
- [~] **E2 (rest)** skill-learning primitive DONE (`/api/spine/learn/skill` — persists wins as reusable skills, live). TODO: auto-trigger on every conversation/swarm + tool/connector auto-creation.
- [x] **E3** sandbox verify-before-launch `/api/spine/sandbox/run` — isolated, timeout-bounded child process (ELECTRON_RUN_AS_NODE), runs+verifies code before deploy. Verified LIVE (ok on good code, fails on throw). WASM/full-VM jail = ROADMAP.
- [x] **E4 (local)** git ops + repo registry: `/api/spine/git` (status/log/diff/branches/reflog/remotes — verified live on the OS repo) + `/api/spine/repo/register|list`. Plus **Mercury** `/v1/chat/completions` + `/v1/models` (OpenAI-compatible — verified live, 20 models) so Cursor/LangChain/n8n/Hermes use ABUZ8 as a brain. TODO: issue→PR + GitHub/Azure DevOps (need tokens → ROADMAP).
- [x] **P2b** scheduler tick already firing (`setInterval` 60s, live) + Mercury `/v1` mounted. Autonomy loop active.
- [x] **E5** hardware abstraction layer `/api/spine/hardware/probe` — 7-transport registry (BT5.4/NFC PN532/HackRF/SIM7600/Iridium/UHF-mesh/ASMP-Tor) w/ honest device probe (tor detected live). Software layer DONE; physical-device drivers ROADMAP until hardware verified.
- [x] **E6** hash-chained audit ledger `/api/spine/audit/*` (tamper-evident, verified intact live) + neocortex decision `/api/spine/decide` (10k Monte-Carlo scenarios, emotion/utility-weighted, picks highest-EV — verdict verified live). TODO: fully-autonomous self-upgrade loop (scheduler exists; activate in 2b).

## DEPLOY STATE
- Live app redeployed 2026-06-25 with P1+P2+E2; `:8900/api/version`=1.34.1, `/api/spine/*` LIVE.
- Redeploy = stop ABUZ8 procs → pack `src`-minus-node_modules via `electron\node_modules\@electron\asar\bin\asar.js` → swap `…\ABUZ8 OS Portable\ABUZ8 OS\resources\app.asar` (timestamped backup) → `Launch-ABUZ8.bat` → poll :8900.

## VERIFY (every change)
```
cd E:\ABU\ABUZ8_OS_DIST
node --check src/portable-core.js
node scripts/lint-routes.js src/portable-core.js   # expect 0 duplicates
node scripts/smoke.js                              # expect all ok
node scripts/sec-smoke.js                          # expect 28/28
```

## REDEPLOY TO LIVE APP (when a chunk is ready)
Repack `app.asar` from `src` (excl node_modules) → back up + swap into
`C:\Users\wirec\AppData\Local\ABUZ8 OS Portable\ABUZ8 OS\resources\app.asar` →
kill `ABUZ8 OS` procs → relaunch `…\Launch-ABUZ8.bat` → verify `:8900/api/version`.
