# ABUZ8 OS vs Hermes Agent Desktop — Re-Audit (2026-06-19)

## 1. Verdict

After today's operator-spine build, ABUZ8 has moved from "behind on safety/operations" to **leading Hermes on the entire sovereign-operator axis** — kill switch, tiered approval, outward-action verification spine, AES-256-GCM vault, revenue ledger, merged audit timeline, offline duplex voice, rigged 3D avatar, automated no-public-IP tunnel, and headless daemon are all live and grep-confirmed, and none of those exist in Hermes. ABUZ8 is **at parity** on memory/learning, observability, providers/models, daemon uptime, and (mechanism-wise) the skills curator. It is **still behind** on a small set of UI-surface and breadth items: structured/live tool-call cards, composer @// popovers + prompt queue, an interactive terminal + drag-to-attach file tree, cron-expression/run-history UI, multi-window/^Tab/resume self-heal session handling, inbound rich-media + channel directory on the gateway, and the pre-authored skills catalog. *(Correction 2026-06-20: an earlier draft listed **profiles (multi-isolated instances)** and **automation blueprints** as structural gaps; both shipped in v1.24.0 — Hermes still leads on profile/cron depth.)* All remaining gaps are local-first hardening; none require SaaS.

## 2. Now CLOSED today (were gaps, now parity/lead)

| Capability | What closed it (ABUZ8 file / endpoint) |
|---|---|
| Kill switch / global halt | `actionsAllowed()`/`_halted` (portable-core.js:42,550); `/api/halt` `/api/resume` `/api/halt/status` (6868-6870); honored in scheduler (2709) + TG gateway (4627) |
| Tiered approval + queue + audit | `TOOL_TIERS`/`enforceTier()` (5433,5446); `enqueueApproval`/`decideApproval`/`recordDecision` (5458-5472); `auditTimeline()` merges 5 logs (5475); `/api/approvals/*` `/api/decisions` `/api/audit` `/api/policy` (6883-6889) |
| Outward-action verification spine | `verifyAction()` adversarial pre-flight (3806) on `VERIFY_TOOLS=[send_email,social_post,x_post,stripe_op]` (3805); high-severity → enqueue+block (906-912) |
| Secrets vault | AES-256-GCM `/api/vault/*` |
| Revenue ledger | `/api/revenue/*`; per-day `costSummary()` (5313) |
| Per-turn learning + dedup | `reviewTurn()` after every chat (3773, 6151, 6194); `memoryHasSimilar()` cosine ≥0.9 (3797); `/api/learn/review` (6901) |
| Offline duplex voice | Piper TTS (1163) + Whisper STT (1277), sentence-chunked `chunkForSpeech` (index.html:1252), barge-in (1230), wake word (1355-1368) |
| Rigged 3D avatar | `loadRiggedAvatar()` GLB/VRM via local r160 vendor loaders (index.html:3547); offline bundle on disk (three.module.js 1.27MB etc.) |
| Operator HUD | `view-spine` loadSpine (index.html:3406): world-state + approvals + escalations + audit + brief + file tree + Halt |
| Headless daemon + autostart | `--server` HEADLESS (main.js:13,149); `scripts/install-autostart.ps1` (AtLogOn, no time limit); `operatorBrief()` (5414) |
| Automated remote reach | `ensureCloudflared()`/`startTunnel()` auto-download + quick tunnel (5993-6031); `/api/tunnel/*` (7137-7139) |

## 3. Genuinely still missing (grep-verified)

| Capability | Remaining gap | Severity | ABUZ8-native fix |
|---|---|---|---|
| Structured/live tool-call cards | Chat shows only a single name-only `.tool-chip` (index.html:1136); SSE emits `{token}/{note}/{done:tool-name}` only — no `tool_start/tool_end` with args/result/status; agentLoop steps go to HUD `pushActivity` (2515-2539), never the chat stream | medium | Add `tool_start`/`tool_end` SSE events in `/api/chat/live` (6167); thread `onTool` through agentLoop (2502); render expandable per-call rows (args/result/status) in renderThread |
| Composer @// popovers + prompt queue | `#chat-text` is a plain textarea (Enter-to-send only, 1126); no @-mention/`/`-command drawer; 0 grep hits for prompt queue/steering | medium | keydown listener querying `/api/fs/list` + tool/role registry for @/`/`; local queue array drained in sendText completion (reuse openPalette markup) |
| Interactive terminal + tree interaction | 0 renderer hits for terminal/xterm/pty; only fire-and-return `actionCmdRun` (825) / `/api/exec`. `loadSpineFiles` (3419) re-fetches per dir, no inline-expand, no drag-to-attach (0 `draggable` hits on nodes) | medium | Approval-gated `/api/shell/exec` streamed to a HUD log pane; upgrade loadSpineFiles to inline expand + `draggable=true` rows into existing drop zone (3536) |
| Cron-expression + run-history UI | `createSchedule` (2673) supports only `every_min`/`at_hour`; `fireSchedule` keeps a `runs` integer counter + last_* snapshot, no per-run log; modal is 4 hardcoded presets (index.html:2251); 0 hits for cron-expr/next_run | low | Optional `cron` 5-field matcher in schedulerTick + `next_run_at`; append runs to `runs/<id>.jsonl` + `/api/autonomy/schedules/:id/runs`; "Custom (cron)" dropdown option |
| Sessions: multi-window / ^Tab / resume self-heal | Single BrowserWindow (main.js:36); only Ctrl+K and Ctrl+Shift+N bound (3517), no ^Tab; `switchSession` (3138) is bare try/catch, silent no-op on failure | low | ^Tab MRU cycle over `/api/sessions` (~30 lines); retry+inline "Retry" in switchSession; optional per-session BrowserWindow registry |
| Gateway inbound media + channel directory | Telegram poll hard-skips non-text (`if(!msg.text)continue`, 4634); Twilio reads only `Body`, Slack only `text`; 0 hits for channel directory/aliasing | medium | getFile-download inbound media to `attachments/inbox/` + local Whisper/vision; `channels.json` + `/api/gateway/channels[/alias]` resolver |
| Skills cold-start catalog | Exactly 1 authored SKILL.md (x-growth-monetization) vs Hermes ~173; runtime curator at parity-or-better | medium | Author ~8-12 local-first operator packs (file-ops, local-coding, stripe-revenue, comfyui-pipeline, etc.) under `skills/` — listSkills + Skills view already load them |
| Profiles (multi-isolated instances) | **Shipped in v1.24.0** (isolated soul/sessions/memory + profile switcher). Hermes still leads on profile/cron depth (per-profile config + skills + cron) | low | Deepen per-profile config/skills/cron to match Hermes |
| Automation blueprints (parameterized cron templates) | **Shipped in v1.24.0**. Hermes still leads on typed-slot template depth (form/command/seed→create_job authoring layer) | low | Extend the blueprint catalog with typed-slot templates compiling to `createSchedule`; render slots as a form in Operations + a `/blueprint name slot=val` chat path |
| Per-task model-slot routing | Task routing hard-wired by job type (vision/voice/brief); no user-configurable per-slot provider/model + fallback_chain | low | Thin `settings.task_models` map read by ensureVoiceBrain/ensureVisionBrain/reviewTurn, overridable from Brain popover |
| Usage trend chart | Per-day data exists (`costSummary` /api/cost/summary) but no renderer plots it; only instantaneous tok/s + tok/hr shown | low | Reuse `dbar()` inline bars for a 30-day token/cost series + 7/30/90 toggle; pure renderer, no new endpoint |
| Cache/reasoning token split | `_usage.push` (5224) lumps all tokens into one field; Hermes splits cache_read/cache_write/reasoning | low | Capture those fields when the brain exposes them; add columns to usageSummary by_model |
| Command-string de-obfuscation depth | `normalizeCmd` (5257) strips only quotes/backticks/carets — no NFKC/ANSI/null-byte/backslash-escape unfold; DANGEROUS_RX (~11) misses `sed/perl -i` of ~/.ssh, `find -exec rm`, `xargs rm`, SQL DROP/TRUNCATE | low | Add NFKC + ANSI/null-byte strip + backslash unfold to normalizeCmd; extend DANGEROUS_RX (HARDLINE stays non-bypassable) |

## 4. Where ABUZ8 leads Hermes

- **Safety/control breadth** — global kill switch, money/account red-tier, outward-action LLM verification spine, and a unified 5-source audit timeline; Hermes's `approval.py` is command-string-only and has none of these.
- **Operator HUD** — world-state + approvals + escalations + audit + brief + file tree + Halt in one surface; Hermes's command-center has no approvals/audit/kill switch/live CPU-RAM-GPU.
- **Voice** — offline sentence-chunked streaming TTS, mid-speech barge-in, wake word, and a 3D lip-synced avatar; Hermes streams TTS only on cloud ElevenLabs, Piper is full-WAV-per-call, no wake word, no avatar.
- **Avatar** — full rigged GLB/VRM engine with local-bundled loaders; Hermes has only 2D glyph avatars, zero 3D.
- **Automated no-public-IP reach** — auto-downloads cloudflared and spins a key-secured quick tunnel; Hermes only prints manual cloudflared/ngrok instructions.
- **Observability** — per-day cost rollups, multi-source audit merge, persisted run traces, and UI surfacing exceed Hermes's flat session counters + SaaS billing client.
- **Thinking modes** — single/council/debate/auto router (routeThinkMode:2146), a routing axis Hermes lacks.

## 5. Corrections (prior "gaps" overturned by verification)

- **Voice / avatar / remote-reach / observability / approvals / command-center** — re-checked as ABUZ8-leads, not gaps (see §4).
- **Memory-learning, providers-models, daemon-uptime** — verified **at parity**, not behind: local vector RAG + per-turn `reviewTurn` learning (3773), live HF + provider `/v1/models` catalogs (5721/3108), and a real `--server` daemon + autostart (main.js:13, install-autostart.ps1). Daemon has no missing code — only the host is the operator's call (BUILD-SHEET:27).
- **Checkpoints/rollback, backup/restore, skill curator, swarm/kanban, browser automation, artifacts panel, themes/density** — critic re-verified each has a real ABUZ8 implementation (portable-core.js:5352-5370, 5324-5341, 5847-5854, 5793-5801, 1212+; index.html:836); NOT gaps.
- **Skills runtime mechanism** — the curator/synthesis/recall loop (`reviewTurn()` per-turn fact capture, `selfLearnOnce()` tool-frequency learning, synthesizeSkillsOnce 5084, retrieveSkills 5108, curateSkillsOnce 5854) is **at-parity-or-better**; only the pre-authored cold-start catalog is the delta, narrower than 173:1 since much of Hermes's catalog is SaaS-tool-oriented. *(Correction 2026-06-20: an earlier draft cited a symbol `harvestAndLearnOnce` that does not exist in source; the real harvest is split across `reviewTurn()` + `selfLearnOnce()`.)*
- **"Tool-call cards already shipped"** — overturned: today's build added genuine per-message action bars + live SSE streaming (renderThread:1129, streamChat:1187), but the structured/expandable per-call tool cards remain absent — gap stands.