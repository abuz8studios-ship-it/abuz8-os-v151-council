<!-- Generated 2026-06-20 by the built-vs-stated audit workflow (19 agents, grep-verified vs af61ff0/v1.24.4). -->

I have everything I need in the ground-truth payload. This is a synthesis-and-judgment task, not an exploration task — the evidence is already grep-verified with file:line anchors. Writing the report directly.

# ABUZ8 OS v1.24.4 — Built vs Stated

*Brutally honest founder report. Every claim below is anchored to `src/portable-core.js` / `src/renderer/index.html` line evidence supplied in the ground-truth audit. No hype, no fabrication — that's a guardrail, not a style choice.*

---

## 1. Headline Verdict

**ABUZ8 v1.24.4 is a real, ambitious, single-process local-AI operator shell — not vaporware — but it is an *engine without fuel* on a fresh install, and it is *narrower* than Hermes, not more powerful.** The architecture is genuinely there: a real llama.cpp inference stack with GPU/CPU adaptation, three working agentic loops (ReAct / task / goal), a 30-provider cloud router, a multi-brain CLI router (Grok/Claude/Codex/Gemini), council/debate modes, a complete safety spine (kill switch, consent gate, hardline command refusals, AES-256-GCM vault), a Claude-Desktop-class three-panel UI with a real MCP host *and* a reverse MCP server, a two-way Telegram gateway, a cloudflared tunnel, and a mobile PWA. That is a lot of real code.

But the gap between **stated** and **built** is concentrated in one fatal place: **`EMBEDDED_BRAIN_CATALOG = []` (portable-core.js:52)**. The three LFM2 GGUFs physically ship in `resources/brain` but are orphaned from the selector, so on a clean machine the OS boots into **canned "Portable Core" fallback text** until the user manually downloads or copies a model. Voice (Piper), STT (Whisper), vision, RAG embeddings, and a default avatar are all **fully coded but ship with no model/binary** — every "offline on day one" story degrades to a Windows-SAPI or keyword-search fallback. So the truthful one-liner: **the skeleton and nervous system are built and wired; the brain, voice, and eyes are bring-your-own. The "fusion of 10 products" is ~2 fully fused, ~6 partial, and 1 that is just a directory entry.**

---

## 2. Built vs Stated Ledger

### Lead with the gaps that matter (FALSE / STUB / FOUNDATION-ONLY)

| Capability | Status | Evidence | Why it matters |
|---|---|---|---|
| Bundled GGUF auto-selected on fresh install ("offline day one") | **FALSE / PARTIAL** | `EMBEDDED_BRAIN_CATALOG = []` (pc:52); comment "LFM brains were removed to keep the OS lean" (pc:49-51). LFM2 GGUFs exist in `resources/brain` but no catalog entry points to them; `availableEmbeddedBrains()` returns zero. | **The #1 gap.** Out of box the OS can't think locally — it emits canned text until the user supplies a model. |
| "LFM2 2.6B stays primary in this build" | **FALSE** | Stale canned string at pc:3228; runtime catalog is empty (pc:52). Files orphaned from selector. | Marketing/inline claim contradicted by code. |
| Desktop Commander integration | **FALSE** | Zero refs to `desktop-commander` in `src/`. Only marketing copy in CONNECT.md/SALES.md. | Listed as a fused product; not wired at all. |
| Windows-MCP integration | **FALSE** | Zero refs to `windows-mcp` in `src/`. SALES.md copy only. | Same — aspirational, not built. |
| `harvestAndLearnOnce` (cited in competitive docs) | **FALSE** | Symbol does not exist in source. Real harvest split across `selfLearnOnce()` + `reviewTurn()`. | Doc invented a symbol; fix the citation. |
| Universal channel gateway (Discord/n8n/Zapier inbound) | **STUB** | Comment "GAP 4 — Universal channel gateway" at pc:5951 with no implementation block. | Named as a feature; only Slack/Twilio discrete handlers exist. |
| Subagent delegation / true agent spawning | **STUB** | `AGENT_CLASSES`/`AGENT_ROLES` have prompts+tools, but `orchestrate()` (pc:2596) is in-process sequential `reasonReply` calls. No spawning/sandbox/messaging. | "Swarm of agents" is vocabulary, not isolation. |
| Voice brain (tiny fast GGUF) | **FOUNDATION-ONLY** | `voiceModelFile`/`ensureVoiceBrain` wired (pc:1748-1786); no GGUF bundled, no auto-download. | Code complete, dead until user drops a model in `models/voice`. |
| Local vision brain (multimodal + mmproj) | **FOUNDATION-ONLY** | `visionModelFiles`/`ensureVisionBrain`/`callLocalVision` wired (pc:1788-1834); honest fallback "no vision model is loaded yet" (pc:4771). No model bundled. | Offline vision requires user-supplied Gemma3+mmproj. |
| Local vector/RAG embedding brain | **FOUNDATION-ONLY** | Full pipeline (pc:3531-3569, retrieve at 2181); `selfDescription()` admits "there is no long-term vector memory / RAG retrieval yet" (pc:2477). No nomic GGUF in dist. | RAG dead on fresh install → degrades to keyword. **Contradicts CAPABILITY_MANIFEST.** |
| MCP auto-import (Claude/Docker Desktop) | **FOUNDATION-ONLY** | Import endpoints real (pc:6730-6741) but **manual-trigger only** — no watcher/boot hook. Docker entry registered `enabled:false`. | "Auto-import" overstates a manual button. |
| Mobile app (Expo/EAS APK build) | **PARTIAL** | `mobileScaffold`/`mobileBuild` (pc:5223-5251); without EAS token falls back to web export, not an APK. | Real scaffold, weak build path. |

### Then the solid stuff (BUILT) — grouped, condensed

| Subsystem | BUILT capabilities (all wired + callable) | Key evidence |
|---|---|---|
| **Brain runtime** | llama-server launch + health-check + hardware-adaptive args; CUDA vs CPU auto-switch; downloaded-GGUF selection (RAM-aware); CLI brain routing (Grok/Claude/Codex/Gemini); 30-provider cloud catalog; council/debate/auto-router; local-server probing (Ollama/LMStudio/vLLM/Jan/TextGen) | pc:1516-1560, 1836-1879, 1587-1621, 2004-2083, 3062-3101, 2114-2172, 3160 |
| **Agent loop** | `runAgentLoop` (ReAct, ≤12 steps); `runTask` (gather+reflect, ≤5); `runGoal` (decompose+verify+retry, ≤20); `callLocalTool` (30+ real tools); two-layer JSON parse + salvage; dedup guard; consent gate; async `startJob`; `councilThink` true parallel; `swarmTask` Promise.all parallel | pc:4396-4442, 2494-2565, 5170-5198, 886-1057, 4370-4390, 5915-5924, 5931-5948 |
| **Safety** | Global kill switch `/api/halt`; consent gate (fail-closed); HARDLINE_RX (uncircumventable); DANGEROUS_RX approval flow; tiered tools; approval queue (JSONL persist); 5-source audit timeline; AES-256-GCM vault; MCP env scrub | pc:42/6991, 555-566, 5287-5299, 5300-5340, 5581-5604, 5607-5636 |
| **UI** | Three-panel shell (resize+persist); view-mind/docs/gallery/spine/dashboard; agent work pane (Work/Activity feed); tool-call cards; 8 @context refs; density toggle; 11 themes; hash routing; bidirectional MCP host | index.html:491-828, 3302-3530, 1192-1297, 1050-1062, 928-970 |
| **OS control** | `cmd_run` shell exec (guarded); `open_app` (19-target allowlist); screenshot (pure PowerShell/GDI); kill switch across scheduler+TG | pc:830-854, 618-631, 795-818 |
| **Memory/skills** | Per-turn learning `reviewTurn`; dedup `memoryHasSimilar`; skill synthesis/recall/curation; keep-or-revert scaffold loop; 9 authored SKILL.md packs | pc:3814-3839, 5132-5163, 5974-5990, 6008-6044 |
| **Remote/mobile** | Cloudflared tunnel (Win-only); LAN PIN auth; headless daemon `--server`; autostart script; PWA `/m`+manifest+SW; SSE `/api/chat/live`; two-way Telegram; Fleet Mesh dispatch | pc:6132-6151, 6171-6229, main.js:13, mobile.html, pc:4615-4690, 3004-3028 |

### PARTIAL (real but conditional)

| Capability | Status | The condition |
|---|---|---|
| Piper TTS / Whisper STT (neural offline) | **PARTIAL** | Code production-quality (pc:1130-1300); binaries are user-install attachments, **not bundled** → SAPI fallback out of box. |
| Rigged GLB/VRM avatar | **PARTIAL** | Loader+lip-sync real (index.html:3740-3762); no default model ships, requires external URL. Procedural head is the real default (BUILT). |
| `gui_do` (PyAutoGUI) / `browser_do` (Playwright) | **PARTIAL** | Runners ship in `attachments-runners/`; require user-installed Python+pyautogui / Node+playwright. |
| Slack / Twilio inbound | **PARTIAL** | Handlers exist (pc:6283/7284) but require manual external dashboard config; no inbound polling for the tagline's "Slack/Twilio two-way." |
| `verifyAction` adversarial pre-flight | **PARTIAL (fail-open)** | pc:3846-3854 catch returns `safe:true` on any exception. Documented tradeoff, real gap offline. |
| Red-tier approvals persistence | **PARTIAL** | `_redApproved` is in-memory only (pc:5566); `approvals.jsonl` not replayed on boot → re-approve every restart. |

---

## 3. Fusion Scorecard

| Product | Defining capability | ABUZ8 status | Evidence (anchor) |
|---|---|---|---|
| **Claude Desktop** | Desktop chat UI + MCP host + artifacts pane + 3-panel shell | **FUSED** *(exceeds: bidirectional MCP, multi-tab artifacts)* | MCP stdio client initialize/tools/list/call pc:7511-7613; reverse server `src/mcp/abuz8-mcp-stdio.js`; artifacts iframe index.html:3344-3393. Caveat: imported MCP tools not auto-called in agent loop. |
| **Hermes (Nous)** | Function-calling loop + multi-channel gateway + huge skill/tool catalog + cron/MCP/profiles | **FUSED (architecture) / narrower (catalog)** | `runAgentLoop` pc:4396; Telegram 2-way pc:4610-4708; cron pc:2695-2748; MCP server. **Gap: 9 skills + ~40 tools + 3 channels vs Hermes 181 skills / 82 tools / ~24 channels.** |
| **Manus AI** | Autonomous task agent + browser/computer operator + live replay + cloud-async mobile | **FUSED (3 of 4)** | ReAct loop + `/api/agent/run` + Autopilot UI; Playwright browser; "Manus-style" activity ring buffer pc:20-29 → `/api/activity`. **Gap: no hosted cloud-async; mobile is LAN PWA only.** |
| **OpenClaw (Zait)** | 20+ channel messaging gateway + social/content operator + browser/media + ~55-skill marketplace | **PARTIAL** | Social FUSED: real X v2/Bluesky/Mastodon/LinkedIn/IG POSTs pc:4470-4596; Playwright FUSED. **Gap: 1 two-way channel (TG) vs 20+; 9 skills vs ~55; no marketplace.** |
| **CrewAI** | Role agents + crews + agent-to-agent delegation + sequential/hierarchical orchestration | **PARTIAL** | `AGENT_ROLES` (10) pc:56-135; `runSwarm` sequential + `swarmTask` parallel pc:5915. **Gap: no dynamic delegation/manager-agent; crew members don't run their own tool loop.** |
| **Cursor** | Agentic coding loop + repo-aware index + reviewable diffs + in-app editor | **PARTIAL** | `coderRun` plan/write/run/repair pc:5037; semantic `indexCodebase`/`searchCode` pc:5887-5905; @diff refs. **Gap: full-file writes (not diffs), no editor, no review-before-apply; index dead without embed model.** |
| **Desktop Commander** | Terminal streaming + full-disk FS + interactive process sessions + `edit_block` surgical edits | **PARTIAL (strong exec, weak edit)** | `actionCmdRun` pc:830 + full-machine FS read pc:7015. **Gap: no `edit_block` (whole-file only); no persistent interactive sessions; FS write sandboxed to dataRoot.** |
| **Antigravity 2** | Agent-manager parallel surface + editor/terminal/browser agents + Artifacts trust system | **PARTIAL** | Swarm/Jobs/Mission-board surfaces; `swarmTask` parallel; browser/gui/cmd multi-surface. **Gap: no IDE/editor surface; no unified Artifacts inspector (only traces.jsonl + loose shots).** |
| **Mercury (Inception)** | Diffusion LLM, parallel-token 1100+ tok/s, in-gen refinement | **CLAIMED_ONLY** | Single catalog entry pc:3082; generic `callProviderChat` if user pastes key. Zero diffusion code (grep: none). `configured:false` on fresh install. |
| **Windows-MCP / Desktop Commander (as named "OS-control fusions")** | Native Windows automation MCP | **ABSENT** | Zero source refs; marketing copy only. *(Note: ABUZ8's own OS control is BUILT independently — this row is about the named third-party fusions.)* |

**Tally: 3 FUSED · 5 PARTIAL · 1 CLAIMED_ONLY · 1 ABSENT.** (Of the "10 products," only Claude Desktop, Hermes-architecture, and Manus-core are genuinely fused; Mercury and the Windows-MCP/DesktopCommander named fusions do not hold up.)

---

## 4. Is It More Powerful Than Hermes?

**Honest answer: No — not today. It is more *sovereign* and more *embodied*, but less *correct* and far less *broad*.**

**Where ABUZ8 genuinely WINS over Hermes:**
- **Sovereignty / single-binary local-first** — Electron app + bundled llama.cpp runtime, no Python server farm. Runs on Ahmad's machine, owned end to end.
- **Voice + avatar embodiment** — barge-in, wake word, sentence-chunked TTS, MediaPipe presence, Three.js avatar. Hermes has none of this.
- **Safety spine maturity** — kill switch + HARDLINE_RX + AES-256-GCM vault + 5-source audit + consent tiers is a more complete, UI-wired safety surface than Hermes ships.
- **Desktop UX** — Claude-Desktop-class 3-panel shell, 11 themes, artifacts pane, bidirectional MCP. Hermes is gateway-first, not a polished desktop app.
- **PWA / phone reach + tunnel** built in.

**Where Hermes WINS (the parts that decide "more powerful"):**
- **Agent-loop correctness** — Hermes does native provider function-calling; ABUZ8 parses JSON/regex out of free text and *the source itself warns* the local brain "did not emit a usable tool call" (pc:4428). Autonomous chains are only reliable with a cloud provider.
- **Skills breadth** — 181 skills vs **9**. Tools 82 vs ~40.
- **Channels** — ~24 two-way vs **1** (Telegram).
- **Maturity / proven loop** — Hermes's loop is battle-tested; ABUZ8's is newer and brain-dependent.

**ROOT CONSTRAINT:** **The small on-device brain caps autonomous correctness.** A 0.5B–4B local GGUF can't reliably emit clean tool calls, so every loop's *intelligence* collapses to its *brain*. ABUZ8's architecture is arguably broader-in-ambition than Hermes, but its default fuel can't drive it. **It is more powerful only when pointed at a strong brain (cloud or a capable local model) — and that's exactly the model it doesn't ship/auto-select.**

---

## 5. What It Would ACTUALLY Take to Surpass Hermes

Prioritized. Each item maps to the gap it closes.

**P0 — Make it think on day one (closes the FALSE "offline" gap)**
1. **Repopulate `EMBEDDED_BRAIN_CATALOG`** (pc:52) with the three LFM2 GGUFs already in `resources/brain`, and make `selectEmbeddedBrain()` resolve them via `resolveBrainDir()`. *Closes: dead-on-arrival brain; the single biggest credibility gap.*
2. **Auto-download Nemotron 3 Nano 4B on first run** (it's the stated primary, in MODEL_CATALOG but never fetched) with consent + progress UI. *Closes: "Nemotron is primary" being aspirational.*

**P0 — Make the loop correct (closes Hermes's correctness lead)**
3. **Native function-calling tool loop** — when the active brain supports tools (cloud providers, or llama.cpp grammar/`--jinja` tool templates), use structured tool-calls instead of regex salvage. Keep salvage only as fallback. *Closes: agent-loop correctness, the #1 Hermes advantage.*
4. **Fix the fail-open verifier** (pc:3854) — on exception, **fail-closed for high-severity tools** (send_email/social_post/stripe_op), fail-open only for low. *Closes: documented safety gap; protects the money guardrail.*
5. **Persist red-tier approvals** — replay `approvals.jsonl` into `_redApproved` on boot (pc:5566). *Closes: re-approve-every-restart friction.*

**P1 — Activate the dormant senses (closes FOUNDATION-ONLY rows)**
6. **Bundle or auto-fetch:** a nomic embed GGUF (`models/embed`) → turns RAG live; a small voice GGUF (`models/voice`); Gemma3-4B+mmproj (`models/vision`); Piper `.exe`+voice and Whisper `.exe`+model into attachments. *Closes: RAG/voice/vision/STT all dead on fresh install; resolves the selfDescription↔CAPABILITY_MANIFEST contradiction.*

**P1 — Close the catalog/channel gap (the breadth Hermes wins on)**
7. **Grow skills 9 → 40+** by mining the auto-synthesis pipeline (it works — `synthesizeSkillsOnce`) and porting OpenClaw's content/social packs. *Closes: 9-vs-181 skills.*
8. **Add ≥3 real two-way channels** (Slack inbound polling/socket-mode, WhatsApp via Twilio inbound loop, Discord) behind one **universal inbound dispatcher** (implement the GAP-4 stub at pc:5951). *Closes: 1-vs-24 channels; the OpenClaw gateway promise.*

**P2 — Close depth gaps vs the fused products**
9. **`edit_block` surgical edits** + **review-before-apply diff gate** in the coder loop. *Closes: Cursor + Desktop Commander edit gaps.*
10. **Persistent interactive process sessions** (stdin/stdout registry, paginated readback). *Closes: Desktop Commander's interactive-process pillar.*
11. **MCP tools injected into the agent loop** — forward `mcpCallTool` from `callLocalTool` so imported servers are auto-invokable. *Closes: the one Claude-Desktop shortfall.*
12. **True subagent delegation** — even in-process worker isolation with message passing + per-agent tool loops. *Closes: CrewAI delegation + Antigravity agent-manager depth.*

---

## 6. Doc-Fix List (false/stale claims → truthful replacement)

| Location | False/stale claim | Truthful replacement |
|---|---|---|
| pc:3228 (canned reply) | "The native LFM2 2.6B GGUF brain stays primary in this build" | "No GGUF is auto-selected by default; select or download a brain in Models. (LFM2 GGUFs ship but are not yet catalog-wired.)" |
| pc:49-52 comment vs CHANGELOG | "LFM brains removed to keep the OS lean" while CHANGELOG implies bundled-brain | State plainly: bundled GGUFs exist in `resources/brain` but are **not** in the selector catalog; first-run brain requires download or manual placement. |
| `CAPABILITY_MANIFEST` pc:230 | "durable LOCAL vector memory + Second Brain RAG" (unconditional) | "vector RAG **available once an embed model is installed**; defaults to keyword memory." Make it match `selfDescription()` pc:2477. |
| DEFAULT_SOUL/system prompt pc:226 | "You are NOT amnesiac" | Qualify: long-term vector recall requires the embed model; without it, memory is keyword-based. |
| Tagline pc:234 | "two-way messaging gateway (Telegram / Slack / Twilio)" | "two-way Telegram gateway; Slack/Twilio inbound require manual webhook setup." |
| CONNECT.md:48 / SALES.md | "Desktop Commander" + "Windows-MCP" as fused capabilities | Move to "compatible via manual MCP import" — they are **not** built-in. |
| competitive `HERMES-RECHECK-2026-06-19.md:56` | cites `harvestAndLearnOnce` at line 3821 | Correct to `reviewTurn()` (per-turn facts) + `selfLearnOnce()` (tool-frequency). The named symbol does not exist. |
| Marketing "fusion of 10 products" | implies 10 fused | Truthful: **3 FUSED, 5 PARTIAL, 1 CLAIMED_ONLY, 1 ABSENT.** Mercury is a provider entry, not a fusion. |
| pc:235 "offline-capable" | unconditional | "offline-capable **after** installing the voice/STT attachments and a local brain; out of box uses Windows SAPI + cloud/keyword fallback." |
| runSwarm comments / marketing "parallel swarm" | "parallel" | runSwarm is **sequential**; true parallelism is only in `swarmTask` and `councilThink`. |
| pc:498 open_app description | "only 4 apps" | Actual allowlist is 19 targets + `start` fallback (pc:572-599) — under-claims. |

---

**Bottom line for Ahmad:** You built a real OS-shaped operator with a strong spine and genuine embodiment that Hermes lacks. It is **not yet more powerful than Hermes** because (a) it ships with no usable brain auto-selected, and (b) its autonomy is regex-parsed and brain-capped. Fix P0 items 1–5 and it becomes *correct and alive on first launch*; add P1 items 6–8 and it credibly *surpasses* Hermes on the axes that matter to you — sovereignty + embodiment + breadth. The honest headline you can stand behind today: **"A sovereign, voice-embodied, safety-first local AI operator that fuses the Claude-Desktop + Manus + Hermes-architecture cores — bring-your-own-brain until first-run model wiring lands."**

Relevant files: `E:\ABU\ABUZ8_OS_DIST\src\portable-core.js`, `E:\ABU\ABUZ8_OS_DIST\src\renderer\index.html`, `E:\ABU\ABUZ8_OS_DIST\src\mcp\abuz8-mcp-stdio.js`, `E:\ABU\ABUZ8_OS_DIST\main.js`, `E:\ABU\ABUZ8_OS_DIST\resources\brain\` (orphaned LFM2 GGUFs), `E:\ABU\ABUZ8_OS_DIST\docs\VOICE-AND-ATTACHMENTS.md`, `E:\ABU\ABUZ8_OS_DIST\docs\competitive\HERMES-RECHECK-2026-06-19.md`.
