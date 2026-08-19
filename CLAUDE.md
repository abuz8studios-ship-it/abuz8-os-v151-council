# CLAUDE.md — ABUZ8 OS = AbuJarvis (the ONE app)

## 🛑 THE ONE-REPO RULE (read before touching anything)

**This folder — `E:\ABU\ABUZ8_OS_DIST` — IS AbuJarvis OS.** It is the single, canonical,
self-contained agentic-OS desktop `.exe` (Fable lineage). It is the consolidation base.

**Never fork it. Never create a sibling build folder.** Every progression is **committed IN
PLACE** into this repo: edit `src/`, bump `CHANGELOG.md`, commit, done. The day a session
spawns a new top-level "build" folder is the day the vision fragments again — that is exactly
the mistake that turned ONE vision into six folders (AbuJarvis → QadirCore → Soloman → AL_BURAQ
→ ABUZ8 OS → Fable). Do not repeat it.

## The five sibling folders are READ-ONLY PARTS DEPOTS — harvest FROM them, never build IN them
- `E:\ABU\QADIR_CORE` — engine room (FastAPI :8900) + the live abuz8ai.com revenue store + the
  trained brains (qadir_v1/v2, LoRAs). Harvest: council/router logic; use the store as the
  Stripe fulfillment backend this app drives. Do NOT merge the 154GB server.
- `E:\ABU\ABUZ8_AGENT_OS` (Soloman) — deepest life-tracking logic (jiminy reflection, revenue-
  scored missions, entity_graph) + broadest social dispatcher. Harvest the *logic*, not the server.
- `E:\ABU\OPENCLAW` — skills catalog (~53) + channel adapters (~22 two-way). Harvest into `callLocalTool`.
- `E:\ABU\AL_BURAQ` — design spec only (self-upgrading LoRA loop, mission-graph, cinematic boot). Ideas only.
- `E:\ABU\HERMES` — borrowed (Nous, MIT), transport-only. Never an SKU.

## The vision (what "true" means here)
One self-contained Windows `.exe` like Claude Desktop — everything baked in, **no reliance on
external localhost ports** (it self-spawns its own brain/voice/vision as hidden children; any
external `:8900/:8910/:11434` is an OPTIONAL probe, never a dependency). Fuses Claude Desktop +
Hermes + OpenClaw + Manus + Antigravity + Cursor. Runs ANY AI (vLLM/llama.cpp/Ollama/LM Studio/
cloud) with switching + an **embedded brain fallback when cloud runs out**. Full data/project
sovereignty. Connects to + USES your apps. Agentic-first, tracks your life, generates revenue,
builds projects/sites/apps. **Windows-first → prove true → then Linux → then Apple.**

## Build rules
- Edit `src/`; keep root `portable-core.js` byte-identical to `src/portable-core.js` (CI enforces the mirror).
- Build: `bash scripts/rebuild.sh` packs `src/` → `app.asar`. The on-disk `.exe` must be rebuilt
  after source changes (don't trust a stale binary).
- Embedded brain: `EMBEDDED_BRAIN_CATALOG` (Qwen3.5-4B primary + LFM2 floor). Ship the GGUF in the
  build's `brain/` dir (resolveBrainDir) and/or let first-run download it from `MODEL_CATALOG`.

## Full consolidation map + functional-vs-not audit + glue plan
`E:\ABU\MISSION_CONTROL\ABUZ8-BRAIN\02-PROJECTS\notes\ABUJARVIS_CONSOLIDATION_PLAN_2026-06-20.md`
Built-vs-stated truth: `docs/BUILT-VS-STATED-2026-06-20.md`.
