# Changelog

## [1.33.0] — 2026-06-24 — Sovereign Jarvis: local avatar+voice, local studio, 9 cloud connectors, native identity, license-to-sell

The "for every cloud, a free local version" wave — all proven on the dual-5090 Pegasus rig.

- **Local talking-avatar with cloned voice (sovereign, no key):** wired the on-disk ~25GB AvatarStack — text → XTTS cloned voice → Wav2Lip lip-sync → mp4, on GPU. `/api/avatar/generate`, `/api/voiceclone/run`. Proven: 2.2MB cloned-voice avatar mp4.
- **Local image studio (free Midjourney/Krea):** bundled FLUX-dev template — type a prompt, get a PNG on the 5090 via ComfyUI. `/api/studio/local`. Proven: real PNG generated. Video routes to LTX/Wan/HunyuanVideo (local) or veo/runway/luma/kling (cloud).
- **NZT decision engine:** `/api/decide` — Monte-Carlo EV/Kelly/anomaly/GO-NOGO before answering.
- **9 new cloud connectors** (real APIs, key-gated): Google Drive, Notion, Google Veo, AWS Bedrock (pure-node SigV4), OpenAI images/TTS, Sign-in-with-Apple (ES256 JWT), Runway, Luma, Kling. Plus HeyGen/D-ID/Krea/Higgsfield (avatar/video).
- **Native identity with Google recovery:** username+password (scrypt, offline) + Sign-in-with-Google account link/recover/reset. `account.json` encrypted at rest. `/api/account/{register,login,link-google,recover,reset-password}`.
- **License-to-sell:** Ed25519-signed, offline-verifiable Pro licenses auto-issued on a verified Stripe sale; `enforceLicense` gate. `/api/license/{keygen,issue,activate,status}`. Turns the Stripe rail into a real product.
- Providers: +Qwen (DashScope), +Claude Fable family, +Krea.

## [1.32.0] — 2026-06-24 — Security hardening + sovereignty + agent safety (pre-public-deployment sprint)

Closes the entire existential-threat list from the pre-launch audit, plus the sovereignty moat. Every item below ships with an automated test in `scripts/sec-smoke.js` (14 security assertions) — they cannot silently regress.

**Security (the "what will make us fail" list):**
- **Self-update is now safe.** `applyUpdate()` refuses anything that isn't https + host-pinned (github/abuz8ai) + SHA-256-verified against the (pinned-https) manifest before launch; Ed25519 signature layer ready when a key is provisioned. Semver-greater-only compare kills the downgrade-brick. (was: unsigned remote EXE = RCE on every machine)
- **CORS/CSRF lockdown.** Replaced blanket `access-control-allow-origin: *` with per-request same-machine/LAN origin reflection + a DNS-rebinding Host guard. A malicious web page can no longer read `127.0.0.1` responses or drive any endpoint.
- **`/api/fs/read` sandboxed** — blocks credential/secret paths (ssh keys, browser cookie/login stores, keychains, .vaultkey).
- **Prompt-injection guard** — shell/OS tools (`cmd_run`, `gui_do`) no longer ride the autopilot's implicit consent; they require the explicit Allow-actions toggle, so web/inbound content can't talk the agent into a shell command.
- **Revenue integrity** — Stripe webhook now HMAC-signature-verified; `/api/revenue/record` is forced UNVERIFIED; `revenueSummary` splits verified vs unverified so a fabricated POST can never surface as confirmed cash.
- **Onboarding honesty** — the wizard no longer claims "you're earning" without a real connected account + real post.

**Sovereignty (the moat, now enforced in code):**
- **Local-Only / air-gap mode** — a single chokepoint (`fetchUrl`) blocks ALL non-loopback egress when on; only the bundled local brain answers. "Your data never leaves" is now enforced, not marketing. `/api/airgap` toggle + status.
- **Secrets encrypted at rest** — `connectors.json` / `providers.json` / `social.json` are transparently AES-256-GCM encrypted (vault key, optional DPAPI). No plaintext API keys on disk.
- **No-train flag** (`store:false`) on OpenAI-compatible cloud calls.

**Agent safety + capability:**
- **Stop / kill switch** — `/api/agent/stop` checked at the top of every autonomous loop (autopilot, coder, task). Runaway agents are now cancellable mid-run.
- **Executable skills** — the agent now receives the full SKILL.md playbook body on retrieval (was: title only), and `list_mcp_tools`/`mcp_call` are exposed to the planning loop so imported MCP tools are reachable.
- **Honesty pass** — fixed the self-description capability lie (it DOES have RAG/memory/deep-research), relabeled the "LIVE CRM" connector to "External CRM Bridge (bring your own)", removed the draw-monkey/unicorn gimmick from the advertised tool registry.
- **Providers** — added first-class Qwen (DashScope), the Claude Fable family, and a Krea (image/video) studio connector.

## [1.31.0] — 2026-06-22 — N7 route()→route-table refactor (Next-7 complete) — ZERO behavior change

The ~1325-line `route()` monolith (preamble + ~349 exact-match handlers + 4 MCP regex + `/vendor/`
prefix + 404 default) is split **verbatim** into 12 contiguous numbered sub-routers
(`routeG01`…`routeG12`), each `async (req,res,pathname,searchParams)`. `route()` is now a dispatcher:
```
for (const _g of ROUTE_GROUPS) { await _g(req, res, pathname, searchParams); if (res.headersSent) return; }
return json(res, 404, …);  // unchanged default
```
Handler bodies are byte-identical and in original order; the auth gate + OPTIONS short-circuit stay
in the preamble, before dispatch. The "handled" signal is **`res.headersSent`** (set synchronously by
`writeHead` in every responder) — this correctly stops dispatch for streaming handlers (SSE,
file-range) that send headers without ending the stream, which a `writableEnded` check would have
mishandled.

**Verified behavior-preserving to a high bar:**
- Mechanical identity — 1299 chain lines byte-identical, in order, zero added/dropped/reordered.
- Differential GET-probe of **all 378 routes** (status + content-type + JSON key-shape): **ZERO diff**
  before vs after (new harness `scripts/route-diff.js` + `scripts/route-inventory.json`; the one-time
  transform is `scripts/n7-transform.js`).
- smoke **9/9**, full E2E **45/45**, route-lint **372/0**; verified live in the `.exe` (dispatch across
  6 groups + the N6 400 + the 404 default).
- 3-lens adversarial review (async/streaming · ordering/regex-shadow · auth/preamble) — unanimous
  **safe-to-ship**, zero genuine behavior changes (the lone theoretical throw-after-headersSent edge
  is pre-existing in the original monolith, not introduced here).

This closes the Next-7. Remaining work is owner-only (macOS OV cert).

## [1.30.1] — 2026-06-21 — N6 error-contract hardening (HTTP status semantics)

Attack-surface / API-hygiene pass from the audit: **33 hard-error endpoint responses** that were
returning `{ok:false}` with HTTP **200** now return **400** (correct client-error semantics for
missing params, missing config, validation failures, not-found). The **4 intentional soft-signals**
(`optional:true` / `fallback:true` — e.g. "provider not configured, falling back") deliberately
stay 200. Safe by construction: the renderer's `api()` helper reads the JSON body's `.ok` field and
ignores HTTP status, so UI behavior is unchanged; the E2E contract treats 400 as healthy.
- Verified: route-lint **372/0**, smoke **9/9**, isolated full-endpoint E2E **45/45** (no 500/crash/hang).
- N7 (route() → route-table refactor) intentionally deferred to its own careful pass — the dup-route
  lint already guards that bug-class, and a 372-route restructure is not worth rushing.

## [1.30.0] — 2026-06-21 — Next-7 phases: knowledge graph, encrypted-at-rest, file→knowledge, scanner, CI, security fixes

The remaining harvest + hardening from the parallel-fork audit and the deep code review:
- **N4 — knowledge graph + federated search** (`/api/graph/*`, `/api/search/all`, graph_search/
  extract tools) · **encrypted-knowledge-at-rest** (AES-256-GCM on memory content via the vault
  key + Windows DPAPI key-wrap; `/api/vault/encrypt|dpapi`; verified ciphertext-on-disk + transparent
  recall) · **file→knowledge persistence** (full-doc chunk+embed, `/api/knowledge/ingest` +
  ingest_file tool) · **brain ctx budgeting** (prompt trimmed to the model window — the KV-cache
  overflow fix). VERIFIED 7/7 graph + 6/6 subparts.
- **N3 — provider profiles:** confirmed **35 first-class profiles** (exceeds the field; the prior
  "3 dialects" framing undersold it).
- **N2 — skill security scanner** (all packs scanned) · **N5 — CI behavioral smoke + dup-route lint**.
- **5 audit bug-fixes (v1.29.1):** unsigned-pack `allow_unsigned` RCE closed; access-grant scope
  now enforced; accessValidate per-request write race removed; fleet/stats 500→400; graph null-guard.
  + DEP0190 mcp-spawn fix.
- **Verification:** isolated full-endpoint runtime E2E **45/45**, route-lint **372/0**, 13-agent
  code audit (all confirmed bugs fixed), security regression 5/5.
- **N1 (UI):** surgical SVG icon system shipped (depth pass + N7 route-table refactor still queued).


## [1.28.0] — 2026-06-21 — The Next-7 follow-through: full fleet stack + two-way channels + light theme

The 7 follow-on steps, in order, each run-verified:
1. **Fleet panel** (renderer) — see + drive the army: pooled-compute meter, per-node cards,
   collective-brain box, run-on-all, shard preview, roster add/remove. Vendored `fleet.js`.
2. **Fleet-shared collective memory** — federated RAG fan-out + gossip replication (a fact on
   ANY node is recallable on ALL; dedup-safe). `/api/fleet/rag|memsync`. VERIFIED 6/6.
3. **Distributed inference — LIVE** — bundled ABI-matched `rpc-server.exe` (b9743); a model
   served *through* the rpc backend returned a correct completion with the rpc-server holding
   GPU VRAM; the app reports `rpc_binary_present:true`. (planner shipped in 1.27.0)
4. **Fleet-wide verified self-upgrade** — `meshUpgradeAll` format-patches a verified edit to
   every node; each peer applies it in an isolated worktree, eval-gates it, commits only on
   pass (dry-run default). `/api/fleet/upgrade-all`, `/api/self/receive-patch`. VERIFIED 6/6.
5. **Discord/Slack INBOUND** — two-way auto-reply via polling (no new deps); received message
   → agent → reply. `/api/channels/listen|poll|inbound`. VERIFIED 4/4.
6. **Claude-Desktop-precision light theme** — opt-in doctrine palette (#FAF8F5 + #C8A55C +
   DM Sans), dark stays default; vendored toggle. VERIFIED in the .exe.
7. **This release** — v1.28.0 cut, repo stack saved (tree snapshot, docs, tag, CI).

## [1.27.0] — 2026-06-21 — The Next-7: fleet supercomputer + verified self-improvement

A multi-agent power panel (12 agents) ranked the 7 most powerful next moves; 5 shipped this
release (each run-verified, the other 2 specced + queued):
- **#3 Fault-tolerant dispatcher** — `fleetDispatch(units,{retries,perNodeTimeout,minQuorum})`
  runs each work-unit on the best-fit HEALTHY node, fails over on error, never hangs;
  node-health EWMA; `meshDispatchSmart(need:gpu|cpu|any)`. VERIFIED 6/6 (killed a node, all
  units re-routed). `/api/fleet/dispatch`.
- **#2 Fleet-aware orchestrator** — `fleetOrchestrate()` decomposes a goal and dispatches each
  sub-task to a different node in parallel, fuses one report; job ledger; `orchestrate()`
  auto-delegates when a fleet is joined. VERIFIED 5/5. `/api/fleet/orchestrate`.
- **#1 Distributed-inference planner** — `meshShardPlan()` VRAM-proportional tensor-split across
  the fleet's GPUs (verified 3 nodes → 191GB pooled); `meshShardServe()` builds the real
  `--rpc`/`--tensor-split` command and launches it when the rpc-server binary is present (gated
  honestly — ggml-rpc.dll ships, the launcher binary is a queued bundling step). VERIFIED 9/9.
  `/api/fleet/shard/plan|serve`, `/api/fleet/rpc/start`.
- **#5 Verified self-improvement gate** — `runEvalOnWorktree()` boots a patch in isolation and
  runs golden tests; `selfUpgradeApply()` refuses to commit unless the patch BOOTS + scores ≥
  baseline (hardens the fail-closed posture — `node --check` alone is blind to behavioral
  breaks). VERIFIED 5/5. `/api/self/eval`; removed the duplicate `/api/self/status`.
- **#7 Signed .abxpack extensions** — ed25519-signed capability packs (reusing the ledger key):
  `packSign/packVerify/installPack/packPush`, FAIL-CLOSED on tamper, install registers tools +
  KNOWN_AGENT_TOOLS, push installs on every node. VERIFIED 8/8. `/api/packs/*`.

Queued (specced): #4 renderer Fleet panel, #6 fleet-shared collective memory, plus the
rpc-server binary bundling and fleet-wide self-upgrade propagation.

## [1.26.0] — 2026-06-21 — SWARM: opt-in fleet of nodes fused under one master brain

The "nanobots fuse into one big bot" capability — many ABUZ8 nodes, each on its OWN hardware +
brain, voluntarily joined to one orchestrating master that pools their compute and fuses their
answers. **Opt-in + authenticated only** — a node joins by choice with the key; it NEVER
self-propagates and never touches a machine that didn't opt in (the line between a Jarvis swarm
and a worm).
- **Pooled compute** — `/api/fleet/stats` sums every joined node's cores / GPUs / VRAM / RAM into
  one fleet total (multichain compute view). Verified: 2 nodes → 64 cores, 4 GPUs, 127.4GB VRAM.
- **Army-wide tool exec** — `/api/fleet/exec {all:true, tool}` runs one tool on EVERY node at once
  (literal remote device control across the fleet); `{id, tool}` targets a single node.
- **Collective brain** — `/api/fleet/brain` broadcasts a question to all nodes, each answers on its
  own brain, and the master fuses them into one stronger answer.
- **Broadcast** — `/api/fleet/broadcast` fans an agentic task to the whole fleet.
- **Opt-in join** — `/api/fleet/join {master}` lets a worker enroll itself with a master (auth'd).
- **Agent tool `fleet`** (ops: stats/nodes/broadcast/brain/exec/add/remove/join) so the master
  brain can orchestrate the army itself. Functions: `meshStats/meshBroadcast/meshBrain/meshExec/
  meshExecAll/fleetJoin` on the existing `meshAdd/meshPing/meshDispatch` foundation.
- **VERIFIED 8/8** end-to-end: master + 2 real worker processes (separate data dirs/brains) —
  roster join, both online, pooled compute, army-wide exec, targeted exec, agent tool, collective
  brain fan-out. (`docs/` + temp harness `abuz8_e2e_fleet.js`.)

## [1.25.28] — 2026-06-21 — Mobile: gated login + on-device edge model download

The phone-control backbone (Manus/Claude/Apollo-style), no spend:
- **Gated username/password for remote** — sessions now persist (`sessions.json`), the remote gate
  accepts a login session (`x-abuz8-session`), and a new `require_account` setting makes the phone
  **sign in with username+password** (the LAN key alone is rejected). `/api/account/login|logout|require`.
- **On-device edge model download** (Apollo-style) — `/api/mobile/edge-model` lists + serves a small
  GGUF (**LFM2-350M, 219MB**) with **HTTP range/resume**, for the native phone app's on-device runtime
  (llama.cpp/LEAP/MLC) so the phone thinks fully offline.
- **VERIFIED 7/7** (simulated remote): login token, wrong-pass 401, remote-no-login BLOCKED,
  remote-with-login passes, LAN-key-alone blocked under require_account, edge model listed (219MB),
  range download = 206 partial.
- Honest: remote control today = the installable **PWA** (`/m`) + tunnel + this login. A true
  App-Store **`.ipa`/`.apk` with the embedded on-device runtime** = the `mobileScaffold` (Capacitor/Expo)
  → needs a Mac/Android build toolchain to compile (a hardware step, like the cert).

## [1.25.27] — 2026-06-21 — Skills Hub (browse / search / enable / install)

Hermes-Skills-Hub parity. New `skillsHub()` + `/api/skills/hub` (browse + search), `/api/skills/toggle`
(enable/disable, persisted), `/api/skills/install` (drop in a new SKILL.md). **VERIFIED 4/4:** lists
**230** bundled packs, search returns 8 for "github", disable persists (230→229), install creates a
usable skill. `/api/skills/list` now returns the real hub list (was a stub).


## [1.25.26] — 2026-06-21 — MCP forward-host autonomy (agent uses ANY imported MCP tool)

Closes the audit's biggest "tools" gap → Hermes/Claude-Desktop MCP parity.
- New `mcpAllTools()` + `/api/mcp/tools/all`, and two agent tools: **`list_mcp_tools`** (discover every
  tool across all connected MCP servers, name + `server:tool` ref) and **`mcp_call`** (invoke one).
  The brain can now discover + call Desktop Commander / filesystem / github / any imported MCP server.
- **Fixed a real spawn bug:** `spawnMcpClient` used `shell:true` without quoting, so a command/arg
  with a space (e.g. `C:\Program Files\nodejs\node.exe`) broke (`'C:\Program' is not recognized`).
  Now command + args are quoted on Windows.
- **VERIFIED 4/4** (real echo MCP + the bundled filesystem MCP): agent discovers **30 tools**, calls
  one round-trip (`ECHO:HELLO_MCP`), accepts `server:tool` refs, `/api/mcp/tools/all` lists them.

## [1.25.25] — 2026-06-21 — Pro self-upgrade + channel breadth (close the Hermes gaps)

**Self-upgrade ("pro upgrade itself") — now ENABLED + verified:**
- `selfRepoDir()` detects the repo from where the code runs (`__dirname/..` with a real `.git`), so
  self-code-upgrade is enabled in source/dev (the packaged .exe correctly uses the self-update channel).
- New `selfApplyPatch()` + `/api/self/patch` + `/api/self/status`: ABUZ8 edits a file in its own repo,
  **syntax-checks** any `.js`, keeps the root↔src mirror, **git-commits**, and can **rebuild app.asar live**.
- **VERIFIED 4/4** (throwaway repo): enabled, applies+commits its own change (real commit hash), commit
  lands in git log + on disk, **rejects broken JS** (syntax-gated). Plus the existing self-update channel.

**Channel breadth (match/beat Hermes's one real lead):**
- New **Discord** + **Slack** connectors (bot token = your account): `send`/`read`/`channels` via the
  real APIs; `/api/channels` aggregates Telegram + Discord + Slack (all two-way). Drive via
  `connector_call <id> send {channel|channel_id, text}`. 18 connectors total.
- **VERIFIED 4/4:** registered, aggregated, graceful without tokens, live Slack API path reached
  (`invalid_auth` until you paste a token). No spend — uses your own bot tokens.

## [1.25.24] — 2026-06-21 — Native streaming voice + Kinect v2 eyes/ears

- **whisper.cpp STREAMING STT** (real-time native hearing): `whisper-stream.exe` (SDL2 mic capture)
  spawned as a hidden child + rolling transcript. New `/api/voice/stream/start|read|stop|status` +
  `/api/voice/devices`. **VERIFIED:** binary launches, ggml model loads, transcript streams.
- **Kinect v2 as eyes + ears:** `/api/kinect` detects the sensor; `listCaptureDevices()` enumerates
  SDL mics and flags the Kinect. **VERIFIED on this box:** the Kinect mic array is detected as
  `#0 'Microphone Array (Xbox NUI Sensor)'` and `whisper-stream` **auto-selects it** with `{kinect:true}`
  (device 0). Its color camera feeds the existing MediaPipe vision via the camera picker. Speech back
  is Piper TTS (bundled). Native depth/skeleton needs the Kinect SDK + a native binding (honest add-on).
- Renderer: 🎙 **Live** button + rolling-transcript chip (external `vendor/voice/livevoice.js`,
  CI-safe), prefers the Kinect mic automatically.

## [1.25.23] — 2026-06-21 — Cost-routed chat + warm CLI terminals (closeout ②③)

- **`/api/chat/auto`** — `autoChat()` runs every message through the cost router: trivial→free
  on-device, medium→flat-rate subscription CLI ($0 marginal), hard→Claude Max/frontier, with a
  graceful local fallback. The router is now wired into the live chat path, not just advisory.
- **`/api/term/warm` + warm-on-open** — opening the in-app terminal pre-spawns a live PTY for each
  available CLI brain (Claude/Grok/ChatGPT/Gemini) so switching tabs is instant (his "warm activation").
- Verified: core+renderer syntax + CI inline-script contract intact.

## [1.25.22] — 2026-06-21 — In-app terminal (xterm+node-pty) + cost router + every brain connected

**T4 in-app terminal (the keystone):** real PTY via **node-pty** + xterm.js panel (vendored offline)
with a warm tab per CLI brain (Claude/Grok/ChatGPT-Codex/Gemini) + Shell. Opening a tab **warm-
launches** that CLI inside the app so use is instant + honest (you see the real session). Endpoints
`/api/term/open|write|read|resize|close|list`. **VERIFIED:** opened a PTY, ran `echo`, streamed
output back; xterm assets served 200.
**T3 every brain connected** — `/api/brains`: Claude/Grok/Codex/Gemini CLIs (with OAuth token-file
presence) + 10 API providers incl. **Perplexity**, OpenAI, Anthropic, Gemini-native, xAI, DeepSeek,
OpenRouter, Mistral, Kimi.
**T2 cost-efficiency router** — `/api/route`: trivial→free on-device, medium→flat-rate subscription
CLI ($0 marginal), hard→Claude Max / frontier. Never burns metered tokens when a free/flat brain can
do it. **VERIFIED** simple/medium/hard routing.
- **node-pty uses N-API prebuilds** (ABI-stable) + `npmRebuild:false` + `asarUnpack` → the native
  module loads under **both Node and Electron with NO Visual Studio / compile**. **VERIFIED in the
  packaged .exe:** `pty_available=true`, the in-app terminal ran a command and streamed output back;
  all 4 CLI brains detected available (Claude/Grok/ChatGPT/Gemini) + Perplexity; sees both 5090s.

## [1.25.21] — 2026-06-21 — See ALL GPUs + run max (multi-GPU device probe)

- `gpuInfo()` enumerates **every** GPU + per-GPU VRAM (nvidia-smi multi-row) + total VRAM; new
  `/api/device` reports cores/RAM/all-GPUs/total-VRAM/accel/brain.
- `brainArgs` now scales the context window to **total VRAM across all GPUs** (96GB→64k, 48GB→32k,
  24GB→16k ctx) and adds `--split-mode layer` on multi-GPU so the brain offloads across **all** of
  them (`-ngl 999`; we never set CUDA_VISIBLE_DEVICES, so it sees them all — not locked to CPU).
- **VERIFIED:** `/api/device` on this box → 32 cores, 126GB RAM, **gpu_count=2, total_vram=63.7GB**
  (two RTX 5090s), "offloads across all 2 GPUs". node-pty confirmed working (PTY spawn echoed marker).

## [1.25.20] — 2026-06-21 — Autopilot can ACT: consent honored during agent runs (#1 finisher)

Caught by running the rebuilt .exe (not skimming): the agent loop chose `file_write` natively with
correct args but every step threw "Action tools are blocked" — a SECOND consent check
(`requireActionConsent()` inside the action functions) that the earlier `_permitted` bypass didn't
reach. Now `requireActionConsent` honors an active autopilot run (`agentRunning`): an explicitly-
launched loop = consent for LOCAL sandbox tools (file_write/cmd_run/screenshot/open_app/open_url).
Money/outward tools stay gated by the red-tier check + the fail-closed verifier.
- **VERIFIED on the packaged .exe** (Gemma brain on GPU): agent goal → `via:native`, 1 step,
  "Wrote 21 bytes to diag.txt", **file confirmed on disk**. The multi-step tool loop now genuinely acts.

## [1.25.19] — 2026-06-21 — Make-it-green pass 9: deploy anywhere (#6/#7)

- **Platform-aware brain binary** (`llama-server` on Linux/mac, `.exe` on Windows) — the local brain
  can now run on a Linux VPS / Android-Termux / mac, not only Windows.
- **Dockerfile + .dockerignore** — one-command headless VPS deploy (engine only, no Electron/Chromium).
- **USB launcher** (`scripts/Launch-ABUZ8-USB.bat`) — portable, data-on-stick (`ABUZ8_DATA_DIR`).
- **`docs/DEPLOY-ANYWHERE.md`** — Linux/VPS/Docker/Termux/iPhone-via-Tor-onion/USB, with honest RAM
  floors (3–4 GB for the small brain; a literal 1 GB box can't run a local brain — run cloud-brained).
- **VERIFIED:** headless node server boots with **0 Electron processes** (the VPS/Termux path); brain
  resolution helpers added; Docker + USB artifacts present.
- Honest gap: a prebuilt Linux/ARM `llama-server` isn't bundled in the Windows build — provide a
  standard llama.cpp release for an on-device Linux/Android brain, or run cloud-brained.

## [1.25.18] — 2026-06-21 — Make-it-green pass 8: setup wizard + OAuth redirect bug (#3)

- **Fixed the latent OAuth redirect bug:** the setup modal hardcoded `:8900/oauth/callback`, but the
  app auto-falls-back to a free port — causing `redirect_uri_mismatch`. Now the renderer uses
  `location.origin` and the server-reported `oauthRedirectUri()` (runtime port). **VERIFIED:** on port
  8975 the redirect is `http://127.0.0.1:8975/oauth/callback` (matches), not 8900.
- New **`/api/setup/status`** guided checklist (brain/voice/hears, configured connectors, OAuth
  connected, the exact redirect URI to register, next steps) for a one-click-grade first run.
- Honest note: true zero-credential one-click for the 3 OAuth providers still needs a first-party
  OAuth client (owner registers once); paste-key connectors are already one-paste.

## [1.25.17] — 2026-06-21 — Make-it-green pass 7: build-anything self-drivable (#11)

- New **`code_build`** agent tool wrapping the coder loop (plan→write→run→repair→commit), now exposed
  in the autopilot tool menu alongside `studio_produce` + `osint` — so "build me an app/site" self-drives.
- New **`/api/build/preflight`** reports the toolchain (node/git/npm/embed/comfyui) so build readiness
  is transparent (Node+git aren't bundled — preflight says so instead of silently no-op'ing).
- **VERIFIED 4/4:** preflight reports node/git/npm=true; `code_build` dispatches + scaffolds a project;
  `/api/providers/count` = 102 models / 3 dialects; per-provider models route intact.

## [1.25.16] — 2026-06-21 — Make-it-green pass 6: 100+ models + native Gemini dialect (#2)

- **Gemini-native dialect is now REAL** (was dead code): added a `gemini-native` provider type + a
  `callProviderChatTools` branch that POSTs to Gemini's native `generateContent` with
  `functionDeclarations` (+ catalog entry). Three first-class tool-call dialects now reachable:
  OpenAI-compatible, Anthropic `tool_use`, **Gemini `functionDeclarations`**.
- **100+ models reachable** from the static catalog alone: new `/api/providers/count` reports
  **35 providers / 102 static models** (`hundred_plus:true`), 300+ once OpenRouter is connected.
- **VERIFIED:** `/api/providers/models` → providers=35, static_models=102, hundred_plus=true,
  3 native dialects. (Live cloud tool-call round-trips need the user's API keys; the OpenAI dialect
  is already proven live via the local OpenAI-compatible llama-server.)

## [1.25.15] — 2026-06-21 — Make-it-green pass 5: self-update that actually fires (#4)

- **Fixed** the update-channel URL (was `abuz8/abuz8-os` → now `abuz8studios-ship-it/abuz8-os`) and
  replaced the stale `1.23.0` `release-manifest.json` with the current one.
- **Self-hosted channel:** new `/release-manifest.json` route — every ABUZ8 node advertises its own
  version, so a mesh primary can be the update source for its peers (and gives a real reachable URL).
- **Boot-time check** + 6h interval; **auto-applies** when `settings.auto_update` is on (off by default).
- **Self-code-edits can go live:** `selfUpgradeApply` now supports `rebuild:true` → packs src→app.asar +
  swaps via `scripts/rebuild.sh` (was: stopped at a git commit).
- **VERIFIED 3/3:** self-host manifest advertises version; a newer channel (9.9.9) → `update_available:true`
  with installer_url; same version → not-available (truthful). (Public manifest hosting is the owner's
  one-time publish step — gist/site/public branch.)

## [1.25.14] — 2026-06-21 — Make-it-green pass 4: real Tor private network (#9)

Bundled Tor daemon (tor.exe 0.4.9.9, 21MB expert bundle) + `tor_browse` agent tool + `/api/tor`:
- **Anonymous outbound browsing** through Tor's SOCKS5 (pure-node SOCKS5 client + TLS-over-SOCKS,
  handles .onion sites). **VERIFIED end-to-end:** real circuit, `check.torproject.org` returns
  `IsTor:true` with Tor exit IPs (192.42.116.50 / 185.220.101.14).
- **v3 .onion hidden service** (reach the OS privately from any device incl. iPhone Tor Browser) —
  **opt-in only** (`action:onion`): it exposes the OS, so it is never auto-published; inbound still
  requires the LAN key. (Live exposure not auto-tested in the dev sandbox by design.)
- Tor binaries staged in `build-assets/tor` (gitignored) + bundled via `extraResources`. Replaces
  the previous not-built Tor verdict.

## [1.25.13] — 2026-06-21 — Make-it-green pass 3: a real on-device blockchain (#10)

ABUZ8 now maintains its OWN sovereign chain — `blockchain` agent tool + `/api/chain`:
- Append-only, **hash-linked, ed25519-signed** ledger; `snapshot` commits the running code+version
  on-chain (the app records its "self" into its blockchain each build, at boot).
- `verify` validates the whole chain (signatures + prev-hash links); **tamper-evident**.
- `publish` produces a **real IPFS CIDv1** (raw/sha2-256) for the ledger or code.
- **VERIFIED 5/5:** IPFS CID algorithm matches IPFS's canonical empty-file CID exactly; chain verifies
  VALID; a flipped byte is **detected** (broken_at=1, "content hash mismatch"). The literal "become a
  blockchain" was a category error — this is the real, achievable, running version: a verifiable
  single-node chain + IPFS content-addressed distribution. (Not a P2P consensus network.)

## [1.25.12] — 2026-06-21 — Make-it-green pass 2: real OSINT toolkit (#8)

New native `osint` agent tool + `/api/osint` endpoint — genuine recon, no fakes:
- **whois** (RDAP, redirect-following), **dns** (A/AAAA/MX/TXT/NS/CNAME), **subdomains**
  (crt.sh + Cert Spotter fallback), **ip** geo/ASN (ip-api), **headers**, **username** presence
  across 12 sites, **breach** (HaveIBeenPwned, key-gated via new `hibp` connector — never fabricated),
  and **full** dossier.
- **VERIFIED end-to-end 8/8** on real targets: whois github.com (MarkMonitor), 116 subdomains,
  ip 8.8.8.8 (Google), username 10/12, agent-tool path. Was a dead "osint" persona label → now real.

## [1.25.11] — 2026-06-21 — Make-it-green pass 1: headless CLI + reliability

Toward "every capability green, verified end-to-end" (owner request).
- **#5 Headless/CLI/daemon (no Electron):** new `scripts/headless.js` + `bin: abuz8` — runs the
  engine under **plain node**, zero Chromium. **VERIFIED:** `node scripts/headless.js` → `/health`
  200, **0 electron processes** during the run. This is what a VPS / Termux / Docker runs.
- **#1 Reliability:** wired the 5 connectors that had no call branch (openrouter, serper, tripo,
  image_gen, higgsfield) → all 15 drivable. `connector_call image_gen` returns a real FLUX image.
  **Proved the agent loop drives a tool natively** against the packaged exe (`via:native`, step 1 =
  `file_write` with correct args, local Gemma brain emitting real tool_calls).
- **Honesty + autonomy fixes:** `summarizeToolResult` no longer narrates a blocked/failed tool as
  "Done" (it was misleading the brain into hallucinating success); and an explicitly-launched
  autopilot now passes `_permitted` so it can act on LOCAL sandbox-safe tools (file_write/cmd_run/
  screenshot/open_app/open_url). Money/outward tools stay gated by the red-tier check + fail-closed verifier.

## [1.25.10] — 2026-06-21 — SAFETY: verifier now truly fails CLOSED (money/outward guardrail)

A 35-agent adversarial truth-audit found the outward-action verifier was **failing OPEN on a
parse-miss**: `verifyAction` returned `safe: j.safe !== false`, so a non-JSON / empty / truncated
reply from the verifier brain (`j = {}`) yielded `safe: true` — a brain hiccup could let an email,
social post, or **Stripe op** through ungated. (This contradicts the earlier claim that #17 made it
fail-closed; the `catch` was closed but the success path was not.)
- **FIX:** honor ONLY an explicit boolean verdict; any ambiguous outcome (no parseable JSON, no
  boolean `safe`) now BLOCKS with severity high. Aligns with the money hard-stop guardrail.
- Source-fixed + committed; **needs a rebuild to go live in the .exe** (self-mod does not auto-rebuild).
- Full audit (every capability vs Hermes v0.17 / OpenClaw / Claude Desktop / Replit / Manus / Panda
  OS / Odysseus) → `docs/CAPABILITY-TRUTH-AUDIT-2026-06-21.md`.

## [1.25.9] — 2026-06-21 — IT'S A REAL BINARY: first version-accurate packaged build

The whole night's glue (v1.25.1→1.25.8) is now a **runnable artifact**, not just verified source.
- **Built** `dist/win-unpacked/ABUZ8 OS.exe` (180MB electron + 27MB pruned app.asar) bundling the
  **full omni brain** (Gemma-4-E4B 4.7GB + vision mmproj + nomic embed + LFM2 floor + llama.cpp CUDA
  runtime, 6.8GB), **voice** (Piper+Whisper, 484MB), and **230 skills** — **7.45GB self-contained**.
- **VERIFIED on the packaged `.exe`** (not node): launches, `/health` 200 in ~1.5s; `/api/onboard`
  greets *"ABUZ8 OS online — Gemma 4 E4B omni brain loaded on GPU, neural voice ready, I can hear
  you. 230 skills and 30 tools connected"*; `/api/connectors` lists all **15** (incl. youtube,
  comfyui, higgsfield); voice=true, hears=true.
- **Honesty fix:** `/health` reported a stale `1.25.0` / "62 skills" — corrected `APP_VERSION` to
  `1.25.9` and the build stamp to "230 skills + 15 connectors + studio/youtube".
- Still YOUR move to SELL it: an OV code-signing cert (signing was skipped — `cscInfo=null`), and the
  one-time OAuth sign-ins (Google/YouTube, Higgsfield, etc.). The binary itself is done.

## [1.25.8] — 2026-06-21 — Glue pass 4: YouTube connector (the channel posts itself)

New **`youtube`** connector (15 total) riding the existing Google OAuth (the `youtube.upload`
scope was already in the sign-in): `channel` (stats), `videos` (your uploads), and a **real
multipart `upload`** of a rendered `.mp4` (no fake — builds a `multipart/related` body and POSTs
to the YouTube Data API). Closes the studio loop: `studio_produce` → ComfyUI render → `youtube.upload`.
- **VERIFIED:** def + test + call registered; connector appears in the live list; e2e regression PASS.
- App is now **v1.25.8**. (Hands-free avatar channel — needs only your one-time Google OAuth.)

## [1.25.7] — 2026-06-21 — Glue pass 3: `studio_produce` — the brain makes media on command

New agent tool **`studio_produce`**: an **image now** (free FLUX, or your `image_gen` connector) or a
**video** — pass a ComfyUI workflow JSON to render on your GPUs, or route to Wan2GP / Higgsfield
(Sora/Veo/Kling). Wired in `callLocalTool` + `agentToolSchemas` + `KNOWN_AGENT_TOOLS`.
- **VERIFIED:** registers (dispatch + schema + known); onboard-greet + studio e2e regression PASS.
- App is now **v1.25.7**. (The video factory now has a brain-callable produce verb.)

## [1.25.6] — 2026-06-21 — Glue pass 2: the BRAIN can drive every connected app (`connector_call`)

The keystone of the unification — new agent tools **`list_connectors`** + **`connector_call`** let the
brain drive any connected app/service by natural-language command:
- `comfyui` (render video), `wan2gp`, `livecrm` (your CRM), `dealer360`, `github`, `stripe`, `gmail`,
  `gcal`, `higgsfield`, `cloudflare`, … — one tool, all apps.
- Wired in `callLocalTool` dispatch + `agentToolSchemas` + `KNOWN_AGENT_TOOLS`; routes to the proven
  `connectorCall` framework (encrypted vault for secrets).
- **VERIFIED:** tools register (dispatch + schema + known-set); onboard-greet + studio e2e regression PASS.
- App is now **v1.25.6**.

## [1.25.5] — 2026-06-21 — Glue pass 1: dealer + CRM + Wan2GP studio as connectors (one control surface)

ABUZ8 OS becomes the single control surface for YOUR own apps (sovereign — drives them, never rewraps):
- New connectors: **`wan2gp`** (local video studio, default `:7860`), **`livecrm`** (your FastAPI CRM),
  **`dealer360`** (360Car dealer / 3D). Each has reachability `test` + a generic `get`/`post` proxy so
  ABUZ8 drives the app over HTTP when it's running. Joins comfyui / higgsfield / github / stripe /
  gmail / gcal / openrouter / serper / tripo / image_gen → **14 connectors**.
- **VERIFIED live:** all 14 register; the onboard-greet + studio e2e still PASS.
- App is now **v1.25.5**.

## [1.25.4] — 2026-06-21 — Wakes up, probes, and says hello in his own voice + studio glue (ComfyUI + Higgsfield)

ABUZ8 OS now **onboards itself on wake** — it probes, then greets you out loud in its bundled voice.
- **`/api/onboard`** probes the system (brain · GPU · neural voice · hearing · skills · tools) and
  composes a spoken hello; `boot()` fetches it and **speaks it via Piper** (autoplay on).
  **VERIFIED end-to-end:** greeting composed + synthesized to a 736 KB WAV — *"Hello Ahmad. ABUZ8 OS
  online. Portable Core brain loaded on GPU, neural voice ready, and I can hear you. … just say Abuu."*
- **Studio glue (the YouTube/avatar video factory):**
  - **ComfyUI connector** (`local`, default `http://127.0.0.1:8188`) — drives your workflows on the
    GPUs (`stats`/`queue`/`history`). **VERIFIED live: ComfyUI online.**
  - **Higgsfield connector** (`mcp`) — official hosted MCP (Sora 2 / Veo 3 / Kling 3 / Nano-Banana),
    browser OAuth at `https://mcp.higgsfield.ai/mcp`, authorize your own account (no key stored).
  - Both join the encrypted-vault connector framework (`test`/`call`) beside Stripe/Gmail/GitHub/…
- App is now **v1.25.4**.

## [1.25.3] — 2026-06-21 — Always-on, speak-first by DEFAULT (no click, no typing) + e2e voice verified

ABUZ8 OS now listens for the wake word **"Abuu" from the very first launch** — talk to it
immediately, never touch the keyboard.
- **Wake loop defaults ON** (`renderer`): listens from first launch + auto-resumes across launches;
  respects an explicit off (`wake_on === '0'`). Was: off until you clicked the toggle once.
- **Gesture-free, always-on audio** (`main.js`): `autoplayPolicy: 'no-user-gesture-required'` so
  spoken replies play without a click, and `backgroundThrottling: false` so the wake loop keeps
  running when the window is backgrounded. (Mic was already auto-granted; the wake → record → STT →
  brain → TTS loop + barge-in + sentence-chunked playback were already coded.)
- **VERIFIED end-to-end through the app's OWN endpoints** (real backend under node, fresh seeded data
  dir, fully offline): `/api/voice/status` → `piper-neural`, `neural_tts` + `neural_stt` true, 6
  voices; `POST /api/tts` → 221 KB WAV; `POST /api/stt` → transcribed it back
  (*"…your sovereign Jarvis."*). The speech↔text round-trip works through the shipped HTTP API.
- App is now **v1.25.3**.

## [1.25.2] — 2026-06-21 — Voice BUNDLED + 168 Hermes skills migrated (talks + listens offline; 230 skills)

ABUZ8 OS now **speaks and hears on a fresh install**, and carries the full fused skill library.

### Voice is bundled — the #1 "make it talk" blocker is CLOSED
- **Piper TTS** (+ `en_US-ryan-high`, `en_US-hfc_female`, **`ar_JO-kareem` Arabic**) + **whisper.cpp STT**
  (`whisper-cli`/`server`/`stream`) + `ggml-base.en` model staged in `build-assets/voice` and shipped
  via `extraResources` → `resources/voice`. New **`seedBundledVoiceOnce()`** seeds them into
  `dataRoot/attachments` on first run, so `piperPaths()`/`whisperPaths()` resolve them and
  `piperAvailable()`/`whisperAvailable()` flip true — **no SAPI fallback, no user install**.
- **VERIFIED live, fully offline:** Piper synthesized a sentence (127 KB WAV) → Whisper transcribed
  it back verbatim — *"Hello from Abuz8, your Sovereign Jarvis."* (573 ms). It talks and it hears.

### Skill library: 62 → 230 (all Hermes + OpenClaw fused)
- Migrated **168 Hermes** skill packs (`skills` + `optional-skills`) on top of the 62 OpenClaw packs →
  **230 bundled `SKILL.md` packs**, seeded on first run + embedded for semantic recall. Knowledge
  only — no scripts, tokens, or secrets copied.

- Voice payload (binaries/models/voices) gitignored + staged at build, same as the brain GGUFs.
- App is now **v1.25.2**.

## [1.25.1] — 2026-06-21 — Vision awareness wired into the brain (it knows it can SEE you)

The bundled MediaPipe face/gesture pipeline already tracked presence/attention/gaze/hand-gesture
(`_presence`) — but the brain was never told what the camera saw. Now it is:
- New **`presenceDirective()`** injects the LIVE vision state (present · attentive · gaze · **last
  hand gesture**) into the brain's context on every turn — in **both** `composeSystem` (full) and
  `voiceSystem` (voice). The agent genuinely knows it can see you and reads your hand motion.
  Returns `''` when there's no fresh presence, so it stays silent otherwise. Unit-tested.
- This connects the existing offline MediaPipe vision (`face_landmarker.task` +
  `gesture_recognizer.task`, bundled in `src/vendor/mediapipe/models/`) to the reasoning loop.
- App is now **v1.25.1**.

## [1.25.0] — 2026-06-21 — Semantic RAG memory + verified native agent loop + BOM-safe input

The agent now **remembers by meaning** and its autonomous loop is **verified end-to-end**.

### Semantic memory (RAG) is live
- **Bundled `nomic-embed-text-v1.5` (f16, 262 MB)** ships beside the brain. `embedModelFile()` now
  finds an embed GGUF either in `models/embed` (user override) **or beside the brain** (bundled), so
  vector RAG works **out-of-box** — no download. `retrieveMemories` switches from keyword to true
  cosine-similarity recall.
- **Verified live:** wrote "favorite systems language is Rust…", indexed (`embed_engine: nomic`),
  then recalled it from the lexically-unrelated query "which language does the user prefer for
  low-level coding" (`engine: vector`, score 0.58). It remembers by meaning, not keywords.

### Native agent loop — verified, and a real bug fixed
- The **local** native tool-calling loop (Gemma 4 via `--jinja` → structured `tool_calls`) is now
  **proven end-to-end**: a goal ran `get_time`, observed the result, and finished (`via: native`).
  This pairs with the universal cloud adapter (1.24.7) so tool-calling is reliable on every brain.
- **Fixed a payload-dropping bug:** `getBody` now strips a leading UTF-8 **BOM** before `JSON.parse`.
  A BOM (common from some clients/files) previously made parsing fail silently, so endpoints without
  a `body.raw` fallback (e.g. `/api/agent/run`) received an empty goal. Hardened at the root.
### Skills breadth — 0 → 62 bundled packs
- **62 OpenClaw skill packs now ship with the app** (`build-assets/skills` → `resources/skills`) and
  are seeded into the data root on first run, then **embedded for semantic recall** so the agent
  surfaces the right skill by meaning (`retrieveSkills`). Covers notion, obsidian, slack, discord,
  github, weather, summarize, whisper, image-gen, x-cli, trello, tmux, and more. Only `SKILL.md`
  knowledge is bundled — no scripts, tokens, or secrets are copied. (`seedBundledSkillsOnce`,
  `bundledSkillsDir`.)

- Version constants reconciled (`APP_VERSION` had lagged package.json). App is now **v1.25.0**.

## [1.24.9] — 2026-06-20 — GitHub own-account connector (sign into YOUR account, ship code)

Extends the existing own-account connector framework (the Desktop-Commander model — encrypted
vault + live `test`/`call`, already shipping Stripe / Cloudflare / Gmail / GCal / OpenRouter /
Serper / Tripo / image-gen) with **GitHub**, so the agent can use *your own* account to create
repos, list repos, and ship projects from one place — no rewrapping, your token, your data.
- `CONNECTOR_DEFS.github` + `connectorTest('github')` (GET `/user`) + `connectorCall('github', …)`
  with `user` / `repos` / `create_repo` actions. Secret stored in the encrypted vault.
- Endpoint + headers **live-validated** against the real GitHub API.
- App is now **v1.24.9**.

## [1.24.8] — 2026-06-20 — Performance-aware brain routing

`bestFrontierProvider` now picks the **healthiest** connected brain by measured recent success
rate minus a latency penalty (recency-weighted EWMA, keyed by provider name) instead of a hardcoded
priority list — so the router prefers the brain that's actually answering well right now.
- New: `_providerHealth`, `recordProviderHealth`, `providerHealthScore`; wired into `providerReply`
  and `providerToolTurn` (record success + latency on a win, failure on error). Static priority
  remains the tiebreaker for brains with no measurements yet. Ranking unit-tested.
- Note: council/swarm already existed (`councilThink`, `runSwarm`, `swarmTask`) — not re-ported.
- App is now **v1.24.8**.

## [1.24.7] — 2026-06-20 — Universal LLM tool-call adapter (native tool-calls from ANY brain)

The agentic loop now gets **structured native tool-calls from cloud/API brains too** — not only the
local Gemma. One internal OpenAI-format tool schema (`agentToolSchemas`) is translated into each
provider's **native** dialect and the response normalized back:
- **OpenAI-family** (OpenAI / OpenRouter / Gemini-compat / DeepSeek / xAI-Grok / Groq / Together /
  LM Studio): pass `tools` + `tool_choice`, parse `choices[].message.tool_calls`.
- **Anthropic**: tools as `input_schema`, parse `content[].type==='tool_use'`.
- **Gemini native**: `functionDeclarations`, parse `functionCall` (for native endpoints).
- `runAgentLoop` now tries `providerToolTurn` (native) **before** the text/regex fallback when a
  cloud brain is the engine — closing the "reliable tool-calling only on the local brain" gap.
- New: `toAnthropicTools`/`toGeminiTools`, `parseProviderToolCall`, `callProviderChatTools`,
  `activeApiProvider`, `providerToolTurn` in `portable-core.js`. Conversion + parsing unit-tested.
- App is now **v1.24.7**.

## [1.24.6] — 2026-06-20 — Gemma 4 omni brain + working runtime + brain actually bundled

### Bundled brain = a verified omni edge model (Gemma 4)
- **Primary bundled brain = Gemma 4 E4B (Q4_K_M, ~4.75 GB, Apache-2.0)** — the smallest fully
  *omni* edge model: native **text + vision + audio**, 128K context, native function-calling.
  `EMBEDDED_BRAIN_CATALOG` now leads with `gemma-4-e4b`, then `gemma-4-e2b` (omni floor for
  low-RAM machines), then the LFM2 ladder as the deep offline fallback. (Replaces the Qwen3.5-4B
  catalog entry from 1.24.5 — chosen for: smallest-that-is-omni, Apache-2.0 bundle/sell-safety,
  and llama.cpp-native support.)
- **Verified live** (dual RTX 5090, CUDA 13): the OS's own `llama-server` loads Gemma 4 E4B, emits
  clean native tool-call JSON (`finish_reason:tool_calls` → `get_weather({"city":"Paris"})`) at
  ~180 tok/s, and reads a test image via its `mmproj-F16.gguf` sibling. `modalities = {vision,
  video, audio}`.

### Fixed: the runtime was broken; the brain wasn't actually shipped
- **Runtime refreshed to llama.cpp b9743 (CUDA 13.3, Blackwell-capable, libmtmd multimodal).** The
  previously bundled `llama-server.exe` was missing its core `ggml-base`/`ggml-cpu`/`llama`/`mtmd`
  DLLs and failed to launch (`STATUS_DLL_NOT_FOUND`) — a brain that could not start.
- **Brain bundling is now canonical in the build config** — `extraResources` ships
  `build-assets/brain` → `resources/brain` via electron-builder, not fragile side-scripts. The two
  packaging scripts (`make-installer.ps1`, `make-portable-bundle.ps1`) no longer strip GGUFs — that
  deletion is exactly what shipped brainless installers before.
- App is now **v1.24.6**.

## [1.24.5] — 2026-06-20 — Real embedded brain + safety hardening + docs honesty pass

### Embedded brain is now REAL (make-it-true)
- **Primary bundled brain = Qwen3.5-4B (Q4_K_M, 2.55 GB, Apache-2.0)** — the leading sub-4GB
  agentic tool-caller (2026). `EMBEDDED_BRAIN_CATALOG` is no longer empty: it declares Qwen3.5-4B,
  resolved from the build's `brain/` dir beside `llama-server.exe`. **Verified live** — the OS's own
  `llama-server` loads it and emits correct tool-call JSON (`{"tool":"open_app",...}`).
- **One brain also sees** — ships `mmproj-F16.gguf` (0.63 GB) beside the brain, so the same model
  serves vision via `mmprojSibling()`. Brain+vision footprint ≈ 3.18 GB — under the 4 GB ceiling.
- **`MODEL_CATALOG`** now lists Qwen3.5-4B as the recommended first-run download; larger models still
  auto-win on capable hardware (`selectEmbeddedBrain`), and any GGUF in the models shelf is auto-found.

### Safety hardening
- **`verifyAction` is now fail-CLOSED** — if the pre-flight verifier can't run, outward/irreversible
  actions (`send_email` / `social_post` / `x_post` / `stripe_op`) are **blocked pending explicit
  approval** instead of allowed (was fail-open). Protects the money/account guardrail.

### Documentation honesty pass
A guardrail/honesty pass over the docs to make every marketing claim match the grep-verified reality
of the source. Overclaims create FTC/chargeback risk; these corrections remove them.

- **Bundled brain / "offline day one"** — corrected to **bring-your-own-brain on first run**.
  Three LFM2 GGUFs physically ship in `resources/brain`, but none is auto-selected on a fresh
  install (the embedded-brain catalog is empty; Nemotron is catalogued but never auto-downloaded),
  so out of the box the OS falls back to canned "Portable Core" text until the user selects or
  downloads a model. Cloud providers also supported. **(✅ RESOLVED in 1.24.5 — Qwen3.5-4B is now the bundled primary brain, verified loading + tool-calling.)**
- **Voice / STT / vision / RAG** — Piper TTS, Whisper STT, local vision (Gemma3+mmproj), and
  vector-RAG embeddings are fully **coded** but ship with **no model/binary**. Corrected to:
  out of box uses **Windows SAPI voice + browser STT + keyword memory**; neural voice/STT/vision/RAG
  become available after installing the voice/STT attachments and an embed/vision model.
- **Channels** — corrected to: two-way **Telegram** gateway is built in; **Slack/Twilio require
  manual webhook setup**; broader channels (Discord/n8n/Zapier "universal gateway") are roadmap, not
  shipped.
- **Desktop Commander / Windows-MCP** — clarified that these are **not** bundled or fused; they are
  compatible only via **manual MCP import** of your Claude Desktop config. ABUZ8's *own* native OS
  control (shell exec, app launch with a 19-target allowlist, screenshot) is genuinely built and is
  unchanged.
- **"Fusion of 10 products"** — corrected to the grep-verified tally: **3 fused** (Claude Desktop,
  Manus-core, Hermes-architecture), **5 partial** (OpenClaw, CrewAI, Cursor, Desktop-Commander
  capability, Antigravity), **1 claimed-only** (Mercury — a provider-catalog entry, no diffusion
  code), **1 absent** (Windows-MCP/Desktop-Commander as named third-party fusions).
- **vs Hermes** — dropped any "more powerful than Hermes" framing; ABUZ8 is **more sovereign and
  embodied** (bundled runtime, voice, avatar, safety spine) but **narrower** on agent-loop
  correctness, skills breadth, and channel count.
- **Competitive doc fix** — `docs/competitive/HERMES-RECHECK-2026-06-19.md` cited a non-existent
  symbol `harvestAndLearnOnce`; corrected to `reviewTurn()` (per-turn fact capture) +
  `selfLearnOnce()` (tool-frequency learning). Also corrected its "still missing" list: **profiles
  (multi-isolated instances)** and **automation blueprints** both shipped in v1.24.0.
- Added **`docs/BUILT-VS-STATED-2026-06-20.md`** — the full built-vs-stated audit behind these edits.

## [1.24.4] — 2026-06-20 — True three-panel agentic shell (Claude Desktop / Hermes parity)

Promoted ABUZ8's existing 4-column grid into a real, persistent **left · center · right**
agentic shell that finally looks and feels like Claude Desktop + Hermes. Purely additive —
nothing removed; all 30+ views, overlays, density, nav-rail, and resizers keep working.

- **Right "Agent Work" panel** — the artifact pane (`#artifact-pane`) is now a dual-mode panel
  with **Work** (artifacts/preview — existing iframe/code/markdown tabs) and **Activity** (a live
  tool-call feed). It **auto-opens the instant the agent calls a tool** and streams each call
  (name · args · ok/err · time), mirroring Claude's "artifacts open on the right" + Hermes's
  preview rail. Resizable (`#art-resize`), dockable left/right, closable; state persisted.
- **Claude-style centered reading measure** — chat thread + composer share a centered
  `--measure` (820px) so prose never runs edge-to-edge; full-width on phones.
- **Left** — existing nav rail + sessions context pane (`#ctx-pane`), collapsible (unchanged).
- **Responsive** — wide (>1100px) = true split (center+right share, draggable divider);
  tablet (761–1100px) = right pane floats over center; phone (≤760px) = right hidden, full-width chat.
- Persisted open/close intent (`aw_open`); the pane returns in agentic views once you've opened it.
- App is now **v1.24.4**.

## [1.24.3] — 2026-06-19 — Mobile app: streaming PWA that connects to your home server

ABUZ8's own phone app — a direct, Manus-style chat line to the agent on your home server.
Installable to the home screen, no app store needed; the brain/tools/OS-control stay on the server.

- **Connect to home server** — a connection screen points the app at your ABUZ8 OS (server URL +
  access key), remembered across launches; auto-connects when opened from the server's own address.
  Live connection dot + "Change server" in More.
- **Streaming chat (Manus-style)** — replies stream token-by-token over `/api/chat/live`, with a
  live **thinking/tool strip** (the agent's notes + tool chips as it works) and a stop button.
- **Session history** — a slide-over drawer lists your chats (`/api/sessions`), tap to reopen
  (`/api/session?id=`), or start a new one.
- Retained + polished: spoken replies (Piper TTS), one-tap **Brief**, **live activity**, quick actions.
- **PWA** — installable (manifest + service worker), standalone, safe-area aware; served at `/m`.
- App is now **v1.24.3**.

## [1.24.2] — 2026-06-19 — Hermes-parity context references + artifacts gallery

Closed every remaining document/context gap vs the newest Hermes desktop agent.

- **Typed `@`-context references** — `@file:` `@folder:` `@line:path:start-end` `@url:`
  `@diff` `@staged` `@git` `@terminal` expand **server-side** into the model context via the new
  **`/api/context/expand`** endpoint, with a **soft/hard token budget** (truncates/omits so a big
  file or diff can never blow the window). An `@`-popover suggests the kinds; file/folder open a picker.
- **Git-aware context** — `@diff` / `@staged` / `@git` inject live `git diff` / staged / `log -p`
  from the working folder.
- **In-app drag + line refs** — Document Center file rows are draggable into chat (drop = `@file:`),
  each has a ➜ button, and selecting text in a preview adds a precise `@line:` range.
- **Terminal → chat** — the Operator terminal has a ➜ chat button that attaches output (or your
  selection) as context (and as `@terminal:last`).
- **Searchable artifacts Gallery** (`view-gallery`) — a retrospective, searchable, paginated grid
  of every image/file/link in the conversation; local image thumbnails lazy-load via `/api/fs/read`;
  files send back to chat as `@file:` refs.
- App is now **v1.24.2**.

## [1.24.1] — 2026-06-19 — Mind cockpit · Document Center · cross-platform foundation

Three vision pillars, built and verified end-to-end. All additive.

- **Mind cockpit** (`view-mind`) — the see-through "glass engine." Live brain + mood indicator,
  real-time **CPU/RAM/GPU/VRAM gauges**, a streaming **"live thinking"** feed (from `/api/activity`),
  and recent **tool calls** (from `/api/audit`). Auto-refreshes while open. *Verified: packed in
  app.asar; `/api/dashboard` `ok:true` + `/api/activity` `events[]` live.*
- **Document Center** (`view-docs`) — browse and preview **your own files locally** — photos, PDFs,
  text, and code — nothing leaves the machine. New backend **`/api/fs/read`** (text inline, images +
  PDF as base64, 12 MB guard, binary noted) over the existing `/api/fs/list` tree. Home-folder button.
  *Verified: text + image (jpeg) + dir-list all return live.*
- **Cross-platform foundation (Win/Mac/Linux)** — CLI brains now launch via `cliLaunch()` (Windows →
  `cmd.exe` shim; macOS/Linux → direct `PATH` spawn via cached `onPath()`); the four bin-finders are
  POSIX-aware. **electron-builder** config in `src/package.json` (NSIS/portable · dmg/zip · AppImage/deb,
  x64+arm64) and a **CI `release` matrix** building native installers on each OS runner. Signing wired
  via secrets when present. *Verified non-breaking on Windows: Claude brain returns `PONG` through the
  refactored path.* See `docs/CROSS-PLATFORM.md`.
- App is now **v1.24.1**.

## [1.24.0] — 2026-06-19 — Sovereign Operator: spine, HUD, voice, avatar, fluidity

The biggest single pass — closing the Hermes-Desktop gaps and building the operator spine.
A grep-verified re-audit (`docs/competitive/HERMES-RECHECK-2026-06-19.md`) confirms ABUZ8 now
**leads** Hermes on the sovereign-operator axis and is at parity on the rest, with a short
UI-polish punch list. All additive; nothing removed.

- **Fluidity layer** — overlay-view pattern (peripheral surfaces float over the live workspace),
  hash deep-linking + restore-last-view, smooth transitions, collapsible hover-peek nav-rail.
- **Safety spine** — command danger-guard (HARDLINE refuse + DANGEROUS approval, NFKC/backslash
  de-obfuscation), MCP env scrub, global kill switch (`/api/halt`), green/yellow/red **tiered
  approval** + persistent **approval queue** + **decisions log** + unified **`/api/audit`** timeline,
  and an adversarial **verification spine** (`verifyAction` pre-flight on send/post/charge).
- **Memory + learning** — encrypted AES-256-GCM **vault**, **per-turn learning** (`reviewTurn` →
  vector memory, deduped), real local RAG persistence.
- **Observability + money** — `/api/usage`, `/api/cost/summary` (per-day), per-call token split,
  **revenue ledger** (`/api/revenue/*`), Stripe lane (`/api/store/*`, key-gated), 14-day usage chart.
- **Autonomy** — goals verify/retry(3) + failure escalation, **cron-expression** schedules +
  run-history, **automation blueprints**, headless **daemon** (`--server` + `install-autostart.ps1`),
  `/api/brief`.
- **Voice + avatar** — offline duplex (Piper TTS + Whisper STT, sentence-chunked, verified
  round-trip), rigged **GLB/VRM avatar** engine (offline-bundled loaders) with viseme lip-sync +
  2D fallback.
- **Operator HUD** (`view-spine`) — world-state, approvals (approve/deny), audit, brief,
  escalations, file tree, **terminal**, usage chart, **profile** switcher, Halt — one screen.
- **Reach + extensibility** — channel directory + Telegram captions/media-ack, DM pairing,
  per-task model routing, ComfyUI bridge, `/api/fs/list`, **profiles** (isolated soul/sessions/
  memory), 8 local-first **skill packs**, live structured **tool-call cards**, prompt queue + slash
  popover, ^Tab/^1-9 session switching.
- App is now **v1.24.0**. (Account username/password login + LAN PIN already shipped.)

## [1.23.0] — 2026-06-16 — Convergence Pack: Coder loop · Deploy · Mobile · Goals · Learning v2 · Ark

The capability gaps vs Hermes (Nous), Panda OS, and the Agent-OS funnels — closed in one pass.
Everything additive and guarded; command execution is sandboxed to the project workspace and
limited to a dev-toolchain allowlist (npm/npx/node/git/vite/next/expo/eas/python…).
- **Coder loop** — `coderRun()`: frontier-first plan → write full files → run build/tests →
  read errors → repair, looping in a sandboxed `workspaces/<project>` dir. Falls back to the
  local brain when no provider is connected; honestly skips exec when npm/node aren't on PATH.
  `/api/coder/run` · `/projects` · `/files` · `/file`. *Verified: endpoints live, files written.*
- **Deploy pipeline** — `deployRun()`: Vercel (`npx vercel --prod`), GitHub (`gh repo create --push`),
  and GitHub Pages — returns the live URL; honest errors when a CLI/token is missing.
  `/api/deploy/run` · `/targets`.
- **Mobile build (the open lane)** — `mobileScaffold()` writes a runnable Expo app offline every time;
  `mobileBuild()` produces a real Android APK via EAS when an Expo token is set, else `expo export`
  web. `/api/mobile/scaffold` · `/build`. *Verified: App.js/app.json/eas.json/package.json on disk.*
- **Goals — long-horizon autonomy** — `runGoal()`: decompose → subagent step → strict verify →
  retry, with resumable goal state under `goals/`; new scheduler kind `goal` runs them unattended.
  `/api/goals` · `/create` · `/run` · `/get`.
- **Self-learning v2** — beyond the tool-frequency counter: `synthesizeSkillsOnce()` has the brain
  write real `SKILL.md` files from successful traces, embeds them, and `retrieveSkills()` recalls
  them semantically into the system prompt. Runs every 15 min. `/api/skills/synthesize` · `/feed` · `/recall`.
- **Self-update channel** — a default release manifest URL is now wired (`release-manifest.json`);
  `applyUpdate()` downloads and launches the installer. `/api/update/apply` · `/url`.
- **The Ark expanded** — +Novita, Nebius, AI21 (Jamba), Nous Portal (Hermes); provider key-health
  check and palette quick-switch. `/api/providers/health` · `/quick`.
- **Build view** — new **Build** tab + command-palette entries: Coder, Deploy, Mobile, Goals,
  and the live learned-skills feed in one screen.
- App is now **v1.23.0**.

## [1.22.0] — 2026-06-12 — Sessions · command palette · file attachments · self-update · 3D talking avatar

Closing the last UX gaps vs Hermes, plus a real talking character.
- **Chat sessions** — named, searchable, durable threads (`+ New`, `Chats`, rename, delete, search).
  Server-side at `sessions/*.json`; the chat auto-persists. `/api/sessions`, `/api/session`.
  *Verified: save → list → search → delete.*
- **Command palette (Ctrl/Cmd+K)** — fuzzy launcher for every view + action (new chat, Brief me,
  Studio, check updates…). Ctrl+Shift+N = new chat.
- **File attachments — understands any file** — 📎 / drag-drop: **PDFs** (bundled pdf.js text
  extraction), **images** (read by the vision brain), **text/code/csv/json/md/logs** (read directly);
  binary files noted honestly. Content is fed to the agent as hidden context, keeping the chat clean.
- **Self-update** — `/api/update/check` against a configurable release manifest ({version,
  installer_url}); honest "no channel configured" until set. APP_VERSION 1.22.0.
- **3D talking avatar** — the avatar window now renders a real-time **Three.js character head** whose
  mouth/jaw **lip-syncs to his TTS** (amplitude-driven), with head motion + blinks; non-breaking
  fallback to the 2D avatar if WebGL is unavailable. (A photoreal GTA-grade model is an art-asset swap.)

## [1.21.0] — 2026-06-12 — Messaging gateway (chat with ABUZ8 from Telegram) + CEO/SEO cockpit

Benchmarked against Hermes Agent v0.16.0 (v2026.6.5). ABUZ8 already matches/exceeds most of
it (Electron desktop app + installer, dashboard, providers, memory, skills, kanban, MCP — plus
Operator, Forge, vision, Earn, Second Brain, the business cockpit that Hermes lacks). The one
signature feature Hermes had that we lacked — a **two-way messaging gateway** — is now built:
- **Telegram gateway** — talk to your sovereign agent from a normal Telegram chat anywhere.
  A 3s poll loop (`tgPollOnce`) reads incoming messages via getUpdates, runs them through the
  full agent (`agenticReply`), and replies via sendMessage (with a typing indicator). Reuses the
  Telegram bot token you connect in Social. Toggle in **Connect → Telegram gateway**.
  `/api/gateway/telegram`. *Verified: status/enable/disable + poll loop wired.*
- **CEO desk + SEO** in the Command Center — the CEO seat now has an objective box (→ the
  orchestrator runs the agent team) + Brief me, and an SEO card (keyword → SEO article) so all
  six C-suite seats (CEO/CFO/CRO/COO/CKO/CTO + SEO) are on one screen.
- Honest: the gateway needs your free Telegram bot token (@BotFather) connected in Social; on a
  CPU brain replies take ~30-60s (instant with a connected frontier model or on GPU).

## [1.20.0] — 2026-06-12 — Command Center (HUD) + Content Studio — the business-OS cockpit

The pieces that turn ABUZ8 into a one-person-company OS (CEO/CFO/CRO/COO/CKO/CTO in one).
- **Command Center (HUD)** — a single cockpit aggregating the whole business live: Revenue (CFO,
  Stripe), Growth (CRO, content loops + posts + platforms), Operations (COO, missions + schedules),
  Knowledge (CKO, notes + memories), the Team (CTO, classes + providers + connectors + vision),
  and the latest activity. `/api/hud`. *Verified pulling live data across all functions.*
- **Content Studio** — the production gap, filled: **image generation** (free best-effort via
  Pollinations; reliable with a FREE Hugging Face token, hf_… → FLUX, or an OpenAI images key) and
  **SEO articles** (keyword → full H1/H2 markdown article). `/api/studio/image|article`. New
  `image_gen` connector. *Verified: real structured SEO article generated; image path honest.*
- Honest: Pollinations gated its free tier (now rate-limited/402), so image gen is best-effort
  free and reliable with a free HF token (30-second setup) — not faked.

## [1.19.0] — 2026-06-12 — Second Brain (the missing piece from Obsidian/Understand-Anything)

Researched the field (Julian Goldie's Hermes Agent OS, Nous Hermes Agent, Jarvis OS, Obsidian,
Understand-Anything, Paperclip) — ABUZ8 already matches most (self-improving skills, persistent
memory, orchestration-as-company, local-first, voice, Operator, MCP). The one genuinely missing,
high-leverage piece for organization + revenue was a **second brain / knowledge vault** (the common
thread across Obsidian + Understand-Anything + claude-obsidian + Paperclip-notes). Built it:
- **Capture any source** — drop a link or text → ABUZ8 reads it (URL fetch + strip), the brain
  auto-titles + summarizes + extracts key points + tags, and **files it as Markdown YOU own**
  (`brain/notes/*.md`) + indexes it into the RAG vector store.
- **Ask your own knowledge** — questions retrieve from your notes + past work and answer with them.
  *Verified: ingested a note → brain summarized it (title + 4 key points) → "what price & market?"
  answered "$29/mo, Muslim solo entrepreneurs…" straight from the note.*
- New **Second Brain** view; `/api/vault/ingest|ask|notes|note`.
- (Honest: next-best migrations identified but not yet built — a multi-modal **Content Studio**
  (image generation for posts, the marketing gap) and a unified **HUD mission-control** cockpit.)

## [1.18.0] — 2026-06-12 — Learn from Claude: import your full history into memory

A "Learn from Claude" button in the Claude Bridge that ingests **every past conversation**
into ABUZ8's long-term RAG memory, so it recalls and builds on your prior work.
- **Honest mechanic:** Claude's chats live in your claude.ai account (the desktop app is
  cloud-backed, local cache is opaque), so the complete path is the one-time **claude.ai data
  export** (`conversations.json`). The button makes importing it one tap.
- **Scan** finds a `conversations.json` in Downloads/Desktop/Documents; **Choose file** imports
  any export; both ingest every conversation into `events.jsonl` + the vector store, then
  background-index for recall. Robust parser handles the export shape (chat_messages / content).
- `/api/bridge/learn/scan`, `/api/bridge/learn/import {path|json}`. *Verified: a 2-conversation
  export imported (2 convos, 4 messages) into both the memory log and the RAG vector index.*
- Result: relevant past Claude work is retrieved into ABUZ8's reasoning context automatically —
  it genuinely gets smarter from your history. (Recall quality scales with a stronger embed setup.)

## [1.17.0] — 2026-06-12 — Earn: the dead-simple money machine + first-run wizard

Onboarding a 5-year-old could finish, wired to the engine we already built (faceless
content → auto-post → your link).
- **First-run wizard** (shows on first launch): Hi → pick your niche (chips) → your money
  link (optional) → connect one account (or skip) → 🎉 "You're earning." Sets `onboarded`.
- **Earn tab** — one screen: a big **Start earning** button, then a live "money machine is ON"
  dashboard (posts made, where it's posting, Post-now / Pause, connect-account nudge).
- **`/api/earn/start`** creates a recurring `content_loop` (drafts faceless content on your
  topic + appends your link, posts to connected socials, fires one immediately),
  **`/api/earn/status`**, **`/api/earn/stop`**. *Verified: start creates+runs the loop; status
  reflects it.*
- **Honest:** it automates the *work* that earns (content + posting + your link) and starts
  today; real income builds with your audience over time, and auto-posting needs one social
  account connected (the UI nudges you, and the easy ones — X/Telegram/Bluesky/Discord — take seconds).

## [1.16.0] — 2026-06-12 — One unified multimodal brain (leaner + sees)

Consolidated to a **single brain** that reasons, tool-calls, AND sees — and deleted the
redundant text-only model. You can't bolt a vision projector onto a model it wasn't trained
for, so instead of keeping Nemotron (text) + Gemma (vision) we made **Gemma 3 4B the one brain**:
- `ensureEmbeddedBrain` now loads the main model **with its `--mmproj` vision projector** when one
  sits beside it → one llama.cpp server handles text *and* image requests. `callLocalVision`,
  `jarvis/see`, the Forge, and the Operator all route to this single brain.
- **Deleted Nemotron 4B (−2.8GB).** Local models went **6.4GB → 3.7GB**; the installer drops
  ~7.5GB → ~4.7GB. Half the model weight, lighter RAM, more edge-usable (one 4B, not two),
  faster cold-start, vision native to the main brain.
- **Verified:** the unified Gemma brain answered a text question AND read a test image, both on
  the one model. Frontier quality stays one tap away via the Providers Ark (Claude/GPT/Gemini).
- Honest: same 4B param count, so per-token speed is similar on CPU — the real 2× levers remain
  GPU (auto-enabled) or a smaller quant for phones/old machines.

## [1.15.0] — 2026-06-12 — Mobile companion app (installable PWA)

There was never a native iOS/Android app, and the old mobile files were orphaned (never
served). This wires up and rebuilds a real **mobile companion** — an installable PWA that
controls the ABUZ8 agent running on your computer from your phone over Wi-Fi.
- **Served now:** `/m` (mobile app), `/manifest.json`, `/sw.js` — added to the LAN open-paths,
  and the phone URLs (`/api/lan/status`) now point at `/m`. *Verified all serve 200 with the
  right MIME, and the phone URL is `http://<pc-ip>:8900/m`.*
- **The app:** mobile-first UI with Chat (talks to `/api/chat`), **Brief me** (`/api/jarvis/brief`,
  spoken), live **Activity**, status, and spoken replies via `/api/tts`. Sends the LAN key on
  every call. Installable to the home screen (manifest + service worker), works offline-shell.
- **Honest:** it's a PWA companion (the brain/vision/OS-control run on the PC; the phone is the
  remote), not an App-Store native app. Voice *input* needs an HTTPS link (a tunnel); text +
  spoken replies work over plain Wi-Fi. Enable **LAN access** in Settings to connect a phone.

All work performed during the 2026-06-10 audit & rebuild of ABUZ8 OS. The app pre-dates this; these entries cover the repair and expansion captured in this repo.

## [1.14.0] — 2026-06-12 — The Operator (autonomous computer use)

The frontier capability, unlocked now that ABUZ8 has eyes (Gemma 3 / cloud vision),
hands (PyAutoGUI), and a brain. Give it a goal and it **operates the computer itself**:
- **See → think → act loop** — the renderer captures the screen each step; `operatorStep()`
  (vision model) returns the single next action as JSON with **resolution-independent
  coordinates** (0–1000 grid); the renderer executes it via PyAutoGUI (`gui_do`) and loops.
  `/api/operator/step`. **Verified:** given a test image + "click the green square," the local
  Gemma vision brain returned a grounded `click` action, fully offline.
- **Actions** — click / double-click / right-click / type / key / hotkey / scroll / wait / done.
  `gui.py` upgraded to convert normalized `nx,ny` → true pixels via PyAutoGUI's own screen size.
- **Safety** — requires "Allow actions" ON + a per-run screen-share grant; step-capped; Stop
  button; PyAutoGUI corner-failsafe. New **Operator** view with a live action log.
- **Honest:** the local 4B vision brain is coarse on exact coordinates and slow per step
  (~100s on CPU); accuracy + speed jump with a connected cloud vision model or on a GPU, and
  the loop self-corrects by re-looking after each action.

## [1.13.0] — 2026-06-12 — Offline local vision (Gemma 3) + auto-GPU on boot

- **Local vision brain (Gemma 3 4B, multimodal)** — fully offline eyes, no cloud, no key.
  Served on the bundled llama.cpp (v9124, `--mmproj` multimodal) at port 8905; `jarvis/see`
  and the Forge route to it (cloud vision provider → local Gemma → honest fallback).
  **Verified:** it correctly read a test image (red circle, green square, on-screen text)
  with `source: local:gemma-3-vision`. ~100s cold on CPU; fast on GPU.
  `ensureVisionBrain`, `callLocalVision`, `/api/vision/local/status|warm`.
- **Auto-GPU on boot** — on startup, if an NVIDIA GPU is present and not yet accelerated,
  ABUZ8 **automatically installs the CUDA runtime and moves the brains (incl. vision) onto
  the GPU** — so the same portable build self-tunes: Surface → CPU, Pegasus/DGX → GPU.
  Opt-out via `auto_gpu:false`. `maybeAutoAccelerate()` in `start()`.
- Vision-model detection broadened to recognize Gemma 3, NVIDIA NIM vision, and open VLMs
  (Llava/Qwen-VL/InternVL/etc.) while treating Gemma 2/3-1B/Nemotron as text-only.

## [1.12.0] — 2026-06-12 — The Jarvis layer (he sees your screen + briefs you)

The two traits that make an assistant truly "Jarvis," both real:
- **Screen vision** — "what's on my screen?" / "read this": the app captures the screen with
  the native, user-granted `getDisplayMedia` (auto-granted via `setDisplayMediaRequestHandler`,
  no picker, **zero PowerShell**) and a connected vision model (gpt-4o/Gemini/Grok/Claude) reads
  it. Honest fallbacks when no frame or no vision model. `/api/jarvis/see`.
- **Proactive briefing** — "brief me" / "good morning": a real, instant briefing fused from the
  live clock, weather, active missions, and (if connected) calendar + unread inbox — spoken by
  the avatar. Deterministic (no model echo). `/api/jarvis/brief`. *Verified: real Fri Jun 12 2026
  briefing in 0.7s.*
- **Image → real 3D mesh** — a **Tripo** connector turns a photo into an editable mesh for the
  Forge (`/api/forge/mesh` + `/mesh-status`); honest `needs_auth` until a key is added.
- Tools `jarvis_see`/`jarvis_brief` + intents ("what's on my screen", "brief me") routed
  client-side to the native capture. See/Brief buttons in the avatar window.

## [1.11.0] — 2026-06-12 — The Forge (holographic CAD / world builder)

A real-time Three.js CAD workspace — build engines, reactors, rockets, labs, towers and
**cities**, commanded by voice, hands, and click (Stark-style).
- **Assembly library** (engine, arc reactor, rocket, tower, building, city, gear train, lab,
  atom, molecule) — each a named multi-part 3D assembly.
- **Exploded view** — "blow it up" animates parts outward; slider scrubs 0–100%; collapse reassembles.
- **Select → keep / delete / isolate / duplicate** — click or pinch a part (the arc-reactor-rebuild move).
- **Voice commands** (offline Whisper → `/api/forge/interpret`, verified across build/explode/
  delete/add/scale/city) · **Hands** mode (MediaPipe: one hand orbits, two hands zoom) · mouse orbit/zoom.
- **Photo → 3D** (`/api/forge/analyze`) — vision model identifies the object + parts when connected,
  else an honest label-driven reconstruction. (A 2D photo can't reveal hidden internals; a true
  photo→mesh needs an image-to-3D model on GPU/cloud — documented, not faked.) Docs: `docs/FORGE.md`.

## [1.10.0] — 2026-06-11 — Voice barge-in + true 3D point-cloud hologram

### Voice barge-in (interrupt like a real call)
While ABUZ8 speaks, a parallel echo-cancelled mic VAD listens; when you start talking it
**cuts the TTS and hands the turn back to you** (`startBargeWatch` → `speakReply`). A raised
threshold (0.06) + 240ms sustained + a zero-gain sink keep the speech from triggering itself.

### True 3D point-cloud hologram (Three.js, bundled offline)
Bundled **Three.js** (`vendor/three/three.module.js`, 1.27MB, served offline). Holographic mode
now renders a real WebGL scene: a glowing wireframe core by default, and **"Scan frame" builds
a genuine 3D point cloud** of the webcam image (depth from brightness) you rotate, zoom and spin
with both hands. CSS-3D remains the fallback when WebGL is unavailable. All 10 Three.js classes
verified exported; the engine serves with the correct MIME. (Live manipulation needs camera + hands.)

## [1.9.0] — 2026-06-11 — Persistent OAuth · agent-callable connectors · holographic control

### Persistent OAuth (hands-free, auto-refresh)
Real OAuth 2.0 + PKCE with a **loopback redirect on the app's own server**
(`http://127.0.0.1:8900/oauth/callback`). Authorize once in the browser; ABUZ8 stores the
**refresh token and silently renews access forever** — no more 1-hour re-paste. Presets:
Google (Gmail·Calendar·YouTube), Meta (Instagram·Facebook), TikTok. Gmail/Calendar/Instagram
now pull the auto-refreshed token automatically. Setup uses the user's own OAuth client
(one-time) — credentials are never shipped or faked. Verified: a genuine Google consent URL
with PKCE + `access_type=offline` + `prompt=consent`. `/api/oauth/status|setup|start|disconnect`.

### Connectors are agent-callable mid-task
The agent's ReAct tool menu now includes **`send_email`, `calendar_create`, `stripe_op`,
`social_post`, `social_draft`, `get_weather`, `get_time`** — so inside an orchestration it can
actually email, schedule, charge, and post **without you driving**. Each routes to the real
connector and returns honest `needs_auth` when a credential is missing (verified).

### Two-hand holographic control (Iron-Man style)
Vision now tracks **both hands** (MediaPipe, `numHands:2`). A holographic stage lets you
manipulate an artifact in 3D: **two-hand pinch → zoom + rotate**, two-hand drag → pan, one-hand
pinch → 3D spin (rotateX/Y). **Scan frame** freezes the live webcam image onto the artifact so
you grab the real thing. Glowing pinch HUD; CSS-3D transform engine; 100% offline. (Live
manipulation needs a camera + hands; the pipeline is structurally complete.)

## [1.8.0] — 2026-06-11 — Social Beacon (post everywhere) + faceless content loops

The in-shell answer to "migrate Postiz": ABUZ8 becomes the home beacon that broadcasts
to every network and runs faceless-content marketing loops on its own.
- **13-platform catalog.** Work-now with a simple token (real, verified): X, Mastodon,
  Bluesky (AT Protocol), Telegram, Discord. Wired-but-OAuth-gated: Instagram, TikTok,
  LinkedIn, Facebook, YouTube, Threads, Reddit, Pinterest.
- **Fan-out beacon** — `POST /api/social/post {platforms[],text}` posts to all selected
  networks at once with an **honest per-platform result** (posted / needs_auth / error).
  Verified: reports exactly which credential each platform needs; never fakes success.
- **Faceless AI content** — `POST /api/social/draft {topic,platform}` writes a ready-to-post,
  platform-tailored post (hook→value→CTA→hashtags). Verified: a real 270-char X post.
- **Marketing loops** — the autonomy scheduler gained `social` and `content_loop` actions;
  a loop drafts fresh content on your topic and broadcasts it on a cadence (Social → Schedule loop).
- Tools `social_post`/`social_draft` + NL intents ("broadcast: …"). Edge control already
  works (Playwright launches the `msedge` channel first). New Social view. Docs: `docs/SOCIAL.md`.
- Keys stay local in `config/social.json`.

## [1.7.0] — 2026-06-11 — Providers (the Ark), native Arabic, real-world grounding

### Provider catalog — the Noah's Ark of AI
30+ providers preset (Antigravity/Continue/LiteLLM style): OpenRouter, OpenAI, Anthropic
(with a new `/v1/messages` adapter), Gemini, Grok, DeepSeek, Kimi, GLM, MiniMax, Perplexity,
Mistral; NVIDIA NIM, Cerebras, Groq, Together, Fireworks, DeepInfra, Mercury, SambaNova,
Cohere, Bedrock*, Azure; local engines (llama.cpp native, Ollama, LM Studio, vLLM, Jan —
auto-detected); and the Claude Desktop bridge for a Claude *subscription*. Pick a brain;
chat routes there with **native-engine fallback if it fails** (verified). New Providers view.
`/api/providers(/connect|/test|/models|/select|/use-native|/disconnect|/detect)`. Docs: `docs/PROVIDERS.md`.

### Native Arabic (understand · speak · transcribe)
- **Speaks Arabic**: TTS auto-switches to the Kareem voice (with libtashkeel diacritization)
  whenever the text is Arabic — verified 315 KB of real Arabic audio.
- **Transcribes Arabic**: Whisper now passes `-l auto` (multilingual model) and accepts `language:'ar'`.
- **Understands & replies in Arabic**: every system prompt carries a language-matching directive;
  verified the local 4B answering "من أنت؟" in fluent Arabic.

### Real-world grounding (no more stale model facts)
- **Correct date/time**: the real OS clock is injected into every system prompt and exposed as a
  `get_time` tool — it now says 2026, never 2023. Verified.
- **Live weather**: a `get_weather` tool locates the user by IP and pulls Open-Meteo (no key) —
  current + 4-day forecast. "what's the weather tomorrow" routes to it in <1s. Verified.

### Wake word grabs the command
"Abuu/abu" must lead the utterance (Siri-style), and anything said after it ("hey abu, what's the
weather tomorrow") is captured and acted on in the same breath — not just a greeting.

\* Bedrock listed for completeness; SigV4 adapter pending.

## [1.6.0] — 2026-06-11 — Connect: real connectors, fleet mesh, account, wake word

### Real connectors (keys stay on the machine)
A connectors framework with **genuine API calls** — verified by Stripe rejecting a
bogus key from its own API. `config/connectors.json` (gitignored). Stripe (balance/
customers/charges), Cloudflare (token verify/zones/DNS), Gmail (list/**send**),
Google Calendar (list/**create**), OpenRouter (cloud brain), Serper (auto-upgrades
web search). `/api/connectors(/set|/test|/call|/delete)`. Docs: `docs/CONNECT.md`.

### Fleet mesh (OpenClaw-style control-node + workers)
Every ABUZ8 instance is a worker out of the box (`/health` + `/api/chat` + LAN key).
This node becomes a **control node**: add workers by URL, **live ping** (health +
latency), and **dispatch** tasks that run on the worker's own brain and return results.
*Verified: a dispatched task ran on the worker's Nemotron brain and replied.*
`/api/mesh/nodes|add|remove|ping|dispatch|whoami`. `fetchUrl` now takes a timeout.

### Secure local account + MCP surfacing
scrypt-hashed local sign-in (`/api/account/status|setup|login`). The Connect view also
lists MCP servers and one-click **imports the Claude Desktop config** (Desktop Commander
et al.) into ABUZ8's existing MCP client.

### Wake word — "Abuu" (always-listening, like Siri)
An offline VAD + Whisper loop in the chat bar: listens only on speech, detects the wake
word "Abuu", greets, and opens the hands-free conversation; steps aside during a
conversation and auto-resumes on reload. 100% offline.

## [1.5.0] — 2026-06-11 — Vision & spatial awareness (the Jarvis senses)

### On-device perception (100% offline)
A new **Vision** view turns the webcam into a perception layer via bundled
**MediaPipe Tasks Vision** (WASM) — no cloud, no API key, no frame leaves the machine.
- **Gesture control** — pre-trained hand gestures (open palm → wake, fist → stop,
  thumbs up → confirm, point → next, victory → screenshot, ILoveYou → chat) with a
  configurable `gesture→action` map; opt-in "gestures drive the app", debounced + confidence-gated.
- **Eye / gaze tracking** — gaze direction, blink, and an attention state from face blendshapes.
- **Spatial presence** — present/away, distance (near/medium/far), head orientation, with edge logging.
- **Presence-aware voice** — TTS only speaks while you're present and looking; pauses when you step away.
- API: `/api/presence` (GET/POST), `/api/vision/gestures(/set)`, `/vendor/*` static serving of the bundled wasm+models. Docs: `docs/VISION.md`.

## [1.4.0] — 2026-06-11 — Autonomy + durable missions + Operations dashboard

- **Durable mission graph** (JSON-backed) with approval gates: create → advance → pause-at-gate → approve → complete. `/api/missions/*`.
- **Autonomy scheduler** — `every_min`/`at_hour` schedules fire tasks/orchestrations/missions on a 60s tick. `/api/autonomy/*`.
- **Operations dashboard** — a UI to create missions, approve gates, and set up autonomous schedules visually.

## [1.3.0] — 2026-06-11 — Agent-first architecture + soul

### Agent-first reasoning (the Hermes/OpenClaw framework)
Chat is no longer a tool-dispatcher. A request that needs thinking is **understood → the agent gathers (tools + self-knowledge) → reasons over the results → synthesizes the real answer**, instead of dumping raw tool output.
- `isComplexTask()` routes reasoning/research/comparison/multi-step requests through `runTask()`; simple actions stay instant; voice stays fast.
- `selfDescription()` gives ABUZ8 honest self-knowledge (real capabilities + bottlenecks) so it can reflect on itself.

### The four agent phases (each verified)
1. **Vector memory / RAG** — a local nomic embedding model (port 8904) embeds memories; relevant ones are retrieved and injected into context. ABUZ8 remembers across sessions. (`/api/memory/index`, `/api/memory/recall`)
2. **Iterative ReAct loop** — `runTask` chains tools: plan → tool → observe → reason → repeat until done, then synthesizes. Dedup guard for small-model loops.
3. **Deep-read research** — `deepResearch()` decodes search redirects and fetches/reads the top source pages (full text, not snippets). (`deep_research` tool, `/api/research`)
4. **Self-reflection** — `reflectAndImprove()` critiques and tightens the draft answer before returning. (`/api/reflect`)

### Soul (Hermes-style)
A **name + 4 files** (`NAME.txt`, `SOUL.md`, `VOICE.md`, `MISSION.md`, `DIRECTIVES.md`) define who ABUZ8 is and how it speaks, loaded into **every** reply (typed and voice). Editable in Settings → Soul.

### Brains
Four local engines run in concert: **Nemotron 4B** (reasoning, :8902), **Qwen 0.5B** (instant voice, :8903), **nomic-embed** (memory, :8904), and the core (:8900). Lazy-loaded.

### Themes
Added **Sakīna** (Islamic green/blue/gold-lapis) and **Superman · Krypton** palettes (~12 total).

> Honest note: every phase is verified working, but quality and speed are capped by the local CPU models — they scale up dramatically with the GPU unlock (Pegasus/DGX) or a 7B+/cloud brain.

## [1.2.0] — 2026-06-10 — Jarvis: voice, automation, hardware-adaptive, installer

### Voice & speech (offline)
- **Piper neural TTS** attachment — 4 natural voices (US f/m, UK, Arabic) + presets (normal/calm/fast/narrator/cartoon).
- **whisper.cpp STT** attachment — offline hearing; multilingual model (~99 languages).
- **In-chat hands-free voice companion** — mic button starts a live loop (listen→Whisper→brain→Piper→repeat); window loads over `http://localhost` for a secure mic context; Electron media permission granted.
- **Dedicated fast voice brain** — Qwen2.5 0.5B on its own port (8903) → spoken replies in ~1-3 s (was ~20 s) while Nemotron handles deep reasoning.

### Brains & hardware
- **NVIDIA Nemotron 3 Nano 4B** is the primary brain (LFM brains removed to stay lean ~4 GB).
- **Hardware-adaptive launch** — uses ALL CPU cores, context scales with RAM, `-ngl` GPU offload when a CUDA runtime + NVIDIA GPU are present.
- **One-click GPU unlock** (`/api/brain/accelerate`) downloads the CUDA llama.cpp build on a GPU machine; `brain-cuda/` is preferred over the CPU runtime.
- **Richer probe** — per-GPU VRAM (nvidia-smi), monitor count, CPU/GPU acceleration mode, `can_unlock_gpu`; `/api/status` exposes `brain_alive`/`brain_error`. Tiers scale lightweight → DGX-class.

### Native control & agents
- **Real tool execution** — open browsers/apps/sites by name, run any command (`cmd_run`), draw (monkey **and unicorn**), tweet/post-to-X intent. Consent persists across launches.
- **Playwright** browser automation (drives system Edge — no bundled Chromium) + **PyAutoGUI** desktop control.
- **Autonomous agent loop** (`/api/agent/run`) with live-streaming steps; **live Activity feed** (`/api/activity`).

### UI & distribution
- **Cinematic boot/probe** screen (Claude-designed) reading real hardware.
- **Themes**: Claude Dark/Light + multi-hue cinematic (Nebula, Deep Ocean, Aurora, Sunset Dusk, Twilight), **Mythos**, **Fable**, **Sakīna** (Islamic green/blue/gold-lapis), **Superman · Krypton**.
- **Phone/LAN access** — serve dashboard over HTTP, PIN-gated, off by default.
- **One-click installer** (`scripts/make-installer.ps1` → `ABUZ8-Setup.exe`, ~4.4 GB) and **USB portable bundle** (`make-portable-bundle.ps1`) with the brain + voice + attachments.

### Crash-resilience
- `uncaughtException`/`unhandledRejection` guards, renderer auto-reload, hardware acceleration disabled (old iGPU stability).

## [1.1.0] — 2026-06-10 — Audit, repair, and executive expansion

### Phase 1 — Audit & repair (made it actually connect)
**Fixed**
- Removed `installOptionalProbeGuard()` port blackhole in `main.js` that redirected every optional connector port (1234/11434/8188/8910/9119/18789) to a stub answering HTTP 200 — it broke all external connections and showed false "Connected" states.
- Brain readiness: `lfmHealthy()` now requires HTTP **200** (llama-server returns 503 while loading); `waitForLfm` window raised to 150 s. Previously the app gave up and served canned keyword replies that looked like a broken brain.
- Provider errors now **throw** instead of being returned as chat text; added cloud failover.
- Implemented a **real MCP client** (JSON-RPC initialize/tools-list/tools-call over stdio) + endpoints `/api/mcp/servers/:name/tools` and `/api/mcp/call`. Previously MCP servers could be spawned but never used.
- UI live-probes Mission/Hermes/OpenClaw instead of hardcoded `wired:false`; chat fallback timeout 30 s → 180 s.
- Configs rebuilt: `providers.json` (OpenRouter + LM Studio + Ollama), junk settings removed, MCP catalog corrected (fetch/time/git are `uvx` Python packages, not npm).

### Phase 2 — Clean dashboard + capability expansion
**Added**
- `/api/system/scan` — netstat port map (+PID→process), CLI discovery, hardware, endpoint catalog.
- `/api/agents/roles` + role-aware chat (system prompt threaded through brain & providers).
- `cmd_run` tool + `/api/cmd/run` — full native shell/CLI execution, consent-gated.
**Changed**
- `renderer/index.html` **rewritten** as a clean Claude-Desktop-style SPA: lighter-green theme, fit-to-screen grid, sidebar nav (Chat/Agents/System Map/Tools/MCP/Memory/Settings), chat-first.
**Removed**
- All fake/price/personal UI (revenue/cost/souls/chimera/SHA-512 claims, Telegram tokens, hardcoded IDs).

### Phase 3 — Executive / growth suite
**Added**
- 5 executive roles: `ceo-operator`, `seo-strategist`, `x-growth-operator`, `content-producer`, `swarm-orchestrator` (prompts distilled from migrated Hermes operator-mode + x-growth playbooks).
- `/api/swarm/run` — real multi-agent fan-out + synthesis.
- `/api/content/generate` — carousel/thread/YouTube/blog/synthesis, saved to `exports/content`.
- `/api/x/post` — X API v2, key-gated, honest `needs_credentials`.
- `/api/growth/seed` — 25-problems weekly board + 7-day cadence.
- `/api/skills/installed` — reads migrated skill packs.
- Two-way Claude bridge: `/api/bridge/status` + `/api/bridge/reinstall`; `start()` self-heals the symbiote and imports Claude's MCP servers each launch.
- UI: theme palettes (7), and views Swarm, Kanban, Growth & Content, Skills, Claude Bridge; multi-model picker.
- Migrated real Hermes skill packs (`x-growth-monetization`, `kanban-video-orchestrator`) into the skills dir.

### Known follow-ups
- OpenRouter key on the build machine was dead (401) — replace in Settings.
- X posting needs an OAuth2 `tweet.write` token.
- Hermes/OpenClaw sibling gateways aren't auto-started.

## Backups produced
- `app.asar.audit-backup-20260610` — pre-audit original app.
- `renderer/index.html.prerewrite-backup` — pre-rewrite UI.
