# Honesty Policy — what's real, what needs a key, what can't exist

ABUZ8 OS is built on one rule: **nothing fake, nothing that lies.** A feature either works, or it tells you exactly what it needs. This page is the ground truth.

## ✅ Fully working, no external account required
- Bundled local `llama.cpp` runtime — **bring-your-own-brain on first run.** LFM2 GGUFs ship in `resources/brain`, but none is auto-selected on a fresh install (the embedded-brain catalog is empty), so out of the box chat returns canned "Portable Core" text until you select or download a brain (LFM2 / Nemotron / Gemma). No external account needed once a local brain is selected.
- Native desktop + CLI control (`cmd_run`, open app/url, screenshot, file write) — consent-gated
- System Map (real netstat port scan, PID→process, CLI detection)
- MCP client — enable/list/call tools on real MCP servers
- Agent roles + multi-agent swarm + synthesis
- Kanban board + delegation
- Content generation (carousel/thread/YouTube script/SEO outline/synthesis) — saved to disk
- X growth board seeding (25-problems protocol)
- Two-way Claude Desktop bridge (inbound symbiote + outbound shared MCP servers)
- Local memory, color palettes, Windows TTS/STT

## ⚠️ Real, but needs a model/attachment/credential you supply
- **Cloud model providers** (OpenRouter/OpenAI/etc.) — need a valid API key in Settings. The local brain works without one once you've selected/downloaded a GGUF.
- **Neural voice / STT** (Piper TTS, Whisper STT) — fully coded but ship with **no model/binary**. Out of box ABUZ8 uses **Windows SAPI voice + browser STT**; install the voice/STT attachments to enable the neural offline stack.
- **Local vision** (Gemma3 + mmproj) — coded but needs the vision model installed, or use a cloud vision provider.
- **Vector-RAG memory** — coded but needs an embed model installed; out of box uses **keyword memory** (true semantic recall after you add an embed model).
- **Channels beyond Telegram** — the **two-way Telegram** gateway is built in; **Slack/Twilio require manual webhook setup**; broader channels (Discord/n8n/Zapier) are roadmap.
- **Desktop Commander / Windows-MCP** — **not** bundled or fused; compatible via **manual MCP import** of your Claude Desktop config. (ABUZ8's own native OS control — shell, app launch, screenshot — is built independently and needs nothing.)
- **X (Twitter) posting** — needs an OAuth2 user token with `tweet.write` scope (`x_access_token` in settings). Without it, `/api/x/post` returns `needs_credentials: true` instead of pretending to post.
- **Other social/SEO platform publishing** (YouTube upload, Instagram, etc.) — need each platform's API credentials.

## ❌ Cannot exist exactly as described (and is not faked)
- **Remote-controlling Claude Desktop's chat** — Claude Desktop is not an MCP server; no product can puppet its conversation. We provide shared tools + bidirectional tool calls instead.
- **Literal NotebookLM / proprietary "Kimi/MiniMax swarm" imports** — those are external products/methods, not importable code. We implement the *equivalent patterns* (source→media synthesis; decompose→parallel→verify→synthesize) locally.
- **Auto-growth that guarantees followers/revenue** — the protocol, content, and scheduling scaffolding are real; outcomes depend on you posting and the market.

## Things explicitly removed for being fake
The earlier build shipped fabricated UI: revenue/cost dashboards with invented numbers, fake "Connected" states for services that were blackholed, "SHA-512 ✓ / 14 systems wired" badges, fake "souls," and personal data baked into the UI. **All removed.** If a number appears in ABUZ8 OS, it comes from a real measurement or your own data.
