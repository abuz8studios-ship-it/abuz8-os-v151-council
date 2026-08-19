# ABUZ8 → All-in-One Company Operator — Build Sheet (items 1–6)

> Grounded in the real codebase, not the "fuse 9 agents" fantasy. ABUZ8 already has
> memory, scheduler, goals, swarm, HUD, Stripe, gateway, self-upgrade, mesh, coder loop
> natively. The remaining gap to a true company operator is the **6 infrastructure/safety
> items below + the operator-supplied accounts/legal/host** — nothing more.
>
> Legend: **[CODE]** = I build it. **[YOU]** = account/key/legal/host only you can supply.
> Status: ✅ done · 🟡 partial · 🔴 not started.
>
> **SHIPPED & VERIFIED 2026-06-19 — the whole code half of the list is done.** Every
> endpoint below was tested live against the running app (not just 200s): brief aggregates,
> red-tier blocks then allows on approval, vault round-trips and the on-disk file is pure
> AES-256-GCM ciphertext, ledger computes net/ROI, voice matrix lists every offline voice +
> 18 STT locales, store checkout honestly returns `needs_key` and the webhook fulfils a sale.
> What's left is **[YOU]**: a host for 24/7 and a Stripe key. (Voice is now fully native + offline — verified.)

---

## 1. Always-on daemon mode  ✅ (code done; host = your call)
**Goal:** ABUZ8 runs and acts while you sleep — not tied to the app window.
**Why:** the backend (`portable-core` on `:8900`) is already a persistent server with `schedulerTick`, goals, and gateway loops — but it dies when the Electron window closes.
**Definition of done:** closing the window leaves the operator running; a scheduled goal fires overnight and a result is waiting in the morning brief.
- **[CODE]** Headless entry: launch `portable-core` without the Electron window (`--headless`), or a tray-only mode; keep `:8900` + scheduler + gateway alive.
- **[CODE]** Register as a Windows **auto-start** (Task Scheduler "at logon" or a tray app), with `/api/halt` respected on boot.
- **[CODE]** "Morning brief" artifact at a set hour: cash + queue + blockers + yesterday's results → `/api/brief`.
- **[YOU]** Decide host: this PC always-on, or a cheap VPS for true 24/7.

## 2. Kill switch + tiered approval  ✅ (kill switch + green/yellow/red tiers DONE)
**Goal:** safety floor before autonomy — instant stop, and graduated permissions.
**Definition of done:** one call freezes everything; spend/publish/delete require explicit sign-off.
- **[CODE] ✅ DONE** Global kill switch: `POST /api/halt` (freezes actions, scheduler, inbound gateway), `POST /api/resume`, `GET /api/halt/status`. Verified live.
- **[CODE] ✅ DONE** Command danger-guard: hardline refuse-list + approval gate (`/api/actions/approve-command`).
- **[CODE] 🟡 NEXT** Replace the binary "Allow actions" with **green/yellow/red tiers**: green (read/draft/research) autonomous; yellow (publish, spend < cap) → approval queue; red (payments, account creation, external comms) → human only. Persist tier rules in settings; enforce in `callLocalTool`.
- **[CODE]** Approval queue endpoint + a HUD panel listing pending yellow/red actions.

## 3. Encrypted secrets vault  ✅ (AES-256-GCM, verified ciphertext at rest)
**Goal:** ABUZ8 holds real keys without leaving them in near-plaintext JSON.
**Why:** secrets currently live in `connectors.json` / `oauth.json` (readable on disk); MCP env is already scrubbed (done), but at-rest encryption is missing.
**Definition of done:** keys encrypted at rest; agents get **scoped, short-lived** tokens, never the master secret; nothing secret in logs (redaction already added).
- **[CODE]** Encrypt the secrets store at rest (Windows DPAPI / `safeStorage`, or a passphrase-derived key).
- **[CODE]** `vaultGet(scope)` returning only the keys a task needs; audit every access.
- **[YOU]** A master passphrase or confirm DPAPI (machine-bound) is acceptable.

## 4. Revenue ledger + telemetry  ✅ (per-channel P&L + ROI)
**Goal:** see money per channel, and cost/ROI per action — optimize what you can measure.
**Why:** `/api/usage` + `/api/cost/summary` now exist (just shipped); the HUD shows Stripe — but there's no per-channel P&L or per-action ROI tag.
**Definition of done:** one query shows revenue by channel, spend by action, and net ROI for the week.
- **[CODE]** `revenue.jsonl` — every action tagged `{channel, cost, expected_value, actual_value, roi}`.
- **[CODE]** `/api/revenue/summary` (real, replacing the stub) + a HUD "P&L" tab with a CSS bar chart; $0 sovereign cost shown as a selling point.
- **[YOU]** Connect at least one real revenue source (Stripe / Gumroad / Lemon Squeezy) so numbers are real.

## 5. Offline duplex voice + full language/voice matrix  ✅ (live offline loop + sentence-chunked TTS — verified TTS→STT round-trip)
**Goal:** talk to ABUZ8 in real time, hands-free, **even with the internet cut** — in any bundled language/voice.
**Why:** Piper TTS + Whisper STT are bundled, but there's no real-time duplex stream or a full voice picker.
**Definition of done:** push-to-talk **and** wake-word; partial transcripts while you speak; chunked TTS while it replies; every bundled voice selectable per language; works offline on the local brain.
- **[CODE]** Duplex voice loop in the UI over a WebSocket; sub-500ms first audio byte where hardware allows.
- **[CODE]** STT: whisper.cpp with explicit locale list (en, ar, es, fr, de, pt, zh, ja, ko, hi, ru, tr, it…), partial transcripts.
- **[CODE]** TTS: expose **every** bundled Piper voice in a picker (male/female/neutral per locale); chunked streaming; honest UI note when a locale has no offline voice.
- **[CODE]** Brain routing: offline → local `:8902`; online → user's accounts. Voice never hard-requires internet.

## 6. One live revenue lane (end-to-end)  🟡 (wired + webhook verified; awaiting your Stripe key)
**Goal:** the only proof that matters — ABUZ8 sells, delivers, and logs a real product while you sleep.
**Definition of done:** a single SKU listed, sold, auto-delivered on payment webhook, and visible in the ledger — start to finish, no manual step.
- **[CODE]** Stripe Checkout + payment webhook → auto-fulfill (digital delivery) → `revenue.jsonl`.
- **[CODE]** Pick ONE faceless lane first (digital product / template kit / automated pipeline) and wire it fully before any second lane.
- **[YOU]** Funded Stripe (or Gumroad/Lemon Squeezy) account; the product to sell; legal/tax wrapper.

---

## The remaining gaps — glued (so he knows himself)
- **Self-knowledge** ✅ **DONE** — `CAPABILITY_MANIFEST` is injected into the agent's system prompt (`composeSystem`), so it states its real capabilities instead of claiming "no memory / no scheduler / no revenue." Human-readable mirror: [`docs/CAPABILITIES.md`](../CAPABILITIES.md).
- **Per-turn learning** ✅ **DONE** — `reviewTurn()` runs after every chat exchange (`/api/chat` + `/api/chat/live`), extracts durable user facts/preferences/corrections, and writes them to vector memory. Verified: a stated fact persisted to disk and was recalled by semantic search — real learning each pass, not the 15-min batch. (`/api/learn/review` triggers it manually.)
- **Company DNA** 🟡 — formalize `SOUL.md` + a `COMPANY.md` (mission, niche, pricing rules, halal constraints) + rolling `MEMORY.md` daily-log consolidation. Mostly existing memory infra; needs the framing.

## Honest bottom line
Do **not** integrate Manus / CrewAI / Replit / cash.bot / cognitum / hyperagent / OpenClaw — ABUZ8 already replicates them and doing so breaks the sovereign/local-first edge. Finish **1–6**, supply the **[YOU]** items, and ABUZ8 *is* the all-in-one operator — natively, not by gluing competitors.
