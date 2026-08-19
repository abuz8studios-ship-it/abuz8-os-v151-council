# ABUZ8 OS vs Hermes Agent (newest `main`, d2c53ff5) — Gap Report

## 1. Executive summary

ABUZ8 is at rough feature parity with Hermes on the **core agent loop, multi-channel messaging, MCP client, providers, scheduling, skills, and desktop UI** — and it genuinely **leads** in areas Hermes does not have: the Command Center/HUD business cockpit, a self-modification engine that edits its own source in a git worktree (`selfUpgradePropose`), a richer autonomy action set (goal/social/content_loop), and a sovereign no-API-fees posture (local llama brain :8902 + CLI brains on the user's own Claude/Grok/ChatGPT/Gemini accounts). The deltas are almost all of one shape: **Hermes is more "industrial"** — it has the depth-of-engineering layers a multi-tenant hosted product needs, while ABUZ8 has the breadth but thinner safety/observability/recovery floors.

Where ABUZ8 honestly trails: it has **no command-level danger guard below its single consent boolean** (the one HIGH-severity gap — once "Allow actions" is on, `cmd_run` will run `rm -rf /` unchecked), **no real tracing/cost-accounting** (the `/api/traces`, `/api/usage`, `/api/cost/summary` endpoints are empty stubs), **no backup/restore or pre-update snapshot**, **no config schema versioning/migration**, and it leaks the full process env (API keys) to every spawned MCP server. It also lacks several adjacent surfaces — filesystem checkpoints/rollback, DM pairing for inbound, an `abuz8` CLI binary, and a no-public-IP dial-out relay.

Crucially, several "missing" claims were **overturned on verification**: ABUZ8 has discrete Slack/Twilio inbound handlers (which require manual webhook setup, not a turnkey gateway), a real headless stdio MCP interface, and a USB portable-data bundle. *(Correction 2026-06-20: only the two-way **Telegram** gateway is a built-in turnkey channel; the "universal channel gateway" — generic inbound webhook for Discord/n8n/Zapier — is an unimplemented stub, and Slack/Twilio require manual webhook configuration.)* The remediation philosophy throughout is ABUZ8-native: migrate the idea + the essential 20%, never Hermes' multi-tenant/SaaS bloat.

## 2. Gap table (corrected status)

| Capability | Hermes has | ABUZ8 status | Severity | Effort |
|---|---|---|---|---|
| Security / command guard | Hardline + dangerous-pattern command guards below consent, glob allowlist (once/session/always), MCP env scrub, protected-path guards | partial | **high** | M |
| Observability / tracing | Per-turn trace tree (LLM+tool spans), token+cost accounting, request debug dumps, secret redaction, log viewer | partial | medium | M |
| Relay / gateway (no-public-IP) | Dial-out WS relay, capability negotiation, HMAC per-instance enrollment, token-less follow_up, mid-turn /stop | partial | medium | M |
| Messaging connectors | ~20 two-way platform adapters, channel directory + aliases, per-platform prompt hints, allowlists, inbound media | partial | medium | M |
| Desktop app | PTY terminal pane, working-dir file tree, multi-session windows, i18n, profiles, in-place git self-update | partial | medium | M |
| Memory system | Pluggable provider seam, batch memory ops, per-turn self-improvement review writing facts | partial | medium | M |
| Skills curator | LLM umbrella-consolidation, recoverable archive + active/stale/archived lifecycle + pin, consolidated-vs-pruned report | partial | medium | M |
| MCP integration | Browseable curated catalog w/ per-entry vet detail, install-time tool-subset probe, connected-vs-configured count | partial | medium | M |
| Providers / models | Live models.dev catalog (context/$ pricing/caps) w/ TTL refresh, capped interactive picker, xAI Responses+web_search OAuth, custom named providers | partial | medium | M |
| Cron scheduling | Full cron expr (weekday/DoM/minute), one-shot relative+ISO, NL schedule parsing, per-job delivery routing | partial | medium | M |
| Autonomy / self-improve | Per-turn forked review (captures style/frustration corrections), phantom empty-name dampening, parallel-tool-call steer | partial | medium | M |
| Config / onboarding | Versioned schema + migration engine, guided provider/brain setup wizard, `doctor` diagnostics | partial | medium | M |
| Web dashboard | Streamed multipart upload, per-device pairing approve/revoke, mid-stream chat resume | partial | medium | M |
| Backup / portability | Full data export/import zip, machine-state-preserving import skip-list, auto pre-update backup, build-commit stamping | partial | medium | M |
| TUI / CLI | `abuz8` binary w/ subcommands, slash-command REPL w/ live completion, shell completion scripts | partial | low | M |
| Billing / cost transparency | Per-model price table, per-day cost breakdown, real burn/hr | partial | low | S |
| Filesystem checkpoints / rollback | Auto per-edit snapshot store + `/rollback` undo | missing | medium | S |
| DM pairing / inbound-contact gating | Pairing-code allow/approve/revoke for who can DM the agent | missing | medium | S |
| ACP / editor-IDE integration | Agent Client Protocol server (Zed/JetBrains drive the agent) | missing | low | M |
| Conversational automation blueprints | Templated cron recipes w/ typed slots filled in chat | shipped in v1.24.0 (Hermes still leads on typed-slot depth) | low | M |
| Usage insights / analytics | `hermes insights` — historical tokens/cost/tool-pattern reporting | missing | low | S |
| Multi-profile isolation | Multiple isolated HERMES_HOME instances | missing | low | S |
| Achievements / gamification | Session-history badges + share cards | missing (skip — bloat) | low | — |

## 3. Close-these-first (top 5)

1. **Command-level danger guard + MCP env scrub (security — the only HIGH).**
   In `actionCmdRun` (portable-core.js:805) and `devExec`, check a `HARDLINE_RX` (~10 regexes: `rm -rf /`, `del /s` on drive roots, `format`, `mkfs`, `dd of=/dev`, `:(){:|:&};:`, `shutdown/reboot/poweroff`, `taskkill /f`, writes to `.ssh`/`.env`/credentials) BEFORE `execFile`, after normalizing (strip backticks, lowercase, collapse whitespace) — refuse unconditionally even with consent. Add a `DANGEROUS_RX` list returning `{needs_approval:true}` via the existing consent envelope (line 2387), with `POST /api/actions/approve-command {command,scope:once|session|always}` persisting `always` globs to `settings.command_allowlist`. Add `buildSafeMcpEnv(spec)` (whitelist PATH/SystemRoot/TEMP/HOME/APPDATA + `spec.env` only) at `spawnMcpClient` (line 6853). ~80 lines; closes the worst exposure.

2. **Real local-first tracing + wire the dead endpoints (observability).**
   Add a per-turn trace object `{trace_id, session_id, spans:[]}`; have every `embeddedReply`/`localReply` and tool dispatch push `{type:'llm'|'tool', name, model, tokens_in, tokens_out, cost_usd, ms, ok, error}` (cost from a small static price map, 0 for sovereign). Append to the existing `logs/traces.jsonl`. Replace the empty stubs at line 6381: `GET /api/traces` (paginate jsonl), `GET /api/usage` (aggregate the existing `recordUsage` ring), `GET /api/cost/summary` (sum by day/model). Add `redactSecrets()` on all jsonl writes + a `request_dump_<ts>.json` on any provider HTTP error. Renderer Traces panel. The `recordUsage` ring (line 5136) already captures per-call tokens — just expose it.

3. **Backup/restore + pre-update snapshot (backup-portability).**
   `GET /api/backup` streams a zip of dataRoot EXCEPT `{cache,logs,shots,bin,models}` and host-state files (pid/lock); add the missing `sessions`+`goals` dirs the USB bundle omits. `POST /api/restore {zipPath}` with a path-traversal guard (`resolve().startsWith(dataRoot)`) and an `_IMPORT_SKIP_NAMES`-style set that never clobbers machine-tuned config (brain/GPU/port keys). In `applyUpdate()` (line 5073), zip dataRoot to `exports/pre-update-<ver>.zip` BEFORE launching the installer (auto-prune to 5). Bake a `BUILD_SHA` constant exposed in `/api/health`.

4. **Filesystem checkpoints / rollback (completeness — cheap safety win).**
   Wrap the `file_write` tool path: copy any file to `~/.abuz8/checkpoints/<sha>/` before overwrite. Endpoints `GET /api/checkpoints`, `POST /api/checkpoints/rollback`, `DELETE /api/checkpoints`; renderer "Undo last edit" button. Small, high safety value, complements the danger guard.

5. **Per-turn self-improvement review + DM pairing (autonomy + inbound security).**
   (a) After `runTask`/`agenticReply` returns, fire non-blocking `reviewTurn(lastUser, lastAssistant)` calling `frontierReply` with a Hermes-style prompt ("did the user reveal durable facts/preferences/style corrections? JSON or NONE; do NOT capture env failures") that writes via memory + the `synthesizeSkillsOnce` writer; surface a "Remembered: …" chip. Captures the highest-signal moments ABUZ8's success-only 15-min batch misses. (b) `POST /api/pairing/request|approve|revoke`, `GET /api/pairing/list`; gate the Telegram inbound handler (`tgPollOnce`) on approved sender IDs so a leaked gateway secret doesn't grant blanket inbound.

## 4. Per-gap detail

### Security / operator (HIGH)
**Hermes:** layered guard (`tools/approval.py`, `terminal_tool.py`) — ~13 unconditional `HARDLINE_PATTERNS` below even `--yolo`, ~47 `DANGEROUS_PATTERNS` routed to per-pattern approval, obfuscation-hardened normalization, session/permanent glob allowlist with once/session/always, MCP env scrub (`mcp_tool.py _build_safe_env`), protected-path file guards.
**Delta:** ABUZ8's `actionCmdRun` (805) pipes `args.command` raw to `cmd.exe /c`, gated only by the single `actionConsentGranted` boolean — no command inspection, no floor below consent. `spawnMcpClient` (6853) passes `{...process.env, ...spec.env}` leaking all keys. `sandboxFilePath` constrains only `file_write`, not `cmd_run`. No obfuscation normalization (moot until a detector exists).
**Remediation:** see Top-5 #1.

### Observability
**Hermes:** `hermes.observer.v1` hook contract + Langfuse plugin (`plugins/observability/langfuse/__init__.py`) building per-turn trace trees with LLM/tool spans, normalized usage+cost, request debug dumps (`agent_runtime_helpers.py:1154`), secret redaction (`agent/redact.py`), `LogView` UI.
**Delta:** `recordTrace` writes one summary line per run, no spans/correlation IDs. `recordUsage` ring (5136) captures tokens but no cost; `burn_per_hr_usd` is hardcoded null/0. `/api/traces`, `/api/usage`, `/api/cost/summary` are empty stubs (6381). No request dumps, no redaction, no viewer.
**Remediation:** see Top-5 #2.

### Relay / gateway (no-public-IP)
**Hermes:** one generic dial-OUT `RelayAdapter` over WebSocket (`gateway/relay/`) with frozen `CapabilityDescriptor` handshake, HMAC enrollment (`hermes gateway enroll`), token-less `follow_up`, mid-turn `/stop` — one agent serves many platforms behind NAT, no inbound port.
**Delta:** ABUZ8 has zero outbound WS (grep: no `ws://`/`socket.io`/dial-out). Remote reach is cloudflared quick-tunnel only (needs a reachable inbound URL) + Telegram long-poll; a NAT'd node with no tunnel can't receive inbound. Each platform is a hand-written `/api/gateway/*` handler (no capability negotiation), one flat shared `gateway_secret`, no per-remote-session interrupt.
**Remediation:** add a descriptor-driven `CHANNEL_REGISTRY` + single `handleChannelInbound(channel,event)`; add outbound WS `relayConnect(url,secret)` (reuse Electron's `ws`) to a user-owned tiny relay / Fleet Mesh peer (`/api/relay/connect|status|stop`); per-instance HMAC bearer via `/api/relay/enroll`; `/stop` control frame setting the existing job abort flag. **Skip** the Redis bus / multi-tenant connector / crypto-shedding (SaaS bloat).

### Messaging connectors
**Hermes:** ~20 two-way adapters on `BasePlatformAdapter`, `channel_directory.py` + aliases, per-platform LLM prompt hints, allowlists, inbound media (photo/doc/audio), iMessage (photon sidecar) + Teams.
**Delta (corrected):** ABUZ8 already has the universal abstraction — `/api/gateway/inbound` (generic secret-gated webhook → `botRespond`→`agenticReply`), native `/api/gateway/slack/events`, `/api/gateway/twilio` (WhatsApp/SMS), shared `botRespond()/commandReplyText()`. Genuinely missing: channel directory/aliases, per-platform prompt hint override (replies are surface-unaware), per-platform allowlist/mention-gating, inbound media (`tgPollOnce` skips non-text), Discord/email two-way, iMessage/Teams.
**Remediation:** generalize Telegram loop into a `gatewayAdapter` contract; add a `platformHints` map injected into `agenticReply` (cheapest high-leverage win); persist `channel_directory.json` + `/api/gateway/channels`; add `allowed_chat_ids`. **Skip** iMessage/Teams (macOS sidecar / Azure tenant = bloat).

### Desktop app
**Hermes:** PTY terminal pane (node-pty+xterm), working-dir file tree, multi-session OS windows + stranded recovery, i18n (en/zh/zh-hant/ja), profiles, in-place git-pull+rebuild self-update.
**Delta:** ABUZ8 has the artifact/preview/brain-picker surfaces but no user-typeable terminal, no live fs tree (only flat coder build lists), single window, `lang="en"` only, single dataRoot, and self-update downloads+relaunches the installer `.exe` (not git rebuild).
**Remediation (ship):** (A) node-pty IPC `terminal:start/write/resize/dispose` + xterm panel as a new artifact part `{type:'terminal'}` — biggest gap, pairs with `cmd_run`. (B) `GET /api/fs/list?dir=` + lazy renderer tree calling existing `/api/coder/file`. (C) in-place git self-update branch in `applyUpdate()` when running from repo. **Skip:** multi-window, profiles, full i18n (defer).

### Memory system
**Hermes:** built-in MEMORY/USER + one swappable provider (`memory_provider.py` ABC, 9 plugins), batch `apply_batch()` (all-or-nothing budget-validated), per-turn forked self-improvement review writing facts with a visible summary.
**Delta:** `/api/memory/write` is hardcoded JSONL+nomic, one item per call; no batch; no per-turn "what should I remember about the user?" pass (`reflectAndImprove` only rewrites the draft; `selfLearnOnce` only counts tool usage).
**Remediation:** thin `memoryBackend` seam (default `local`); `POST /api/memory/batch` (validate-all then commit+embed); `reviewTurnForMemory()` after `runTask` writing via the batch path + a "Remembered:" chip; `POST /api/memory/review`. **Skip** the 9 cloud providers (break no-API-fees).

### Skills curator
**Hermes:** inactivity-triggered curator (`agent/curator.py`) — deterministic active→stale→archived lifecycle + pin, LLM umbrella-consolidation merging narrow siblings into class-level SKILL.md, restorable archive, before/after report distinguishing "consolidated into X" vs "pruned stale".
**Delta:** `curateSkillsOnce` (5384) is title-dedup + age-prune with hard `fs.unlinkSync` (unrecoverable), no pin, no LLM consolidation (`synthesizeSkillsOnce` only writes new), flat `{pruned,kept}` report.
**Remediation:** move prune→`learnedSkillsDir()/.archive/`; add `pinned` field + `/api/skills/pin|restore`; add `consolidateSkillsOnce()` calling `frontierReply` for `{umbrellas,prune}` → `/api/skills/consolidate`; extend the curator.jsonl report with `consolidated[]`/`archived[]`. **Skip** per-profile sync, bundled-skill diff, hub-install.

### MCP integration
**Hermes:** curated catalog (`optional-mcps/*/manifest.yaml` + `mcp_catalog.py`), per-entry vet detail (transport/auth/source/post-install), install-time tool-subset probe, connected-vs-configured count.
**Delta (confirmed real):** ABUZ8 has a real MCP client + import (Claude Desktop/Docker), but no browseable curated catalog — `/api/mcp/install` just persists caller-supplied specs tagged `source:'catalog'`; no recommended list, no per-entry inspect, no tool-subset enable, no connected-vs-configured headline.
**Remediation:** ship a static `MCP_CATALOG` array (filesystem/fetch/git/sqlite/playwright + Unreal/Linear/n8n) following the `PROVIDER_CATALOG` pattern; `GET /api/mcp/catalog` (cross-ref installed/enabled); reuse `/api/mcp/install` for one-click add; renderer "Browse Catalog" tab; split headline into connected (JSON-RPC initialized) vs configured. **Skip** git-bootstrap + curses probe.

### Providers / models
**Hermes:** merged models.dev catalog (109+ providers, context/$ pricing/caps) w/ 3-tier cache + 60-min refresh, capped interactive picker (None/0/N), first-class xAI OAuth (Responses transport + native server-side web_search, grok-composer 262k ctx), arbitrary `custom:<name>` providers.
**Delta:** `MODEL_CATALOG` (4787) is local-GGUF-only (hardware-fit, no ctx/price/caps, no refresh); `catalogModels` returns bare IDs; one model per provider, no cap/browse; xAI is a vanilla chat-completions Ark entry (SuperGrok only as CLI brain); `catalogConnect` requires a pre-registered entry (no custom named providers except Azure's endpoint field).
**Remediation:** `modelsCatalog.js` `fetchCatalog()` → `models_catalog.json` (24h TTL + stale-fallback), enrich `/api/providers/models` with `{context,cost_in,cost_out}`, `GET /api/models/refresh`; `?cap=N`; xAI OAuth-token mode routing to `api.x.ai/v1` Responses with `tools:[{type:web_search}]` + a `modelContext()` map; generalize `catalogConnect` to persist `custom:<name>`.

### Cron scheduling
**Hermes:** full schedule grammar (`cron/jobs.py parse_schedule`) — relative one-shot, `every Nm`, 5/6-field cron (croniter), ISO timestamps; NL via LLM; per-job delivery to 20+ targets; wakeAgent gate; blueprints.
**Delta:** ABUZ8 stores only `every_min` + `at_hour`; no cron precision, no one-shot, no NL parsing (`/api/autonomy/schedules` passes body raw), output goes only to the activity feed (no delivery routing).
**Remediation:** `parseSchedule(str)` (interval/cron/once; ~40-line cron matcher, no dep); upgrade `schedulerTick`; `scheduleFromText()` (regex table → brain fallback); extend `createSchedule` with `{schedule,deliver}` and route `fireSchedule` output via the existing Telegram/gmail/`socialPost` senders. **Skip** 20-platform fan-out + blueprint catalog (latter tracked separately below).

### Autonomy / self-improve
**Hermes:** per-turn forked review (`background_review.py`) capturing style/frustration corrections as first-class skill signals (with do-NOT-capture rules), phantom empty-name tool-call dampening (anti-priming, no catalog dump — protects weak models), universal parallel-tool-call steer, async background subagents.
**Delta:** ABUZ8 learns success-only from coarse summaries every 15 min (never sees the conversation, misses corrections); `callLocalTool` throws generic errors with no anti-priming guard (the :8902 llama is exactly the weak-model class); chat loop says "exactly one tool call" (only swarm parallelizes).
**Remediation:** (A) per-turn `reviewTurn` (see Top-5 #5a). (B) in tool dispatch, empty/whitespace name → terse "tool-call XML is DATA, reply in plain text" with NO catalog; only non-empty unknown → catalog. (C) append one parallel-tool-call line to the cached system prompt. *(ABUZ8's `selfUpgradePropose` source-self-edit engine exceeds Hermes here — don't touch it.)*

### Config / onboarding
**Hermes:** versioned schema (`_config_version:30`) + idempotent migration engine, modular setup wizard + Portal one-shot, 12-panel desktop settings, `hermes doctor` (33 checks).
**Delta:** flat untyped key-merge `/api/settings` (no `_config_version`, future renames strand keys); first-run wizard is monetization-only (provider/brain setup is manual); no `doctor` (only `/api/providers/health` + System Map probe).
**Remediation:** `CONFIG_VERSION` + `migrateConfigs()` at boot (ordered migration fns, atomic re-save) + `GET /api/config/version`, `POST /api/config/migrate`; add a "Set up your brain" wizard path reusing `/api/onboarding/brains` + `/api/providers/health`; `GET /api/doctor` wrapping existing health checks. *(A consolidated Settings view already exists — `loadSettings` 1455.)*

### Web dashboard
**Hermes:** streamed multipart upload (`/api/files/upload-stream`, fixes the base64 33% inflation), OAuth + per-device pairing approve/revoke (`PairingPage`), clean-close "Start new session" recovery; loopback-default bind + DNS-rebinding protection.
**Delta:** ABUZ8 base64-buffers attachments in the browser (the NS-501 anti-pattern); remote auth is a single shared LAN PIN (no per-device identity/revoke); no mid-stream resume affordance. *(ABUZ8 already leads on LAN binding, PIN gate, PWA, public tunnel.)*
**Remediation:** `POST /api/files/upload` piping `req` → `fs.createWriteStream` under `workspaces/attachments` (tiny hand-rolled boundary splitter, no busboy); per-device pairing on top of the PIN (`/api/lan/pair/request|approve|revoke|list`, accept master PIN OR approved device token); "Connection dropped — retry" chip in `streamChat`.

### Backup / portability
**Hermes:** `hermes backup`/`import` (curated exclusions, consistent SQLite snapshots, `_IMPORT_SKIP_NAMES` so restore never clobbers volatile machine state), auto pre-update/pre-migration backups, git-based self-update surfacing the commit hash.
**Delta (corrected):** `make-portable-bundle.ps1` already does a real `Copy-Item -Recurse` of most user data to a USB `ABUZ8_OS_Data` root — but it's one-shot external/swap-only (no restore/merge), has no machine-state skip-list, **omits `sessions` and `goals`**, and there's no in-app export, no pre-update snapshot, and self-update surfaces installer version only (no build SHA).
**Remediation:** see Top-5 #3.

### TUI / CLI
**Hermes:** `hermes` binary, prompt_toolkit slash-REPL (~35 commands, live completion), shell completion generation, status bar, `/reload-mcp` headline.
**Delta (corrected):** ABUZ8 already has a real headless stdio interface — `src/mcp/abuz8-mcp-stdio.js` (shebang'd, `electron . --mcp` no GUI, reads stdin via readline, exposes ~22 tools incl. `abuz8_chat`, `abuz8_tools_list`). Genuinely missing: an ergonomic `abuz8 <cmd>` binary (no `bin` in package.json), a human slash-REPL with completion, shell completion scripts.
**Remediation:** add `bin/abuz8.js` (`#!/usr/bin/env node`) + `"bin":{"abuz8":"bin/abuz8.js"}` with subcommands POSTing to existing :8900 endpoints; readline REPL with completion from `/api/tools/list`. **Skip** shell-completion generation (low ROI).

### Billing / cost transparency
**Hermes:** interactive credit-purchase screen (out of scope) + `usage`/`credits` showing live per-model dollar cost.
**Delta:** `recordUsage` counts tokens only (no price field); `burn_per_hr_usd` hardcoded; cost endpoints dead-stubbed.
**Remediation (S):** `MODEL_PRICES` map (paid providers only, null for sovereign); capture `input_tokens`/`output_tokens` separately (already available at line 6805); back `/api/cost/summary` + `/api/usage` with per-day breakdown; real `burn_per_hr_usd`; small "$0 sovereign" cost panel. **No** purchase/card flow. *(Overlaps observability #2 — do together.)*

### Filesystem checkpoints / rollback (missing)
**Hermes:** `~/.hermes/checkpoints/` auto-snapshots backing `/rollback` + `hermes checkpoints list|prune|clear` (`checkpoints.py`).
**Remediation (S):** see Top-5 #4.

### DM pairing / inbound-contact gating (missing)
**Hermes:** `hermes pairing list|approve|revoke|clear-pending` (`PairingStore`) controlling who can DM the agent.
**Remediation (S):** see Top-5 #5b.

### ACP / editor-IDE integration (missing)
**Hermes:** `acp_adapter/server.py` exposes the agent over Agent Client Protocol (Zed/JetBrains drive it).
**Remediation (M):** `POST /api/acp` JSON-RPC bridge mapping ACP session/prompt/tool calls onto the :8900 loop (sovereign, no API fees).

### Conversational automation blueprints (shipped in v1.24.0)
**Hermes:** `hermes_cli/blueprint_cmd.py` — templated cron recipes with typed slots filled one question at a time → `create_job`.
*ABUZ8: shipped in v1.24.0 (this entry predates it); Hermes still leads on typed-slot template depth.*
**Remediation (M):** ship a JSON blueprint catalog + `GET /api/blueprints`, `POST /api/blueprints/:name/create-cron` writing into the cron/goals store; conversational slot-fill in chat. *(Do after cron-scheduling lands.)*

### Usage insights / analytics (missing)
**Hermes:** `hermes insights` — historical tokens/cost/tool-pattern/activity from session history.
**Remediation (S):** `GET /api/insights?range=` aggregating session/token logs; render as a Command Center/HUD tab. *(Reuses the tracing store from #2.)*

### Multi-profile isolation (missing)
**Hermes:** `hermes profile` — multiple isolated HERMES_HOME instances.
**Remediation (S, low priority):** `--profile <name>` selecting an alternate data dir; `GET/POST /api/profiles`. Low value for a single-user sovereign agent.

### Achievements / gamification — **skip** (bloat under the 20%-essential rule).

## 5. Where ABUZ8 already matches or leads (don't spend effort)

No dimension was found fully behind in *idea* — every gap above is "partial" depth or a small adjacent feature. ABUZ8 **already covers or leads** on:

- **Core agent loop, goals, coder loop, swarm orchestrator, multi-brain consult** — present; swarm/consult already parallelize.
- **Two-way messaging** — built-in turnkey **Telegram** gateway + shared `botRespond`; discrete Slack/Twilio handlers exist but **require manual webhook setup**, and the generic `/api/gateway/inbound` "universal gateway" (Discord/n8n/Zapier) is an unimplemented stub.
- **MCP client** — real JSON-RPC client + Claude-Desktop/Docker import (only the *catalog UI* is missing).
- **Headless/stdio interface** — `abuz8-mcp-stdio.js` (only the ergonomic `abuz8` binary + slash-REPL are missing).
- **Self-modification** — `selfUpgradePropose` edits ABUZ8's own source in a git worktree gated by `node --check` with rollback — **beyond** Hermes.
- **Business cockpit / Command Center / HUD, Content Studio, Forge, Operator/vision, deploy, mobile build** — Hermes has no equivalent.
- **Sovereign / no-API-fees** — local llama :8902 + CLI brains on the user's own accounts.
- **LAN/PWA/public-tunnel remote access** — ABUZ8 leads the web-dashboard story (only streamed upload + per-device pairing are gaps).
- **Coarse per-call usage telemetry** — `recordUsage` ring exists (just unexposed).
- **USB portable data bundle** — `make-portable-bundle.ps1` (just needs in-app export + sessions/goals + restore).
- **Voice (Piper/Whisper), Playwright browser, vision, themes (Fable/Mythos)** — already present.

## 6. Corrections (verification overturned the first-pass claim)

These were initially called **"missing"/over-claimed** and were corrected after reading ABUZ8 source — trust the report accordingly:

1. **TUI/CLI: "No terminal/headless interface at all" → PARTIAL.** `src/mcp/abuz8-mcp-stdio.js` is a shebang'd headless stdio JSON-RPC server (`electron . --mcp`, no GUI, readline over stdin, ~22 tools incl. `abuz8_chat`/`abuz8_tools_list`). Only the ergonomic binary + slash-REPL + shell completion are genuinely absent.
2. **Messaging connectors: "only Telegram, hardcoded, no adapter abstraction" → partly overturned.** Only the **Telegram** gateway is a built-in turnkey two-way channel. ABUZ8 *also* has `/api/gateway/slack/events` and `/api/gateway/twilio` handlers + shared `botRespond()/commandReplyText()` in code (newer than CHANGELOG 1.23.0) — but **Slack/Twilio require manual webhook setup**, and `/api/gateway/inbound` (the generic Discord/n8n/Zapier "universal gateway") is an **unimplemented stub**. Real remaining gaps: the universal-gateway implementation, directory/aliases, prompt hints, allowlists, inbound media, iMessage/Teams.
3. **Backup-portability: "backs up no user data" → understated.** `make-portable-bundle.ps1` does a real recursive copy of config/soul/skills/mcp/memory/mission/attachments/models/exports. Still partial: omits sessions+goals, swap-only (no restore/merge), no machine-state skip-list, no pre-update snapshot.
4. **Config-onboarding: "no consolidated Settings panel" → false.** A real consolidated Settings view exists (`loadSettings` 1455). The substantive gaps (schema versioning/migration, guided provider onboarding, `doctor`) stand.
5. **MCP: "can't run diverse servers" → understated.** ABUZ8 already runs arbitrary remote/stdio servers + Docker MCP gateway import; only the curated **browseable catalog UI** is missing.
6. **Observability/billing: "no usage capture at all" → understated.** `recordUsage` ring (5136) captures per-call token estimates + tok/s + ms across all brain lanes; it's simply never exposed through `/api/usage` or a viewer. Remediation wires the existing ring, not from scratch.

---

## Appendix A — Completeness critic (uncovered capabilities)

Confirmed. ABUZ8 has no ACP/editor integration, no DM pairing/contact whitelist for inbound messaging, no conversational blueprint automation, no usage-insights analytics, no per-edit filesystem checkpoint/rollback, no multi-profile isolation, no achievements/gamification. The "allowlist" hit is a command allowlist (unrelated to inbound-contact gating).

Here is my completeness-critic report.

---

## Significant Hermes capabilities NOT covered by the 16 studied dimensions

The 16 dimensions (relay-gateway, messaging-connectors, desktop-app, memory, skills-curator, mcp, providers-models, cron-scheduling, autonomy-self-improve, observability, security-operator, billing, config-onboarding, web-dashboard, tui-cli, backup-portability) miss the following genuinely user-facing capabilities. Each is checked against ABUZ8's CHANGELOG (its feature ledger).

1. **ACP / editor-IDE integration** — exposes the Hermes agent over the Agent Client Protocol so external editors (Zed, JetBrains, etc.) drive it as their agent backend. Path: `acp_adapter/server.py` ("ACP agent server — exposes Hermes Agent via the Agent Client Protocol"), `hermes_cli/subcommands/acp.py`. **ABUZ8: NO** (0 real hits; matches were false positives).

2. **Filesystem checkpoints / per-edit rollback** — automatic snapshot store at `~/.hermes/checkpoints/` backing a user-facing `/rollback` to undo agent file edits, plus `hermes checkpoints status|list|prune|clear`. Path: `hermes_cli/checkpoints.py`. This is editing safety, distinct from session/state backup-portability. **ABUZ8: NO** (0 hits for rollback/file-checkpoint).

3. **DM pairing / inbound-contact gating** — a pairing-code allow/approve/revoke system that controls which external users can DM the agent across messaging platforms (`hermes pairing list|approve|revoke|clear-pending`, `gateway.pairing.PairingStore`). Path: `hermes_cli/pairing.py`. Security for the *inbound* messaging surface, not covered by the outbound connectors or operator dimensions. **ABUZ8: NO** (its only "allowlist" is a dev-command toolchain allowlist, unrelated).

4. **Conversational Automation Blueprints** — a named catalog of templated automations with typed slots that the agent fills one question at a time and turns into a cron job, available across CLI/TUI/gateway/dashboard (`/blueprint`, `fill_blueprint` -> `create_job`). Path: `hermes_cli/blueprint_cmd.py`. This is the human-friendly authoring layer *on top of* cron-scheduling, not raw cron. **ABUZ8: shipped in v1.24.0** (this 2026-06-18 entry predates it); Hermes still leads on typed-slot template depth.

5. **Usage insights / cost & activity analytics** — `hermes insights` analyzes local session history to report token usage, costs, tool-usage patterns, and activity trends. Path: `hermes_cli/subcommands/insights.py`. Distinct from observability (tracing/Langfuse) — this is user-facing spend/usage reporting. **ABUZ8: PARTIAL/NO** — has a Command Center/HUD cockpit but no historical token/cost/tool-pattern analytics surface (0 hits).

6. **Multi-profile isolation** — `hermes profile` manages multiple fully isolated `HERMES_HOME` instances, each with its own config/sessions/memory, switchable from the CLI. Path: `hermes_cli/profiles.py`. **ABUZ8: NO** (0 hits; single-instance only).

7. **Achievements / gamification** — a vendored dashboard plugin that scans real session history to unlock tiered badges with shareable 1200x630 PNG share cards. Path: `plugins/hermes-achievements/`. Engagement/retention surface. **ABUZ8: NO** (0 hits). *Lower priority — bloat-adjacent under ABUZ8's 20%-essential philosophy.*

### Notes (already covered — NOT gaps)
- Image-gen / video-gen plugins, voice (TTS/STT), goals (Ralph loop), browser/CDP connect, clipboard-image, skins/theming, Spotify, Teams meeting pipeline → ABUZ8 already has equivalents (Content Studio image gen, Piper/Whisper voice, goals v-something, Playwright browser, Fable/Mythos themes) or they fall under existing dimensions (connectors/skills/providers).

### Recommended ABUZ8-native remediation (highest leverage first, single-binary local-first)
- **#2 Rollback** — add `portable-core.js` middleware that copies any file before an agent write into `~/.abuz8/checkpoints/<sha>/`, plus endpoints `POST /api/checkpoints/rollback`, `GET /api/checkpoints`, `DELETE /api/checkpoints`; renderer "Undo last edit" button. Cheap, high safety value.
- **#3 Pairing** — `POST /api/pairing/request` (issues code), `POST /api/pairing/approve`, `GET /api/pairing/list`, `POST /api/pairing/revoke`, persisted in a `pairings` table; gate the Telegram gateway inbound handler on approved sender IDs. Directly hardens the existing Telegram surface.
- **#5 Insights** — `GET /api/insights?range=` aggregating existing session/token logs into tokens/cost/tool-frequency/activity; render as a Command Center tab (reuses HUD).
- **#1 ACP** — `POST /api/acp` JSON-RPC bridge mapping ACP session/prompt/tool calls onto the existing :8900 agent loop, so Zed/JetBrains use ABUZ8 as their agent (sovereign, no API fees).
- **#4 Blueprints** — ship a small JSON blueprint catalog + `GET /api/blueprints`, `POST /api/blueprints/:name/create-cron` that fills slots and writes into the existing cron/goals store; conversational fill in chat.
- **#6 Profiles** — `--profile <name>` flag selecting an alternate ABUZ8 data dir; `GET/POST /api/profiles`. Lower priority for a single-user sovereign agent.
- **#7 Achievements** — skip or defer (bloat per the 20%-essential rule).
