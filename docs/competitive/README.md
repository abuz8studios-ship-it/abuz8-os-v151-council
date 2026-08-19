# Competitive intelligence — ABUZ8 OS vs Hermes & the 2026 agent-desktop field

Generated 2026-06-18 from the **newest** Hermes Agent source (`hermes update` → git `d2c53ff5`,
the v2026.6.5 "Surface Release" desktop line + 521 newer commits) plus live web research.
Each report was produced by a multi-agent workflow with an **adversarial verification pass**, so
"who's better" calls are honest in both directions (several first-pass "ABUZ8 is missing X" claims
were overturned on verification — see the Corrections sections).

## The three reports

| File | What it answers |
|---|---|
| [HERMES-GAP-ANALYSIS.md](HERMES-GAP-ANALYSIS.md) | **Strategic capability map** — 16 dimensions of Hermes vs ABUZ8 from source, with severity/effort and ABUZ8-native remediation. The one HIGH-severity gap + close-these-first top 5. |
| [HERMES-DESKTOP-BIT-BY-BIT.md](HERMES-DESKTOP-BIT-BY-BIT.md) | **Surface-by-surface** inventory — every Desktop screen, the 18 skill umbrellas, the tool/CLI registry, who's better, and a staged **IA/organization adoption plan**. |
| [AGENT-DESKTOP-LANDSCAPE-2026.md](AGENT-DESKTOP-LANDSCAPE-2026.md) | **Market landscape** — Hermes / Claude Cowork / Operator / browser-agents / Manus etc., what's winning, and ABUZ8's positioning. Cited; 13 confirmed / 12 killed claims. |
| [ONE-OPERATOR-BUILD-SHEET.md](ONE-OPERATOR-BUILD-SHEET.md) | **The 6 concrete items** to become an all-in-one company operator (daemon, kill switch+tiers, vault, ledger, voice, revenue lane) — code vs. account split, definition-of-done. |
| [../CAPABILITIES.md](../CAPABILITIES.md) | **Who ABUZ8 is & what it can completely do** — the grounded self-knowledge manifest (also injected into the agent's system prompt). |
| [../BUILT-VS-STATED-2026-06-20.md](../BUILT-VS-STATED-2026-06-20.md) | **Built-vs-stated honesty audit** (2026-06-20) — every marketing claim checked against the source; the basis for the documentation honesty pass. |

## One-paragraph takeaway

ABUZ8 has the **breadth and the sovereign edge** (no API fees, runs on the user's own
Claude/Grok/ChatGPT/Gemini accounts + local brain; business cockpit; self-code-update; voice with
barge-in/wake-word/3D avatar — none of which Hermes has). Hermes has the **craft, observability, and
ops floors** of an industrial product: a written design system, a "chat-with-overlays" IA, structured
tool-call cards, real cron, a tool registry, and a safety layer (command danger-guard, checkpoints,
backup). The play: **keep ABUZ8's substance, graft Hermes's fluidity + safety surgically** — the idea
plus the essential 20%, never the bloat.

## Already actioned (2026-06-18) — shipped & live in `app.asar`

- ✅ **Fluidity layer** (`src/renderer/index.html`): additive **overlay-view** pattern (peripheral
  surfaces float over the live workspace instead of swapping the whole page), **hash deep-linking +
  restore-last-view**, **smooth view transitions**, **collapsible nav-rail** with hover-to-peek.
- ✅ **Command danger-guard + MCP env scrub** (`portable-core.js`): `HARDLINE_RX` refuse-list (blocks
  `rm -rf /`, `format`, `mkfs`, fork-bombs, raw-disk writes — even with consent) + `DANGEROUS_RX`
  approval-gate via `POST /api/actions/approve-command`; `buildSafeMcpEnv()` stops leaking API keys to
  spawned MCP servers. *Live-verified: hardline refused, dangerous gated, safe runs.*
- ✅ **Observability**: `recordUsage` now computes cost (sovereign = $0) + persists `logs/usage.jsonl`;
  `/api/usage`, `/api/cost/summary`, `/api/traces` wired to real data (were empty stubs).
- ✅ **Backup/restore + pre-update snapshot**: `/api/backup` (37 MB zip verified), `/api/restore`
  (traversal-guarded + machine-state skip-list), auto snapshot inside `applyUpdate()`; `/health` now
  reports `version` + `build`.
- ✅ **Filesystem checkpoints/rollback**: `file_write` snapshots prior contents; `/api/checkpoints`,
  `/api/checkpoints/rollback`.
- ✅ **DM pairing**: `/api/pairing/*`; Telegram inbound gated on approved sender IDs (opt-in, back-compat).
- ✅ **Per-message chat action bar**: hover Copy / Retry / Read-aloud / Edit on every message.

Nothing was removed — all additive.

## Remaining (lower priority, from the gap report)

- Structured **live tool-call cards** (needs SSE `tool_start`/`tool_end` events) + live subagent tree.
- Cron-grade scheduling UI (real cron expr + run-history), working-dir file tree, auxiliary-model routing.
- ACP/editor-IDE bridge, usage-insights HUD tile, `abuz8` CLI shim. *(Automation blueprints shipped in v1.24.0 — Hermes still leads on typed-slot depth.)*
