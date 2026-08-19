# ABUZ8 OS — SESSION HANDOFF (2026-06-25)

**Status: NOT broken — actively shipping. Two studios + Spine layer + local 3D + editor all PROVEN this session.**
Machine: ABUZ8 ("Pegasus"), dual RTX 5090. Branch: `harden/v1.32.0-security-sovereignty` (off `main`).
Version: **v1.34.1**. Home build (running Portable app on `:8900`) redeployed live many times this run.

## ⬆️ UPDATE 2026-06-25 (late) — home fully sovereign + security do-not-ship items closed + v1.34.1 packaged
Verified LIVE on `:8900` this run (all committed + pushed):
- **Sovereign brain LIVE** (was the FR-01 blocker): Gemma 4 E4B omni is PRIMARY on the dual 5090s (`/api/status`=Gemma, real inference). Gotcha: `llama-server.exe` + `ggml-cuda.dll` MUST be the same build (Gemma-4 crashes at warmup otherwise). `make-portable-bundle.ps1` now ships the brain with a fail-closed gate.
- **Neural VOICE LIVE** (was the roadmap's #1 blocker): Piper neural TTS (4 voices incl Arabic) + Whisper STT are real, not SAPI. `/api/voice/status`=piper-neural; TTS->STT round-trip proven. The renderer's hands-free loop (wake-word "abuu" + VAD + barge-in) is wired and now unblocked. Bundle script ships `resources/voice` (fail-closed MUTE gate).
- **Security follow-ups (adversarial review = do-not-ship, now closed):** SEC-01b desktop-control was drivable cross-origin via no-Origin GET with no consent -> POST-only + Allow-actions gate; SEC-04b backups shipped plaintext secrets (incl license SIGNING key) -> scrubbed fail-closed; SEC-02 fs/read+fs/list realpath jail + remote-only workspace containment + bare secret-dir block; SEC-03 SSRF now DNS-resolves + vets every IP + PINS the socket (kills DNS-rebind), /api/mesh/add metadata-blocked + consent-gated. Gates: smoke 55/0, **sec-smoke 40/0**, lint 0-dup.
- **v1.34.1 packaged from HEAD:** `electron-builder --dir` -> `dist/win-unpacked` = full app (brain+voice+tor, 7.6GB). **The one-click NSIS CANNOT carry it** — 32-bit makensis can't mmap a >4GB payload (the 5GB brain); error `File: failed creating mmap`. So the brain-bundled distributable is the **portable bundle + single-file `ABUZ8-OS-1.34.1-Portable.7z`** (`scripts/build-release.ps1`, default mode). A lean one-click NSIS (`-Lean`, LFM-350M brain) is the <4GB path. **Code-signing is one cert-drop away** (CSC_LINK/CSC_KEY_PASSWORD or build\code-sign.pfx) — cert purchase is the only owner-money ship-gate (see `RELEASE_SIGNING.md`).

> ⚠️ **PARALLEL SESSIONS share this branch.** This run had a "Spine" builder (P1–P11/E1–E6) AND a
> "T6–T18 security/multi-tenant" builder committing interleaved. **`BUILD_PLAN.md` (repo root) is the
> master roadmap/status — read it FIRST.** Pull before you edit `portable-core.js`; commit small + often
> so the other session can rebase. Both add routes as new route-GROUPS or `if (pathname===…)` blocks.

## HOW TO RESUME (read this, then BUILD_PLAN.md)
- Source of truth: `src\portable-core.js` (~11k lines, backend, ~461 routes/13+ groups). The **Spine** layer
  (`/api/spine/*`, route group `routeGSpine`) holds the new primitives/studio/3D/editor/swarm/sdlc/etc.
  Renderer pages: `index.html` (main), `ide.html` (/ide), `spine.html` (/spine dashboard), `viewer360.html`
  (/360 — orbits .glb or photo-turntable), `editor.html` (/editor — CapCut timeline).
- Verify any change: `cd E:\ABU\ABUZ8_OS_DIST && node --check src/portable-core.js && node scripts/lint-routes.js src/portable-core.js && node scripts/smoke.js && node scripts/sec-smoke.js` (expect **smoke 52+ ok/0 fail, sec-smoke 33+ ok/0 fail, lint 461+ routes/0 dup** — numbers grow as both sessions add).
- Redeploy live: stop `ABUZ8` procs → pack `src` minus node_modules via `electron\node_modules\@electron\asar\bin\asar.js` (NOT rebuild.ps1) → timestamped backup + swap `…\ABUZ8 OS Portable\ABUZ8 OS\resources\app.asar` → `Launch-ABUZ8.bat` → poll `:8900/api/version`. **RULE: after relaunch, wait for a warm `/api/chat` before any heavy brain call (cold brain crashes natively).**
- Git: commit on the branch (never main); push often; footer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## WHAT'S DONE vs NEXT → see `BUILD_PLAN.md`
DONE+live this session: Spine unify+migration, agent-loop, SDLC pipeline, adjudication swarm, sandbox,
audit-chain+neocortex decide, computer-use, Mercury /v1, earn-loop+license, git/repo, dashboard, mobile
client, **studio (script→storyboard→FLUX render), local TripoSR photo→3D (zero cloud key), CapCut timeline editor**.
**NEXT XL (not started): DaVinci-style grading · Blender 3D automation · white/red-hat security-org product.**
Runtime gotchas: TripoSR uses a PyMCubes CPU shim (torchmcubes won't compile — see `reference_triposr_local_setup`);
ffmpeg at `E:\ABU\AI\ffmpeg`; ComfyUI must be running on `:8188` for studio renders.

## RUNTIME DEPENDENCIES (the studios need these RUNNING/present)
- **ComfyUI**: `E:\ABU\ComfyUI\.venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --enable-cors-header *` (GPU0). Used by image + video studio.
- **Ollama** `:11434` (running): coder brain `qwen3.6-128k`, `nomic-embed-text` (RAG embeddings).
- **xtts conda env** `E:\Miniconda3\envs\xtts` (coqui-tts 0.26 + cu128 torch). Voice clone runner: `scripts/avatar/abuz8_xtts_clone.py` (also at `E:\ABU\AvatarStack\`) — invoke with `-s`; it monkeypatches torchaudio.load→soundfile (torchcodec is broken on torch 2.11).
- **AvatarStack** `E:\ABU\AvatarStack` (~25GB): Wav2Lip/XTTS/MuseTalk/LatentSync/SadTalker/LivePortrait.

---

## ✅ THE TWO PRIORITY STUDIOS — BOTH WORK (proven this session)

### Local AI Avatar Studio — WORKS
- `/api/avatar/generate {face, text, voice_ref}` → text → **XTTS cloned voice** → **Wav2Lip lip-sync** → mp4. Proven: 2.2MB cloned-voice talking-avatar mp4. `/api/voiceclone/run` for voice only.
- Cloud option: HeyGen + D-ID connectors (real, key-gated).

### Local Video Studio — WORKS (NEW, just landed)
- `/api/studio/local {kind:'video', prompt}` → **Wan 2.1 t2v** on GPU0 → mp4. **Proven: real 213KB `abuz8_t2v_00001_.mp4` generated locally.**
- Workflow (`studioWanT2VWorkflow`): `wan2.1_t2v_1.3B_fp16` + `umt5_xxl_fp8` (CLIP type `wan`) + **`wan_2.1_vae_official.safetensors`** (16ch — the non-"official" one is 48ch and mismatches, that was the bug). uni_pc sampler, EmptyHunyuanLatentVideo, CreateVideo→SaveVideo(mp4/h264).
- `/api/studio/local {kind:'image', prompt}` → **FLUX** local image (proven PNG).
- UPGRADE PATH for higher quality: Wan 2.2 14B t2v weights aren't on disk (only metadata) and 5B needs a wan2.2 VAE (missing). LTX-2 22B checkpoint IS on disk (`ltx-2.3-22b-distilled-fp8`) + `ltx2_19b_av_vae` — wiring an LTX-2 workflow is the next quality jump. Or download `wan2.2_t2v_high/low_14B_fp8` weights.

---

## EVERYTHING SHIPPED THIS SESSION (all committed, all green)
**Security foundation (existential — re-audited twice):** signed+host-pinned+SHA256 self-update; CORS no-wildcard + DNS-rebind guard + **CSRF Origin gate** (blocks any cross-site state-changing POST); `/api/fs/read` + `/api/learn/ingest` sensitive-path block; cmd_run/gui_do consent gate + coder devExec segment-allowlist; Stripe webhook HMAC + revenue provenance (no fabricated cash); enforced **air-gap** (blocks ALL egress incl web_search/tor/download) + SSRF guard (cloud-metadata blocked).
**Sovereignty:** secrets (connectors/providers/social/account.json) AES-256-GCM encrypted at rest.
**Capabilities:** NZT Monte-Carlo decision engine `/api/decide`; ASRED dev spec-ops `/api/devteam/solve` (local Qwen3-Coder, writes real files); sovereign **Monaco Dev IDE** at `/ide`; **self-learning** file-watcher + per-turn fact learning (embeds every file into RAG via Ollama nomic-embed); 9 cloud connectors (Drive/Notion/Veo/Bedrock-SigV4/OpenAI/Apple-ES256/Runway/Luma/Kling) + HeyGen/D-ID; native account + Google recovery (scrypt, encrypted); Ed25519 license-to-sell; 1-click onboarding catalog (69 providers, 400+ models, OpenRouter 1-key); +Qwen/Fable/Krea models; all Anthropic/Google/NVIDIA SDKs installed.
**UI:** premium **light palette is now the default** (#FAF8F5 + #C8A55C + DM Sans); Dev IDE topbar link.

---

## UPDATE 2026-06-25 13:45 EDT — all 6 remaining "18-phase" items DONE + verified live (HEAD 05abdd9)
- **T6** native GUI driver: native `spineComputer` (.NET P/Invoke) exists; bridged `gui_do` tool to it for clean boxes. Proven: cursor+screen 4480x1440. (c40a466)
- **T10** light palette: white-on-gold→dark ink + wizard reskin (parallel worker).
- **T11** clean-box: harness now targets the REAL Portable bundle + HTTP /health gate; artifact self-containment verified. CAVEAT: live Windows Sandbox VM would not boot on this host — harness ready, live run NOT executed (not claimed). `vm-tests/` is gitignored.
- **T13** secure reach: `/api/reach/*` — sovereign SSH/SCP via Windows OpenSSH, ed25519 keygen, encrypted host registry, consent-gated exec; VPS auto-buy OFF (money hard stop). Proven live. (9478d66)
- **T17** multi-tenant: `/api/tenant/*` — token-hash auth, RBAC owner>admin>member>viewer, per-tenant isolation, owner-gated. Full flow proven; restored actions setting after test. (98e9b61)
- **T18** earn-loop + license gate + project/preview/git + Mercury /v1: preserved+verified+committed (9ddd252).
- Tests: smoke 48/48 (live), sec-smoke 31/31. **A second "ABUZ8 Release Bot" agent is committing Spine P1–P11 to this same branch in parallel** — I added separate route groups + committed only my own files to avoid clobbering.
- Still net-new (not part of the 18): LTX-2.3 22B (3 downloads), continuous Qadir Core observer daemon, full Qadir/AGENT_OS skill port.

## REMAINING / NEXT (honest — pre-update, kept for history)
- **UI punch-list (T10)** from the swarm audit: white-on-gold contrast (index.html :52/:110/:139 → dark ink); onboarding wizard + boot screen still neon-green/black (re-skin to light); dead mode-pill bar (nav-labels lack `data-group`); cut nav 33→~13; finish emoji→SVG; soften dark shadows.
- **Earn-loop attribution (T18)** — the load-bearing revenue gap: UTM links + click tracking → signed ledger.
- **Multi-channel YouTube** — single token now; needs per-channel token store for the 10 channels.
- **`enforceLicense` not wired to any Pro feature** yet (sign/issue/activate work).
- **T6** native GUI driver (Operator needs bundled nut.js/pyautogui), **T13** SSH/VPS/VPN reach (only cloudflared tunnel exists), **T17** multi-tenant scale.
- **Qadir Core / Qadir_Core integration** (Ahmad's ask): inventory `E:\ABU\QADIR_CORE` + `E:\ABU\ABUZ8_AGENT_OS` skills/missions/codes and port/connect the best into ABUZ8 OS. NOT yet done — was the next swarm.

## KNOWN BUGS FIXED THIS SESSION (from 2 adversarial re-audits)
CSRF on new endpoints, license keygen/issue ungated, learn/ingest secret-exfil, fetchUrl SSRF, Bedrock region/model injection, unbounded duplicate vectors (dedup), Krea phantom handler, CORS regression on SSE/chat-live. All closed + tested.
