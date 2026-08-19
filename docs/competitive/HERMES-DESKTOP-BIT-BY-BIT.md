# Hermes Agent Desktop vs ABUZ8 OS — Bit-by-Bit Comparison

> Source: verified file-grounded findings across 23 studied units + a completeness critic that surfaced 7 uncovered Hermes subsystems. Hermes head = `d2c53ff5`. ABUZ8 ledger = `CHANGELOG.md` through v1.23.0. Honest in both directions.

---

## 1. TL;DR

Hermes Desktop is organized as **"a chat with overlays"**: a tiny flat route table where `/` *is* a new chat and `/:sessionId` is a conversation, with only 9 named surfaces — and 5 of those (settings, command-center, cron, profiles, agents) render as **full-screen modal overlay cards floating over the live chat**, not page swaps. Underneath sits a disciplined engineering substrate: a written `DESIGN.md` constitution, a single React primitive library, generative WCAG-corrected theming, a CSS-grid pane engine with resize + hover-reveal + left/right flip, a true tool **registry** with capability gating, a SQLite **kanban kernel** that doubles as the execution engine, and one unified `hermes` CLI binary (~50 verbs) that makes the whole product scriptable.

**ABUZ8 already leads** in several places and must not regress these: sovereign/no-API-fee local brains with a native llama.cpp fallback; multi-brain thinking modes (single/council/debate/auto) + web-grounding in an in-composer pill; a genuine business cockpit (CEO/CFO/CRO/COO/CKO/CTO HUD with Stripe/CRM/content-loop write-actions); a self-improving skill loop that *writes its own SKILL.md files* from successful traces and semantically recalls them; a local semantic vector RAG + Second Brain vault; a cross-machine Fleet Mesh; voice (Piper/Whisper local, acoustic barge-in, wake word, presence-aware, Arabic diacritization, 3D lip-synced avatar); and 12 cinematic gradient themes.

**ABUZ8 trails** mainly on *craft, observability, and ops tooling*: it has no per-message action bar, no structured/live tool-call cards or human-in-the-loop approval, no prompt queue/steering, no @/slash completions, no live subagent tree, no real cron-expression scheduler with run-history, no persistent file-tree, no keyboard session switcher, no auxiliary-model routing, no design-system discipline (one 3392-line HTML, 0 aria-labels, 0 i18n), and **none** of Hermes's autonomy/safety/ops layer (Automation Blueprints, Suggestions, Insights/usage analytics, Security audit/advisories, Checkpoints/rollback, Doctor, Backup, a CLI binary).

**Headline takeaway:** ABUZ8 can *do* more sophisticated, sovereign, business-grade agent work; Hermes is better organized, more observable, more maintainable, and lets you *watch and govern* the work. The win condition is to keep ABUZ8's substance and graft Hermes's craft + ops verbs surgically — migrate the idea + the ~20% essentials, never the bloat.

---

## 2. Surface-by-surface table

| Surface | What Hermes does | ABUZ8 equivalent | Status | Who's better | Effort to close |
|---|---|---|---|---|---|
| **Chat surface** | @assistant-ui runtime; streaming subtree-isolation; live/structured tool cards + HITL approval; per-msg action bar (copy/regen/edit/branch/read-aloud/restore); rich contentEditable composer w/ @+/ popovers; prompt queue + Cmd+Enter steering; drag-drop + paste-image; per-thread drafts; sent-history recall | `src/renderer/index.html` SPA: `renderThread`, `/api/chat/live` SSE w/ council `{note}` events, brain quick-switch pill, sessions, Ctrl+K, attachments, TTS/voice | partial | **Hermes** | M |
| **Artifacts / previews** | TWO surfaces: live sandboxed `<webview>` preview pane (console capture, devtools, file-watch reload, "restart dev server"); + full-page cross-session **Artifacts gallery** auto-indexing images/files/links | `#artifact-pane` (`renderArtifact/showWeb/showCode/showDiff/showMarkdownArt/showBuildArtifact`) + dock-flip + persisted width; wired to coder loop `/api/coder/file` | partial | **Hermes** | M |
| **Agents (live subagent tree)** | Read-only recursively-nested live tree of `delegate_task` subagents; per-row status glyph + metrics (model/duration/tools/tokens/cost) + files-touched + parallel-batch grouping | Swarm view + `/api/swarm/run`; `orchestrate()`; flat Activity feed (15 kinds); **Fleet Mesh** cross-machine | present | **Tie** (ABUZ8 does more; Hermes lets you watch better) | M |
| **Command Center / HUD** | Dev/ops overlay: Sessions + System health (restart/update) + Usage analytics (token/cost bar chart, top-models/skills, 7/30/90) | Business cockpit `hudSnapshot()` `/api/hud`: CFO/CRO/COO/CKO/CTO tiles + CEO objective→`/api/orchestrate` + inline SEO article | present | **Tie** (different territory) | M |
| **Command palette (Ctrl+K)** | cmdk launcher: live data (200 sessions, settings fields w/ deep-link, MCP servers, archived), nested VS Code-style sub-pages incl. Marketplace theme installer, per-item hotkey hints, dual mod+k/mod+p | `PALETTE[]` static array + `openPalette()` covers 24 surfaces; separate richer brain quick-switch popover | present | **Hermes** | M |
| **Cron / scheduling UI** | Master/detail; real cron exprs + NL presets + custom w/ live human-readable preview; run-history as openable sessions (8s poll); next/last-status/last-error; per-job delivery channels; pause/resume/repeat-count; full edit | "Autonomy Schedules" `/api/autonomy/*` — richer **actions** (task/orchestrate/mission/goal/coder/tool/social/content_loop) but 4-option dropdown, no edit, only `last_run` | partial | **Hermes** (as a scheduling UI) | M |
| **Gateway / remote** | Desktop dials OUT to remote backend: auth-mode probe, OAuth/password/token sign-in, WS-ticket minting, per-profile scoping, exponential-backoff sleep/wake reconnect, per-request retry; relay enrollment | Inverse: ABUZ8 is SERVED remotely — LAN PWA `/m` + PIN gate, cloudflared `/api/tunnel/*`, Fleet Mesh dispatch | partial | **Tie** (inverse problems) | M |
| **Messaging / connectors** | Dedicated "Channels" master-detail; 20 two-way platforms (iMessage/Slack/Signal/WhatsApp/Matrix/SMS/email + China stack); dynamic plugin catalog; structured per-field schema; 6s status poll; per-platform /test | Connect + Social Beacon + Telegram toggle; outbound `/api/social/post` fan-out (13 platforms) + agent-callable connectors — but 1 real inbound gateway (Telegram) | partial | **Hermes** (for inbound connector mgmt) | M |
| **Profiles / personas** | Fully isolated `HERMES_HOME` per profile (config/.env/memory/sessions/skills/cron + own gateway); clone/rename/delete/export/import; git-distributable | Agent Classes "The Lineage" `/api/classes` — 5 hardcoded specialist personas, instant switch, shared dataRoot, no isolation/clone/export | partial | **Hermes** (for isolation); ABUZ8 better instant-switch UX | M |
| **Right sidebar / file browser** | Persistent virtualized `react-arborist` tree of session cwd; gitignore-aware; drag-out + SHIFT-attach; OS+remote pickers; self-healing root; embedded **xterm terminal** w/ select-to-chat | `#artifact-pane` (richer renderer) + `#ctx-pane`; file list only inside build artifacts (`/api/coder/files`); no persistent tree, no terminal | partial | **Hermes** (file browser); ABUZ8 wins preview/diff renderer | M |
| **Sessions / windows** | `^Tab`/`^1-9` Mac switcher; multi-window pop-out + watch/spectator windows; resume self-heal state machine; 8-min watchdog; lineage pinning; sectioned sidebar | Server-side JSON sessions `/api/sessions` (+ deeper full-text search); Chats sidebar, search modal, rename/delete, Ctrl+Shift+N | partial | **Hermes** (workspace); ABUZ8 better search | M |
| **Settings / providers / models** | Deep-linkable; export/import/reset; **auxiliary model matrix** (8 task slots); per-model reasoning_effort + fast tier; **model visibility**; inline key activation; ~28 vendor cards; VS Code theme install | Ark `/api/providers/*` + Settings; native fallback brain, thinking modes, Soul editor, app-bridge providers, health roll-up — but no aux routing/visibility/reasoning UI | partial | **Hermes** | L |
| **Skills management UI** | Two-tab toggle console (Skills/Toolsets): category filters+counts, search, per-skill on/off, toolset config panel (provider picker, env-var fields, inline installer) | Read-only installed grid + self-learning v2 (`synthesizeSkillsOnce`/`retrieveSkills`); MCP surface for toolset-equiv | partial | **Tie** (Hermes curation; ABUZ8 self-generation) | M |
| **Shell / navigation / IME** | Chat-first route-driven shell; overlay-views; CSS-grid pane engine (resize/hover-reveal/flip); OS-native frameless titlebar; statusbar; URL-as-state | ~30-surface labeled grouped sidebar; work-modes pills; density toggle; draggable tri-pane; topbar live pills | present | **Tie** (ABUZ8 IA breadth; Hermes shell mechanics) | M |
| **Lifecycle overlays** | 5 full-screen overlays: install-progress (staged, log tail, cancel/retry), onboarding, gateway-connecting, **boot-failure recovery** (retry/repair/local/logs), dual-target git self-update w/ changelog | Cinematic `#boot` hardware probe; first-run wizard; `/api/update/*` manifest update; **self-code-update** `/api/self/apply`+rollback; `.exe` installer | partial | **Hermes** (ABUZ8 wins boot polish + self-code-update) | M |
| **Ambient UI** (notifications/status/haptics/i18n/prompt-overlays/brand/themes) | Typed 4-kind toast stack (portaled, a11y, actions); 12-intent haptics; 4-locale i18n switcher; sudo/secret modals w/ "silence≠consent"; generative themes | `toast()` single bubble; `.dot`; 12 gradient themes + density; agent-reply language matching (incl. Arabic) — no UI i18n switcher, no haptics | partial | **Tie** (ABUZ8 themes; Hermes notifications/i18n/haptics) | M |
| **Voice** | PTT dictation + hands-free loop; streaming sentence-chunk TTS; per-msg read-aloud; whisper-hallucination filter; local Piper/Kitten/Neu + cloud providers (edge default) | Piper TTS + Whisper STT (local default); acoustic barge-in; "Abuu" wake word; presence-aware; Arabic diacritization; dedicated fast voice brain; 3D avatar | present | **ABUZ8** | S |
| **Design system** | `DESIGN.md` constitution; single primitive lib; color-mix() token chain; VS Code import + WCAG auto-correct; 21-curve Loader; i18n + a11y | Single-file SPA; CSS-var tokens; 12 hand-authored gradient themes + density + draggable panes; 0 primitives, 0 a11y, 0 i18n | partial | **Hermes** (system); ABUZ8 wins theme ambience | M |

---

## 3. Skills — catalog comparison

**Verified:** Hermes ships **73 `SKILL.md` files across 18 umbrella directories** (`find skills -name SKILL.md | wc -l = 73`); each is a structured playbook with YAML frontmatter, managed via `hermes_cli/skills_hub.py` (CLI + `/skills`), per-platform togglable, with a marketplace cache (`skills/index-cache/`). **ABUZ8 ships ~2 authored/migrated packs** (`x-growth-monetization`, `kanban-video-orchestrator`) + the self-learning loop.

| Hermes umbrella (count) | Representative skills | ABUZ8 coverage |
|---|---|---|
| **apple (5)** | macos-computer-use, imessage, findmy, notes, reminders | None (Windows-first) — N/A |
| **autonomous-ai-agents (4)** | claude-code, codex, opencode, hermes-agent | Partial — ABUZ8 has its own coder loop + brain CLIs |
| **creative (16)** | comfyui, manim-video, p5js, excalidraw, touchdesigner, humanizer | None as packs — overlaps Content Studio/Forge idea |
| **data-science (1)** | jupyter-live-kernel | None |
| **devops (2)** | kanban-orchestrator, kanban-worker | Partial — mission board, no worker-lifecycle pack |
| **dogfood (1)** | 5-phase web QA | None — overlaps Operator/Playwright |
| **email (1)** | himalaya | Partial — `send_email` tool (no terminal-email pack) |
| **github (6)** | code-review, pr-workflow, repo-management, issues, auth | None as packs — overlaps deploy |
| **media (4)** | youtube-content, gif-search, song-gen, spectrograms | None |
| **mlops (4)** | inference, models, evaluation, huggingface-hub | Partial — `/api/models/huggingface/download` |
| **note-taking (1)** | obsidian | None — overlaps Second Brain vault |
| **productivity (8)** | google-workspace, powerpoint, notion, airtable, nano-pdf, ocr, maps | Partial — connectors exist, no skill packs |
| **research (5)** | arxiv, polymarket, llm-wiki, blogwatcher, paper-writing | Partial — `deep_research` tool, no packs |
| **smart-home (1)** | openhue | None |
| **social-media (1)** | xurl (X/Twitter) | **Tie/lead** — Social Beacon outbound fan-out + `x_post` |
| **software-development (9)** | plan, TDD, systematic-debugging, spike, simplify, debuggers | Partial — coder loop covers idea, no packs |
| **yuanbao (1)** | Tencent Yuanbao | None — N/A |
| **index-cache** | external marketplace catalogs | None |

**Gap:** Hermes has a vastly larger, organized, installable, togglable human-authored catalog with discoverability + a validator. **ABUZ8's edge:** it *generates* skills autonomously (`synthesizeSkillsOnce` writes real SKILL.md from traces, embeds, `retrieveSkills` semantically recalls into the prompt at cosine>0.4, usage-weighted, 15-min loop) — Hermes desktop has zero self-learning. **Adopt:** normalize ABUZ8's authored + learned skills into Hermes's umbrella/frontmatter layout under one `skills/` tree; add `/api/skills/list` + `/api/skills/toggle` (write a `disabled[]`); hand-port ~8-12 high-leverage umbrellas that map to surfaces ABUZ8 *already has* (software-development → coder loop; dogfood → Operator; research/productivity → Content Studio; github → deploy), authored sovereign-style (own tools/CLIs, no paid 3rd-party deps). Skip the cloud-CLI packs (himalaya/gws/airtable/notion).

---

## 4. Tools & commands comparison

### Agent tool registry
Hermes `tools/registry.py` is a **true decoupled registry** — `register(name, toolset, schema, handler, check_fn, emoji, max_result_size)` with AST auto-discovery, per-tool **`check_fn` gating** (a tool's schema is hidden from the model unless its precondition holds), per-platform toolset config, per-tool result caps, and a **`tool_search` deferral** layer to cap prompt tokens when many tools/MCP servers are enabled. ABUZ8's `callLocalTool()` is a **hand-maintained if/else chain** plus a *duplicated* `KNOWN_AGENT_TOOLS` schema set (drift risk), a flat `SENSITIVE_TOOLS` consent gate (no capability gating), single static schema, no deferral.

| Capability | Hermes | ABUZ8 |
|---|---|---|
| Browser | ~12 granular tools (navigate/snapshot/click/type/cdp/console/dialog/vision) | single `browser_do` |
| File | read/write/**patch**/search_files | single `file_write` |
| Memory | one tool, batch ops, write-gated, threat-scanned | `abuz8_memory_write/search` (jsonl append + vector add) |
| Kanban | 9 tools | mission board tools |
| Orchestration | delegate_task, mixture_of_agents | `swarm_run`, `orchestrate` |
| **ABUZ8-only leads** | — | `deep_research` (full-page reads), `send_email`/`calendar_create`/`stripe_op`, `social_post`/`social_draft`, `jarvis_see`/`jarvis_brief`, `get_time` (OS clock)/`get_weather` (Open-Meteo) |
| MCP | registry namespacing + OAuth + description security scan | real JSON-RPC client (`/api/mcp/call`) |

### CLI / TUI
Hermes ships **one unified `hermes` binary** (~50 argparse verbs in the `_BUILTIN_SUBCOMMANDS` frozenset) — the whole product is scriptable, pipeable, remotely operable. **ABUZ8 has no CLI entrypoint at all** (only the consent-gated `cmd_run` tool). Power ABUZ8 doesn't expose: `kanban` (multi-board, worktrees, specify/decompose/swarm), `cron edit/pause/status`, `backup`/`import`, `checkpoints`, `doctor`, `insights`, `dump`, `claw migrate`, `goals`, `curator`.

**Completeness-critic uncovered Hermes subsystems with NO clean ABUZ8 analog (verified files exist):**
- **Automation Blueprints** (`hermes_cli/blueprint_cmd.py`) — named fill-in-the-slots automation catalog bridging chat ↔ cron. *ABUZ8: shipped in v1.24.0 (this 2026-06-18 inventory predates it); Hermes still leads on typed-slot template depth.*
- **Suggestions engine** (`suggestions_cmd.py`) — agent proactively proposes automations. *ABUZ8: none.*
- **Insights / usage analytics** (`subcommands/insights.py`) — token/cost/tool-pattern trends. *ABUZ8: none.*
- **Security audit + advisories + MCP security gate** (`security_audit.py`, `security_advisories.py`, `mcp_security.py`) — OSV.dev supply-chain scan, compromised-PyPI startup check, MCP command exfil gate. *ABUZ8: none.*
- **Checkpoints** (`checkpoints.py`, `tools/checkpoint_manager.py`) — per-turn shadow-git snapshots + `/rollback`. *ABUZ8: none* (only end-of-run git commit).
- **Doctor** (`doctor.py`) — env health. *ABUZ8: `/api/security/integrity` is a one-line stub.*
- **Kanban Swarm/specify/decompose** — verifier+synthesizer topology on the kanban kernel. *ABUZ8: partial (separate swarm/orchestrate, no kanban integration).*
- **Plugin system** (4-source discovery, `plugin.yaml` + `register(ctx)`). *ABUZ8: none.*
- **Model cost guard** — deliberate **non-gap** for ABUZ8 (no-API-fee/sovereign; cost is meaningless — say so, don't adopt).

---

## 5. Where ABUZ8 already LEADS — do NOT regress

1. **Sovereign / no-API-fees** — embedded llama.cpp native brain runs with zero login as the default fallback; CLI brains run on the user's OWN Claude/Grok/ChatGPT/Gemini accounts. Hermes has no native-fallback model and its best voice/memory/models lean on paid cloud providers.
2. **Multi-brain thinking modes** — in-composer pill switches single/council/debate/auto + web-grounding + council brain-set; SSE `/api/chat/live` natively streams council/debate `{note}` progress. Hermes switches one main model only.
3. **Business cockpit (HUD)** — `hudSnapshot()` aggregates a live C-suite (CFO real Stripe balance, CRO content loops, COO mission/schedule graphs, CKO vault+memories, CTO providers/connectors) with **write-actions** (CEO objective → `/api/orchestrate`, inline SEO article). No Hermes equivalent.
4. **Self-learning v2** — agent writes its own SKILL.md from successful traces, embeds, semantically recalls into the live prompt. Hermes desktop has none.
5. **Local semantic RAG + Second Brain vault** — nomic embeddings on :8904, cosine recall; ingest URL/text → owned Markdown notes + ask-anything. Hermes's built-in memory is a flat dumped list (semantic recall only via paid external providers).
6. **Fleet Mesh** — cross-machine control-node → worker dispatch over HTTP (`/api/mesh/dispatch`). Hermes is single-process.
7. **Voice** — local Piper/Whisper by default, **acoustic barge-in** (parallel echo-cancelled VAD cuts TTS the instant you speak), **"Abuu" wake word**, **presence-aware** (pauses when you leave), **Arabic diacritization** (libtashkeel), **dedicated fast voice brain** (Qwen 0.5B :8903), **3D lip-synced avatar**. Hermes has none of these (verifier-confirmed).
8. **Self-code-update** — patches its OWN source, git-commits, rebuilds app.asar, rolls back. Hermes self-update only git-pulls a pre-existing branch.
9. **Served-remotely** — phone PWA `/m` + one-command cloudflared tunnel auto-secured with a PIN. Hermes has no "serve myself remotely" mode.
10. **Cinematic themes + boot** — 12 gradient/glow skins, density toggle, hardware-probe boot screen. ABUZ8 looks richer out of the box.
11. **Mission graph approval gates** — first-class human-approval nodes (`approveMissionNode`) Hermes's kanban lacks.

---

## 6. Where Hermes leads — adopt these (prioritized)

Ranked by value-to-effort. All ABUZ8-native, single-file SPA + `portable-core.js`, sovereign.

1. **Per-message action bar (S, chat).** In `renderThread()` add hover buttons on `.msg.ai` — Copy (`navigator.clipboard`), Regenerate (re-call `sendText` with prior user turn), Read-aloud (reuse `speakReply`/`stopSpeaking`); on `.msg.user` an Edit (load text back, truncate thread). No backend change. *Biggest UX gap closed cheapest.*
2. **Boot-failure recovery overlay (S/M, lifecycle).** Renderer overlay when :8900 unreachable after N retries — Retry / Repair (restart brain+backend) / Open logs / collapsible last-40-lines from a new `GET /api/logs/recent`. Closes "app renders dead with only a toast."
3. **Auxiliary / task-model routing (M, settings — Hermes's biggest organizational lead).** Add task slots to `settings.json` (`vision_model`, `compress_model`, `title_model`, `curator_model`); small matrix in `loadSettings()` → `/api/settings`; **default every slot to native brain** so sovereignty holds; `reasonReply`/vision read the slot before falling back.
4. **Keyboard session switcher (S, sessions).** `^Tab`/`^Shift+Tab` step recent, `^1-9` jump to Nth, tap-vs-hold reveal — port `session-switcher.ts` logic over `/api/sessions`, commit via `switchSession()`. Pure renderer.
5. **Live/structured tool-call cards (M, chat).** Extend `/api/chat/live` SSE to emit `{tool_start,name,args}`/`{tool_end,result}` from `agenticReply`'s `onNote` path; render an expandable tool card instead of the after-the-fact `tool · name` chip. Add live subagent-tree view by tagging events with `agentId`/`parentId` + `/api/agents/tree`.
6. **Prompt queue + steering (M, chat).** Client-only: queue on `send()` while a reply pends, show queued pills, drain on complete; Ctrl+Enter → append-to-context nudge.
7. **Drag-drop + paste-image attach (S, chat).** Wire `dragover`/`drop` on `#chat-thread` + paste handler on `#chat-text` into existing `processFile()`/`pendingAttach`.
8. **Slash + @ completions (M, chat).** Lightweight popover over `#chat-text` driven by `/api/skills`, `/api/sessions`, `/api/agents/roles`; start with `/skill`, `/role`, `@session`.
9. **Cron-grade scheduling UI (M).** Extend `createSchedule` to persist `next_run`, `last_status`, `last_error`, `repeat`, `deliver`, append-only `runs[]`; add cron-expr parser + preset map; `/api/autonomy/update` (close no-edit gap) + `/api/autonomy/runs`; master/detail UI w/ run-history drill-in + Telegram delivery. **Keep ABUZ8's multi-kind action engine (the real edge).**
10. **Skills management UI (M).** Make skills toggleable (`enabled`+`category` flags, `/api/skills/toggle` writing a `disabled[]`, `retrieveSkills` skips disabled); merge installed+learned into one searchable/filterable Skills view.
11. **Automation Blueprints (✅ shipped in v1.24.0; this 2026-06-18 plan predates it).** A named catalog of fill-in-the-slots templates that seed the agent conversationally or create an autonomy schedule directly. Built on `content_loop` seeding + `/api/autonomy`. *Remaining: deepen typed-slot template depth to match Hermes.*
12. **Checkpoints + per-turn rollback for coderRun (M, safety).** Snapshot `workspaces/<project>` to a shadow git ref before each file-write step; `/api/coder/rollback`. Closes the one real autonomy-safety gap.
13. **Insights / usage tile (M).** Aggregate `logs/signal.jsonl` into `/api/usage?days=7|30|90` (calls, by-provider, daily in/out, top-skills); add a HUD tile w/ CSS bar chart. Cost honest-by-default ($0.00 on local/own-account brains — a *selling point*).
14. **Working-dir file tree (M).** `POST /api/fs/dir` lazy readdir (reuse `listProjectFiles` path guard + gitignore) → tabbed `#ctx-pane` (Chats | Files) lazy tree; SHIFT/drag attaches to composer; `artOpenFile()` already routes to the best-in-class preview side.
15. **Config export/import/reset + design-system hardening (S/M).** 3 buttons hitting `/api/settings`; derive theme tokens via `color-mix()` from ~5 seeds; port ~30 lines of WCAG contrast guard; factor ~6 CSS utility classes + write `docs/DESIGN.md`; add aria-labels to icon buttons + global Esc-to-close.
16. **Thin `abuz8` CLI shim (S — closes the loved-CLI gap cheaply).** ~120-line Node script that curls localhost:8900 (`abuz8 goal create`, `abuz8 mission board`, `abuz8 status`). Plus `/api/backup/create|restore` + upgrade `/api/security/integrity` into a real `abuz8 doctor`.

**Skip as bloat:** VS Code Marketplace theme browser, 28 auto-generated vendor env cards, 10x cloud TTS backends, per-profile separate gateways/systemd, China-stack messaging platforms, remote-reauth/relay enrollment, model cost guard, 21-curve Loader, haptics (desktop-only).

---

## 7. Organization / IA adoption plan (the structure the user loves)

ABUZ8 keeps its **rich ~30-surface sidebar** (a true OS — far richer IA than Hermes's 9 routes) plus work-modes/density. Layer Hermes's *shell mechanics* on top, staged:

**Stage 1 — Overlay-view pattern (S/M, highest perceived polish).** Hermes's defining move: settings/command-center/cron/profiles/agents float as **modal cards over the live chat** with return-path memory, instead of tearing down the running view. In `index.html` add `openOverlay(view)`/`closeOverlay()` that stashes the prior `.view`, shows a z-indexed container, restores on Esc/close. Apply to Settings, HUD, Operations first — so opening Settings never kills a running Chat/Build.

**Stage 2 — URL/hash-as-state (S).** `setView(v)` also sets `location.hash`; a `hashchange` listener restores; persist last view + restore on boot (today always lands on Dashboard). Enables deep-linkable surfaces + notification/deep-link jumps + back/forward.

**Stage 3 — Hover-reveal collapse (S).** Below ~820px collapse `#sidebar` to a 0-width track + left edge-trigger strip that slides in on hover (reuse existing `translateX(-105%)` mobile style). Space reclaim without losing the rich nav (mirrors Hermes's 768px rule).

**Stage 4 — Design-system discipline (M, compounds forever).** Reduce each `THEMES` entry to ~5 seeds + derive `--card/--border/--text2/3` via `color-mix()`; add the WCAG contrast guard; factor ~6 documented CSS utility classes (`.btn/.field/.card/.row/.empty/.spinner`); write `docs/DESIGN.md` ("one source per concern, tokens not literals"); add aria-labels + Esc-to-close. Optional VS Code/JSON theme import (instant infinite on-brand themes).

**Stage 5 — Right-rail upgrades (M).** Tabbed `#ctx-pane` (Chats | Files) with the lazy file tree (Stage 14 above); keep ABUZ8's superior artifact/diff/markdown renderer; auto-route the pane onto a `localhost`/`*.html` URL when the coder loop or a tool result yields one (detect in the chat-stream handler → `showWeb`).

**Skip:** pane-flip and OS-native frameless titlebar — high effort, low payoff for ABUZ8's dashboard model; the topbar + work-modes already cover that ergonomic need.

---

## 8. Corrections

One verdict-adjacent overclaim was overturned by adversarial verification, in the **Voice** unit:

- **Original reasoning claimed** "Hermes' best TTS/STT are cloud paid services; its only local STT is faster-whisper and its default TTS edge is a Microsoft cloud endpoint." **This understates Hermes.** Verified: Hermes ships **three fully-local, no-API-key on-device TTS engines** as native built-ins — **Piper** (the *same* OHF-Voice engine ABUZ8 uses), **KittenTTS** (25MB), and **NeuTTS** — see `agent/tts_registry.py` (LOCAL_BUILTINS L56-58) and `tools/tts_tool.py` (L13-15, 153-176, `_import_piper PiperVoice`); plus `local_command` for any CLI. STT also has local faster-whisper + `local_command` (`agent/transcription_provider.py` L10-11). So **Hermes CAN run voice fully offline.** ABUZ8's real edge is "**local-by-default + a dedicated local fast-voice model + acoustic barge-in + wake word + presence + Arabic + 3D avatar**," not "Hermes is cloud-only." (It remains true that `edge` (cloud) is Hermes's *default* TTS.)
- **The Voice verdict itself HOLDS:** ABUZ8 is **present + better**. Verifier confirmed all ABUZ8 voice claims are real (barge-in `startBargeWatch` runs a parallel echo-cancelled mic + AnalyserNode RMS watch *while* TTS plays, cutting via `onBarge()`; wake word `wakeStream`; presence `/api/presence`; Qwen 0.5B :8903; Arabic Kareem voice + libtashkeel; 3D avatar), and confirmed Hermes has **none** of acoustic barge-in (only Space-key stop), wake word, presence, Arabic diacritization, second/fast voice model, or a real 3D avatar (the "three" grep hits were CSS/icon false positives). Hermes's genuine, correctly-credited wins remain: streaming sentence-chunk TTS, per-message read-aloud, and a whisper-hallucination filter — all worth adopting (effort S).

No other verdicts were overturned; all 23 units' `whoIsBetter` calls stand as recorded.