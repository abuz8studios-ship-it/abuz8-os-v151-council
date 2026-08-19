# ABUZ8 OS — Licensing

ABUZ8 OS uses an **open-core** model: a free, MIT-licensed core that anyone can use, study,
modify, and ship — plus an optional **Pro** tier that funds the project. *By the people, for the
people — with a way to keep the lights on.*

> Plain-English summary, not a substitute for the actual license texts (`LICENSE`, `EULA-PRO.md`)
> or for legal advice. The license files control.

## The three layers

| Layer | What it is | License | File |
|---|---|---|---|
| **Open Core** | The ABUZ8 OS app, agent, UI, operator spine, and default skills | **MIT** | `LICENSE` |
| **ABUZ8 OS Pro** | Paid features/modules/models distributed under a Pro entitlement | **Commercial EULA** | `EULA-PRO.md` |
| **Bundled third-party** | Electron, llama.cpp, AI models, MCP servers, Node.js | Their own licenses | see below |

### What "Open Core" (MIT) gives you
Use it free, personally or commercially. Fork it, modify it, redistribute it, even sell your own
build — as long as you keep the MIT copyright notice. No fees, no telemetry, your data stays on your
machine. The MIT grant does **not** include the **ABUZ8 name or logo** (those are trademarks) or the
**Pro** features.

### What is "Pro" (commercial)
Any file or module marked **"ABUZ8 OS Pro"**, and any feature, model, or service we distribute only
under a paid Pro license key or entitlement. Pro is governed by `EULA-PRO.md`, not by MIT. If a file
carries no Pro marking and is in this repository, treat it as MIT Core.

> Maintainer note: keep the boundary clean. Put Pro-only code behind a clear marker (a header
> comment `// ABUZ8 OS Pro — licensed under EULA-PRO.md`, a `pro/` directory, or a separate private
> repo/package). Everything shipped in the public/Core tree is MIT.

## Trademarks
"ABUZ8", "ABUZ8 OS", and the ABUZ8 logo are trademarks of ABUZ8 LLC. The MIT License covers the
**code**, not the marks. If you ship a fork, use your own name and branding (you may state, factually,
that it is "based on ABUZ8 OS").

## Bundled third-party components (each retains its own license)
- **Electron** — MIT
- **llama.cpp / ggml** (local inference runtime) — MIT
- **Node.js** — MIT / OpenSSL
- **Bundled AI models (what actually ships):**
  - **Gemma 3 4B IT** (`vision/gemma-3-4b-it-*`, primary local brain + vision mmproj) — **Google,
    "Gemma Terms of Use".** ⚠️ This is a custom license, **not** Apache/MIT. It permits redistribution
    and commercial use **but requires** that you (a) include the Gemma Terms of Use and the Gemma
    Prohibited Use Policy with any distribution, (b) keep "Gemma" attribution, and (c) pass the use
    restrictions to downstream recipients. Ship those terms alongside the model. <https://ai.google.dev/gemma/terms>
  - **Qwen2.5 0.5B Instruct** (`voice/qwen2.5-0.5b-*`) — Alibaba, **Apache-2.0**.
  - **Nomic Embed Text v1.5** (`embed/nomic-embed-text-*`) — **Apache-2.0**.
- **Optional / downloadable models** (e.g., NVIDIA Nemotron, LFM2/LFM2.5, other GGUFs the model
  manager can fetch) — **not bundled** in the default build; each is governed by its own license at
  the time you download it (review its model card before shipping it).
- **Piper** (neural TTS) and **Whisper / whisper.cpp** (STT) and their voice/model files — their respective licenses.
- **Model Context Protocol servers** (`@modelcontextprotocol/*`, `mcp-server-*`) — their respective licenses.
- **Playwright** (browser automation) — Apache-2.0 (drives the host's existing Edge/Chrome).

If you distribute ABUZ8 OS (Core or a fork), you are responsible for complying with each bundled
component's license — **especially the Gemma Terms of Use**, which is the binding redistribution
constraint for the default local brain.

## Buying / contributing
- **Pro:** https://abuz8ai.com — license keys, team/enterprise terms.
- **Contributions to the Core** are accepted under MIT; by submitting a contribution you agree it may
  be distributed under the MIT License (and you confirm you have the right to contribute it).

**Contact:** ABUZ8 LLC — support@abuz8ai.com
