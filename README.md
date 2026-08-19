<div align="center">

# ABUZ8 OS

### The sovereign desktop AI operator — your own agent OS that runs on your machine, not someone's cloud.

A local-first agent operating system for Windows: a bundled `llama.cpp` brain, a native desktop/CLI operator, a unified **Spine** of agents · souls · skills · missions, local **studios** (image · video · talking-avatar · 3D), a sovereign **Monaco IDE**, an OpenAI-compatible API, and a security-hardened core — with nothing faked and nothing phoning home unless *you* connect it.

![version](https://img.shields.io/badge/version-1.34.1-C8A55C)
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-2A2520)
![license](https://img.shields.io/badge/license-MIT%20core%20%2B%20Pro-2A2520)
![local-first](https://img.shields.io/badge/local--first-no%20cloud%20required-2e7d57)
![honest](https://img.shields.io/badge/policy-no%20faked%20results-2e7d57)

</div>

> **Local-first, bring-your-own-brain.** ABUZ8 OS is an Electron desktop app built around a bundled HTTP **Portable Core** (`127.0.0.1:8900`) and a bundled `llama.cpp` runtime. Pick the offline brain *or* any OpenAI-compatible cloud provider. Once a local brain is selected, **no cloud account is required**. Anything that needs an external key says so honestly instead of faking success.

---

## Why it exists

Most "AI desktop apps" are a thin chat window in front of someone else's server. ABUZ8 OS is the opposite: **the model, the tools, the memory, and the automation all live on your machine, and you own every layer.** It scales from a single personal cockpit to a multi-tenant swarm — without ever surrendering the keys.

---

## What it does

| Capability | How it works | Status |
|---|---|---|
| **Local chat brain** | Bundled `llama.cpp` runtime; select or download a GGUF on first run (Gemma / LFM2 / Nemotron). Canned fallback text until you pick one, then zero network. | ⚠️ BYO-brain on first run, then offline |
| **Multi-model access** | The offline brain *or* any OpenAI-compatible provider (OpenRouter, LM Studio, Ollama, Anthropic, Google…). 1-click onboarding for 69 providers. | ✅ |
| **Spine** — unified primitive layer | One coherent store of `agents · souls · teams · threads · skills · missions · tools · providers · lessons · library`, with a real cross-system migration importer + heartbeat (`/api/spine/*`). | ✅ |
| **Soul-driven team** | 13 ported executive **souls** (CEO, CFO, CMO, COO, CTO, Heads of Sales/Content/Legal/Ops + system souls). Run any soul as a live agent, or let the **CEO route** a goal to the right department head. (`/api/team/*`) | ✅ wiring; brain-speed bound on local |
| **Agent-first reasoning** | Understands → gathers (tools/research) → reasons → synthesizes: iterative ReAct tool-chaining + self-reflection. | ✅ |
| **Multi-agent swarm + SDLC** | Fan a goal across roles and synthesize one plan; a full plan→design→code→review→test→deploy→monitor pipeline. | ✅ |
| **Native desktop + CLI control** | `cmd_run` runs shell pipelines; open apps, write files, screenshots — gated by one real consent toggle. **Native GUI driver** (mouse/keyboard/screen) needs **no Python** on a clean box. | ✅ |
| **Local Studios** | **Image** (FLUX), **video** (Wan 2.1 t2v), **talking avatar** (Wav2Lip + XTTS voice-clone), **photo→3D** (TripoSR → `.glb`), plus a **universal ComfyUI runner** for any workflow. | ✅ needs ComfyUI + GPU |
| **Sovereign Dev IDE** | Vendored **Monaco** editor at `/ide` (no CDN) + ASRED dev spec-ops that writes real files via a local coder brain. | ✅ |
| **OpenAI-compatible API (Mercury)** | `/v1/models` + `/v1/chat/completions` so LangChain / Cursor / n8n / any tool can use ABUZ8 as a brain. | ✅ |
| **Self-learning + Observer** | Per-turn fact learning + a file-watcher that embeds your files into RAG; an optional **global observer** records cross-system activity into durable memory. | ✅ |
| **Secure reach** | Sovereign **SSH/SCP** via Windows' built-in OpenSSH, ed25519 keygen, encrypted host registry, consent-gated remote exec (`/api/reach/*`). | ✅ |
| **Multi-tenant + licensing** | Token-hash auth, **RBAC** (owner>admin>member>viewer), per-tenant data isolation, Ed25519 license-to-sell, UTM earn-loop attribution. | ✅ |
| **MCP fleet + Claude Desktop bridge** | Real MCP client (JSON-RPC/stdio) + a two-way symbiote so Claude Desktop and ABUZ8 share the same tools. | ✅ |
| **Sovereignty: air-gap** | One toggle blocks **all** outbound egress (web search, updates, downloads) + an SSRF guard; secrets are AES-256-GCM encrypted at rest. | ✅ |
| **Hardware-adaptive** | Uses all CPU cores, scales context to RAM, one-click CUDA GPU unlock — Surface → dual-5090. | ✅ |

Full honesty policy: anything that needs an external credential says so instead of faking success → [`docs/HONESTY.md`](docs/HONESTY.md).

---

## Security, by design

Two adversarial self-audits hardened the core. Verified by `scripts/sec-smoke.js`:

- **CSRF Origin gate** — any cross-site state-changing POST is blocked (403).
- **No CORS wildcard** + DNS-rebinding Host guard.
- **Signed + host-pinned + SHA-256 self-update** (embedded Ed25519 release key) — no unsigned RCE.
- **Sensitive-path jail** on `fs/read` + `learn/ingest` (`.env`, `.ssh`, cloud creds blocked).
- **No fabricated revenue** — manual revenue is forced *unverified*; unsigned Stripe webhooks are refused.
- **Air-gap chokepoint + SSRF guard** (cloud-metadata blocked).

---

## Quick start

1. Launch **ABUZ8 OS** (`…\ABUZ8 OS Portable\Launch-ABUZ8.bat` or the Start-menu shortcut). The Portable Core boots on `http://127.0.0.1:8900`.
2. **Select or download a local brain** (bundled GGUFs, or pull Gemma/Nemotron) — until then chat returns canned text. Cold load ≈ 1–2 min on first chat.
3. Pick an **agent / soul** + **model**, toggle **Allow actions** for native control, and go.
4. Try the team: `POST /api/team/dispatch {"goal":"draft this week's revenue plan"}` and watch the CEO route it.

**Rebuild from source** (any machine): see [BUILD.md](BUILD.md). Short version — pack `src/` minus `node_modules` into `app.asar`, drop it into the Electron `resources/` next to the `brain/` and `mcp/` assets.

```powershell
npx @electron/asar pack ./src ./app.asar
```

---

## Architecture at a glance

```
Electron main (main.js)
 ├─ portable-core.js   → HTTP API on 127.0.0.1:8900  (~11k LOC, 460+ routes, 17 route groups)
 │    ├─ Spine         → /api/spine/*   agents·souls·teams·skills·missions·studio·swarm·sdlc
 │    ├─ Team glue     → /api/team/*     souls → live agents + CEO-routed dispatch
 │    ├─ Mercury       → /v1/*           OpenAI-compatible surface (ABUZ8 as a brain)
 │    ├─ Reach         → /api/reach/*    sovereign SSH/SCP
 │    ├─ Tenant        → /api/tenant/*   multi-tenant auth + RBAC
 │    └─ llama.cpp     → 127.0.0.1:8902  loads the selected GGUF (none auto-selected fresh)
 ├─ renderer/          → index.html (dashboard) · ide.html (/ide) · spine.html · viewer360.html · editor.html
 └─ mcp/abuz8-mcp-stdio.js → Claude Desktop symbiote (stdio JSON-RPC)
```

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Verify it yourself

```powershell
cd ABUZ8_OS_DIST
node --check src/portable-core.js
node scripts/lint-routes.js src/portable-core.js   # 460+ routes, 0 duplicates
node scripts/smoke.js                              # behavioral suite (boots headless, hits real endpoints)
node scripts/sec-smoke.js                          # security assertions
```

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — every component, port, data path, request flow
- [docs/API.md](docs/API.md) — full HTTP endpoint reference
- [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md) — the agent loop, the brains, the soul
- [docs/HARDWARE.md](docs/HARDWARE.md) — hardware-adaptive brain + GPU unlock
- [BUILD.md](BUILD.md) — exact reproduction on a new computer
- [docs/HONESTY.md](docs/HONESTY.md) — the no-faked-results policy
- [CHANGELOG.md](CHANGELOG.md) — the full audit + build history

---

## License

**Open core (MIT) + optional Pro.** The ABUZ8 OS core is **MIT-licensed** ([LICENSE](LICENSE)) — free to use, fork, and ship. "ABUZ8 OS Pro" features are commercial ([EULA-PRO.md](EULA-PRO.md)). © 2026 ABUZ8 LLC; "ABUZ8" is a trademark. Bundled third-party components (Electron, llama.cpp, Node.js) and AI models (Gemma — Google Gemma Terms, Qwen — Apache-2.0, Nomic Embed — Apache-2.0, Piper, Whisper) retain their own licenses. Full breakdown in [LICENSING.md](LICENSING.md).

<div align="center">

**Built on Pegasus 🐎 — dual RTX 5090, sovereign by design.**

</div>
