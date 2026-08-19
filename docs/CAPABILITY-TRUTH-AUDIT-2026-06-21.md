# ABUZ8 OS — Capability Truth Audit (2026-06-21)

Method: 35 sub-agents, ~2.75M tokens. Each capability grepped against the actual `src/portable-core.js`
(+ the shipped `dist/win-unpacked` binary), then an **adversarial skeptic** re-checked every verdict to
catch over-claims. Provider/skill/channel counts for Hermes + OpenClaw were taken from the real trees on
disk. Competitors were web-researched. Nothing here is marketing — every line is traceable to code.

**One-line verdict:** ABUZ8 OS is a real, well-architected sovereign agent with a genuinely working spine
(local Gemma omni brain on GPU, neural voice, 15 connectors, 30 tools, a runtime-proven reverse-MCP server,
AES-256-GCM vault, a real coder loop). But ~half the *headline* claims are over-stated: it is **not** a
single offline binary on Linux/1GB, has **no** Tor browser, **no** real OSINT, **cannot** become a
blockchain, and its boldest reliability / self-update / 100+-provider claims are **code-present but
runtime-unproven**, not "done."

## Answers to each question (verdicts)

| # | Question | Verdict |
|---|----------|---------|
| 1 | Full reliability — agent loop drives tools/connectors/vault/verifier end-to-end | 🟡 PARTIAL — spine real & runtime-proven; verifier was fail-OPEN (fixed v1.25.10); multi-step autonomy unproven; 5/15 connectors have no call branch |
| 2 | 100+ providers, native tool-call for every LLM, CLI auths incl. xai-oauth | 🟡 PARTIAL — 34-entry catalog (code says "35+"); only 2 dialects work (Anthropic + OpenAI-compat); gemini-native dead, Bedrock stub, CLI brains text-only; **xai-oauth does not exist**; "100+" only via OpenRouter proxy |
| 3 | One-click setup like Desktop Commander | 🟡 PARTIAL (≈NO) — OAuth needs user-created provider apps + pasted client id/secret; zero first-party clients shipped; latent redirect-port bug |
| 4 | Build/update/upgrade itself after power-on | 🟡 PARTIAL — self-skill-writing + 1-time CUDA self-accel run on boot (real); self-UPDATE manifest is a live 404 + nothing calls apply; self-code-mod disabled on consumer .exe & never rebuilds the running binary; no daily refresh cron |
| 5 | Headless CLI background (no GUI) | 🟡 PARTIAL — `--server` windowless mode + autostart task wired; but it's windowless **Electron**, not a GUI-free CLI; never runtime-proven |
| 6 | Runs on a $5 / no-GPU / ~1GB VPS | 🔴 IMPOSSIBLE as stated — brain hardcoded to `llama-server.exe` (no Linux ELF/.so), `main.js` hard-requires Electron, team docs set a 2GB floor (1GB = "Illegal instruction"), no Dockerfile |
| 7 | USB micro-PC / Android (Andrax) / iPhone via Tor | 🟡 PARTIAL — reach FROM a phone browser over Cloudflare tunnel + PWA is the strong part; USB all-in-one assemblable but never built (Win x64 only); **Android-native = NO** (Electron can't run on a phone); **Tor = NO** |
| 8 | Full OSINT | 🟡 PARTIAL (≈NO) — real multi-backend web search + deep-read + optional Playwright; **zero OSINT tradecraft** (no whois/dns/breach/username-enum); osint/kali/nmap are dead labels |
| 9 | Own Tor private browser | 🔴 NOT-BUILT — zero tor/onion/socks across full repo + 5 sibling depots + the 7.45GB binary; its own roadmap doc marks it unbuilt |
| 10 | Rebuild itself into a blockchain | 🔴 IMPOSSIBLE as stated (category error) — only git self-mod + 4 read-only crypto-query skills; no p2p/consensus/ledger |
| 11 | Build anything (code/site/app/video) | 🟡 PARTIAL — real coder/deploy/image lanes; but no bundled node/git, dead code-index, **video not built** (ComfyUI bridge only), agent loop can't self-drive builds |

## What is genuinely WORKING (runtime-proven)
- Offline **omni brain** (Gemma-4-E4B) loads on the GPU; **neural voice** (Piper TTS + Whisper STT) roundtrip offline.
- **Reverse MCP server** (~24 `abuz8_*` tools) auto-installed into Claude Desktop — live this session.
- **15 own-account connectors** listed; **30 agent tools**; AES-256-GCM vault correctly coded; real `callLocalTool` dispatcher (refuses unknown tools); universal adapter translates Anthropic/Gemini/OpenAI dialects; real `coderRun` plan→write→run→repair→commit loop; multi-source `webSearch` + `deepResearch`.

## The fused systems, real counts (on disk)
- **Hermes** tree on disk = **v0.15.1** (no v0.16/v0.17 locally), 28 provider profiles (custom registry, not litellm), **181 live skills**, **22 channels**. (Upstream **v0.17.0 "The Reach Release"** shipped 2026-06-19 — real, per web.)
- **OpenClaw** (v2026.3.13) = **53 skills**, **22 two-way channels**, **36 provider integrations**.

## Honest competitive position
ABUZ8's **only durable moat** is true single-binary, GPU-free-on-Windows, **offline-by-default sovereignty WITH bundled voice** — which **no** rival optimizes for:
- **Hermes v0.17, OpenClaw, Odysseus (PewDiePie)** = open + local-*capable* but **cloud-default, BYO-brain, multi-component stacks** (Electron+Python / TS gateway / Docker+Python). They beat ABUZ8 on breadth, channels, providers, maturity.
- **Claude Desktop, Replit Agent, Manus** = pure cloud, closed, no offline brain. Replit/Manus beat ABUZ8 on turnkey build/deploy autonomy.
- **Panda OS** = local *workspace*, likely cloud LLM (BYO key); **AgentOmatic** = no canonical product found (likely misremembered).

Sell sovereignty + offline voice/vision + own-account action in one owned artifact. **Stop claiming** Tor, full OSINT, blockchain, 100+ native providers, $5-VPS, and unattended self-upgrade until they're real.

## Top fixes (priority order)
1. **[DONE v1.25.10]** Verifier fail-OPEN → fail-CLOSED (money/outward guardrail). Needs a rebuild to ship live. *(Further hardening: add the 4 VERIFY_TOOLS to a hard human-approval gate.)*
2. **Self-update is inert:** publish a real `release-manifest.json` (default URL = live 404) and wire a caller to `/api/update/apply` (UI button only opens a URL today).
3. **Prove the unproven headlines:** capture one live multi-step `/api/agent/run`, one live cloud native tool-call, one real `connector_call`, and one `.exe --server` windowless launch.
4. **MCP forward-host autonomy:** add an `mcp` branch to `callLocalTool` + add imported MCP tools to `KNOWN_AGENT_TOOLS`/toolMenu (the brain currently can't select any imported MCP tool); then spawn-and-call one external server end-to-end.
5. **Make self-code-mod take effect:** auto-`rebuild.sh` + asar swap after `selfUpgradeApply` (it stops at a git commit today; never runs on consumer installs).
6. **Trim the copy** to the verified truth (see verdict table).
7. **One-click setup:** fix the hardcoded `:8900` redirect-URI bug; bundle a first-party OAuth client per provider for real one-click.
8. **If Linux/$5-VPS is wanted:** ship a Linux `llama-server` + `.so`, a no-Electron node entrypoint, and the Dockerfile the team's own roadmap lists as unbuilt (plan 3–4GB RAM, not 1GB).
9. **Build-anything gaps:** bundle/auto-install node+git, wire an embedding model (code-index is dead), build a real text-to-video lane or stop implying video; expose coder/deploy/mobile in the agent loop.
10. **Real version of the "blockchain" intent:** a hash-chained signed self-upgrade ledger + optional IPFS content-addressed build distribution. ABUZ8 stays a blockchain *client/publisher*, never "a blockchain."
