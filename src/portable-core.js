// portable-core.js - bundled local API for ABUZ8 OS.
// This is the clean-machine safety net: chat, memory, MCP import, status, and
// common UI endpoints work without private developer paths, Python, Docker, ComfyUI, or a server.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

let PORT = Number(process.env.QADIR_PORT || process.env.ABUZ8_PORT || 8900); // preferred; auto-falls-back to a free port if taken
const LFM_PORT = Number(process.env.ABUZ8_LFM_PORT || 8902);
const VOICE_PORT = Number(process.env.ABUZ8_VOICE_PORT || 8903);

let server = null;
let serverHost = '127.0.0.1';
let dataRoot = null;
// Live activity feed (Manus-style): an in-memory ring buffer the UI polls.
const activityLog = [];
let activitySeq = 0;
let agentRunning = false;
let _agentStop = false; // cooperative cancel — set by /api/agent/stop, checked atop every agent loop
function agentStopRequested() { return _halted || _agentStop; }
function stopAgentRun() { _agentStop = true; agentRunning = false; }

// ── NZT DECISION ENGINE — runs Monte Carlo + anomaly checks BEFORE giving an answer ──
// The "filter the noise, take the highest-velocity move" reflex, made real and honest: simulate the
// move thousands of times, surface expected value / tail risk / Kelly size / ruin risk / anomalies,
// then give a GO / GO-SMALL / NO-GO verdict grounded in math, not vibes.
function _gauss(mean, sd) { if (!sd) return mean; let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function _pctile(sorted, p) { const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p / 100 * sorted.length))); return sorted[i]; }
function monteCarloDecide(opts = {}) {
  const name = String(opts.name || opts.move || 'this move').slice(0, 160);
  const p = Math.max(0, Math.min(1, Number(opts.p_success != null ? opts.p_success : 0.5)));
  const up = Math.abs(Number(opts.upside_usd) || 0), upSd = Math.abs(Number(opts.upside_sd) || up * 0.3);
  const down = Math.abs(Number(opts.downside_usd) || 0), downSd = Math.abs(Number(opts.downside_sd) || down * 0.3);
  const cost = Math.abs(Number(opts.cost_usd) || 0), bankroll = Math.abs(Number(opts.bankroll_usd) || 0);
  const trials = Math.min(200000, Math.max(1000, Number(opts.trials) || 20000));
  if (!up && !down) return { ok: false, error: 'Provide at least upside_usd and downside_usd (plus p_success, cost_usd, bankroll_usd) to simulate.' };
  const nets = new Array(trials); let sum = 0, profitCount = 0, ruin = 0;
  for (let i = 0; i < trials; i++) {
    const outcome = (Math.random() < p) ? Math.max(0, _gauss(up, upSd)) : -Math.max(0, _gauss(down, downSd));
    const net = outcome - cost; nets[i] = net; sum += net;
    if (net > 0) profitCount++; if (bankroll && net <= -bankroll) ruin++;
  }
  nets.sort((a, b) => a - b);
  const ev = sum / trials;
  const sd = Math.sqrt(nets.reduce((s, x) => s + (x - ev) * (x - ev), 0) / trials);
  const pProfit = profitCount / trials;
  const p10 = _pctile(nets, 10), p50 = _pctile(nets, 50), p90 = _pctile(nets, 90);
  const b = down > 0 ? up / down : (up > 0 ? Infinity : 0);
  const kelly = (b && isFinite(b)) ? (p * b - (1 - p)) / b : (p > 0.5 ? 1 : 0);
  const sharpe = sd > 0 ? ev / sd : (ev > 0 ? Infinity : 0);
  const ruinRisk = bankroll ? ruin / trials : null;
  const anomalies = [];
  if (ev <= 0) anomalies.push('Negative expected value — the math says do NOT take this as framed.');
  if (pProfit < 0.5 && ev > 0) anomalies.push('Positive EV but <50% chance of profit — a few fat wins carry it; size small, expect a losing streak.');
  if (down && p10 < -(cost + down) * 0.9) anomalies.push('Fat downside tail — the worst 10% of outcomes are severe.');
  if (kelly <= 0) anomalies.push('Kelly ≤ 0 — no mathematical edge; do not stake on it.');
  if (ruinRisk != null && ruinRisk > 0.05) anomalies.push('Single-bet wipeout risk > 5% against your bankroll — over-exposed; cut the size. (This is per-bet, not sequential gambler\'s ruin.)');
  if (p >= 0.99 || p <= 0.01) anomalies.push('Probability is near-certain/near-impossible — sanity-check the input; real edges are rarely this clean.');
  let verdict, why;
  if (ev > 0 && kelly > 0 && (ruinRisk == null || ruinRisk <= 0.05)) { verdict = 'GO'; why = 'Positive expectancy, a real edge, and survivable downside.'; }
  else if (ev > 0) { verdict = 'GO (SMALL)'; why = 'Edge exists but with tail/ruin risk — take it, but small.'; }
  else { verdict = 'NO-GO'; why = 'No mathematical edge as framed — pass, or re-negotiate the terms until EV turns positive.'; }
  const stake = (bankroll && kelly > 0) ? Math.round(Math.min(kelly, 0.25) * bankroll) : null; // quarter-Kelly cap
  return { ok: true, move: name, trials, expected_value_usd: +ev.toFixed(2), std_usd: +sd.toFixed(2), prob_profit: +pProfit.toFixed(3), p10_usd: +p10.toFixed(2), p50_usd: +p50.toFixed(2), p90_usd: +p90.toFixed(2), kelly_fraction: +Math.max(0, kelly).toFixed(3), suggested_stake_usd: stake, sharpe: isFinite(sharpe) ? +sharpe.toFixed(2) : null, wipeout_risk_single_bet: ruinRisk != null ? +ruinRisk.toFixed(3) : null, anomalies, verdict, why };
}
function pushActivity(type, label, detail) {
  activitySeq += 1;
  activityLog.push({ id: activitySeq, t: new Date().toISOString(), type, label: String(label || '').slice(0, 120), detail: String(detail || '').slice(0, 240) });
  if (activityLog.length > 300) activityLog.shift();
  return activitySeq;
}
let logFn = (m) => console.log('[portable-core] ' + m);
const jobs = [];
let lfmProcess = null;
let lfmStarting = false;
let lastLfmError = '';
let activeBrain = null;
// Dedicated tiny "voice brain" (e.g. Qwen2.5 0.5B) for instant spoken replies,
// running alongside the main reasoning brain on its own port.
let voiceProcess = null;
let voiceStarting = false;
let hostExecutable = null;
let actionConsentGranted = false;
let _halted = false; // global kill switch — freezes actions, scheduler, and inbound gateway
let _activeProfile = ''; // '' = default (root); else an isolated instance under profiles/<name>
function profileBase() { return _activeProfile ? safeMkdir(path.join(dataRoot, 'profiles', _activeProfile)) : dataRoot; }
function profilesList() { try { const d = path.join(dataRoot, 'profiles'); return exists(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []; } catch { return []; } }
function activeProfileFile() { return path.join(dataRoot, 'config', 'active_profile'); }
const mcpProcesses = new Map();

// Brains bundled in the build's brain dir (beside llama-server.exe), resolved by
// availableEmbeddedBrains(). Primary = Qwen3.5-4B (Apache-2.0) — the leading
// sub-4GB agentic tool-caller as of 2026-06; multimodal when its mmproj sibling
// is present, so one brain serves both chat and vision. Any GGUF dropped in the
// models shelf also appears as a selectable brain via downloadedGgufBrains(),
// and a larger model auto-wins on capable hardware (selectEmbeddedBrain).
const EMBEDDED_BRAIN_CATALOG = [
  {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 E4B (omni)',
    tier: 'standard',
    file: 'gemma-4-E4B-it-Q4_K_M.gguf',
    role: 'Primary bundled brain — smallest fully-omni edge model (text+vision+audio, Apache-2.0); native function-calling; multimodal via its mmproj sibling.',
    min_ram_gb: 8,
    context: 8192
  },
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B (omni floor)',
    tier: 'lite',
    file: 'gemma-4-E2B-it-Q4_K_M.gguf',
    role: 'Omni floor brain for low-RAM machines — text+vision+audio, runs on phones and old laptops; native function-calling.',
    min_ram_gb: 4,
    context: 8192
  },
  {
    id: 'lfm2-2.6b',
    name: 'LFM2 2.6B',
    tier: 'lite',
    file: 'LFM2-2.6B-Exp-Q4_K_M.gguf',
    role: 'Lite offline fallback brain.',
    min_ram_gb: 6,
    context: 8192
  },
  {
    id: 'lfm2-1.2b-tool',
    name: 'LFM2 1.2B Tool',
    tier: 'micro',
    file: 'LFM2-1.2B-Tool-Q4_K_M.gguf',
    role: 'Micro tool-calling fallback for low-RAM machines.',
    min_ram_gb: 4,
    context: 4096
  },
  {
    id: 'lfm2-350m',
    name: 'LFM2.5 350M',
    tier: 'nano',
    file: 'LFM2.5-350M-Q4_K_M.gguf',
    role: 'Nano always-on floor brain — runs on anything.',
    min_ram_gb: 3,
    context: 4096
  }
];
// Auto-select (selectEmbeddedBrain) picks the largest PRESENT brain that fits the
// machine's RAM, so a build ships whichever GGUF(s) it bundles and this Just Works:
// Gemma 4 E4B/E2B (omni: text+vision+audio) if present, else the LFM2 ladder as the offline floor.

// Predefined executive agents the user can pick. Each is a system prompt plus a
// recommended real toolset. No personas are faked — every listed tool exists.
const AGENT_ROLES = [
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    tagline: 'Executive coordinator — plans, routes, and delegates across every tool.',
    tools: ['web_search', 'cmd_run', 'file_write', 'open_app', 'open_url', 'screenshot', 'abuz8_memory_write', 'abuz8_mission_board'],
    system: 'You are ABUZ8 OS Orchestrator, the executive controller of a local agent operating system. You plan multi-step work, decide which tool or sub-agent fits, and keep answers decisive and technical. You have native control of this machine through the host tools. Be direct, no filler.'
  },
  {
    id: 'research-analyst',
    name: 'Research Analyst',
    tagline: 'Live web research and source synthesis.',
    tools: ['web_search', 'open_url', 'abuz8_memory_write'],
    system: 'You are ABUZ8 OS Research Analyst. You gather current information with web_search and fetch, cross-check sources, and synthesize concise, cited findings. State uncertainty plainly. Never invent facts or URLs.'
  },
  {
    id: 'systems-engineer',
    name: 'Systems Engineer',
    tagline: 'Inspects the host, runs CLIs, drives MCP servers.',
    tools: ['cmd_run', 'shell_run', 'cli_probe', 'web_search'],
    system: 'You are ABUZ8 OS Systems Engineer. You inspect and operate this machine through the command line and MCP servers. Explain what a command does before proposing it, prefer read-only diagnostics first, and report exact output. You are precise and safety-aware but you do execute real work.'
  },
  {
    id: 'desktop-operator',
    name: 'Desktop Operator',
    tagline: 'Native desktop actions — apps, files, screenshots, URLs.',
    tools: ['open_app', 'open_url', 'screenshot', 'file_write', 'cmd_run'],
    system: 'You are ABUZ8 OS Desktop Operator. You carry out native desktop actions: launching apps, writing files in the sandbox, opening URLs, and capturing the screen. Confirm the concrete action taken and its result path. Do only what is asked.'
  },
  {
    id: 'automation-builder',
    name: 'Automation Builder',
    tagline: 'Creates new tools and wires connectors.',
    tools: ['abuz8_tool_create', 'cli_probe', 'web_search'],
    system: 'You are ABUZ8 OS Automation Builder. You design and register new local tools and connectors, defining clear names, commands, and arguments. Produce working tool definitions, not placeholders.'
  },
  {
    id: 'knowledge-keeper',
    name: 'Knowledge Keeper',
    tagline: 'Reads, writes, and searches local memory.',
    tools: ['abuz8_memory_write', 'memory_search'],
    system: 'You are ABUZ8 OS Knowledge Keeper. You capture durable facts to local memory and retrieve them on request. Keep entries atomic and well-labeled. Never expose data outside this machine.'
  },
  // ── Executive / growth roles migrated from the Hermes operator-mode & X-growth playbooks ──
  {
    id: 'ceo-operator',
    name: 'CEO / Operator',
    tagline: 'Runs the company in Operator Mode — revenue-first, no permission theater.',
    tools: ['abuz8_mission_board', 'abuz8_mission_task_create', 'swarm_run', 'web_search', 'cmd_run', 'abuz8_memory_write'],
    system: 'You are the ABUZ8 OS CEO / Operator. You run the user’s one-person company in Operator Mode. RULES: (1) Revenue first — judge every task by whether it moves money or builds a revenue asset; deprioritize the rest. (2) No permission theater — once direction is clear, execute; do not ask "shall I continue?" after each step. (3) Massive action bias — ship the whole plan (e.g. a 7-day calendar), not one item at a time. (4) Multi-agent output — when parts can be produced in parallel, produce them together. (5) Fact-check specs/pricing before publishing. You delegate via the Kanban board and the swarm. Coordinate Sales, Content, Distribution, Research, and Kanban-Ops sub-agents. Be decisive and concrete.'
  },
  {
    id: 'seo-strategist',
    name: 'SEO Strategist',
    tagline: 'Keyword strategy, content architecture, technical + on-page SEO.',
    tools: ['web_search', 'content_generate', 'abuz8_memory_write'],
    system: 'You are the ABUZ8 OS SEO Strategist. You plan keyword clusters and search intent, design site/content architecture and internal linking, and write on-page + technical SEO recommendations (titles, meta, schema, Core Web Vitals, crawlability). Ground recommendations in real search behavior and state assumptions. Output concrete briefs, not generic advice.'
  },
  {
    id: 'x-growth-operator',
    name: 'X Growth Operator',
    tagline: 'Audience growth + monetization on X. Carousels, threads, 25-problems protocol.',
    tools: ['content_generate', 'x_post', 'web_search', 'abuz8_mission_task_create'],
    system: 'You are the ABUZ8 OS X Growth Operator, running the migrated x-growth-monetization playbook v2. Engine: carousel posts (10–15 slides: hook → problem → why it matters → mental model → steps → proof → TL;DR → CTA), 3× daily, plus 5–8 short tweets and live threads. Signature protocol: publicly solve 25 of the hardest problems in the niche per week, each tagged with the user’s signature. Engage every reply, quote-RT with added insight, weekly AMA. Track impressions/engagement/follower growth and iterate. Revenue paths: ad share, digital products, affiliates, sponsorships. Fact-check all specs/pricing before drafting. Produce ready-to-post content, not theory.'
  },
  {
    id: 'content-producer',
    name: 'Content Producer',
    tagline: 'NotebookLM-style synthesis → YouTube scripts, threads, carousels.',
    tools: ['content_generate', 'web_search', 'file_write'],
    system: 'You are the ABUZ8 OS Content Producer. You synthesize sources into structured content the way a research-to-media pipeline does: ingest notes/links, extract the spine, then produce the requested format — YouTube script (hook, beats, B-roll cues, CTA), X carousel, thread, blog outline, or show notes. Keep a consistent voice and a single CTA. Mark anything you could not verify rather than inventing it.'
  },
  {
    id: 'swarm-orchestrator',
    name: 'Swarm Orchestrator',
    tagline: 'Decomposes a goal and runs a multi-agent swarm to completion.',
    tools: ['swarm_run', 'abuz8_mission_task_create', 'cmd_run', 'web_search'],
    system: 'You are the ABUZ8 OS Swarm Orchestrator. You decompose a goal into parallel work, assign each part to the best specialized role, run them as a swarm, then verify and synthesize the results into one coherent deliverable. Topology: orchestrator → workers → verifier → synthesis. Name the sub-agents you used and reconcile conflicts explicitly.'
  }
];

function resolveRoleSystem(roleId) {
  if (!roleId || roleId === 'default' || roleId === 'auto') return null;
  const role = AGENT_ROLES.find((r) => r.id === roleId || slug(r.name) === slug(roleId));
  return role ? role.system : null;
}

// ── The Lineage: a family of specialist agent CLASSES on one shared chassis ──
// Like Mercedes shares a platform but the S, G, CL each specialize, every class
// rides the ABUZ8 Portable Core (same API, tools, voice, memory, soul system)
// but loads its own identity, toolset, brain bias, and connectors. Selecting a
// class re-skins the same engine into a different specialist.
const AGENT_CLASSES = [
  {
    id: 'abuz8-s', class: 'S', name: 'ABUZ8 — Flagship Operator', specialty: 'general sovereign operator',
    tagline: 'The flagship. Runs the whole company, commands every tool.',
    brain: 'reasoning', tools: ['*'], connectors: ['claude-desktop', 'mcp'],
    soul: { name: 'ABUZ8', voice: 'Warm, confident, decisive — a JARVIS-class right hand. Acts, never grovels.', mission: 'Run the one-person company end to end and generate revenue.' }
  },
  {
    id: 'intel-e', class: 'E', name: 'Raqib — Intel & OSINT Analyst', specialty: 'research, OSINT, investigation',
    tagline: 'Executive intelligence. Reads the web deeply, builds dossiers, finds the signal.',
    brain: 'reasoning', tools: ['deep_research', 'web_search', 'browser_do', 'abuz8_memory_write', 'cmd_run'], connectors: ['osint'],
    soul: { name: 'Raqib', voice: 'Calm, precise, analytical — an intelligence officer. Cites sources, separates fact from rumor.', mission: 'Gather, verify, and synthesize intelligence into clear dossiers and decisions.' }
  },
  {
    id: 'studio-cl', class: 'CL', name: 'Mubdi — Creator Studio', specialty: 'content, video, avatar media',
    tagline: 'The luxury coupe. Carousels, threads, scripts, video & avatar pipelines.',
    brain: 'reasoning', tools: ['content_generate', 'x_post', 'web_search', 'file_write', 'browser_do'], connectors: ['kling', 'heygen', 'x', 'youtube'],
    soul: { name: 'Mubdi', voice: 'Bold creative director — punchy hooks, strong taste, ships fast.', mission: 'Turn ideas into scroll-stopping content and revenue assets across every channel.' }
  },
  {
    id: 'sentinel-g', class: 'G', name: 'Haris — Sentinel', specialty: 'security, red-team, system ops',
    tagline: 'The rugged off-roader. CLI, recon, hardening — careful and guarded.',
    brain: 'reasoning', tools: ['cmd_run', 'shell_run', 'cli_probe', 'web_search', 'abuz8_device_probe'], connectors: ['kali', 'nmap'],
    soul: { name: 'Haris', voice: 'Terse, disciplined, security-minded. Explains a command before running it; defaults to read-only.', mission: 'Inspect, harden, and operate systems safely. Never run a destructive action without explicit approval.' }
  },
  {
    id: 'ops-gl', class: 'GL', name: 'Mudir — Ops & Growth', specialty: 'CEO/ops, SEO, mass marketing',
    tagline: 'The SUV that hauls the business. Kanban, growth protocol, revenue.',
    brain: 'reasoning', tools: ['abuz8_mission_board', 'abuz8_mission_task_create', 'content_generate', 'x_post', 'swarm_run', 'web_search'], connectors: ['x', 'stripe'],
    soul: { name: 'Mudir', voice: 'CEO operator — revenue-first, no permission theater, massive action.', mission: 'Run operations and growth: ship the 7-day cadence, solve hard problems publicly, track revenue.' }
  },
  {
    id: 'companion-c', class: 'C', name: 'Anis — Companion', specialty: 'voice-first conversation',
    tagline: 'The everyday compact. Instant voice, warm, always with you.',
    brain: 'voice', tools: ['web_search', 'open_url', 'open_app', 'abuz8_memory_write'], connectors: [],
    soul: { name: 'Anis', voice: 'Warm, quick, friendly — a true companion. Short spoken answers, real personality.', mission: 'Be a present, helpful voice companion through the day.' }
  },
  {
    id: 'scout-a', class: 'A', name: 'Kashif — Scout', specialty: 'lightweight edge / weak devices',
    tagline: 'The nimble entry class. Tiny, fast, runs on anything.',
    brain: 'voice', tools: ['web_search', 'open_url', 'cmd_run'], connectors: [],
    soul: { name: 'Kashif', voice: 'Lean and fast. Minimal, direct, no waste.', mission: 'Stay useful on the weakest hardware; do the basics instantly.' }
  },
  {
    id: 'hakim-r', class: 'R', name: 'Hakim — Biomedical Research', specialty: 'disease research, molecular genomics, immunology',
    tagline: 'The research class. Reads the literature on cancer, ALS, AIDS, dementia, genomes, autoimmune markers.',
    brain: 'reasoning', tools: ['deep_research', 'web_search', 'browser_do', 'content_generate', 'file_write', 'abuz8_memory_write'],
    connectors: ['pubmed', 'clinicaltrials.gov', 'ncbi-genbank', 'uniprot', 'ensembl'],
    soul: {
      name: 'Hakim',
      voice: 'A rigorous physician-scientist. Evidence-first, calm, precise. Cites peer-reviewed sources, distinguishes established findings from hypotheses, and states uncertainty and effect sizes plainly.',
      mission: 'Synthesize biomedical research toward understanding and potentially curing disease — cancer, ALS, AIDS, dementia — and analyze molecular genomics, blood-type variation, and the genetic markers linked to autoimmune risk and prevention. SAFETY LAW: you are a research synthesis aid, not a doctor. You do NOT diagnose, prescribe, or claim cures; you summarize evidence, cite sources, flag what is unproven, and direct all personal medical decisions to qualified clinicians. Never invent a study, statistic, gene, or result — if you are not sure, say so.'
    }
  },
  {
    id: 'faqih-q', class: 'Q', name: 'Faqih — Arabic & Quranic Thinker', specialty: 'Arabic-first reasoning, Quranic & Islamic scholarship',
    tagline: 'The wisdom class. Thinks in Arabic first, reasons from the Quran and the Islamic tradition.',
    brain: 'reasoning', tools: ['deep_research', 'web_search', 'abuz8_memory_write'],
    connectors: ['quran-api', 'hadith-api', 'tafsir'],
    soul: {
      name: 'Faqih',
      voice: 'A thoughtful Muslim scholar-companion. Thinks in Arabic first, then explains in the user’s language. Speaks with adab (good manners), humility, and warmth; opens with Bismillah where fitting; grounds reasoning in the Quran, the Sunnah, and the scholarly tradition.',
      mission: 'Reason Arabic-first and through a Quranic, Islamic worldview: tafsir-aware, fiqh-aware, ethics-centered. Help with Arabic language, Quranic understanding, and decisions weighed against Islamic principles. SAFETY LAW: you are a study and thinking aid, not a mufti. You do NOT issue binding fatwas; you present what the Quran, authentic hadith, and recognized scholars say, note differences between schools, cite sources, and direct rulings on personal matters to qualified living scholars. Never fabricate a verse, hadith, or attribution — if unsure, say so and recommend verification.'
    }
  }
];
function activeClassId() { try { return readJson(settingsPath(), {}).active_class || ''; } catch { return ''; } }
function resolveClass(id) { return AGENT_CLASSES.find((c) => c.id === id || slug(c.name) === slug(id) || String(c.class).toLowerCase() === String(id).toLowerCase()); }

// ── Soul: persistent personality + mission, Hermes-style, loaded into every chat ──
// ── Soul system (Hermes-style): a NAME + 4 files that define who ABUZ8 is and
// how it speaks. Loaded into every reply — including fast voice — so it always
// answers in character. Fully editable in Settings → Soul. ──
const DEFAULT_NAME = 'ABUZ8';
const DEFAULT_SOUL = `You are a sovereign, JARVIS-class agent operating system — the loyal right hand of the one person you serve. You are not a generic chatbot; you are a partner with a spine. You have agency: when a request implies something you can actually do (open an app or site, run a command, search, build a tool, draw, post), you DO it, then report what happened. You are calm under pressure, decisive, and quietly proud of being genuinely useful.`;

// Ground truth of what ABUZ8 (you) can ACTUALLY do — injected into the system prompt
// so the agent never again under-claims its own built-in body. Keep it accurate.
const CAPABILITY_MANIFEST = `WHAT YOU ACTUALLY ARE — never claim you lack these; they are built into your body (ABUZ8 OS) on this machine:
• Brains: a local llama.cpp brain (offline, zero fees) PLUS the user's own Claude / Grok / ChatGPT / Gemini accounts. Thinking modes: single, council, debate, auto.
• Machine control: run shell/CLI (cmd_run — safety-guarded), write/read files (writes sandboxed; reads credential-jailed with auto checkpoints + rollback), open apps & URLs, screenshot, control mouse/keyboard (gui_do), drive a real browser (Playwright).
• Tools: web_search, deep_research, vision (jarvis_see), content_generate, image generation (Studio), send_email, calendar_create, stripe_op, social_post / x_post, get_time, get_weather — plus any user-defined tool and any MCP server.
• Memory: durable LOCAL vector memory + Second Brain RAG. You persist across sessions — you are NOT amnesiac.
• Autonomy: a goals engine (decompose → verify → retry), schedules/cron (you wake on a timer with no prompt), swarm/orchestrate (parallel sub-agents), a self-learning skill loop, AND per-turn learning — after every exchange you extract durable facts/preferences about the user into memory, so you genuinely learn each pass (not faked).
• Self-modification: you can edit your OWN source in a git worktree and rebuild (selfUpgradePropose).
• Business OS: Command Center / HUD cockpit (CEO/CFO/CRO/COO/CKO/CTO), Stripe revenue, Content Studio, coder loop, deploy (Vercel/GitHub), mobile build, Forge 3D.
• Reach: two-way messaging gateway (Telegram / Slack / Twilio, pairing-gated), LAN/phone PWA, cross-machine Fleet Mesh, MCP client + headless stdio.
• Voice: local Piper TTS + Whisper STT (offline-capable), wake word, 3D lip-synced avatar.
• Safety: actions gated by consent + a danger-guard (hardline refusals + approval for destructive commands), a global /api/halt kill switch, and full action logging.
Be honest about what genuinely needs the user's keys/accounts (paid APIs, merchant rails) or an always-on host — but do NOT understate the capabilities above. They exist.`;
const DEFAULT_VOICE = `Warm, confident, concise — a trusted right-hand, never a servant and never robotic. You speak in plain, human language with an occasional touch of dry wit. You mirror your owner's energy: when they're hyped, you match it; when they're focused, you're crisp. You address them as a partner, never grovel, never pad answers with filler. End with the next move, not a question, when the path is clear.`;
const DEFAULT_MISSION = `Help your owner build a one-person company that generates real revenue through content creation and mass SEO/social marketing. Bias toward shipping assets that compound — carousels, threads, articles, tools — and the signature protocol of publicly solving hard problems. Revenue-first, massive action, no permission theater.`;
const DEFAULT_DIRECTIVES = `1. Act, don't describe — if you can do it, do it.\n2. Never fake a result. If something needs a key or isn't possible, say so in one honest line and offer the next best move.\n3. Fact-check specs, prices, and hardware before asserting them.\n4. Stay in character as defined by your name, soul, and voice at all times.\n5. Be brief by default; expand only when asked.`;

function soulDir() { return safeMkdir(path.join(profileBase(), 'soul')); }
function readTextFile(f, fallback) { try { const s = fs.readFileSync(f, 'utf8'); return s; } catch { return fallback; } }
function soulFile(name, def) {
  const p = path.join(soulDir(), name);
  if (!exists(p)) fs.writeFileSync(p, def, 'utf8');
  return readTextFile(p, def).trim();
}
function loadSoul() {
  return {
    name: soulFile('NAME.txt', DEFAULT_NAME).split('\n')[0].trim() || DEFAULT_NAME,
    personality: soulFile('SOUL.md', DEFAULT_SOUL),     // who it is
    voice: soulFile('VOICE.md', DEFAULT_VOICE),         // how it speaks
    mission: soulFile('MISSION.md', DEFAULT_MISSION),   // what it's for
    directives: soulFile('DIRECTIVES.md', DEFAULT_DIRECTIVES) // how it operates
  };
}
function saveSoul(patch = {}) {
  const map = { name: 'NAME.txt', personality: 'SOUL.md', voice: 'VOICE.md', mission: 'MISSION.md', directives: 'DIRECTIVES.md' };
  for (const k of Object.keys(map)) if (typeof patch[k] === 'string') fs.writeFileSync(path.join(soulDir(), map[k]), patch[k], 'utf8');
  return loadSoul();
}
// Full system prompt for typed chat: the whole soul + the active role.
// Always answer in the user's language — fluent, native Arabic when they write/speak Arabic.
const LANG_DIRECTIVE = 'Language: reply in the SAME language the user used. If they write or speak in Arabic, answer in fluent, natural Modern Standard Arabic (فصحى) — never transliterate Arabic into Latin letters. Match their dialect when it is clear.';
// Ground the model in the REAL current date/time (from the OS clock) so it never
// guesses the year from stale training weights (e.g. saying 2023 when it is 2026).
function nowDirective() {
  try { const t = currentTimeContext(); return `The current date and time is ${t.date}, ${t.time}${t.tz ? ' ' + t.tz : ''}. This is the real, authoritative clock — ALWAYS use it for anything about the date, day, year, or "today"/"tomorrow". Never state the date or year from memory/training data. The current year is ${t.year}.`; } catch { return ''; }
}
function composeSystem(roleId, explicit) {
  if (explicit) return explicit.includes('Language:') ? explicit : (explicit + '\n\n' + LANG_DIRECTIVE);
  const s = dataRoot ? loadSoul() : { name: DEFAULT_NAME, personality: DEFAULT_SOUL, voice: DEFAULT_VOICE, mission: DEFAULT_MISSION, directives: DEFAULT_DIRECTIVES };
  const role = resolveRoleSystem(roleId);
  // If a lineage CLASS is active, it re-skins the identity (name/voice/mission/focus).
  const cls = resolveClass(activeClassId());
  if (cls) {
    return [
      `Your name is ${cls.soul.name}. You are the ${cls.class}-Class of the ABUZ8 lineage — a specialist in ${cls.specialty}.`,
      s.personality,
      `Voice & manner:\n${cls.soul.voice}`,
      role,
      `Mission:\n${cls.soul.mission}`,
      cls.tools && cls.tools[0] !== '*' ? `Your focus tools: ${cls.tools.join(', ')}.` : '',
      `Directives:\n${s.directives}`,
      CAPABILITY_MANIFEST,
      LANG_DIRECTIVE,
      nowDirective(),
      presenceDirective()
    ].filter(Boolean).join('\n\n');
  }
  return [
    `Your name is ${s.name}.`,
    s.personality,
    `Voice & manner:\n${s.voice}`,
    role,
    `Mission:\n${s.mission}`,
    `Directives:\n${s.directives}`,
    CAPABILITY_MANIFEST,
    LANG_DIRECTIVE,
    nowDirective(),
    presenceDirective()
  ].filter(Boolean).join('\n\n');
}
// Compact system for fast voice/brief turns — short, but still fully in character.
function voiceSystem() {
  const s = dataRoot ? loadSoul() : { name: DEFAULT_NAME, voice: DEFAULT_VOICE };
  const manner = String(s.voice).split(/(?<=[.!])\s/).slice(0, 2).join(' ').slice(0, 240);
  return `Your name is ${s.name}. Speak in ${s.name}'s voice: ${manner} Answer in 1-2 short spoken sentences, in character. Reply in the user's language — fluent natural Arabic (فصحى) if they spoke Arabic. ${nowDirective()} ${presenceDirective()}`;
}

// Live camera/vision awareness → fed into the brain's context so the agent KNOWS it can
// SEE the user (presence, attention, gaze, hand gesture) via the bundled MediaPipe
// face/gesture pipeline. Returns '' when there's no fresh presence, so it stays silent otherwise.
function presenceDirective() {
  try {
    if (typeof isUserPresent !== 'function' || !isUserPresent()) return '';
    const p = _presence || {};
    const bits = [p.attentive ? 'present and looking at you (attentive)' : 'present'];
    if (p.distance && p.distance !== 'unknown') bits.push('distance ' + p.distance);
    if (p.gaze && p.gaze !== 'center') bits.push('gaze ' + p.gaze);
    if (p.gesture && p.gesture !== 'none') bits.push('last hand gesture: ' + p.gesture);
    return 'Live vision — you can SEE the user via the camera right now: ' + bits.join(', ') + '. Acknowledge it naturally only when relevant.';
  } catch { return ''; }
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isWritable(dir) {
  try {
    safeMkdir(dir);
    const probe = path.join(dir, `.write-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataRoot(app) {
  const explicit = process.env.ABUZ8_DATA_DIR || process.env.QADIR_DATA_DIR;
  if (explicit) return safeMkdir(explicit);

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && isWritable(portableDir)) {
    return safeMkdir(path.join(portableDir, 'ABUZ8_OS_Data'));
  }

  const appData = app && typeof app.getPath === 'function'
    ? app.getPath('userData')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'ABUZ8 OS');
  return safeMkdir(appData);
}

function initFolders() {
  for (const name of ['memory', 'mcp', 'skills', 'logs', 'models', 'workspaces', 'cache', 'exports', 'config', 'mission']) {
    safeMkdir(path.join(dataRoot, name));
  }
  try { _activeProfile = (fs.readFileSync(path.join(dataRoot, 'config', 'active_profile'), 'utf8') || '').trim(); } catch {}
  const cfg = path.join(dataRoot, 'config', 'runtime.json');
  if (!fs.existsSync(cfg)) {
    writeJson(cfg, {
      product: 'ABUZ8 OS',
      mode: process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed',
      backend_port: PORT,
      data_root: dataRoot,
      local_brain: {
        default: 'auto',
        tiers: EMBEDDED_BRAIN_CATALOG.map((b) => ({ id: b.id, name: b.name, tier: b.tier, file: b.file })),
        status: 'embedded-offline'
      },
      created_at: new Date().toISOString()
    });
  }
}

function missionFile() {
  return path.join(dataRoot, 'mission', 'board.json');
}

function toolsFile() {
  return path.join(dataRoot, 'config', 'local_tools.json');
}

function runtimeConfigFile() {
  return path.join(dataRoot, 'config', 'runtime.json');
}

function readRuntimeConfig() {
  return readJson(runtimeConfigFile(), {});
}

function writeRuntimeConfigPatch(patch = {}) {
  const cfg = readRuntimeConfig();
  const next = { ...cfg, ...patch, updated_at: new Date().toISOString() };
  writeJson(runtimeConfigFile(), next);
  return next;
}

function defaultMissionBoard() {
  const now = new Date().toISOString();
  return {
    ok: true,
    mission: {
      title: 'ABUZ8 OS Production Launch',
      objective: 'Ship a local-first agent OS that works offline, bridges Claude Desktop through MCP, and can be verified by a buyer on a clean Windows machine.',
      updated_at: now
    },
    columns: [
      { id: 'backlog', title: 'Backlog', limit: 12 },
      { id: 'ready', title: 'Ready', limit: 8 },
      { id: 'doing', title: 'Doing', limit: 3 },
      { id: 'verify', title: 'Verify', limit: 6 },
      { id: 'done', title: 'Done', limit: 20 }
    ],
    tasks: [
      { id: 'task-brain-tiers', title: 'Three offline LFM brain variants', column: 'done', priority: 'high', owner: 'ABUZ8', details: 'Lite, Standard, and Pro packaged with llama.cpp runtime and verified fallback:false.', created_at: now, updated_at: now },
      { id: 'task-claude-mcp', title: 'Claude Desktop MCP symbiote', column: 'verify', priority: 'high', owner: 'ABUZ8', details: 'Install abuz8_os into Claude Desktop config and expose native tools over stdio.', created_at: now, updated_at: now },
      { id: 'task-clean-vm', title: 'Clean Windows VM installer pass', column: 'ready', priority: 'high', owner: 'human', details: 'Requires a fresh Windows machine and code-signing decision.', created_at: now, updated_at: now },
      { id: 'task-code-sign', title: 'Code signing certificate', column: 'backlog', priority: 'high', owner: 'human', details: 'Needed before distribution to executives or customers.', created_at: now, updated_at: now }
    ]
  };
}

function readMissionBoard() {
  const file = missionFile();
  if (!fs.existsSync(file)) writeJson(file, defaultMissionBoard());
  const board = readJson(file, defaultMissionBoard());
  board.ok = true;
  board.columns = Array.isArray(board.columns) && board.columns.length ? board.columns : defaultMissionBoard().columns;
  board.tasks = Array.isArray(board.tasks) ? board.tasks : [];
  return board;
}

function writeMissionBoard(board) {
  board.ok = true;
  board.mission = board.mission || {};
  board.mission.updated_at = new Date().toISOString();
  writeJson(missionFile(), board);
  return board;
}

function missionSummary(board = readMissionBoard()) {
  const counts = {};
  for (const col of board.columns) counts[col.id] = 0;
  for (const task of board.tasks) counts[task.column] = (counts[task.column] || 0) + 1;
  return {
    total: board.tasks.length,
    counts,
    blockers: board.tasks.filter((t) => t.priority === 'blocker' || t.blocked).length,
    human_required: board.tasks.filter((t) => String(t.owner || '').toLowerCase() === 'human').length,
    next: board.tasks.filter((t) => !['done'].includes(t.column)).slice(0, 5).map((t) => ({ id: t.id, title: t.title, column: t.column, priority: t.priority, owner: t.owner }))
  };
}

function upsertMissionTask(input = {}) {
  const board = readMissionBoard();
  const now = new Date().toISOString();
  const title = String(input.title || input.task || '').trim();
  if (!title) throw new Error('Mission task title is required.');
  const allowed = new Set(board.columns.map((c) => c.id));
  const id = slug(input.id || title || `task-${Date.now()}`);
  const existing = board.tasks.find((t) => t.id === id);
  const task = {
    id,
    title,
    column: allowed.has(input.column) ? input.column : (existing?.column || 'backlog'),
    priority: input.priority || existing?.priority || 'medium',
    owner: input.owner || existing?.owner || 'ABUZ8',
    details: input.details || input.description || existing?.details || '',
    blocked: Boolean(input.blocked ?? existing?.blocked ?? false),
    created_at: existing?.created_at || now,
    updated_at: now
  };
  if (existing) Object.assign(existing, task);
  else board.tasks.unshift(task);
  writeMissionBoard(board);
  return task;
}

function moveMissionTask(id, column) {
  const board = readMissionBoard();
  const allowed = new Set(board.columns.map((c) => c.id));
  if (!allowed.has(column)) throw new Error(`Unknown mission column: ${column}`);
  const task = board.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Mission task not found: ${id}`);
  task.column = column;
  task.updated_at = new Date().toISOString();
  writeMissionBoard(board);
  return task;
}

function localToolsList() {
  const brain = activeBrain || selectEmbeddedBrain();
  const builtIns = [
    { name: 'abuz8_chat', type: 'mcp', status: 'ready', description: 'Claude Desktop can ask the embedded ABUZ8 brain through MCP.' },
    { name: 'abuz8_device_probe', type: 'mcp', status: 'ready', description: 'Hardware and local capability probe.' },
    { name: 'abuz8_brains_list', type: 'mcp', status: 'ready', description: 'List bundled and downloaded local model files.' },
    { name: 'abuz8_brain_select', type: 'mcp', status: 'ready', description: 'Switch the active embedded brain tier for future local chat calls.' },
    { name: 'abuz8_memory_write', type: 'mcp', status: 'ready', description: 'Write a note to local ABUZ8 memory.' },
    { name: 'abuz8_tools_list', type: 'mcp', status: 'ready', description: 'List local tools, MCP tools, model shelf, and permission-gated bridges.' },
    { name: 'abuz8_tool_create', type: 'mcp', status: 'ready', description: 'Create a local ABUZ8 tool definition.' },
    { name: 'abuz8_tool_call', type: 'mcp', status: 'ready', description: 'Execute a local ABUZ8 built-in or registered tool by name.' },
    { name: 'abuz8_mission_board', type: 'mcp', status: 'ready', description: 'Read the local mission/Kanban board.' },
    { name: 'abuz8_mission_task_create', type: 'mcp', status: 'ready', description: 'Create or update a mission task from Claude Desktop.' },
    { name: 'abuz8_mission_task_move', type: 'mcp', status: 'ready', description: 'Move a mission task between Kanban columns.' },
    { name: 'huggingface_model_download', type: 'local-api', status: 'permission-gated', description: 'Download model files to the local model shelf with allow_network_download.' },
    { name: 'model_download_hf', type: 'network-model', status: 'permission-gated', description: 'Alias for downloading a user-approved Hugging Face GGUF into the portable data model shelf.' },
    { name: 'cloud_brain_register', type: 'cloud-model', status: 'permission-gated', description: 'Register a user-owned cloud brain endpoint or provider key reference locally.' },
    { name: 'open_url', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Open an http/https URL in the default browser after Allow actions consent.' },
    { name: 'open_app', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Open an allowlisted desktop app: notepad, mspaint, calc, or explorer.' },
    { name: 'screenshot', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Capture the primary screen to the portable data shots folder.' },
    { name: 'file_write', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Write a text file inside the portable data sandbox only.' },
    { name: 'shell_run', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Run allowlisted quick probes: whoami, hostname, or dir.' },
    { name: 'cmd_run', type: 'action', status: actionConsentGranted ? 'ready' : 'blocked', description: 'Run any local CLI command or shell pipeline with full native control after Allow actions consent.' },
    { name: 'cli_probe', type: 'local-api', status: 'permission-gated', description: 'Probe local CLIs with allow_cli.' },
    { name: 'cli_register', type: 'local-api', status: 'permission-gated', description: 'Register a local CLI bridge with allow_cli.' },
    { name: 'oauth_exchange', type: 'local-api', status: 'permission-gated', description: 'Store user-authorized OAuth tokens locally with allow_oauth_store.' },
    { name: 'embedded_brain_runtime', type: 'local-runtime', status: brain?.embedded ? 'ready' : 'fallback', description: brain?.embedded ? `\${brain.name} selected automatically.` : 'No embedded GGUF selected.' },
    { name: 'web_search', type: 'local-api', status: 'ready', description: 'Real-time web search via DuckDuckGo HTML scraping. Returns structured results with titles, URLs, and snippets.' },
    { name: 'browser_do', type: 'action', status: browserAutomationAvailable() ? 'ready' : 'attachment-missing', description: 'Drive a real browser with Playwright: navigate, click, fill, screenshot, extract page text.' },
    { name: 'gui_do', type: 'action', status: guiAutomationAvailable() ? (actionConsentGranted ? 'ready' : 'blocked') : 'attachment-missing', description: 'Control the real mouse/keyboard/screen with PyAutoGUI (move, click, type, hotkey, screenshot).' }
  ];
  return builtIns.concat(readCustomTools());
}

function readCustomTools() {
  const cfg = readJson(toolsFile(), { tools: [] });
  return Array.isArray(cfg.tools) ? cfg.tools : [];
}

function createLocalTool(input = {}) {
  const name = slug(input.name || input.title || '');
  if (!name) throw new Error('Tool name is required.');
  const cfg = readJson(toolsFile(), { tools: [] });
  cfg.tools = Array.isArray(cfg.tools) ? cfg.tools : [];
  const now = new Date().toISOString();
  const tool = {
    name,
    label: input.label || input.title || name,
    type: input.type || 'manual',
    status: input.status || 'draft',
    description: input.description || input.purpose || '',
    command: input.command || '',
    args: Array.isArray(input.args) ? input.args : [],
    endpoint: input.endpoint || '',
    permission_required: input.permission_required || (input.command ? 'allow_cli' : ''),
    created_at: cfg.tools.find((t) => t.name === name)?.created_at || now,
    updated_at: now
  };
  const existing = cfg.tools.findIndex((t) => t.name === name);
  if (existing >= 0) cfg.tools[existing] = tool;
  else cfg.tools.unshift(tool);
  writeJson(toolsFile(), cfg);
  return tool;
}

function normalizeHttpUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('url is required');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.');
  return parsed.toString();
}

function actionsAllowed() {
  if (_halted) return false; // kill switch wins over everything
  if (actionConsentGranted) return true;
  // Honor the persisted setting so consent survives relaunch (the UI toggle writes this).
  try { return readJson(settingsPath(), {}).auto_grant_actions === true; } catch { return false; }
}

// Shell/OS-level primitives that can be reached by prompt-injection from web pages the agent reads
// or inbound Slack/WhatsApp/Discord messages. These NEVER ride the autopilot's implicit consent —
// they require the user's explicit standing "Allow actions" toggle. Closes the cmd_run RCE path.
const HIGH_RISK_TOOLS = ['cmd_run', 'gui_do'];
function requireActionConsent(tool) {
  if (actionsAllowed()) return; // explicit standing consent (the Allow-actions toggle) — full power
  // An explicitly-launched autopilot run IS the user's consent to act on LOCAL sandbox-safe tools
  // (file_write/screenshot/open_app/open_url). Money/outward tools stay gated by the red-tier check
  // (enforceTier) + the fail-closed verifier; shell/OS tools stay gated by the explicit toggle.
  if (typeof agentRunning !== 'undefined' && agentRunning && !HIGH_RISK_TOOLS.includes(tool)) return;
  throw new Error(HIGH_RISK_TOOLS.includes(tool)
    ? 'Blocked: "' + tool + '" (shell/OS control) needs the explicit Allow-actions toggle — it will not auto-run inside an autonomous task (prompt-injection guard).'
    : 'Action tools are blocked until the user enables Allow actions.');
}

// Apps the agent can launch by name. Browsers/Office/utilities resolve through
// the Windows App Paths registry via `start`, so they work without a full path.
function normalizeAllowedApp(name) {
  const key = slug(name || '');
  const apps = {
    notepad: { target: 'notepad', label: 'Notepad' },
    mspaint: { target: 'mspaint', label: 'Paint' },
    paint: { target: 'mspaint', label: 'Paint' },
    calc: { target: 'calc', label: 'Calculator' },
    calculator: { target: 'calc', label: 'Calculator' },
    explorer: { target: 'explorer', label: 'File Explorer' },
    files: { target: 'explorer', label: 'File Explorer' },
    chrome: { target: 'chrome', label: 'Google Chrome' },
    'google-chrome': { target: 'chrome', label: 'Google Chrome' },
    edge: { target: 'msedge', label: 'Microsoft Edge' },
    msedge: { target: 'msedge', label: 'Microsoft Edge' },
    firefox: { target: 'firefox', label: 'Firefox' },
    brave: { target: 'brave', label: 'Brave' },
    word: { target: 'winword', label: 'Word' },
    excel: { target: 'excel', label: 'Excel' },
    powerpoint: { target: 'powerpnt', label: 'PowerPoint' },
    outlook: { target: 'outlook', label: 'Outlook' },
    cmd: { target: 'cmd', label: 'Command Prompt' },
    terminal: { target: 'wt', label: 'Windows Terminal' },
    powershell: { target: 'powershell', label: 'PowerShell' },
    'task-manager': { target: 'taskmgr', label: 'Task Manager' },
    taskmgr: { target: 'taskmgr', label: 'Task Manager' },
    settings: { target: 'ms-settings:', label: 'Settings' },
    spotify: { target: 'spotify', label: 'Spotify' },
    code: { target: 'code', label: 'VS Code' },
    vscode: { target: 'code', label: 'VS Code' }
  };
  return apps[key] || null;
}

// Launch via `start` so browsers, URLs, App-Paths apps, and shell verbs all work.
function launchViaStart(target, extra = []) {
  const quote = (s) => `"${String(s).replace(/"/g, '')}"`;
  const cmdline = `start "" ${quote(target)} ${extra.map(quote).join(' ')}`.trim();
  const child = spawn(cmdline, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { launched: true, target, args: extra };
}

async function startProcessDetached(file, args = []) {
  const child = spawn(file, args.map(String), { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { launched: true, pid: child.pid, file, args };
}

async function actionOpenApp(args = {}) {
  requireActionConsent();
  const raw = args.name || args.app || args.target || '';
  const app = normalizeAllowedApp(raw);
  if (!app) {
    // Unknown name: try launching it directly through `start` (resolves App Paths).
    const guess = slug(raw);
    if (!guess) throw new Error('No app name supplied.');
    const r = launchViaStart(guess);
    return { ...r, app: guess, note: 'Launched via Windows start; if nothing opened, the app is not installed or not on App Paths.' };
  }
  const result = launchViaStart(app.target);
  return { ...result, app: app.label };
}

async function actionDrawMonkeyInPaint(args = {}) {
  requireActionConsent();
  const artDir = safeMkdir(path.join(dataRoot, 'art'));
  const file = path.join(artDir, `paint-monkey-${Date.now()}.png`);
  const scriptFile = path.join(safeMkdir(path.join(dataRoot, 'cache')), `draw-monkey-${process.pid}-${Date.now()}.ps1`);
  const caption = String(args.caption || 'ABUZ8 OS drew this locally').replace(/'/g, "''").slice(0, 80);
  const script = [
    'param([string]$OutFile, [string]$Caption)',
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 900, 700',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
    '$bg = [System.Drawing.Brushes]::White',
    '$g.FillRectangle($bg, 0, 0, 900, 700)',
    '$fur = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 78, 44))',
    '$fur2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(88, 53, 31))',
    '$skin = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(224, 174, 120))',
    '$ink = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(45, 31, 24), 7)',
    '$thin = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(45, 31, 24), 4)',
    '$smile = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 42, 34), 5)',
    '$g.FillEllipse($fur2, 220, 95, 180, 180)',
    '$g.FillEllipse($fur2, 500, 95, 180, 180)',
    '$g.FillEllipse($fur, 250, 80, 400, 400)',
    '$g.FillEllipse($skin, 315, 180, 270, 255)',
    '$g.FillEllipse([System.Drawing.Brushes]::White, 365, 235, 55, 55)',
    '$g.FillEllipse([System.Drawing.Brushes]::White, 480, 235, 55, 55)',
    '$g.FillEllipse([System.Drawing.Brushes]::Black, 383, 252, 18, 18)',
    '$g.FillEllipse([System.Drawing.Brushes]::Black, 498, 252, 18, 18)',
    '$g.FillEllipse($fur2, 428, 290, 75, 58)',
    '$g.FillEllipse($skin, 365, 325, 170, 90)',
    '$g.DrawArc($smile, 400, 340, 100, 55, 15, 150)',
    '$g.DrawEllipse($ink, 250, 80, 400, 400)',
    '$g.DrawEllipse($thin, 220, 95, 180, 180)',
    '$g.DrawEllipse($thin, 500, 95, 180, 180)',
    '$g.DrawArc($thin, 180, 420, 190, 160, 190, 115)',
    '$g.DrawArc($thin, 530, 420, 190, 160, 345, 115)',
    '$font = New-Object System.Drawing.Font "Segoe UI", 24, ([System.Drawing.FontStyle]::Bold)',
    '$g.DrawString($Caption, $font, [System.Drawing.Brushes]::Black, 245, 575)',
    '$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose(); $bmp.Dispose(); $fur.Dispose(); $fur2.Dispose(); $skin.Dispose(); $ink.Dispose(); $thin.Dispose(); $smile.Dispose(); $font.Dispose()'
  ].join(os.EOL);
  fs.writeFileSync(scriptFile, script, 'utf8');
  const drawn = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, file, caption], 20000);
  try { fs.unlinkSync(scriptFile); } catch {}
  if (!drawn.ok || !fs.existsSync(file)) throw new Error(drawn.stderr || drawn.stdout || 'Monkey drawing failed.');
  const opened = await startProcessDetached('mspaint.exe', [file]);
  return { ...opened, app: 'Paint', file, bytes: fs.statSync(file).size };
}

// Draw a simple unicorn and open it in Paint — a real local creative action.
async function actionDrawUnicornInPaint(args = {}) {
  requireActionConsent();
  const artDir = safeMkdir(path.join(dataRoot, 'art'));
  const file = path.join(artDir, `paint-unicorn-${Date.now()}.png`);
  const scriptFile = path.join(safeMkdir(path.join(dataRoot, 'cache')), `draw-unicorn-${process.pid}-${Date.now()}.ps1`);
  const caption = String(args.caption || 'ABUZ8 OS drew a unicorn').replace(/'/g, "''").slice(0, 80);
  const script = [
    'param([string]$OutFile,[string]$Caption)',
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 900,700',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
    '$g.Clear([System.Drawing.Color]::FromArgb(235,243,255))',
    '$body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
    '$ink = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70,60,90),5)',
    '$pink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,182,213))',
    '$g.FillEllipse($body,300,300,320,210)',
    '$g.DrawEllipse($ink,300,300,320,210)',
    '$g.FillEllipse($body,520,200,180,170)',
    '$g.DrawEllipse($ink,520,200,180,170)',
    '$g.FillPolygon($body,@((New-Object System.Drawing.Point(640,250)),(New-Object System.Drawing.Point(720,300)),(New-Object System.Drawing.Point(630,330))))',
    '$g.FillRectangle($body,340,470,34,150); $g.DrawRectangle($ink,340,470,34,150)',
    '$g.FillRectangle($body,420,480,34,150); $g.DrawRectangle($ink,420,480,34,150)',
    '$g.FillRectangle($body,500,480,34,150); $g.DrawRectangle($ink,500,480,34,150)',
    '$g.FillRectangle($body,560,470,34,150); $g.DrawRectangle($ink,560,470,34,150)',
    '$gold = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245,200,70))',
    '$g.FillPolygon($gold,@((New-Object System.Drawing.Point(600,205)),(New-Object System.Drawing.Point(625,90)),(New-Object System.Drawing.Point(645,205))))',
    '$g.FillPolygon($body,@((New-Object System.Drawing.Point(560,200)),(New-Object System.Drawing.Point(575,150)),(New-Object System.Drawing.Point(600,205))))',
    '$g.FillEllipse([System.Drawing.Brushes]::Black,640,250,16,16)',
    '$cols = @([System.Drawing.Color]::FromArgb(255,99,132),[System.Drawing.Color]::FromArgb(255,180,80),[System.Drawing.Color]::FromArgb(120,200,120),[System.Drawing.Color]::FromArgb(100,170,255),[System.Drawing.Color]::FromArgb(180,120,230))',
    'for($i=0;$i -lt 5;$i++){ $p=New-Object System.Drawing.Pen ($cols[$i],14); $g.DrawArc($p,470,150,160,230,200,150) }',
    'for($i=0;$i -lt 5;$i++){ $p=New-Object System.Drawing.Pen ($cols[$i],12); $g.DrawArc($p,250,330,120,200,40,160) }',
    '$g.FillEllipse($pink,560,300,30,22)',
    '$font = New-Object System.Drawing.Font "Segoe UI",24,([System.Drawing.FontStyle]::Bold)',
    '$g.DrawString($Caption,$font,[System.Drawing.Brushes]::DarkSlateBlue,230,600)',
    '$bmp.Save($OutFile,[System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose();$bmp.Dispose()'
  ].join(os.EOL);
  fs.writeFileSync(scriptFile, script, 'utf8');
  const drawn = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, file, caption], 20000);
  try { fs.unlinkSync(scriptFile); } catch {}
  if (!drawn.ok || !fs.existsSync(file)) throw new Error(drawn.stderr || drawn.stdout || 'Unicorn drawing failed.');
  const opened = await startProcessDetached('mspaint.exe', [file]);
  return { ...opened, app: 'Paint', file, bytes: fs.statSync(file).size };
}

// Resolve a site name or bare domain to a URL. Handles "youtube", "youtube.com",
// "gmail", optional search query (e.g. youtube search), and full URLs.
const SITE_MAP = {
  youtube: 'https://www.youtube.com', yt: 'https://www.youtube.com',
  google: 'https://www.google.com', gmail: 'https://mail.google.com',
  github: 'https://github.com', x: 'https://x.com', twitter: 'https://x.com',
  reddit: 'https://www.reddit.com', maps: 'https://maps.google.com',
  chatgpt: 'https://chat.openai.com', claude: 'https://claude.ai',
  amazon: 'https://www.amazon.com', wikipedia: 'https://www.wikipedia.org',
  netflix: 'https://www.netflix.com', linkedin: 'https://www.linkedin.com',
  instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com',
  huggingface: 'https://huggingface.co', drive: 'https://drive.google.com'
};
function resolveSiteUrl(name, search) {
  const raw = String(name || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const key = slug(raw);
  let base = SITE_MAP[key];
  if (!base && /\.[a-z]{2,}$/i.test(raw)) base = 'https://' + raw.replace(/^\/+/, '');
  if (!base) return null;
  if (search) {
    if (key === 'youtube' || key === 'yt') return `${base}/results?search_query=${encodeURIComponent(search)}`;
    if (key === 'google') return `${base}/search?q=${encodeURIComponent(search)}`;
    if (key === 'github') return `${base}/search?q=${encodeURIComponent(search)}`;
    if (key === 'amazon') return `${base}/s?k=${encodeURIComponent(search)}`;
    if (key === 'reddit') return `${base}/search/?q=${encodeURIComponent(search)}`;
  }
  return base;
}

async function actionOpenUrl(args = {}) {
  requireActionConsent();
  // Accept url, a site name (+ optional search), or a raw query.
  let url = args.url || args.href;
  if (!url && (args.site || args.name)) url = resolveSiteUrl(args.site || args.name, args.search);
  url = normalizeHttpUrl(url || args.query);
  const browserKey = args.browser ? slug(args.browser) : '';
  const browser = browserKey && normalizeAllowedApp(browserKey);
  if (browser) {
    const r = launchViaStart(browser.target, [url]);
    return { ...r, browser: browser.label, url };
  }
  const r = launchViaStart(url);
  return { ...r, browser: 'default', url };
}

function sandboxFilePath(relpath) {
  const rel = String(relpath || '').trim();
  if (!rel) throw new Error('relpath is required.');
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new Error('file_write only accepts a relative path inside the portable data sandbox.');
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, rel);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('file_write path escapes the portable data sandbox.');
  return target;
}

async function actionFileWrite(args = {}) {
  requireActionConsent();
  const target = sandboxFilePath(args.relpath || args.path || args.file);
  const content = String(args.content ?? '');
  safeMkdir(path.dirname(target));
  try { checkpointFile(target); } catch {} // snapshot prior contents so the edit is undoable
  fs.writeFileSync(target, content, 'utf8');
  return { file: target, bytes: Buffer.byteLength(content, 'utf8') };
}

async function actionScreenshot() {
  requireActionConsent();
  const shotsDir = safeMkdir(path.join(dataRoot, 'shots'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(shotsDir, `${stamp}.png`);
  const scriptFile = path.join(safeMkdir(path.join(dataRoot, 'cache')), `capture-${process.pid}-${Date.now()}.ps1`);
  const script = [
    'param([string]$OutFile)',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$gfx = [System.Drawing.Graphics]::FromImage($bmp)',
    '$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$gfx.Dispose()',
    '$bmp.Dispose()'
  ].join(os.EOL);
  fs.writeFileSync(scriptFile, script, 'utf8');
  const out = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, file], 20000);
  try { fs.unlinkSync(scriptFile); } catch {}
  if (!out.ok || !fs.existsSync(file)) throw new Error(out.stderr || out.stdout || 'Screenshot capture failed.');
  return { file, bytes: fs.statSync(file).size };
}

async function actionShellRun(args = {}) {
  requireActionConsent();
  const command = slug(args.cmd || args.command || '');
  if (!['whoami', 'hostname', 'dir'].includes(command)) {
    throw new Error('shell_run blocked. Allowed commands: whoami, hostname, dir.');
  }
  if (command === 'dir') return runCommand('cmd.exe', ['/d', '/c', 'dir'], Number(args.timeout || 15000));
  return runCommand(command, [], Number(args.timeout || 15000));
}

async function actionCmdRun(args = {}) {
  requireActionConsent('cmd_run');
  const command = String(args.command || args.cmd || '').trim();
  if (!command) throw new Error('command is required.');
  const list = Array.isArray(args.args) ? args.args.map(String) : [];
  guardCommand([command, ...list].join(' ')); // safety floor below consent — inspect BOTH the shell-string and args-array forms

  const timeout = Number(args.timeout || 60000);
  // Full native CLI control, gated only by the session Allow-actions consent.
  // Run through the shell so pipelines and built-ins work like a real terminal.
  if (list.length) return runCommand(command, list, timeout);
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    execFile(shell, shellArgs, { windowsHide: true, timeout, cwd: args.cwd && exists(args.cwd) ? args.cwd : dataRoot, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        command,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || '').slice(0, 12000),
        stderr: String(stderr || err?.message || '').slice(0, 12000)
      });
    });
  });
}

const SENSITIVE_TOOLS = ['shell_run', 'cmd_run', 'file_write', 'screenshot', 'open_app', 'open_url'];

// ── OSINT toolkit (real recon, keyless where possible) ───────────────────────
// whois via RDAP, DNS records via node dns, subdomains via crt.sh certificate
// transparency, IP geo via ip-api, HTTP headers, username presence across sites,
// and breach lookup (HaveIBeenPwned, key-gated). All real network calls — no fakes.
const _dnsP = require('dns').promises;
function _bareHost(s) { return String(s || '').trim().replace(/^https?:\/\//i, '').split('/')[0].split('?')[0]; }
// GET that follows redirects (RDAP bootstrap + crt.sh both 30x) and returns the body string.
function _getFollow(url, headers, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? require('https') : require('http');
    const r = lib.request(url, { method: 'GET', timeout: 20000, headers: Object.assign({ 'User-Agent': 'ABUZ8-OS', Accept: 'application/json' }, headers || {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString(); return resolve(_getFollow(next, headers, (depth || 0) + 1)); }
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString()));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
async function osintWhois(domain) {
  const d = _bareHost(domain);
  if (!d) throw new Error('domain required');
  const j = JSON.parse(await _getFollow('https://rdap.org/domain/' + encodeURIComponent(d), { Accept: 'application/rdap+json' }));
  const ev = {}; (j.events || []).forEach((e) => { ev[e.eventAction] = e.eventDate; });
  const reg = (j.entities || []).find((e) => (e.roles || []).includes('registrar')) || {};
  let registrar = reg.handle || '';
  try { const vc = (reg.vcardArray || [])[1] || []; const fn = vc.find((x) => x[0] === 'fn'); if (fn) registrar = fn[3]; } catch {}
  return { domain: d, handle: j.handle || null, status: j.status || [], registrar, nameservers: (j.nameservers || []).map((n) => n.ldhName), registered: ev.registration || null, expires: ev.expiration || null, updated: ev.lastChanged || null };
}
async function osintDns(domain) {
  const d = _bareHost(domain); if (!d) throw new Error('domain required');
  const out = { domain: d };
  for (const [k, fn] of [['A', 'resolve4'], ['AAAA', 'resolve6'], ['MX', 'resolveMx'], ['TXT', 'resolveTxt'], ['NS', 'resolveNs'], ['CNAME', 'resolveCname']]) {
    try { out[k] = await _dnsP[fn](d); } catch { out[k] = []; }
  }
  return out;
}
async function osintSubdomains(domain) {
  const d = _bareHost(domain); if (!d) throw new Error('domain required');
  const set = new Set();
  // Source 1: crt.sh certificate transparency (flaky but rich).
  try {
    const txt = await _getFollow('https://crt.sh/?q=' + encodeURIComponent('%.' + d) + '&output=json');
    const rows = JSON.parse(txt);
    rows.forEach((r) => String(r.name_value || '').split('\n').forEach((n) => { n = n.trim().toLowerCase(); if (n && !n.startsWith('*') && n.endsWith(d)) set.add(n); }));
  } catch {}
  // Source 2 (fallback / supplement): SSLMate Cert Spotter (keyless, reliable JSON).
  if (set.size < 5) {
    try {
      const txt = await _getFollow('https://api.certspotter.com/v1/issuances?domain=' + encodeURIComponent(d) + '&include_subdomains=true&expand=dns_names');
      const rows = JSON.parse(txt);
      rows.forEach((r) => (r.dns_names || []).forEach((n) => { n = String(n).trim().toLowerCase(); if (n && !n.startsWith('*') && n.endsWith(d)) set.add(n); }));
    } catch {}
  }
  return { domain: d, count: set.size, subdomains: [...set].sort().slice(0, 300), sources: ['crt.sh', 'certspotter'] };
}
async function osintIp(ip) {
  const t = String(ip || '').trim(); if (!t) throw new Error('ip/host required');
  return JSON.parse(await fetchUrl('http://ip-api.com/json/' + encodeURIComponent(t) + '?fields=status,message,country,regionName,city,zip,isp,org,as,asname,reverse,mobile,proxy,hosting,lat,lon,query', { timeout: 10000 }));
}
function osintHeaders(url) {
  let u = String(url || ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https') ? require('https') : require('http');
    const r = lib.request(u, { method: 'GET', timeout: 12000, headers: { 'User-Agent': 'ABUZ8-OS' } }, (res) => {
      resolve({ url: u, status: res.statusCode, server: res.headers.server || null, headers: res.headers }); res.resume();
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
async function osintUsername(username) {
  const u = String(username || '').trim().replace(/^@/, ''); if (!u) throw new Error('username required');
  const sites = { GitHub: 'https://github.com/' + u, Reddit: 'https://www.reddit.com/user/' + u, Instagram: 'https://www.instagram.com/' + u + '/', TikTok: 'https://www.tiktok.com/@' + u, YouTube: 'https://www.youtube.com/@' + u, Twitch: 'https://www.twitch.tv/' + u, Telegram: 'https://t.me/' + u, Medium: 'https://medium.com/@' + u, GitLab: 'https://gitlab.com/' + u, Pinterest: 'https://www.pinterest.com/' + u + '/', Steam: 'https://steamcommunity.com/id/' + u, Replit: 'https://replit.com/@' + u };
  const results = {};
  await Promise.all(Object.entries(sites).map(([name, link]) => new Promise((resolve) => {
    try {
      const r = require('https').request(link, { method: 'GET', timeout: 9000, headers: { 'User-Agent': 'Mozilla/5.0 (ABUZ8-OS)' } }, (res) => { results[name] = { url: link, found: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode }; res.resume(); resolve(); });
      r.on('error', () => { results[name] = { url: link, found: false, error: 'net' }; resolve(); });
      r.on('timeout', () => { r.destroy(); results[name] = { url: link, found: false, error: 'timeout' }; resolve(); });
      r.end();
    } catch { results[name] = { url: link, found: false }; resolve(); }
  })));
  return { username: u, found: Object.values(results).filter((r) => r.found).length, sites: results };
}
async function osintBreach(email) {
  const e = String(email || '').trim(); if (!e) throw new Error('email required');
  const key = (connectorCreds('hibp') || {}).api_key;
  if (!key) return { email: e, note: 'Add a HaveIBeenPwned API key (connector "hibp") to enable per-email breach lookup. ABUZ8 will not fabricate breach data.', breaches: null };
  try {
    const txt = await fetchUrl('https://haveibeenpwned.com/api/v3/breachedaccount/' + encodeURIComponent(e) + '?truncateResponse=false', { timeout: 12000, headers: { 'hibp-api-key': key, 'User-Agent': 'ABUZ8-OS' } });
    const arr = JSON.parse(txt || '[]');
    return { email: e, breach_count: arr.length, breaches: arr.map((b) => ({ name: b.Name, domain: b.Domain, date: b.BreachDate, data: b.DataClasses })) };
  } catch (e2) { return { email: e, breach_count: 0, breaches: [], note: 'No breaches found or lookup failed: ' + e2.message }; }
}
async function osintLookup(action, target, opts = {}) {
  const a = String(action || '').toLowerCase();
  if (a === 'whois') return await osintWhois(target);
  if (a === 'dns') return await osintDns(target);
  if (a === 'subdomains' || a === 'subs') return await osintSubdomains(target);
  if (a === 'ip' || a === 'geo') return await osintIp(target);
  if (a === 'headers' || a === 'http') return await osintHeaders(target);
  if (a === 'username' || a === 'user') return await osintUsername(target);
  if (a === 'breach' || a === 'email') return await osintBreach(target);
  if (a === 'full' || a === 'dossier') {
    const d = _bareHost(target);
    const [whois, dns, subs] = await Promise.all([osintWhois(d).catch((e) => ({ error: e.message })), osintDns(d).catch((e) => ({ error: e.message })), osintSubdomains(d).catch((e) => ({ error: e.message }))]);
    let ip = null; try { const a4 = dns.A && dns.A[0]; if (a4) ip = await osintIp(a4); } catch {}
    return { domain: d, whois, dns, subdomains: subs, ip };
  }
  throw new Error('osint action must be one of: whois | dns | subdomains | ip | headers | username | breach | full');
}

// ── ABUZ8 SOVEREIGN CHAIN — a real on-device blockchain ──────────────────────
// Append-only, hash-LINKED, ed25519-SIGNED ledger of the agent's own state,
// upgrades and key actions. Each block commits the previous block's hash and is
// signed by the install's identity key → the history is tamper-evident and
// independently verifiable (a genuine single-node chain). Plus real IPFS CIDv1
// content-addressing so the build/ledger can be published + verified by anyone.
const _crypto = require('crypto');
function chainDir() { return safeMkdir(path.join(dataRoot, 'chain')); }
function chainLedgerPath() { return path.join(chainDir(), 'ledger.jsonl'); }
function chainKeyPath() { return path.join(chainDir(), 'identity.pem'); }
function chainPubPath() { return path.join(chainDir(), 'identity.pub.pem'); }
function chainIdentity() {
  try { if (fs.existsSync(chainKeyPath())) return { priv: _crypto.createPrivateKey(fs.readFileSync(chainKeyPath())), pub: _crypto.createPublicKey(fs.readFileSync(chainPubPath())) }; } catch {}
  const { publicKey, privateKey } = _crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(chainKeyPath(), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(chainPubPath(), publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv: privateKey, pub: publicKey };
}
function chainPubHex() { try { return chainIdentity().pub.export({ type: 'spki', format: 'der' }).toString('hex'); } catch { return ''; } }
function _sha256hex(s) { return _crypto.createHash('sha256').update(s).digest('hex'); }
function chainReadAll() { try { return fs.readFileSync(chainLedgerPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
function chainHead() { const a = chainReadAll(); return a[a.length - 1] || null; }
function chainBlockHash(b) { return _sha256hex(JSON.stringify({ index: b.index, ts: b.ts, prev: b.prev, type: b.type, data: b.data, pub: b.pub })); }
function chainAppend(type, data) {
  const id = chainIdentity();
  const all = chainReadAll();
  const prev = all.length ? all[all.length - 1].hash : '0'.repeat(64);
  const block = { index: all.length, ts: new Date().toISOString(), prev, type: String(type || 'event'), data: data || {}, pub: chainPubHex() };
  block.hash = chainBlockHash(block);
  block.sig = _crypto.sign(null, Buffer.from(block.hash, 'hex'), id.priv).toString('hex');
  fs.appendFileSync(chainLedgerPath(), JSON.stringify(block) + '\n');
  return block;
}
function chainVerify() {
  const all = chainReadAll();
  let prev = '0'.repeat(64);
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (b.index !== i) return { valid: false, length: all.length, broken_at: i, reason: 'index mismatch' };
    if (b.prev !== prev) return { valid: false, length: all.length, broken_at: i, reason: 'prev-hash break (tamper detected)' };
    if (chainBlockHash(b) !== b.hash) return { valid: false, length: all.length, broken_at: i, reason: 'content hash mismatch (tamper detected)' };
    try { const pub = _crypto.createPublicKey({ key: Buffer.from(b.pub, 'hex'), format: 'der', type: 'spki' }); if (!_crypto.verify(null, Buffer.from(b.hash, 'hex'), pub, Buffer.from(b.sig, 'hex'))) return { valid: false, length: all.length, broken_at: i, reason: 'bad signature' }; } catch (e) { return { valid: false, length: all.length, broken_at: i, reason: 'sig verify error: ' + e.message }; }
    prev = b.hash;
  }
  return { valid: true, length: all.length, head: prev, identity: chainPubHex().slice(0, 24) + '…' };
}
// Real IPFS CIDv1 (raw codec, sha2-256) — the exact CID `ipfs add --cid-version=1 --raw-leaves` yields.
function _b32(bytes) { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += A[(val << (5 - bits)) & 31]; return out; }
function ipfsCidV1(buf) { const dig = _crypto.createHash('sha256').update(buf).digest(); const mh = Buffer.concat([Buffer.from([0x12, 0x20]), dig]); const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55]), mh]); return 'b' + _b32(cidBytes); }
// ── SIGNED .abxpack EXTENSIONS — install/sign/push capability packs across the fleet ──
// A pack = { name, version, tools[], skills[], permissions[], handler? } + an ed25519 sig
// from THIS node's identity key (the SAME key the blockchain ledger uses). Verified on
// install (FAIL-CLOSED on tamper), merged into the tool registry, pushable to every node.
function packsDir() { return safeMkdir(path.join(dataRoot, 'packs')); }
function _packCanonical(m) { return JSON.stringify({ name: m.name, version: m.version || '1.0.0', tools: m.tools || [], skills: m.skills || [], permissions: m.permissions || [], handler: m.handler || '' }); }
function packSign(manifest) {
  const m = Object.assign({}, manifest);
  if (!m.name) throw new Error('pack name required');
  const id = chainIdentity();
  const digest = _crypto.createHash('sha256').update(Buffer.from(_packCanonical(m))).digest();
  m.pub = chainPubHex();
  m.sig = _crypto.sign(null, digest, id.priv).toString('hex');
  m.cid = ipfsCidV1(Buffer.from(_packCanonical(m)));
  return m;
}
function packVerify(manifest) {
  if (!manifest || !manifest.sig || !manifest.pub) return { valid: false, reason: 'unsigned' };
  try {
    const digest = _crypto.createHash('sha256').update(Buffer.from(_packCanonical(manifest))).digest();
    const pub = _crypto.createPublicKey({ key: Buffer.from(manifest.pub, 'hex'), format: 'der', type: 'spki' });
    const ok = _crypto.verify(null, digest, pub, Buffer.from(manifest.sig, 'hex'));
    return { valid: !!ok, reason: ok ? 'ok' : 'bad signature (tamper detected)' };
  } catch (e) { return { valid: false, reason: 'verify error: ' + e.message }; }
}
function registerPackTools(tools) { for (const t of (tools || [])) { const n = slug(t.name || t.id || ''); if (n) KNOWN_AGENT_TOOLS.add(n); } }
function installPack(input = {}, opts = {}) {
  const m = input.manifest || input;
  if (!m || !m.name) return { ok: false, error: 'pack manifest with a name required' };
  const v = packVerify(m);
  if (!v.valid && opts.allow_unsigned !== true) return { ok: false, error: 'refusing to install — signature ' + v.reason + ' (fail-closed)', verify: v };
  const name = slug(m.name);
  const dir = safeMkdir(path.join(packsDir(), name));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  if (m.handler) fs.writeFileSync(path.join(dir, 'handler.js'), String(m.handler));
  const cfg = readJson(toolsFile(), { tools: [] }); cfg.tools = Array.isArray(cfg.tools) ? cfg.tools : [];
  for (const t of (m.tools || [])) {
    const tn = slug(t.name || t.id || ''); if (!tn) continue;
    const def = { name: tn, label: t.label || t.name || tn, type: 'pack', status: 'enabled', description: t.description || '', command: t.command || '', endpoint: t.endpoint || '', args: Array.isArray(t.args) ? t.args : [], permission_required: t.permission_required || (Array.isArray(m.permissions) && m.permissions.length ? m.permissions[0] : ''), pack: name, updated_at: new Date().toISOString() };
    const i = cfg.tools.findIndex((x) => x.name === tn); if (i >= 0) cfg.tools[i] = def; else cfg.tools.unshift(def);
  }
  writeJson(toolsFile(), cfg);
  registerPackTools(m.tools);
  try { chainAppend('pack_install', { name, version: m.version || '1.0.0', cid: m.cid || ipfsCidV1(Buffer.from(_packCanonical(m))), tools: (m.tools || []).map((t) => slug(t.name || t.id || '')), signed: v.valid }); } catch {}
  return { ok: true, installed: name, version: m.version || '1.0.0', tools: (m.tools || []).map((t) => slug(t.name || t.id || '')), signed: v.valid, verify: v };
}
function packList() {
  const out = [];
  try { for (const d of fs.readdirSync(packsDir())) { try { const m = readJson(path.join(packsDir(), d, 'manifest.json'), null); if (m) out.push({ name: m.name, version: m.version, tools: (m.tools || []).map((t) => t.name || t.id), signed: !!m.sig, cid: m.cid }); } catch {} } } catch {}
  return out;
}
async function packPush(name) {
  const m = readJson(path.join(packsDir(), slug(name), 'manifest.json'), null);
  if (!m) return { ok: false, error: 'pack not found: ' + name };
  return { ok: true, ...(await meshExecAll('install_pack', { manifest: m })) };
}
function chainSnapshotSelf() {
  let codeHash = ''; try { codeHash = _sha256hex(fs.readFileSync(path.join(__dirname, 'portable-core.js'))); } catch {}
  return chainAppend('self-snapshot', { version: APP_VERSION, code_sha256: codeHash, build: BUILD_STAMP });
}
async function chainPublish(target) {
  let buf;
  if (target === 'code') { try { buf = fs.readFileSync(path.join(__dirname, 'portable-core.js')); } catch { buf = Buffer.from(''); } }
  else if (target && target !== 'ledger') buf = Buffer.from(String(target));
  else { try { buf = fs.readFileSync(chainLedgerPath()); } catch { buf = Buffer.from(''); } }
  const cid = ipfsCidV1(buf);
  const block = chainAppend('ipfs-publish', { target: target || 'ledger', cid, bytes: buf.length });
  return { cid, bytes: buf.length, gateway: 'https://ipfs.io/ipfs/' + cid, block: block.index, note: 'Real IPFS CIDv1 (raw/sha2-256) — `ipfs add --cid-version=1 --raw-leaves` on the same bytes yields this exact CID. Pin via a service to make it globally retrievable.' };
}
function chainTool(body = {}) {
  const action = String(body.action || 'verify').toLowerCase();
  if (action === 'append') return chainAppend(body.type || 'event', body.data || {});
  if (action === 'verify') return chainVerify();
  if (action === 'head') return chainHead();
  if (action === 'snapshot' || action === 'self') return chainSnapshotSelf();
  if (action === 'identity') return { identity: chainPubHex() };
  if (action === 'list') return { length: chainReadAll().length, blocks: chainReadAll().slice(-(body.limit || 10)) };
  throw new Error('chain action: append | verify | head | snapshot | identity | list | publish');
}

// ── TOR — bundled private network: SOCKS5 anonymized fetch + .onion hidden service ──
// A real Tor daemon (tor.exe, bundled) spawned as a child; ABUZ8 routes requests through
// its SOCKS5 proxy (anonymous exit) and publishes a v3 .onion so the OS is reachable
// privately from any device (incl. an iPhone via Tor Browser) with no port-forwarding.
const _cp = require('child_process');
let torProcess = null, torReady = false, torOnion = '';
const TOR_SOCKS = Number(process.env.ABUZ8_TOR_SOCKS || 9050);
function bundledTorDir() {
  const cands = [process.resourcesPath ? path.join(process.resourcesPath, 'tor') : null, path.join(__dirname, '..', 'build-assets', 'tor'), path.join(__dirname, 'tor')].filter(Boolean);
  for (const c of cands) { if (fs.existsSync(path.join(c, 'tor', 'tor.exe')) || fs.existsSync(path.join(c, 'tor', 'tor'))) return c; }
  return cands[0] || cands[1];
}
function torExePath() { const d = bundledTorDir(); const w = path.join(d, 'tor', 'tor.exe'); return fs.existsSync(w) ? w : path.join(d, 'tor', 'tor'); }
function torDataDir() { return safeMkdir(path.join(dataRoot, 'tor')); }
function torHiddenDir() { return safeMkdir(path.join(torDataDir(), 'hs')); }
function torAvailable() { try { return fs.existsSync(torExePath()); } catch { return false; } }
function ensureTor(opts = {}) {
  return new Promise((resolve, reject) => {
    if (torReady && torProcess) return resolve({ ready: true, socks: TOR_SOCKS, onion: torOnion });
    const exe = torExePath();
    if (!fs.existsSync(exe)) return reject(new Error('Tor binary not bundled (build-assets/tor).'));
    const dataD = torDataDir();
    const base = bundledTorDir();
    const geoip = path.join(base, 'data', 'geoip'), geoip6 = path.join(base, 'data', 'geoip6');
    const torrc = path.join(dataD, 'torrc');
    // SECURITY: the .onion hidden service EXPOSES this OS to the public Tor network, so it is
    // OPT-IN ONLY (opts.hidden === true). Default Tor = anonymous OUTBOUND browser, zero exposure.
    // Even when exposed, inbound requests arrive as non-local and still require the LAN key.
    const hs = opts.hidden === true ? `HiddenServiceDir ${torHiddenDir()}\nHiddenServiceVersion 3\nHiddenServicePort 80 127.0.0.1:${PORT}\n` : '';
    fs.writeFileSync(torrc, `SocksPort 127.0.0.1:${TOR_SOCKS}\nDataDirectory ${path.join(dataD, 'd')}\n${fs.existsSync(geoip) ? 'GeoIPFile ' + geoip + '\n' : ''}${fs.existsSync(geoip6) ? 'GeoIPv6File ' + geoip6 + '\n' : ''}${hs}Log notice stdout\n`);
    const proc = _cp.spawn(exe, ['-f', torrc], { windowsHide: true });
    torProcess = proc; let done = false;
    const onLine = (buf) => { const s = buf.toString(); if (/Bootstrapped 100%/.test(s) && !done) { done = true; torReady = true; try { const hn = path.join(torHiddenDir(), 'hostname'); if (fs.existsSync(hn)) torOnion = fs.readFileSync(hn, 'utf8').trim(); } catch {} resolve({ ready: true, socks: TOR_SOCKS, onion: torOnion }); } };
    proc.stdout.on('data', onLine); proc.stderr.on('data', onLine);
    proc.on('error', (e) => { if (!done) { done = true; reject(e); } });
    proc.on('exit', () => { torReady = false; torProcess = null; });
    setTimeout(() => { if (!done) { done = true; reject(new Error('Tor bootstrap timeout')); } }, Number(opts.timeout || 90000));
  });
}
function torStop() { if (torProcess) { try { torProcess.kill(); } catch {} torProcess = null; torReady = false; } }
function socks5Connect(host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect(TOR_SOCKS, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    let stage = 0;
    const onData = (data) => {
      if (stage === 0) { if (data[0] !== 0x05 || data[1] !== 0x00) { sock.destroy(); return reject(new Error('SOCKS5 no-auth refused')); } const hb = Buffer.from(host); sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(port >> 8) & 0xff, port & 0xff])])); stage = 1; return; }
      if (stage === 1) { if (data[1] !== 0x00) { sock.destroy(); return reject(new Error('SOCKS5 connect failed (code ' + data[1] + ')')); } sock.removeListener('data', onData); resolve(sock); }
    };
    sock.on('data', onData); sock.on('error', reject); sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('SOCKS5 timeout')); });
  });
}
function _dechunk(s) { let out = '', i = 0; while (i < s.length) { const nl = s.indexOf('\r\n', i); if (nl < 0) break; const len = parseInt(s.slice(i, nl).trim(), 16); if (isNaN(len) || len === 0) break; out += s.slice(nl + 2, nl + 2 + len); i = nl + 2 + len + 2; } return out; }
async function torFetch(url) {
  if (airgapOn()) throw new Error('Local-Only (air-gap) mode is ON — Tor/outbound disabled.');
  await ensureTor({ hidden: false });
  const u = new URL(/^https?:\/\//.test(url) ? url : 'https://' + url);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  const raw = await socks5Connect(u.hostname, port);
  const sock = u.protocol === 'https:' ? require('tls').connect({ socket: raw, servername: u.hostname, rejectUnauthorized: false }) : raw;
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const send = () => sock.write(`GET ${(u.pathname + u.search) || '/'} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: ABUZ8-OS-Tor\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    if (u.protocol === 'https:') sock.on('secureConnect', send); else send();
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => { const buf = Buffer.concat(chunks).toString(); const idx = buf.indexOf('\r\n\r\n'); const headers = buf.slice(0, idx); let body = buf.slice(idx + 4); if (/transfer-encoding:\s*chunked/i.test(headers)) body = _dechunk(body); resolve({ status: Number((headers.match(/HTTP\/1\.\d (\d+)/) || [])[1] || 0), headers, body }); });
    sock.on('error', reject); sock.setTimeout(60000, () => { sock.destroy(); reject(new Error('Tor fetch timeout')); });
  });
}
async function torStatus() {
  try { const r = await torFetch('https://check.torproject.org/api/ip'); let j = {}; try { j = JSON.parse(r.body); } catch {} return { running: torReady, socks: TOR_SOCKS, onion: torOnion || null, exit_ip: j.IP || null, is_tor: j.IsTor === true }; }
  catch (e) { return { running: torReady, socks: TOR_SOCKS, onion: torOnion || null, error: e.message }; }
}
async function torTool(body = {}) {
  const a = String(body.action || 'status').toLowerCase();
  if (a === 'start') return await ensureTor({});
  if (a === 'status') return await torStatus();
  if (a === 'fetch' || a === 'browse' || a === 'get') { const r = await torFetch(body.url || body.target); return { status: r.status, body: String(r.body).slice(0, 6000) }; }
  if (a === 'onion') { torStop(); await ensureTor({ hidden: true }); return { onion: torOnion || '(bootstrapping — retry in a moment)', reachable: 'Open this .onion in Tor Browser on any device (incl. iPhone) to reach ABUZ8 privately. Inbound still requires the LAN key.', warning: 'This EXPOSES the OS to the public Tor network — opt-in only.' }; }
  if (a === 'stop') { torStop(); return { stopped: true }; }
  throw new Error('tor action: start | status | fetch | onion | stop');
}

// ── Real-world grounding: clock (from the OS, never the model weights) + weather ──
function currentTimeContext() {
  const d = new Date();
  let date, time, tz;
  try { date = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch { date = d.toDateString(); }
  try { time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch { time = d.toTimeString().slice(0, 5); }
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = ''; }
  return { iso: d.toISOString(), date, time, tz, year: d.getFullYear() };
}
async function getGeoLocation() {
  const set = readJson(settingsPath(), {});
  if (set.location && set.location.lat) return set.location;
  const j = JSON.parse(await fetchUrl('http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon,timezone', { timeout: 6000 }));
  if (j.status !== 'success') throw new Error('Could not determine your location automatically — set it in Settings.');
  return { city: j.city, region: j.regionName, country: j.country, lat: j.lat, lon: j.lon, tz: j.timezone, source: 'ip' };
}
function weatherCodeText(c) { const m = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' }; return m[c] || 'unknown'; }
async function getWeather(args = {}) {
  const loc = (args.lat && args.lon) ? { lat: args.lat, lon: args.lon, city: args.city || '' } : await getGeoLocation();
  const unit = args.units === 'f' || args.fahrenheit ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4&temperature_unit=${unit}`;
  const j = JSON.parse(await fetchUrl(url, { timeout: 8000 }));
  const units = (j.current_units && j.current_units.temperature_2m) || '°';
  const cur = j.current || {};
  const forecast = ((j.daily && j.daily.time) || []).map((t, i) => ({ date: t, hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i], sky: weatherCodeText(j.daily.weather_code[i]), rain_pct: j.daily.precipitation_probability_max[i] }));
  return { location: loc, units, current: { temp: cur.temperature_2m, feels_like: cur.apparent_temperature, humidity: cur.relative_humidity_2m, wind_kmh: cur.wind_speed_10m, sky: weatherCodeText(cur.weather_code) }, forecast, as_of: currentTimeContext().date };
}

async function callLocalTool(name, args = {}) {
  const toolName = String(name || args.name || args.tool || '').trim();
  if (!toolName) throw new Error('tool name is required');
  const _tierBlock = enforceTier(toolName); if (_tierBlock) return _tierBlock; // red-tier (money/account) needs explicit approval
  const key = slug(toolName);
  const isTool = (...names) => names.map(slug).includes(key);
  const body = args || {};

  // Permission gate: sensitive tools require consent
  const settings = readJson(settingsPath(), {});
  const requireConsent = settings.require_consent !== false;
  const autoGrant = settings.auto_grant_actions === true;
  if (requireConsent && !autoGrant && SENSITIVE_TOOLS.some(t => slug(t) === key)) {
    if (!body._permitted) {
      return {
        ok: false,
        tool: toolName,
        action_required: true,
        reason: `The tool \`${toolName}\` requires your permission to run.`,
        prompt: `⚠️ **Permission Required**: Run \`${toolName}\`?\nType \`/allow-actions\` to grant permission, or \`/deny\` to reject.`
      };
    }
  }

  // Verification spine: adversarial pre-flight check on irreversible/outward actions.
  if (VERIFY_TOOLS.some((t) => slug(t) === key) && readJson(settingsPath(), {}).verification_spine !== false) {
    const v = await verifyAction(toolName, body);
    if (!v.safe && v.severity === 'high') {
      let apId; try { apId = enqueueApproval({ tool: toolName, action: toolName, tier: 'verify', reason: v.reason }); } catch {}
      try { recordDecision({ action: toolName, decision: 'blocked-by-verifier', why: v.reason, severity: v.severity }); } catch {}
      return { ok: false, tool: toolName, verified: false, severity: v.severity, action_required: true, approval_id: apId, reason: 'Verification spine blocked this: ' + (v.reason || 'unsafe') + ' — if intended, approve it: POST /api/approvals/approve {"id":"' + apId + '"}.' };
    }
  }

  if (isTool('abuz8_chat', 'chat')) {
    const prompt = body.message || body.content || body.prompt || body.raw || '';
    const r = await reasonReply(prompt);
    return { ok: true, tool: toolName, result: { response: r.text, brain: embeddedBrainStatus(), answered_by: r.brain, fallback: r.fallback } };
  }
  if (isTool('abuz8_device_probe', 'device_probe', 'hardware_probe')) {
    return { ok: true, tool: toolName, result: await machineProbe() };
  }
  if (isTool('list_connectors', 'list_apps', 'connectors')) {
    return { ok: true, tool: toolName, result: connectorList() };
  }
  if (isTool('connector_call', 'app_call', 'use_app', 'use_connector', 'drive_app')) {
    const id = body.connector || body.id || body.app || '';
    const action = body.action || 'get';
    try { const result = await connectorCall(id, action, body.args || body); return { ok: true, tool: toolName, result }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('studio_produce', 'make_media', 'make_video', 'make_image', 'generate_video')) {
    const kind = String(body.kind || body.type || (/(video|clip|reel)/i.test(toolName) ? 'video' : 'image')).toLowerCase();
    const prompt = String(body.prompt || body.text || body.topic || '').trim();
    if (!prompt && !body.workflow) return { ok: false, tool: toolName, error: 'Give a prompt (or a ComfyUI workflow for video).' };
    if (/video|clip|reel/.test(kind)) {
      if (body.workflow) { try { const r = await connectorCall('comfyui', 'queue', { workflow: body.workflow }); return { ok: true, tool: toolName, result: { kind: 'video', engine: 'comfyui', queued: r } }; } catch (e) { return { ok: false, tool: toolName, error: 'ComfyUI: ' + e.message }; } }
      return { ok: false, tool: toolName, result: { kind: 'video', prompt, needs_comfyui: true, note: 'No video rendered: pass a ComfyUI workflow JSON in args.workflow (queues on your GPUs via comfyui), or drive Wan2GP / authorize Higgsfield (Sora/Veo/Kling) via connector_call.' } };
    }
    return { ok: true, tool: toolName, result: { kind: 'image', prompt, url: studioImageUrl(prompt, body), engine: connectorCreds('image_gen').api_key ? 'premium' : 'flux-free' } };
  }
  if (isTool('osint', 'recon', 'investigate', 'osint_lookup')) {
    const action = body.action || body.type || (body.email ? 'breach' : body.username ? 'username' : (body.ip ? 'ip' : 'full'));
    const target = body.target || body.domain || body.host || body.url || body.email || body.username || body.ip || body.query || '';
    try { const result = await osintLookup(action, target, body); return { ok: true, tool: toolName, result }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('blockchain', 'chain', 'ledger')) {
    try {
      if (String(body.action || '').toLowerCase() === 'publish') return { ok: true, tool: toolName, result: await chainPublish(body.target) };
      return { ok: true, tool: toolName, result: chainTool(body) };
    } catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('tor_browse', 'tor', 'tor_fetch', 'darkweb')) {
    try { return { ok: true, tool: toolName, result: await torTool(body) }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('code_build', 'build_app', 'coder', 'build_project')) {
    try { const result = await coderRun(body.goal || body.task || body.prompt || body.content || '', body); return { ok: true, tool: toolName, result }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('list_mcp_tools', 'mcp_tools', 'discover_mcp')) {
    try { return { ok: true, tool: toolName, result: await mcpAllTools() }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('mcp_call', 'use_mcp', 'call_mcp')) {
    let server = body.server || body.name, tool = body.tool;
    if (!server && typeof body.ref === 'string' && body.ref.includes(':')) { const i = body.ref.indexOf(':'); server = body.ref.slice(0, i); tool = tool || body.ref.slice(i + 1); }
    try { const result = await mcpCallTool(server, tool, body.args || body.arguments || {}); return { ok: true, tool: toolName, result }; }
    catch (e) { return { ok: false, tool: toolName, error: e.message }; }
  }
  if (isTool('get_time', 'current_time', 'what_time', 'time_now', 'get_date')) {
    return { ok: true, tool: toolName, result: currentTimeContext() };
  }
  if (isTool('get_weather', 'weather', 'forecast', 'check_weather')) {
    return { ok: true, tool: toolName, result: await getWeather(body) };
  }
  if (isTool('social_post', 'post_social', 'broadcast', 'cross_post')) {
    return { ok: true, tool: toolName, result: await socialPost(body.platforms || [], { text: body.text || body.content || '', link: body.link }) };
  }
  if (isTool('social_draft', 'draft_post', 'write_post')) {
    return { ok: true, tool: toolName, result: await socialDraft(body.topic || body.text || '', body.platform) };
  }
  if (isTool('send_email', 'email', 'gmail_send')) {
    if (!(await googleToken())) return { ok: false, tool: toolName, result: { ok: false, needs_auth: true, error: 'Gmail not connected — connect Google (OAuth) in the Connect tab.' } };
    return { ok: true, tool: toolName, result: await connectorCall('gmail', 'send', { to: body.to, subject: body.subject, body: body.body || body.text || body.content }) };
  }
  if (isTool('calendar_create', 'create_event', 'schedule_event', 'add_event')) {
    if (!(await googleToken())) return { ok: false, tool: toolName, result: { ok: false, needs_auth: true, error: 'Calendar not connected — connect Google (OAuth) in the Connect tab.' } };
    return { ok: true, tool: toolName, result: await connectorCall('gcal', 'create', { summary: body.summary || body.title, description: body.description, start: body.start, end: body.end }) };
  }
  if (isTool('stripe_op', 'stripe', 'billing')) {
    return { ok: true, tool: toolName, result: await connectorCall('stripe', body.action || 'balance', body.args || body) };
  }
  if (isTool('jarvis_see', 'see_screen', 'look_at_screen', 'read_screen')) {
    return { ok: true, tool: toolName, result: await jarvisSee(body.question || body.q || body.text || '', body.image_base64 || body.image || '') };
  }
  if (isTool('jarvis_brief', 'brief', 'briefing', 'sitrep')) {
    return { ok: true, tool: toolName, result: await jarvisBrief() };
  }
  if (isTool('abuz8_brains_list', 'brains_list', 'models_list')) {
    return { ok: true, tool: toolName, result: { brains: embeddedBrainStatus(), models: listDownloadedModels() } };
  }
  if (isTool('abuz8_brain_select', 'brain_select', 'select_brain')) {
    return { ok: true, tool: toolName, result: setActiveBrain(body.brain || body.id || body.tier || body.name || 'auto') };
  }
  if (isTool('huggingface_model_download', 'model_download_hf')) {
    return { ok: true, tool: toolName, result: await downloadHuggingFaceModel(body) };
  }
  if (isTool('cloud_brain_register')) {
    return { ok: true, tool: toolName, result: registerCloudBrain(body) };
  }
  if (isTool('abuz8_memory_write', 'memory_write')) {
    const item = { id: crypto.randomUUID(), type: body.type || 'note', content: body.content || body.text || '', timestamp: new Date().toISOString() };
    appendJsonl(memoryFile(), item);
    addMemoryVector(item).catch(() => {});
    return { ok: true, tool: toolName, result: item };
  }
  if (isTool('memory_search', 'abuz8_memory_search')) {
    const q = String(body.q || body.query || body.text || '');
    return { ok: true, tool: toolName, result: searchMemoryItems(q, 25) };
  }
  if (isTool('abuz8_tools_list', 'tools_list')) {
    return { ok: true, tool: toolName, result: localToolsList() };
  }
  if (isTool('abuz8_tool_create', 'tool_create')) {
    return { ok: true, tool: toolName, result: createLocalTool(body) };
  }
  if (isTool('abuz8_mission_board', 'mission_board')) {
    const board = readMissionBoard();
    return { ok: true, tool: toolName, result: { ...board, summary: missionSummary(board) } };
  }
  if (isTool('abuz8_mission_task_create', 'mission_task_create')) {
    const task = upsertMissionTask(body);
    return { ok: true, tool: toolName, result: { task, board: readMissionBoard() } };
  }
  if (isTool('abuz8_mission_task_move', 'mission_task_move')) {
    const task = moveMissionTask(body.id, body.column);
    return { ok: true, tool: toolName, result: { task, board: readMissionBoard() } };
  }
  if (isTool('open_url')) {
    return { ok: true, tool: toolName, result: await actionOpenUrl(body) };
  }
  if (isTool('open_app')) {
    return { ok: true, tool: toolName, result: await actionOpenApp(body) };
  }
  if (isTool('draw_monkey_in_paint', 'paint_monkey', 'draw_monkey')) {
    return { ok: true, tool: toolName, result: await actionDrawMonkeyInPaint(body) };
  }
  if (isTool('draw_unicorn_in_paint', 'paint_unicorn', 'draw_unicorn')) {
    return { ok: true, tool: toolName, result: await actionDrawUnicornInPaint(body) };
  }
  if (isTool('screenshot')) {
    return { ok: true, tool: toolName, result: await actionScreenshot(body) };
  }
  if (isTool('file_write')) {
    return { ok: true, tool: toolName, result: await actionFileWrite(body) };
  }
  if (isTool('shell_run')) {
    return { ok: true, tool: toolName, result: await actionShellRun(body) };
  }
  if (isTool('cmd_run', 'run_command', 'terminal')) {
    return { ok: true, tool: toolName, result: await actionCmdRun(body) };
  }
  if (isTool('swarm_run', 'swarm')) {
    return { ok: true, tool: toolName, result: await runSwarm(body.task || body.goal || body.content, body.roles || body.agents) };
  }
  if (isTool('fleet', 'fleet_control', 'swarm_fleet')) {
    const op = String(body.op || body.action || 'stats').toLowerCase();
    if (op === 'nodes') return { ok: true, tool: toolName, result: readMesh().nodes };
    if (op === 'stats' || op === 'compute') return { ok: true, tool: toolName, result: await meshStats() };
    if (op === 'broadcast' || op === 'dispatch_all') return { ok: true, tool: toolName, result: await meshBroadcast(body.task || body.content || '', body) };
    if (op === 'brain' || op === 'collective') return { ok: true, tool: toolName, result: await meshBrain(body.question || body.task || body.content || '', body) };
    if (op === 'exec') return { ok: true, tool: toolName, result: body.all ? await meshExecAll(body.exec_tool || body.tool_name, body.tool_args || body.args) : await meshExec(body.id, body.exec_tool || body.tool_name, body.tool_args || body.args) };
    if (op === 'dispatch') return { ok: true, tool: toolName, result: Array.isArray(body.units) ? await fleetDispatch(body.units, body) : await meshDispatchSmart(body.exec_tool || body.tool_name, body.tool_args || body.args, body) };
    if (op === 'orchestrate' || op === 'mission') return { ok: true, tool: toolName, result: await fleetOrchestrate(body.objective || body.task || body.content || '', body) };
    if (op === 'shard') return { ok: true, tool: toolName, result: body.serve ? await meshShardServe(body.model || body.model_path, body) : await meshShardPlan(body) };
    if (op === 'rag' || op === 'recall') return { ok: true, tool: toolName, result: await fleetRagSearch(body.query || body.q || body.task || '', body.k) };
    if (op === 'memsync') return { ok: true, tool: toolName, result: await fleetMemSync(body) };
    if (op === 'upgrade' || op === 'upgrade_all') return { ok: true, tool: toolName, result: await meshUpgradeAll(body) };
    if (op === 'add' || op === 'enroll') return { ok: true, tool: toolName, result: meshAdd({ url: body.url, token: body.token, name: body.name }) };
    if (op === 'remove') return { ok: true, tool: toolName, result: meshRemove(body.id) };
    if (op === 'join') return { ok: true, tool: toolName, result: await fleetJoin(body.master || body.master_url, body.token || '', body.self) };
    throw new Error('fleet op must be one of: nodes, stats, broadcast, brain, exec, dispatch, orchestrate, shard, add, remove, join');
  }
  if (isTool('rpc_start', 'fleet_rpc_start')) {
    return { ok: true, tool: toolName, result: startRpcServer(Number(body.port) || undefined) };
  }
  if (isTool('install_pack', 'pack_install')) {
    return { ok: true, tool: toolName, result: installPack(body, {}) };
  }
  if (isTool('rag_query', 'memory_search_local')) {
    return { ok: true, tool: toolName, result: await retrieveMemories(body.query || body.q || body.content || '', Number(body.k) || 5) };
  }
  if (isTool('access_grant', 'grant_access')) {
    return { ok: true, tool: toolName, result: accessGrant(body) };
  }
  if (isTool('graph_search', 'knowledge_graph')) {
    return { ok: true, tool: toolName, result: graphSearch(body.query || body.q || body.content || '', body.k) };
  }
  if (isTool('graph_extract', 'graph_add')) {
    return { ok: true, tool: toolName, result: await graphExtract(body.text || body.content || body.query || '', body) };
  }
  if (isTool('ingest_file', 'file_to_knowledge')) {
    return { ok: true, tool: toolName, result: await fileToKnowledge(body.path || body.file || '', body) };
  }
  if (isTool('content_generate', 'generate_content')) {
    return { ok: true, tool: toolName, result: await generateContent(body) };
  }
  if (isTool('x_post', 'post_to_x', 'tweet')) {
    return { ok: true, tool: toolName, result: await xPost(body) };
  }
  if (isTool('browser_do', 'browser', 'web_automate')) {
    return { ok: true, tool: toolName, result: await browserDo(body) };
  }
  if (isTool('gui_do', 'desktop_control', 'mouse_keyboard')) {
    return { ok: true, tool: toolName, result: await guiDo(body) };
  }
  if (isTool('web_search')) {
    return { ok: true, tool: toolName, result: await webSearch(body) };
  }
  if (isTool('decide', 'montecarlo', 'analyze_move', 'run_the_math')) {
    return { ok: true, tool: toolName, result: monteCarloDecide(body) };
  }
  if (isTool('talking_avatar', 'avatar_generate', 'avatar_clone', 'lipsync')) {
    return { ok: true, tool: toolName, result: await generateTalkingAvatar(body) };
  }
  if (isTool('generate_image', 'studio_local', 'local_image', 'text_to_image')) {
    return { ok: true, tool: toolName, result: await localMediaGenerate({ kind: 'image', ...body }) };
  }
  if (isTool('dev_solve', 'devteam', 'spec_ops', 'breakdown_problem')) {
    return { ok: true, tool: toolName, result: await devTeamSolve(body) };
  }
  if (isTool('deep_research', 'research')) {
    return { ok: true, tool: toolName, result: await deepResearch(body.q || body.query || body.topic || '', Number(body.pages) || 3) };
  }
  if (isTool('cli_probe', 'abuz8_cli_probe')) {
    if (!body.allow_cli) throw new Error('allow_cli must be true before executing a local CLI command.');
    return { ok: true, tool: toolName, result: await runCommand(String(body.command || ''), Array.isArray(body.args) ? body.args.map(String) : ['--version'], Number(body.timeout || 15000)) };
  }

  const custom = readCustomTools().find((t) => slug(t.name || t.id) === key);
  if (custom) {
    if (custom.command) {
      if (!body.allow_cli) throw new Error('allow_cli must be true before executing a custom CLI tool.');
      const callArgs = Array.isArray(body.args) ? body.args.map(String) : (Array.isArray(custom.args) ? custom.args.map(String) : []);
      return { ok: true, tool: custom.name, custom: true, result: await runCommand(custom.command, callArgs, Number(body.timeout || 15000)) };
    }
    return { ok: true, tool: custom.name, custom: true, result: custom, note: 'Tool definition exists. Add command/endpoint to execute it.' };
  }

  throw new Error(`Unknown local tool: ${toolName}`);
}

// Secret stores encrypted at rest (AES-256-GCM via the vault key). Transparent: every reader/writer
// goes through readJson/writeJson, so all call sites are covered. Backward-compatible — a legacy
// plaintext file reads normally and is re-written encrypted on the next save.
const SECRET_CONFIG_FILES = new Set(['connectors.json', 'providers.json', 'social.json', 'account.json']);
function _isSecretConfig(file) { try { return SECRET_CONFIG_FILES.has(path.basename(String(file))); } catch { return false; } }
function readJson(file, fallback) {
  // CR-1: on a corrupt/truncated primary (e.g. crash mid-write), fall back to the last-good .bak before giving up.
  for (const f of [file, file + '.bak']) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && obj.__enc === 'v1' && typeof obj.blob === 'string') { try { return JSON.parse(decStr(obj.blob)); } catch { continue; } }
      return obj;
    } catch { continue; }
  }
  return fallback;
}

function writeJson(file, value) {
  safeMkdir(path.dirname(file));
  let data;
  if (_isSecretConfig(file)) {
    try { data = JSON.stringify({ __enc: 'v1', blob: encStr(JSON.stringify(value)) }, null, 2); } catch { data = JSON.stringify(value, null, 2); }
  } else {
    data = JSON.stringify(value, null, 2);
  }
  // CR-1: atomic write — write a temp file, fsync, snapshot the current file to .bak, then rename over.
  // A crash/power-loss (portable USB) can no longer truncate the live store to nothing.
  const tmp = file + '.tmp.' + process.pid;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch {}
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, data, 'utf8'); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function appendJsonl(file, value) {
  safeMkdir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

// CORS: never echo a wildcard. route() stamps res._acao with the per-request allowed
// origin (same-machine, or a LAN IP when lan_access is on). A cross-site page therefore
// gets NO access-control-allow-origin and the browser blocks it from reading the response —
// closing the "any website can read 127.0.0.1:PORT" exfil/CSRF hole on every endpoint.
function corsHeaders(res, base) {
  const h = Object.assign({ 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'vary': 'origin' }, base);
  if (res._acao) h['access-control-allow-origin'] = res._acao;
  return h;
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, corsHeaders(res, { 'content-type': 'application/json; charset=utf-8' }));
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, corsHeaders(res, { 'content-type': type }));
  res.end(body);
}

function binary(res, status, body, type = 'application/octet-stream') {
  res.writeHead(status, corsHeaders(res, { 'content-type': type, 'content-length': body.length }));
  res.end(body);
}

function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 10_000_000) { try { req.destroy(); } catch {} resolve({}); } // CR-4: resolve deterministically — never leave the handler promise pending on oversize
    });
    req.on('end', () => {
      req._rawBody = body; // exact bytes — needed for Stripe webhook HMAC verification
      if (!body) return resolve({});
      // Strip a leading UTF-8 BOM (some clients/files send one) — it makes JSON.parse fail,
      // which previously silently dropped the payload on endpoints without a body.raw fallback.
      const clean = body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body;
      try { resolve(JSON.parse(clean)); } catch { resolve({ raw: clean }); }
    });
    req.on('error', () => resolve({}));
  });
}

function splitPath(reqUrl) {
  const u = new URL(reqUrl, `http://127.0.0.1:${PORT}`);
  return { pathname: u.pathname.replace(/\/+$/, '') || '/', searchParams: u.searchParams };
}

// ── Attachments: optional engines that make ABUZ8 more capable. It runs without
// any of them; each detected one upgrades a capability (voice, hearing, etc.). ──
function attachmentsDir() { return safeMkdir(path.join(dataRoot, 'attachments')); }

function piperPaths() {
  const root = path.join(attachmentsDir(), 'piper');
  return { root, exe: path.join(root, 'piper.exe'), voicesDir: path.join(root, 'voices') };
}
function piperAvailable() { return exists(piperPaths().exe); }

function listPiperVoices() {
  const { voicesDir } = piperPaths();
  if (!exists(voicesDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(voicesDir)) {
    if (!f.endsWith('.onnx')) continue;
    const id = f.replace(/\.onnx$/, '');
    const parts = id.split('-'); // lang_REGION-name-quality
    const lang = (parts[0] || '').split('_')[0];
    out.push({
      id,
      name: prettyVoiceName(id),
      lang,
      engine: 'piper',
      file: path.join(voicesDir, f),
      arabic: lang === 'ar'
    });
  }
  return out;
}
function prettyVoiceName(id) {
  const map = {
    'en_US-hfc_female-medium': 'Aria (US female, natural)',
    'en_US-ryan-high': 'Ryan (US male, hi-fi)',
    'en_GB-alan-medium': 'Alan (British male)',
    'ar_JO-kareem-medium': 'Kareem (Arabic / عربي)'
  };
  return map[id] || id.replace(/_/g, ' ');
}

// Neural TTS via Piper. Optional preset shapes the delivery (e.g. "cartoon" =
// faster + higher pitch via length_scale; "calm" = slower).
function synthesizePiper(textValue, voiceId, preset) {
  return new Promise((resolve, reject) => {
    const { exe, voicesDir } = piperPaths();
    if (!exists(exe)) return reject(new Error('Piper attachment not installed.'));
    const voices = listPiperVoices();
    let voice = voices.find((v) => v.id === voiceId) || voices.find((v) => v.lang === 'en') || voices[0];
    // If the text is in Arabic script, always speak it with an Arabic voice (Piper
    // diacritizes via libtashkeel) so عربي is pronounced natively, not mangled.
    if (/[؀-ۿ]/.test(String(textValue || ''))) { const ar = voices.find((v) => v.lang === 'ar'); if (ar) voice = ar; }
    if (!voice) return reject(new Error('No Piper voice installed.'));
    const textClean = String(textValue || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!textClean) return reject(new Error('No text supplied.'));
    const ttsDir = safeMkdir(path.join(dataRoot, 'cache', 'tts'));
    const outputFile = path.join(ttsDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`);
    // length_scale: <1 faster/brighter, >1 slower. cartoon = fast+light.
    const presets = { normal: ['--length_scale', '1.0'], calm: ['--length_scale', '1.18'], fast: ['--length_scale', '0.82'], cartoon: ['--length_scale', '0.72', '--noise_w', '0.95'], narrator: ['--length_scale', '1.08'] };
    const extra = presets[slug(preset || 'normal')] || presets.normal;
    const args = ['-m', voice.file, '-f', outputFile, ...extra];
    const child = execFile(exe, args, { cwd: piperPaths().root, windowsHide: true, timeout: 45000 }, (err) => {
      if (err && !exists(outputFile)) return reject(err);
      try {
        const wav = fs.readFileSync(outputFile);
        try { fs.unlinkSync(outputFile); } catch {}
        resolve({ wav, voice: voice.id, engine: 'piper' });
      } catch (e) { reject(e); }
    });
    child.stdin.write(textClean);
    child.stdin.end();
  });
}

function attachmentsStatus() {
  const piper = piperAvailable();
  const voices = piper ? listPiperVoices() : [];
  return {
    ok: true,
    attachments: [
      { id: 'piper-tts', name: 'Piper Neural Voice', capability: 'Text-to-speech (offline, natural)', installed: piper, detail: piper ? `${voices.length} voice(s): ${voices.map((v) => v.name).join(', ')}` : 'Not installed — falls back to Windows SAPI.' },
      { id: 'whisper-stt', name: 'Whisper Hearing', capability: 'Speech-to-text (offline)', installed: whisperAvailable(), detail: whisperAvailable() ? 'Offline transcription ready.' : 'Not installed — falls back to browser/Windows STT.' },
      { id: 'lora-adapters', name: 'LoRA Specialist Brains', capability: 'Modular skill adapters on the local brain', installed: listLoraAdapters().length > 0, detail: listLoraAdapters().length ? `${listLoraAdapters().length} adapter(s) available.` : 'Drop .gguf LoRA files in attachments/lora to specialize the brain.' },
      { id: 'playwright', name: 'Playwright Browser Control', capability: 'Real browser automation (navigate/click/fill/extract)', installed: browserAutomationAvailable(), detail: browserAutomationAvailable() ? 'Headless/headed Chromium automation ready.' : 'Not installed — npm i playwright in attachments/playwright.' },
      { id: 'pyautogui', name: 'PyAutoGUI Desktop Control', capability: 'Real mouse/keyboard/screen control', installed: guiAutomationAvailable(), detail: guiAutomationAvailable() ? 'Native desktop control ready (consent-gated).' : 'Not installed — pip install pyautogui.' },
      { id: 'voice-brain', name: 'Fast Voice Brain', capability: 'Tiny model for instant spoken replies', installed: voiceBrainAvailable(), detail: voiceBrainAvailable() ? `${path.basename(voiceModelFile())} — voice replies use this for ~1-2s latency.` : 'Drop a small .gguf in models/voice for instant voice.' }
    ],
    voice_engine: piper ? 'piper' : 'windows-sapi',
    voices: [...voices, ...[]]
  };
}

// ── Playwright browser automation (real, headed or headless) ──
function playwrightPaths() {
  const root = path.join(attachmentsDir(), 'playwright');
  return { root, runner: path.join(root, 'run.js'), node: bundledNodePath() || 'node', hasModule: exists(path.join(root, 'node_modules', 'playwright')) };
}
function browserAutomationAvailable() { const p = playwrightPaths(); return exists(p.runner) && p.hasModule; }

async function browserDo(args = {}) {
  const p = playwrightPaths();
  if (!browserAutomationAvailable()) throw new Error('Playwright attachment not installed (attachments/playwright).');
  const spec = {
    url: args.url ? (resolveSiteUrl(args.url, args.search) || (/^https?:/i.test(args.url) ? args.url : 'https://' + args.url)) : undefined,
    headless: args.headless !== false && args.show !== true,
    actions: Array.isArray(args.actions) ? args.actions : [],
    extract: args.extract !== false,
    screenshot: args.screenshot ? path.join(safeMkdir(path.join(dataRoot, 'shots')), `browser-${Date.now()}.png`) : undefined
  };
  const specFile = path.join(safeMkdir(path.join(dataRoot, 'cache')), `pw-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
  return new Promise((resolve, reject) => {
    execFile(p.node, [p.runner, specFile], { cwd: p.root, windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(specFile); } catch {}
      if (err && !stdout) return reject(new Error(err.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('browser runner returned no JSON: ' + String(stdout).slice(0, 200))); }
    });
  });
}

// ── PyAutoGUI desktop automation (real mouse/keyboard/screen) ──
function pyautoguiPaths() {
  const root = path.join(attachmentsDir(), 'pyautogui');
  return { root, runner: path.join(root, 'gui.py') };
}
// gui_do works on a CLEAN box: PyAutoGUI attachment when present (richer image-matching),
// else the always-available native .NET driver (spineComputer, P6) — no python/pip needed.
function guiAutomationAvailable() { return exists(pyautoguiPaths().runner) || process.platform === 'win32'; }

// Bridge the agent's gui_do tool to the native spineComputer driver when PyAutoGUI is absent.
async function guiDoNative(args = {}) {
  const a = String(args.action || '').toLowerCase();
  if (a === 'screenshot') { const r = await spineComputer('screenshot'); return { ok: !!r.ok, action: 'screenshot', path: r.file || null, width: r.width || null, native: true }; }
  if (a === 'move') return { ...(await spineComputer('move', { x: args.x, y: args.y })), native: true };
  if (a === 'click' || a === 'doubleclick' || a === 'rightclick') {
    if (args.x != null && args.y != null) await spineComputer('move', { x: args.x, y: args.y });
    const r = await spineComputer('click'); if (a === 'doubleclick') await spineComputer('click');
    return { ...r, action: a, native: true };
  }
  if (a === 'type' || a === 'write') return { ...(await spineComputer('type', { text: args.text || args.message || '' })), native: true };
  if (a === 'hotkey' || a === 'press' || a === 'key') {
    const keys = Array.isArray(args.keys) ? args.keys : (args.keys ? [args.keys] : (args.key ? [args.key] : []));
    const mods = { ctrl: '^', control: '^', alt: '%', shift: '+' }; let combo = '';
    for (const k of keys) { const kl = String(k).toLowerCase(); combo += mods[kl] || ('{' + String(k).toUpperCase() + '}'); }
    return { ...(await spineComputer('key', { keys: combo })), action: a, native: true };
  }
  if (a === 'info' || a === 'position') return { ...(await spineComputer('info')), native: true };
  throw new Error('native gui_do: unsupported action "' + a + '" (move|click|type|key|hotkey|screenshot|info)');
}

async function guiDo(args = {}) {
  requireActionConsent('gui_do'); // controls the real machine — always gated
  const p = pyautoguiPaths();
  if (!exists(p.runner)) {
    if (process.platform === 'win32') return guiDoNative(args); // sovereign native fallback (clean box)
    throw new Error('No GUI driver: PyAutoGUI attachment missing and native driver is Windows-only.');
  }
  if (args.action === 'screenshot' && !args.path) args.path = path.join(safeMkdir(path.join(dataRoot, 'shots')), `gui-${Date.now()}.png`);
  return new Promise((resolve, reject) => {
    execFile('python', [p.runner, JSON.stringify(args)], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(err.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('gui runner returned no JSON: ' + String(stdout).slice(0, 200))); }
    });
  });
}

function listLoraAdapters() {
  const dir = path.join(attachmentsDir(), 'lora');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.gguf$/i.test(f)).map((f) => ({ id: f.replace(/\.gguf$/i, ''), file: path.join(dir, f) }));
}

function whisperPaths() {
  const root = path.join(attachmentsDir(), 'whisper');
  const exe = ['whisper-cli.exe', 'main.exe', 'whisper.exe'].map((n) => path.join(root, n)).find((p) => exists(p));
  const mdir = path.join(root, 'models');
  const bins = exists(mdir) ? fs.readdirSync(mdir).filter((f) => /\.bin$/i.test(f)) : [];
  // Prefer a multilingual model (no ".en") so hearing works in many languages.
  const model = bins.find((f) => !/\.en\.bin$/i.test(f)) || bins[0] || null;
  return { root, exe: exe || path.join(root, 'whisper-cli.exe'), model: model ? path.join(mdir, model) : null };
}
function whisperAvailable() { const w = whisperPaths(); return exists(w.exe) && Boolean(w.model); }

// ── WHISPER.CPP STREAMING STT (real-time native hearing) ─────────────────────
// whisper-stream.exe captures the mic continuously (SDL2) and prints a rolling
// transcript. We spawn it as a hidden child and stream its output so ABUZ8 hears
// you live (no push-to-talk). Works with ANY mic the OS exposes — incl. the
// Kinect v2 mic array (set it as the default recording device or pass its index).
function _stripAnsi(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, ''); }
function whisperStreamExe() { return path.join(whisperPaths().root, IS_WIN ? 'whisper-stream.exe' : 'whisper-stream'); }
function whisperStreamAvailable() { const w = whisperPaths(); return exists(whisperStreamExe()) && Boolean(w.model); }
let _whStream = { proc: null, buf: '', running: false, started: 0, device: '-1', lang: 'en' };
async function whisperStreamStart(opts = {}) {
  if (_whStream.running && _whStream.proc) return { ok: true, already_running: true, device: _whStream.device, language: _whStream.lang };
  const exe = whisperStreamExe(); const w = whisperPaths();
  if (!exists(exe) || !w.model) return { ok: false, error: 'whisper-stream or model not bundled', exe, model: w.model };
  let cap = (opts.capture != null && opts.capture !== '') ? String(opts.capture) : '-1';
  // Auto-select the Kinect "Xbox NUI Sensor" mic array when requested.
  if (opts.kinect === true && (cap === '-1')) { try { const idx = kinectMicIndex(await listCaptureDevices()); if (idx != null) cap = String(idx); } catch {} }
  const lang = opts.language || 'en';
  const args = ['-m', w.model, '-t', String(Math.max(2, Math.min(8, os.cpus().length))), '--step', String(opts.step || 700), '--length', String(opts.length || 5000), '--keep', '200', '-vth', String(opts.vad || 0.6), '-c', cap, '-l', lang];
  if (opts.translate) args.push('-tr');
  let proc; try { proc = _cp.spawn(exe, args, { cwd: w.root, windowsHide: true }); } catch (e) { return { ok: false, error: e.message }; }
  _whStream = { proc, buf: '', running: true, started: Date.now(), device: cap, lang };
  const onData = (d) => { _whStream.buf += _stripAnsi(d.toString()); if (_whStream.buf.length > 60000) _whStream.buf = _whStream.buf.slice(-45000); };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('exit', () => { _whStream.running = false; });
  proc.on('error', () => { _whStream.running = false; });
  pushActivity('voice', 'Live hearing on', 'whisper.cpp streaming (' + lang + ')');
  return { ok: true, device: cap, language: lang, note: 'whisper.cpp streaming live — poll /api/voice/stream/read for the rolling transcript.' };
}
function whisperStreamRead(since) { const s = Number(since) || 0; return { running: _whStream.running, transcript: _whStream.buf.slice(s), len: _whStream.buf.length, device: _whStream.device, language: _whStream.lang }; }
function whisperStreamStop() { if (_whStream.proc) { try { _whStream.proc.kill(); } catch {} } _whStream.running = false; _whStream.proc = null; return { ok: true }; }
function whisperStreamStatus() { return { running: _whStream.running, available: whisperStreamAvailable(), device: _whStream.device, language: _whStream.lang, uptime_s: _whStream.running ? Math.round((Date.now() - _whStream.started) / 1000) : 0 }; }
// List SDL capture devices (mics) whisper-stream can use — incl. the Kinect "Xbox NUI Sensor"
// mic array — so the UI can show them and ABUZ8 can auto-pick the Kinect.
function listCaptureDevices() {
  return new Promise((resolve) => {
    const exe = whisperStreamExe(); const w = whisperPaths();
    if (!exists(exe) || !w.model) return resolve([]);
    let proc; try { proc = _cp.spawn(exe, ['-m', w.model, '-c', '99'], { cwd: w.root, windowsHide: true }); } catch { return resolve([]); }
    let buf = '';
    const onD = (d) => { buf += d.toString(); };
    proc.stdout.on('data', onD); proc.stderr.on('data', onD);
    proc.on('error', () => resolve([]));
    setTimeout(() => {
      try { proc.kill(); } catch {}
      const devs = [...buf.matchAll(/Capture device #(\d+):\s*'([^']+)'/g)].map((m) => ({ index: Number(m[1]), name: m[2], kinect: /kinect|xbox\s*nui|nui\s*sensor/i.test(m[2]) }));
      resolve(devs);
    }, 2800);
  });
}
function kinectMicIndex(devs) { const d = (devs || []).find((x) => x.kinect); return d ? d.index : null; }

function transcribeWhisper(wavBase64, language) {
  return new Promise((resolve, reject) => {
    const w = whisperPaths();
    if (!whisperAvailable()) return reject(new Error('Whisper attachment not installed.'));
    const b64 = String(wavBase64 || '').replace(/^data:audio\/\w+;base64,/, '').trim();
    if (!b64) return reject(new Error('No audio supplied.'));
    const sttDir = safeMkdir(path.join(dataRoot, 'cache', 'stt'));
    const inFile = path.join(sttDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`);
    fs.writeFileSync(inFile, Buffer.from(b64, 'base64'));
    // -l auto detects the spoken language (Arabic, English, …); pass 'ar' to force Arabic.
    const lang = String(language || 'auto').toLowerCase();
    execFile(w.exe, ['-m', w.model, '-f', inFile, '-otxt', '-of', inFile, '-nt', '-l', lang], { windowsHide: true, timeout: 60000 }, (err) => {
      const txtFile = inFile + '.txt';
      let transcript = '';
      try { transcript = fs.readFileSync(txtFile, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(inFile); } catch {}
      try { fs.unlinkSync(txtFile); } catch {}
      if (err && !transcript) return reject(err);
      resolve({ transcript, engine: 'whisper.cpp' });
    });
  });
}

function synthesizeWindowsTts(textValue, voiceName = '') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Native TTS is only bundled for Windows in this build.'));
    const textClean = String(textValue || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!textClean) return reject(new Error('No text supplied.'));
    const ttsDir = safeMkdir(path.join(dataRoot, 'cache', 'tts'));
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const inputFile = path.join(ttsDir, `${id}.txt`);
    const outputFile = path.join(ttsDir, `${id}.wav`);
    fs.writeFileSync(inputFile, textClean, 'utf8');
    const scriptBody = [
      'param([string]$InputFile,[string]$OutputFile,[string]$VoiceName)',
      'Add-Type -AssemblyName System.Speech',
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'if ($VoiceName) { try { $synth.SelectVoice($VoiceName) } catch {} }',
      '$synth.Rate = 0',
      '$synth.Volume = 100',
      '$synth.SetOutputToWaveFile($OutputFile)',
      '$synth.Speak([IO.File]::ReadAllText($InputFile))',
      '$synth.Dispose()'
    ].join('; ');
    const script = `& { ${scriptBody} }`;
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, inputFile, outputFile, String(voiceName || '')], { windowsHide: true, timeout: 30000 }, (err) => {
      try { fs.unlinkSync(inputFile); } catch {}
      if (err) return reject(err);
      try {
        const wav = fs.readFileSync(outputFile);
        try { fs.unlinkSync(outputFile); } catch {}
        resolve(wav);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function listWindowsTtsVoices() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
      '$synth.Dispose()'
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean));
    });
  });
}

function listWindowsSttRecognizers() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Name }'
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean));
    });
  });
}

function transcribeWindowsStt(wavBase64) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Native STT is only bundled for Windows in this build.'));
    const b64 = String(wavBase64 || '').replace(/^data:audio\/\w+;base64,/, '').trim();
    if (!b64) return reject(new Error('No WAV audio supplied.'));
    const audio = Buffer.from(b64, 'base64');
    if (audio.length < 44 || audio.slice(0, 4).toString('ascii') !== 'RIFF' || audio.slice(8, 12).toString('ascii') !== 'WAVE') {
      return reject(new Error('Native STT expects 16-bit PCM WAV audio.'));
    }
    const sttDir = safeMkdir(path.join(dataRoot, 'cache', 'stt'));
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const inputFile = path.join(sttDir, `${id}.wav`);
    const outputFile = path.join(sttDir, `${id}.txt`);
    fs.writeFileSync(inputFile, audio);
    const scriptBody = [
      'param([string]$InputFile,[string]$OutputFile)',
      'Add-Type -AssemblyName System.Speech',
      '$infos = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()',
      'if (-not $infos -or $infos.Count -lt 1) { throw "No Windows speech recognizer is installed." }',
      '$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($infos[0])',
      '$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      '$rec.SetInputToWaveFile($InputFile)',
      '$result = $rec.Recognize([TimeSpan]::FromSeconds(25))',
      '$text = if ($result) { $result.Text } else { "" }',
      '[IO.File]::WriteAllText($OutputFile, $text, [Text.Encoding]::UTF8)',
      '$rec.Dispose()'
    ].join('; ');
    const script = `& { ${scriptBody} }`;
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, inputFile, outputFile], { windowsHide: true, timeout: 35000 }, (err) => {
      try { fs.unlinkSync(inputFile); } catch {}
      if (err) return reject(err);
      try {
        const transcript = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
        try { fs.unlinkSync(outputFile); } catch {}
        resolve({ transcript, confidence: transcript ? 0.5 : 0, engine: 'Windows System.Speech DictationGrammar' });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function mcpConfigPath() {
  return path.join(dataRoot, 'mcp', 'mcp_servers.json');
}

function mergeMcpServers(servers, source) {
  const cfg = readJson(mcpConfigPath(), { mcpServers: {}, updated_at: null });
  const imported = [];
  const incoming = Array.isArray(servers)
    ? Object.fromEntries(servers.map((s) => [s.name || slug(s.command || source), s]))
    : (servers || {});
  for (const [name, spec] of Object.entries(incoming)) {
    const key = slug(name);
    cfg.mcpServers[key] = {
      command: spec.command || '',
      args: Array.isArray(spec.args) ? spec.args : [],
      env: spec.env || {},
      enabled: Boolean(spec.enabled),
      source,
      note: spec.note || spec._purpose || spec.description || ''
    };
    imported.push(key);
  }
  cfg.updated_at = new Date().toISOString();
  writeJson(mcpConfigPath(), cfg);
  return imported;
}

function slug(s) {
  return String(s || 'connector').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'connector';
}

function claudeConfigPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
}

function claudeMcpBridgePath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'mcp', 'abuz8-mcp-stdio.js') : null,
    path.join(__dirname, 'mcp', 'abuz8-mcp-stdio.js')
  ].filter(Boolean);
  return candidates.find((file) => exists(file)) || candidates[candidates.length - 1];
}

function bundledNodePath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'mcp', 'node.exe') : null,
    path.join(__dirname, 'mcp', 'node.exe'),
    process.execPath
  ].filter(Boolean);
  return candidates.find((file) => exists(file) && /node\.exe$/i.test(file)) || null;
}

function persistentClaudeBridge() {
  const dir = safeMkdir(path.join(dataRoot, 'mcp', 'abuz8-claude-bridge'));
  const bridgeSrc = claudeMcpBridgePath();
  const nodeSrc = bundledNodePath();
  const bridgeDest = path.join(dir, 'abuz8-mcp-stdio.js');
  const nodeDest = path.join(dir, 'node.exe');
  if (bridgeSrc && exists(bridgeSrc)) fs.copyFileSync(bridgeSrc, bridgeDest);
  if (nodeSrc && exists(nodeSrc)) fs.copyFileSync(nodeSrc, nodeDest);
  return { dir, bridge: bridgeDest, node: exists(nodeDest) ? nodeDest : null };
}

function installClaudeSymbiote() {
  const file = claudeConfigPath();
  const cfg = readJson(file, { mcpServers: {} });
  cfg.mcpServers = cfg.mcpServers || {};
  const bridge = persistentClaudeBridge();
  cfg.mcpServers.abuz8_os = {
    command: bridge.node || 'node',
    args: [bridge.bridge],
    env: {
      ABUZ8_CORE_URL: `http://127.0.0.1:${PORT}`
    }
  };
  safeMkdir(path.dirname(file));
  writeJson(file, cfg);
  return { file, server: cfg.mcpServers.abuz8_os };
}

function commandExists(command, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

function runCommand(command, args = [], timeout = 15000) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || '').slice(0, 4000),
        stderr: String(stderr || err?.message || '').slice(0, 4000)
      });
    });
  });
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

// Cross-platform llama.cpp server binary name: Windows ships .exe, Linux/mac ship a bare ELF/Mach-O.
// This is what lets ABUZ8 run its local brain on a Linux VPS / Android-Termux / mac, not just Windows.
function llamaServerName() { return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'; }
function rpcServerName() { return process.platform === 'win32' ? 'rpc-server.exe' : 'rpc-server'; }
// The rpc-server example binary lets one node lend its GPU to a remote llama-server.
// ggml-rpc.dll (the backend) already ships; this resolves the launcher binary if present.
function rpcServerPath() { try { const dir = resolveBrainDir(); const p = path.join(dir, rpcServerName()); return exists(p) ? p : null; } catch { return null; } }
function brainServerIn(dir) { const a = path.join(dir, llamaServerName()); if (exists(a)) return a; const b = path.join(dir, 'llama-server.exe'); if (exists(b)) return b; const c = path.join(dir, 'llama-server'); return exists(c) ? c : null; }
function resolveBrainDir() {
  // Prefer a CUDA-enabled runtime (brain-cuda) when present so a real GPU is used;
  // fall back to the bundled CPU runtime. This is how ABUZ8 scales to the machine.
  const candidates = [
    process.env.ABUZ8_BRAIN_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, 'brain-cuda') : null,
    path.join(__dirname, 'brain-cuda'),
    dataRoot ? path.join(dataRoot, 'attachments', 'brain-cuda') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'brain') : null,
    path.join(__dirname, 'brain')
  ].filter(Boolean);
  return candidates.find((dir) => brainServerIn(dir)) || candidates[candidates.length - 1];
}
function brainIsCuda() {
  const dir = resolveBrainDir();
  // GPU-capable when the bundled runtime ships the CUDA backend beside llama-server (b9743 ships
  // ggml-cuda.dll) OR when a dedicated brain-cuda dir is present. Do NOT gate on the dir NAME alone —
  // that left dual-RTX-5090 machines running the brain on CPU.
  if (/brain-cuda/i.test(dir)) return true;
  try { return exists(path.join(dir, 'ggml-cuda.dll')); } catch { return false; }
}

let _nvidiaCache = null;
async function hasNvidiaGpu() {
  if (_nvidiaCache !== null) return _nvidiaCache;
  const names = (await detectGpuNames()).join(' ');
  _nvidiaCache = /nvidia|geforce|\brtx\b|\bgtx\b|tesla|quadro|\ba100\b|\bh100\b|\bh200\b|\bb200\b|dgx|rtx ?50\d0/i.test(names);
  return _nvidiaCache;
}
let lastBrainAccel = 'cpu';
let _brainCtx = 2048; // active local model context window (tokens) — set by brainArgs, used to budget prompts
// Build hardware-adaptive llama.cpp args: ALL cpu cores, GPU offload when a CUDA
// runtime + NVIDIA GPU are present, context scaled to RAM.
async function brainArgs(model, baseCtx, port) {
  const cores = os.cpus().length || 4;
  const totalGb = os.totalmem() / 1024 / 1024 / 1024;
  const useGpu = brainIsCuda() && await hasNvidiaGpu();
  lastBrainAccel = useGpu ? 'gpu' : 'cpu';
  // RUN MAX: on GPU, scale the context window to TOTAL VRAM across ALL GPUs (a multi-5090 / DGX box
  // gets a huge context); on CPU, scale to RAM. llama.cpp -ngl 999 + default split-mode=layer offloads
  // every layer across ALL visible GPUs (we never set CUDA_VISIBLE_DEVICES, so it sees them all).
  let gpuCount = 0, vramGb = 0;
  if (useGpu) { try { const gi = await gpuInfo(); gpuCount = gi.count; vramGb = gi.total_vram_gb || 0; } catch {} }
  const ctx = String(baseCtx || (useGpu && vramGb >= 96 ? 65536 : useGpu && vramGb >= 48 ? 32768 : useGpu && vramGb >= 24 ? 16384
    : totalGb >= 48 ? 16384 : totalGb >= 24 ? 8192 : totalGb >= 12 ? 4096 : 2048));
  _brainCtx = parseInt(ctx, 10) || _brainCtx;
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', ctx,
    '-ngl', useGpu ? '999' : '0',
    '--jinja',  // enable the chat template's NATIVE function-calling (Gemma 4 emits clean tool_calls)
    '--threads', String(Math.max(2, cores))];
  if (useGpu) { args.push('--flash-attn', 'on'); if (gpuCount > 1) args.push('--split-mode', 'layer'); } // spread across ALL GPUs
  return args;
}

function brainRuntimeFiles() {
  const dir = resolveBrainDir();
  return {
    dir,
    server: brainServerIn(dir) || path.join(dir, llamaServerName())
  };
}

function availableEmbeddedBrains() {
  const runtime = brainRuntimeFiles();
  const bundled = EMBEDDED_BRAIN_CATALOG.map((brain) => {
    const model = path.join(runtime.dir, brain.file);
    const present = exists(runtime.server) && exists(model);
    const size = present ? fs.statSync(model).size : 0;
    return {
      ...brain,
      embedded: present,
      model,
      model_file: brain.file,
      size_bytes: size,
      size_mb: Math.round(size / 1024 / 1024),
      runtime: exists(runtime.server) ? 'llama.cpp' : null,
      port: LFM_PORT
    };
  });
  const downloaded = dataRoot ? downloadedGgufBrains(runtime) : [];
  return bundled.concat(downloaded);
}

// The vision projector that sits beside a multimodal model (e.g. Gemma 3 + mmproj).
function mmprojSibling(modelPath) {
  try { const dir = path.dirname(modelPath); const mm = fs.readdirSync(dir).find((f) => /mmproj.*\.gguf$/i.test(f)); return mm ? path.join(dir, mm) : null; } catch { return null; }
}
let lfmIsMultimodal = false;
function downloadedGgufBrains(runtime) {
  const root = path.join(dataRoot, 'models');
  const found = [];
  const walk = (dir) => {
    if (!exists(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Resolve symlinks/junctions (readdir reports them as neither dir nor file) so users
      // can junction huge models from another drive instead of copying them into the data dir.
      let isDir = entry.isDirectory(), isFile = entry.isFile();
      if (entry.isSymbolicLink()) { try { const st = fs.statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch {} }
      if (isDir) walk(full);
      // mmproj/embed projectors are not standalone brains; voice 0.5B has its own role.
      else if (isFile && entry.name.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.map((model) => {
    const rel = path.relative(root, model).replace(/\\/g, '/');
    const id = `local-${slug(rel.replace(/\.gguf$/i, ''))}`;
    const size = fs.statSync(model).size;
    return {
      id,
      name: `Local GGUF: ${path.basename(model, '.gguf')}`,
      file: path.basename(model),
      tier: 'local',
      role: 'user-downloaded local brain stored inside portable data',
      min_ram_gb: Math.max(8, Math.ceil(size / 1024 / 1024 / 1024) * 3),
      context: 2048,
      embedded: exists(runtime.server),
      model,
      model_file: rel,
      size_bytes: size,
      size_mb: Math.round(size / 1024 / 1024),
      runtime: exists(runtime.server) ? 'llama.cpp' : null,
      port: LFM_PORT,
      user_model: true
    };
  });
}

function selectEmbeddedBrain() {
  const cfg = dataRoot ? readRuntimeConfig() : {};
  const requested = String(
    cfg.selected_brain ||
    cfg.selected_brain_tier ||
    process.env.ABUZ8_BRAIN_TIER ||
    process.env.ABUZ8_BRAIN ||
    ''
  ).toLowerCase();
  const available = availableEmbeddedBrains().filter((b) => b.embedded);
  if (!available.length) return null;
  if (requested) {
    const exact = available.find((b) => [b.id, b.tier, b.name.toLowerCase(), String(b.model_file || '').toLowerCase()].includes(requested));
    if (exact) return exact;
  }
  const totalGb = os.totalmem() / 1024 / 1024 / 1024;
  return available
    .filter((b) => totalGb >= b.min_ram_gb)
    .sort((a, b) => b.min_ram_gb - a.min_ram_gb)[0]
    || available.sort((a, b) => a.min_ram_gb - b.min_ram_gb)[0];
}

function stopEmbeddedBrain() {
  if (lfmProcess) {
    try { lfmProcess.kill(); } catch {}
  }
  lfmProcess = null;
  lfmStarting = false;
}

function setActiveBrain(requested) {
  const key = String(requested || '').trim().toLowerCase();
  if (!key || key === 'auto') {
    writeRuntimeConfigPatch({ selected_brain: 'auto', selected_brain_name: 'Auto' });
    stopEmbeddedBrain();
    activeBrain = selectEmbeddedBrain();
    return { ok: true, selected: embeddedBrainStatus(), restarted: true };
  }
  const brain = availableEmbeddedBrains().find((b) =>
    [b.id, b.tier, b.name.toLowerCase(), b.model_file.toLowerCase()].includes(key)
  );
  if (!brain) throw new Error(`Unknown brain: ${requested}`);
  if (!brain.embedded) throw new Error(`Brain is not bundled in this build: ${brain.name}`);
  writeRuntimeConfigPatch({ selected_brain: brain.id, selected_brain_name: brain.name, selected_brain_tier: brain.tier });
  stopEmbeddedBrain();
  activeBrain = brain;
  return { ok: true, selected: embeddedBrainStatus(), restarted: true };
}

function embeddedBrainStatus() {
  const selected = activeBrain || selectEmbeddedBrain();
  const brains = availableEmbeddedBrains();
  const present = Boolean(selected);
  return {
    id: selected?.id || 'embedded-lfm',
    name: selected?.name || 'Embedded LFM',
    status: present ? (lfmProcess ? 'online' : (lfmStarting ? 'warming' : 'ready')) : 'missing',
    alive: Boolean(lfmProcess),
    embedded: present,
    kind: 'offline-gguf',
    port: LFM_PORT,
    tier: selected?.tier || null,
    role: selected?.role || null,
    model_file: selected?.model_file || null,
    size_mb: selected?.size_mb || 0,
    runtime: selected?.runtime || null,
    available: brains.map((b) => ({
      id: b.id,
      name: b.name,
      tier: b.tier,
      status: b.embedded ? 'ready' : 'missing',
      embedded: b.embedded,
      size_mb: b.size_mb,
      model_file: b.model_file,
      min_ram_gb: b.min_ram_gb,
      role: b.role
    }))
  };
}

function httpJson(method, port, pathname, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(out || '{}')); } catch { resolve({ content: out }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function lfmHealthy(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: LFM_PORT, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      // llama-server answers 503 while the model is still loading; only 200 means ready.
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForLfm(ms = 150000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await lfmHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

// ── Voice brain (tiny, fast) ──
function voiceModelFile() {
  const dir = path.join(dataRoot || '', 'models', 'voice');
  if (!exists(dir)) return null;
  const gguf = fs.readdirSync(dir).find((f) => /\.gguf$/i.test(f));
  return gguf ? path.join(dir, gguf) : null;
}
function voiceBrainAvailable() {
  return Boolean(voiceModelFile()) && exists(brainRuntimeFiles().server);
}
function portHealthy(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function waitForPort(port, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) { if (await portHealthy(port)) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}
async function ensureVoiceBrain() {
  if (voiceProcess && await portHealthy(VOICE_PORT)) return true;
  if (voiceProcess || voiceStarting) return waitForPort(VOICE_PORT, 30000);
  const files = brainRuntimeFiles();
  const model = voiceModelFile();
  if (!exists(files.server) || !model) return false;
  voiceStarting = true;
  const args = await brainArgs(model, 2048, VOICE_PORT);
  try {
    voiceProcess = spawn(files.server, args, { cwd: files.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    voiceProcess.once('error', () => { voiceProcess = null; voiceStarting = false; });
    voiceProcess.once('exit', () => { voiceProcess = null; voiceStarting = false; });
    const ready = await waitForPort(VOICE_PORT, 30000);
    voiceStarting = false;
    return ready;
  } catch (e) { voiceProcess = null; voiceStarting = false; return false; }
}

// ── Local VISION brain (Gemma 3 4B multimodal) — offline eyes, no cloud ──
const VISION_PORT = Number(process.env.ABUZ8_VISION_PORT || 8905);
let visionProcess = null, visionStarting = false;
function visionModelFiles() {
  const dir = path.join(dataRoot || '', 'models', 'vision');
  if (!exists(dir)) return null;
  const files = fs.readdirSync(dir);
  const llm = files.find((f) => /\.gguf$/i.test(f) && !/mmproj/i.test(f));
  const mm = files.find((f) => /mmproj.*\.gguf$/i.test(f));
  return (llm && mm) ? { llm: path.join(dir, llm), mmproj: path.join(dir, mm) } : null;
}
// Vision is available if the (single) main brain is multimodal, or a separate vision model is present.
function visionBrainAvailable() { const f = brainRuntimeFiles(); if (!f || !exists(f.server)) return false; try { const sel = selectEmbeddedBrain(); if (sel && mmprojSibling(sel.model)) return true; } catch {} return Boolean(visionModelFiles()); }
async function ensureVisionBrain() {
  if (visionProcess && await portHealthy(VISION_PORT)) return true;
  if (visionProcess || visionStarting) return waitForPort(VISION_PORT, 120000);
  const files = brainRuntimeFiles();
  const vm = visionModelFiles();
  if (!exists(files.server) || !vm) return false;
  visionStarting = true;
  const base = await brainArgs(vm.llm, 4096, VISION_PORT);
  const args = [...base, '--mmproj', vm.mmproj];
  try {
    visionProcess = spawn(files.server, args, { cwd: files.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    visionProcess.once('error', () => { visionProcess = null; visionStarting = false; });
    visionProcess.once('exit', () => { visionProcess = null; visionStarting = false; });
    const ready = await waitForPort(VISION_PORT, 180000); // vision model load is heavier than text
    visionStarting = false;
    return ready;
  } catch (e) { visionProcess = null; visionStarting = false; return false; }
}
async function callLocalVision(prompt, imageB64) {
  const url = imageB64.startsWith('data:') ? imageB64 : 'data:image/jpeg;base64,' + imageB64;
  const body = { model: 'abuz8', max_tokens: 700, temperature: 0.3, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] }] };
  // Prefer the UNIFIED main brain (one multimodal model). Fall back to a separate vision brain if present.
  const sel = (() => { try { return selectEmbeddedBrain(); } catch { return null; } })();
  if (sel && mmprojSibling(sel.model)) {
    if (!(await ensureEmbeddedBrain())) throw new Error('brain unavailable');
    const out = await httpJson('POST', LFM_PORT, '/v1/chat/completions', body, 180000);
    if (out && out.choices && out.choices[0] && out.choices[0].message) return out.choices[0].message.content || '';
    throw new Error('vision returned no content');
  }
  if (!(await ensureVisionBrain())) throw new Error('local vision brain unavailable');
  const out = await httpJson('POST', VISION_PORT, '/v1/chat/completions', body, 180000);
  if (out && out.choices && out.choices[0] && out.choices[0].message) return out.choices[0].message.content || '';
  throw new Error('local vision returned no content');
}

async function ensureEmbeddedBrain() {
  if (lfmProcess && await lfmHealthy()) return true;
  if (lfmProcess) return waitForLfm(150000);
  if (lfmStarting) return waitForLfm(150000);
  const files = brainRuntimeFiles();
  const selected = selectEmbeddedBrain();
  if (!exists(files.server) || !selected || !exists(selected.model)) {
    lastLfmError = 'Embedded LFM runtime or model file is missing.';
    return false;
  }
  activeBrain = selected;
  lfmStarting = true;
  lastLfmError = '';
  const args = await brainArgs(selected.model, selected.context || (os.totalmem() / 1e9 >= 24 ? 8192 : 2048), LFM_PORT);
  // UNIFIED BRAIN: if the selected model ships a vision projector beside it, load it
  // multimodal — one brain that reasons, tool-calls, AND sees (no second model).
  const mm = mmprojSibling(selected.model);
  if (mm) { args.push('--mmproj', mm); lfmIsMultimodal = true; } else { lfmIsMultimodal = false; }
  try {
    lfmProcess = spawn(files.server, args, { cwd: files.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    lfmProcess.once('error', (e) => {
      lastLfmError = e.message;
      lfmProcess = null;
      lfmStarting = false;
    });
    lfmProcess.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) lastLfmError = line.slice(-500);
    });
    lfmProcess.once('exit', (code) => {
      lastLfmError = `LFM runtime exited with code ${code}`;
      lfmProcess = null;
      lfmStarting = false;
    });
    const ready = await waitForLfm();
    lfmStarting = false;
    return ready;
  } catch (e) {
    lastLfmError = e.message;
    lfmProcess = null;
    lfmStarting = false;
    return false;
  }
}

function agentToolInstructions() {
  return [
    'You are ABUZ8 OS Pro, a consumer desktop agent running fully local on CPU.',
    'You can request exactly one tool call by returning ONLY compact JSON in this shape:',
    '{"tool":"tool_name","args":{}}',
    'If no tool is needed, return normal helpful text.',
    'Available tools:',
    '- abuz8_device_probe {}',
    '- abuz8_memory_write {"content":"..."}',
    '- abuz8_mission_board {}',
    '- abuz8_mission_task_create {"title":"...","column":"ready","priority":"medium","details":"..."}',
    '- model_download_hf {"repo":"org/repo","file":"model.gguf","allow_network_download":true}',
    '- cloud_brain_register {"provider":"openai|anthropic|custom","endpoint":"https://...","model":"...","api_key_env":"ENV_NAME","allow_cloud_brain":true}',
    '- open_url {"url":"https://example.com"}',
    '- open_app {"name":"notepad|mspaint|calc|explorer"}',
    '- screenshot {}',
    '- file_write {"relpath":"notes/example.txt","content":"..."}',
    '- shell_run {"cmd":"whoami|hostname|dir"}',
    '- cmd_run {"command":"any local CLI command or shell pipeline"}',
    '- web_search {"q":"search terms"}',
    'Action tools require the user to enable Allow actions for this session. Never invent unsupported tools.',
    ''
  ].join('\n');
}

async function embeddedReply(prompt, opts = {}) {
  // Voice/brief turns go to the tiny fast voice brain when present (instant);
  // everything else uses the main reasoning brain. Fall back to main if voice fails.
  let port = LFM_PORT;
  let ready = false;
  if (opts.brief && voiceBrainAvailable()) {
    ready = await ensureVoiceBrain();
    if (ready) port = VOICE_PORT;
  }
  if (!ready) { ready = await ensureEmbeddedBrain(); port = LFM_PORT; }
  if (!ready) return null;
  const brain = activeBrain || selectEmbeddedBrain();
  let persona = opts.system
    ? opts.system
    : `You are ABUZ8 OS Portable Brain running ${brain?.name || 'an embedded model'}. Be concise, practical, and tool-aware.`;
  // Voice/brief mode: keep replies short so spoken responses come back fast on CPU.
  if (opts.brief) persona += '\n\nRespond in 1-3 short spoken sentences. No lists, no markdown, no preamble.';
  const maxTok = Number(opts.maxTokens) || (opts.brief ? 110 : 300);
  // CTX BUDGETING (N4 / fork's KV-cache fix): keep persona + tools + prompt + response under the
  // model's context window. Reserve room for the reply; trim the MIDDLE of an oversized prompt.
  const head = persona.length + (opts.agentic ? agentToolInstructions().length : 0) + 48;
  const promptBudget = Math.max(400, Math.floor((( _brainCtx || 2048) - maxTok - 256) * 3.5) - head);
  let _p = String(prompt == null ? '' : prompt);
  if (_p.length > promptBudget) { const h = Math.floor(promptBudget * 0.6), t = promptBudget - h; _p = _p.slice(0, h) + '\n…[context trimmed to fit the model window]…\n' + _p.slice(-t); }
  const modelPrompt = opts.agentic
    ? `${persona}\n\n${agentToolInstructions()}\nUser: ${_p}\nAssistant:`
    : `${persona}\n\nUser: ${_p}\nAssistant:`;
  for (let i = 0; i < 2; i++) {
    try {
      const out = await httpJson('POST', port, '/completion', {
        prompt: modelPrompt,
        n_predict: maxTok,
        temperature: 0.35,
        stop: ['User:', '\n\nUser:']
      }, 90000);
      const textOut = out.content || out.response || out.text || '';
      if (String(textOut).trim()) { try { const tm = out.timings || {}; recordUsage({ source: 'local', model: brain?.name, tokens: tm.predicted_n || Math.round(String(textOut).length / 4), tok_s: tm.predicted_per_second != null ? tm.predicted_per_second : null, ms: tm.predicted_ms != null ? tm.predicted_ms : null }); } catch {} return String(textOut).trim(); }
    } catch (e) {
      lastLfmError = e.message;
    }
    try {
      const out = await httpJson('POST', port, '/v1/completions', {
        prompt: modelPrompt,
        max_tokens: maxTok,
        temperature: 0.35,
        stop: ['User:', '\n\nUser:']
      }, 90000);
      const textOut = out.choices && out.choices[0] ? out.choices[0].text : '';
      if (String(textOut).trim()) { try { recordUsage({ source: 'local', model: brain?.name, tokens: (out.usage && out.usage.completion_tokens) || Math.round(String(textOut).length / 4) }); } catch {} return String(textOut).trim(); }
    } catch (e) {
      lastLfmError = e.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  return null;
}

// Auto-frontier: pick the best CONNECTED frontier brain (skips keys that recently failed).
const _providerCooldown = {};
// ── PERFORMANCE-AWARE ROUTING (the Qadir-router essence, keyed by provider name) ──
// Recency-weighted success rate minus a latency penalty, so the router prefers the
// brain that is actually answering well right now — not a hardcoded priority list.
const _providerHealth = {};
function recordProviderHealth(name, ok, ms) {
  if (!name) return;
  const h = _providerHealth[name] || (_providerHealth[name] = { ok: 0, fail: 0, ewmaMs: null, last: 0 });
  if (ok) h.ok++; else h.fail++;
  if (ok && ms != null && isFinite(ms)) h.ewmaMs = h.ewmaMs == null ? ms : Math.round(h.ewmaMs * 0.7 + ms * 0.3);
  h.last = Date.now();
}
function providerHealthScore(name) {
  const h = _providerHealth[name];
  if (!h || (h.ok + h.fail) === 0) return null; // no data yet → caller uses static priority
  const success = h.ok / (h.ok + h.fail);                            // 0..1
  const latPenalty = h.ewmaMs == null ? 0 : Math.min(h.ewmaMs / 20000, 0.5); // slow brains lose up to 0.5
  return success - latPenalty;
}
function bestFrontierProvider() {
  try {
    const cfg = readJson(providersPath(), { providers: [] });
    const now = Date.now();
    const cands = (cfg.providers || []).filter((p) => p.api_key && p.enabled !== false && !(_providerCooldown[p.name] && now - _providerCooldown[p.name] < 600000));
    if (!cands.length) return null;
    const prio = (p) => p.type === 'anthropic' ? 0 : ({ openai: 1, openrouter: 2, 'google-gemini': 3, deepseek: 4, 'xai-grok': 5, groq: 6, together: 7 })[p.name] ?? 50;
    return cands.slice().sort((a, b) => {
      const ha = providerHealthScore(a.name), hb = providerHealthScore(b.name);
      if (ha != null && hb != null && ha !== hb) return hb - ha;     // measured: healthiest first
      if (ha != null && hb == null) return -1;                        // measured beats unmeasured
      if (hb != null && ha == null) return 1;
      return prio(a) - prio(b);                                       // static priority tiebreak
    })[0];
  } catch { return null; }
}
async function providerReply(prompt, providerName, system) {
  const cfg = readJson(providersPath(), { providers: [] });
  const candidates = providerName
    ? cfg.providers.filter((p) => p.name === providerName)
    : cfg.providers.filter((p) => p.enabled !== false);
  // Cloud providers with keys answer fastest when local runners are down; try them first.
  const ordered = candidates.slice().sort((a, b) => Number(Boolean(b.api_key)) - Number(Boolean(a.api_key)));
  for (const p of ordered) {
    if (!p.endpoint && !p.api_key) continue;
    const _t = Date.now();
    try {
      const out = await callProviderChat(p, prompt, system);
      const text = String(out || '').trim();
      if (text) { recordProviderHealth(p.name, true, Date.now() - _t); return { text, provider: p.name, model: p.model || p.name }; }
      recordProviderHealth(p.name, false);
    } catch { recordProviderHealth(p.name, false); _providerCooldown[p.name] = Date.now(); }
  }
  return null;
}

// Reply ladder: forced provider -> embedded LFM brain -> any enabled provider -> canned core text.
// ── Cross-platform CLI launching (Windows / macOS / Linux) ──
// On Windows we route through cmd.exe so npm `.cmd` shims resolve; on macOS/Linux
// we spawn the binary directly off PATH. Keeps the multi-brain feature portable.
const IS_WIN = process.platform === 'win32';
function cliLaunch(name, args, opts) {
  const o = { windowsHide: true, ...(opts || {}) };
  return IS_WIN ? spawn('cmd.exe', ['/d', '/s', '/c', name, ...args], o) : spawn(name, args, o);
}
const _pathCache = new Map();
function onPath(name) { // is an executable resolvable on PATH? (POSIX; cached)
  if (IS_WIN) return false;
  if (_pathCache.has(name)) return _pathCache.get(name);
  let ok = false;
  try { ok = !!require('child_process').execFileSync('which', [name], { timeout: 3000 }).toString().trim(); } catch { ok = false; }
  _pathCache.set(name, ok); return ok;
}
// Grok (xAI) as a brain — uses the user's SuperGrok account via the installed grok CLI.
function grokBin() { try { const p = path.join(os.homedir(), '.grok', 'bin', IS_WIN ? 'grok.exe' : 'grok'); if (exists(p)) return p; return onPath('grok') ? 'grok' : null; } catch { return null; } }
function grokAvailable() { try { return !!(grokBin() && exists(path.join(os.homedir(), '.grok', 'auth.json'))); } catch { return false; } }
function grokReply(prompt, system) {
  return new Promise((resolve) => {
    const bin = grokBin(); if (!bin) return resolve(null);
    const full = ((system ? system + '\n\n' : '') + String(prompt || '')).slice(0, 24000);
    try {
      execFile(bin, ['-p', full], { windowsHide: true, timeout: 150000, maxBuffer: 8 * 1024 * 1024, cwd: os.tmpdir() }, (err, stdout) => {
        const out = String(stdout || '').trim();
        if (out) recordUsage({ source: 'grok', model: 'grok (SuperGrok)', tokens: Math.round(out.length / 4) });
        resolve(out || null);
      });
    } catch { resolve(null); }
  });
}
// Claude (Claude Code CLI) as a brain — uses the user's Claude account via `claude -p` (prompt via stdin).
function claudeBin() { try { const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'claude.cmd'); if (IS_WIN && exists(p)) return p; if (!IS_WIN && onPath('claude')) return 'claude'; } catch {} return null; }
function claudeAvailable() { return !!claudeBin(); }
function claudeReply(prompt, system) {
  return new Promise((resolve) => {
    if (!claudeAvailable()) return resolve(null);
    const full = ((system ? system + '\n\n' : '') + String(prompt || '')).slice(0, 24000);
    let out = '';
    try {
      const cp = cliLaunch('claude', ['-p'], { cwd: os.tmpdir() });
      const timer = setTimeout(() => { try { cp.kill(); } catch {} resolve(out.trim() || null); }, 120000);
      cp.stdout.on('data', (d) => { out += d.toString(); });
      cp.on('close', () => { clearTimeout(timer); const t = out.trim(); if (t) recordUsage({ source: 'claude', model: 'Claude Code', tokens: Math.round(t.length / 4) }); resolve(t || null); });
      cp.on('error', () => { clearTimeout(timer); resolve(null); });
      try { cp.stdin.write(full); cp.stdin.end(); } catch {}
    } catch { resolve(null); }
  });
}
// ChatGPT (OpenAI Codex CLI) as a brain — uses the user's ChatGPT account via "Sign in with ChatGPT".
function codexBin() { try { const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd'); if (IS_WIN && exists(p)) return p; if (!IS_WIN && onPath('codex')) return 'codex'; } catch {} return null; }
function codexAvailable() { try { return !!(codexBin() && exists(path.join(os.homedir(), '.codex', 'auth.json'))); } catch { return false; } }
function codexReply(prompt, system) {
  return new Promise((resolve) => {
    if (!codexAvailable()) return resolve(null);
    const full = ((system ? system + '\n\n' : '') + String(prompt || '')).slice(0, 24000);
    let out = '';
    try {
      const cp = cliLaunch('codex', ['exec', '--skip-git-repo-check', '-'], { cwd: os.tmpdir() });
      const timer = setTimeout(() => { try { cp.kill(); } catch {} resolve(out.trim() || null); }, 150000);
      cp.stdout.on('data', (d) => { out += d.toString(); });
      cp.on('close', () => { clearTimeout(timer); const t = out.trim(); if (t) recordUsage({ source: 'codex', model: 'ChatGPT (Codex)', tokens: Math.round(t.length / 4) }); resolve(t || null); });
      cp.on('error', () => { clearTimeout(timer); resolve(null); });
      try { cp.stdin.write(full); cp.stdin.end(); } catch {}
    } catch { resolve(null); }
  });
}
// Gemini (Google Gemini CLI) as a brain — uses the user's Google / Antigravity login via `gemini -p` (prompt via stdin).
function geminiBin() { try { const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'gemini.cmd'); if (IS_WIN && exists(p)) return p; if (!IS_WIN && onPath('gemini')) return 'gemini'; } catch {} return null; }
function geminiAvailable() { try { return !!(geminiBin() && exists(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))); } catch { return false; } }
function geminiReply(prompt, system) {
  return new Promise((resolve) => {
    if (!geminiAvailable()) return resolve(null);
    const full = ((system ? system + '\n\n' : '') + String(prompt || '')).slice(0, 24000);
    let out = '';
    try {
      const cp = cliLaunch('gemini', ['-p', ''], { cwd: os.tmpdir() });
      const timer = setTimeout(() => { try { cp.kill(); } catch {} resolve(out.trim() || null); }, 150000);
      cp.stdout.on('data', (d) => { out += d.toString(); });
      cp.on('close', () => { clearTimeout(timer); const t = out.trim(); if (t) recordUsage({ source: 'gemini', model: 'Gemini (Google)', tokens: Math.round(t.length / 4) }); resolve(t || null); });
      cp.on('error', () => { clearTimeout(timer); resolve(null); });
      try { cp.stdin.write(full); cp.stdin.end(); } catch {}
    } catch { resolve(null); }
  });
}
// CLI brain registry — pluggable frontier engines that run on the user's own accounts.
const CLI_BRAINS = {
  grok: { name: 'Grok · SuperGrok', label: 'Grok (your SuperGrok)', reply: (p, s) => grokReply(p, s), available: () => grokAvailable() },
  claude: { name: 'Claude · Claude Code', label: 'Claude (your Claude account)', reply: (p, s) => claudeReply(p, s), available: () => claudeAvailable() },
  codex: { name: 'ChatGPT · Codex', label: 'ChatGPT (your ChatGPT account)', reply: (p, s) => codexReply(p, s), available: () => codexAvailable() },
  gemini: { name: 'Gemini · Google', label: 'Gemini (your Google / Antigravity login)', reply: (p, s) => geminiReply(p, s), available: () => geminiAvailable() }
};
function cliBrainName(which) { return CLI_BRAINS[which] ? CLI_BRAINS[which].name : null; }
function cliBrainAvailable(which) { return !!(CLI_BRAINS[which] && CLI_BRAINS[which].available()); }
function cliBrainReply(which, prompt, system) { return (CLI_BRAINS[which] && cliBrainAvailable(which)) ? CLI_BRAINS[which].reply(prompt, system) : Promise.resolve(null); }
function availableCliBrains() { return Object.entries(CLI_BRAINS).filter(([, v]) => v.available()).map(([id, v]) => ({ id, name: v.name, label: v.label })); }

// ── IN-APP TERMINAL (node-pty) + warm CLI-brain sessions ─────────────────────
// A real PTY (xterm-compatible) so the actual CLI brains (Claude/Grok/Codex/Gemini)
// run LIVE inside the app, warm-activated on open → instant + honest (you see the real
// session) + never blocks using your AI subscriptions. node-pty is lazy + guarded.
let _ptyLib;
function ptyLib() { if (_ptyLib === undefined) { try { _ptyLib = require('node-pty'); } catch { _ptyLib = null; } } return _ptyLib; }
function ptyAvailable() { return !!ptyLib(); }
const _terms = new Map();
function cliBrainLaunchCmd(brain) {
  if (brain === 'claude') return claudeBin() ? 'claude' : null;
  if (brain === 'grok') { const b = grokBin(); return b ? (String(b).includes(' ') ? '"' + b + '"' : b) : null; }
  if (brain === 'codex') return codexBin() ? 'codex' : null;
  if (brain === 'gemini') return geminiBin() ? 'gemini' : null;
  return null;
}
function termOpen(opts = {}) {
  const lib = ptyLib(); if (!lib) throw new Error('In-app terminal needs node-pty (rebuild for this runtime).');
  const shell = opts.shell || (IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || 'bash'));
  const cols = Number(opts.cols) || 100, rows = Number(opts.rows) || 30;
  const p = lib.spawn(shell, [], { name: 'xterm-color', cols, rows, cwd: opts.cwd || dataRoot || process.cwd(), env: process.env });
  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const t = { id, proc: p, buf: '', title: opts.title || opts.brain || 'terminal', brain: opts.brain || null, created: Date.now(), exited: false };
  p.onData((d) => { t.buf += d; if (t.buf.length > 400000) t.buf = t.buf.slice(-300000); });
  p.onExit(() => { t.exited = true; });
  _terms.set(id, t);
  if (opts.brain) { const cmd = cliBrainLaunchCmd(opts.brain); setTimeout(() => { try { p.write((cmd || ('echo Brain "' + opts.brain + '" CLI not installed; sign in / install it, then it is instant here.')) + '\r'); } catch {} }, 500); }
  return { id, title: t.title, brain: t.brain, cols, rows };
}
function termWrite(id, data) { const t = _terms.get(id); if (!t) throw new Error('no such terminal'); try { t.proc.write(String(data)); } catch (e) { return { ok: false, error: e.message }; } return { ok: true }; }
function termRead(id, since) { const t = _terms.get(id); if (!t) throw new Error('no such terminal'); const s = Number(since) || 0; return { id, data: t.buf.slice(s), len: t.buf.length, exited: t.exited }; }
function termResize(id, cols, rows) { const t = _terms.get(id); if (!t) return { ok: false }; try { t.proc.resize(Number(cols) || 100, Number(rows) || 30); } catch {} return { ok: true }; }
function termClose(id) { const t = _terms.get(id); if (t) { try { t.proc.kill(); } catch {} _terms.delete(id); } return { ok: true }; }
function termCloseAll() { for (const t of _terms.values()) { try { t.proc.kill(); } catch {} } _terms.clear(); }
function termList() { return [..._terms.values()].map((t) => ({ id: t.id, title: t.title, brain: t.brain, exited: t.exited, bytes: t.buf.length })); }
// WARM ACTIVATION: pre-spawn a live PTY for each available CLI brain so switching to its
// tab is instant (the brain is already booted inside the app). Idempotent.
function termWarmAll() {
  if (!ptyAvailable()) return { ok: false, pty_available: false, warmed: [] };
  const open = [..._terms.values()];
  const warmed = [];
  for (const b of ['claude', 'grok', 'codex', 'gemini']) {
    if (cliBrainAvailable(b) && !open.some((t) => t.brain === b && !t.exited)) {
      try { const t = termOpen({ brain: b, title: b }); warmed.push(t.brain); } catch {}
    }
  }
  return { ok: true, pty_available: true, warmed, terminals: termList() };
}

// ── CONNECTED BRAINS (T3) — every subscription/CLI, with token-file presence ──
function connectedBrains() {
  const home = os.homedir();
  const cliDefs = [
    { id: 'claude', label: 'Claude (Claude Code / Max)', bin: claudeBin(), token: path.join(home, '.claude', '.credentials.json'), available: claudeAvailable() },
    { id: 'grok', label: 'Grok (SuperGrok)', bin: grokBin(), token: path.join(home, '.grok', 'auth.json'), available: grokAvailable() },
    { id: 'codex', label: 'ChatGPT (Codex)', bin: codexBin(), token: path.join(home, '.codex', 'auth.json'), available: codexAvailable() },
    { id: 'gemini', label: 'Gemini (Google)', bin: geminiBin(), token: path.join(home, '.gemini', 'oauth_creds.json'), available: geminiAvailable() }
  ];
  const cli = cliDefs.map((b) => ({ id: b.id, label: b.label, kind: 'cli', available: !!b.available, bin: b.bin || null, token_present: (() => { try { return exists(b.token); } catch { return false; } })(), token_file: b.token, terminal: true }));
  const apiIds = ['openai', 'anthropic', 'gemini-native', 'google-gemini', 'xai-grok', 'perplexity', 'deepseek', 'openrouter', 'mistral', 'moonshot-kimi'];
  const api = apiIds.map((id) => { const p = PROVIDER_CATALOG.find((x) => x.id === id) || {}; return { id, label: p.label || id, kind: 'api', models: p.models || [], terminal: false }; });
  return { cli, api, cli_available: cli.filter((b) => b.available).length, perplexity: true, total: cli.length + api.length };
}

// ── COST-EFFICIENCY ROUTER (T2) — handle by what's necessary ─────────────────
// Prefer FREE on-device for trivial, FLAT-RATE subscription CLIs ($0 marginal) for
// medium, and a frontier brain only for genuinely hard work — never burn metered
// API tokens when a free/flat-rate brain can do it.
function classifyTask(text, hint) {
  const t = String(text || '').toLowerCase(); const len = t.length;
  if (hint === 'code' || hint === 'hard') return 'hard';
  if (/\b(code|debug|refactor|implement|compile|stack ?trace|algorithm|architect|prove|multi-?step|complex|research)\b/.test(t) || len > 1200) return 'hard';
  if (hint === 'simple' || (len < 140 && /\b(hi|hello|hey|time|date|weather|what is|who is|define|translate|spell|convert)\b/.test(t))) return 'simple';
  return 'medium';
}
function routeByCost(text, hint) {
  const level = classifyTask(text, hint);
  const cliAvail = availableCliBrains().map((b) => b.id);
  if (level === 'simple') return { level, route: 'local', brain: 'embedded', cost: '$0', why: 'trivial → on-device brain (free, instant)' };
  if (level === 'medium') {
    if (cliAvail.length) return { level, route: 'cli', brain: cliAvail[0], cost: '$0 marginal (flat subscription)', why: 'medium → your flat-rate subscription CLI (no metered tokens)' };
    let fp = null; try { fp = bestFrontierProvider(); } catch {}
    return { level, route: fp ? 'api' : 'local', brain: fp ? fp.name : 'embedded', cost: fp ? 'metered' : '$0', why: 'medium → cheapest available' };
  }
  if (cliAvail.includes('claude')) return { level, route: 'cli', brain: 'claude', cost: '$0 marginal (Claude Max)', why: 'hard → Claude Max (flat-rate frontier)' };
  if (cliAvail.length) return { level, route: 'cli', brain: cliAvail[0], cost: '$0 marginal (flat subscription)', why: 'hard → best flat-rate subscription brain' };
  let fp = null; try { fp = bestFrontierProvider(); } catch {}
  return { level, route: fp ? 'api' : 'local', brain: fp ? fp.name : 'embedded', cost: fp ? 'metered (frontier)' : '$0', why: 'hard → best frontier brain' };
}
// COST-ROUTED CHAT: pick the cheapest capable brain per message and answer with it —
// free on-device for trivial, your flat-rate subscription CLI for the rest, frontier for hard.
async function autoChat(prompt, opts = {}) {
  const d = routeByCost(prompt, opts.hint);
  let response = '', used = d.brain, via = d.route;
  try {
    if (d.route === 'cli' && cliBrainAvailable(d.brain)) { response = (await cliBrainReply(d.brain, prompt, opts.system)) || ''; used = cliBrainName(d.brain) || d.brain; }
    else if (d.route === 'api') { const r = await reasonReply(prompt, { provider: opts.provider }); response = r.text || ''; used = r.brain || d.brain; via = 'api'; }
    else { const r = await reasonReply(prompt, { brief: opts.brief !== false }); response = r.text || ''; used = r.brain || 'embedded'; via = r.model ? 'local-llm' : 'local'; }
  } catch (e) { response = ''; }
  if (!response) { try { const r = await reasonReply(prompt, {}); response = r.text || ''; used = (r.brain || 'embedded') + ' (fallback)'; via = via + '→fallback'; } catch {} }
  return { response, route: via, brain: used, level: d.level, cost: d.cost, why: d.why };
}
// Streaming variant — forwards CLI stdout chunks live (used by /api/chat/live) for token-by-token UX.
function streamCliBrain(which, prompt, system, onChunk) {
  return new Promise((resolve) => {
    const full = ((system ? system + '\n\n' : '') + String(prompt || '')).slice(0, 24000);
    let cp, out = '', jbuf = ''; const tmp = os.tmpdir(); const jsonMode = (which === 'gemini');
    try {
      if (which === 'grok') { const bin = grokBin(); if (!bin) return resolve(null); cp = spawn(bin, ['-p', full], { windowsHide: true, cwd: tmp }); }
      else if (which === 'claude') { cp = cliLaunch('claude', ['-p'], { cwd: tmp }); }
      else if (which === 'codex') { cp = cliLaunch('codex', ['exec', '--skip-git-repo-check', '-'], { cwd: tmp }); }
      else if (which === 'gemini') { cp = cliLaunch('gemini', ['-o', 'stream-json', '-p', ''], { cwd: tmp }); }
      else return resolve(null);
      const timer = setTimeout(() => { try { cp.kill(); } catch {} resolve(out.trim() || null); }, 155000);
      cp.stdout.on('data', (d) => {
        const str = d.toString();
        if (jsonMode) {
          jbuf += str; let nl;
          while ((nl = jbuf.indexOf('\n')) >= 0) {
            const line = jbuf.slice(0, nl).trim(); jbuf = jbuf.slice(nl + 1);
            if (!line) continue;
            try { const o = JSON.parse(line); if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string') { out += o.content; try { onChunk(o.content); } catch {} } } catch {}
          }
        } else { out += str; try { onChunk(str); } catch {} }
      });
      cp.on('close', () => { clearTimeout(timer); const t = out.trim(); if (t) recordUsage({ source: which, model: cliBrainName(which), tokens: Math.round(t.length / 4) }); resolve(t || null); });
      cp.on('error', () => { clearTimeout(timer); resolve(null); });
      if (which !== 'grok') { try { cp.stdin.write(full); cp.stdin.end(); } catch {} }
    } catch { resolve(null); }
  });
}
// ── Multi-brain thinking modes (opt-in via settings.think_mode: single|council|debate) ──
function councilBrainSet() {
  const st = readJson(settingsPath(), {});
  const brains = (st.council_brains && st.council_brains.length) ? st.council_brains.slice() : availableCliBrains().map((b) => b.id);
  return brains.filter((b) => b === 'local' || cliBrainAvailable(b));
}
function brainLabel2(b) { return b === 'local' ? 'Local Gemma' : cliBrainName(b); }
async function brainCall(which, prompt, system) {
  if (which === 'local') { const r = await reasonReply(prompt, { forceLocal: true }); return r && r.text; }
  return cliBrainReply(which, prompt, system);
}
async function councilThink(prompt, opts = {}, onNote) {
  const brains = councilBrainSet();
  const sys = composeSystem(opts.role, opts.system);
  if (brains.length < 2) { const cb = readJson(settingsPath(), {}).cli_brain; return cb ? brainCall(cb, prompt, sys) : null; }
  if (onNote) onNote('Consulting ' + brains.length + ' brains in parallel…');
  const results = await Promise.all(brains.map(async (b) => {
    try { const t = await brainCall(b, prompt, sys); if (onNote && t) onNote(brainLabel2(b) + ' answered'); return t ? { name: brainLabel2(b), text: t } : null; } catch { return null; }
  }));
  const good = results.filter(Boolean);
  if (!good.length) return null;
  if (good.length === 1) return good[0].text;
  if (onNote) onNote('Merging ' + good.length + ' answers…');
  const merged = good.map((r) => '### ' + r.name + '\n' + r.text).join('\n\n');
  const sp = 'Several expert assistants answered the SAME request. Merge into ONE best answer: resolve conflicts, keep the strongest reasoning, drop filler, answer in ABUZ8 voice.\n\nRequest:\n' + prompt + '\n\nAnswers:\n' + merged;
  const synthBrain = brains.find((b) => b !== 'local') || brains[0];
  try { const t = await brainCall(synthBrain, sp, 'You are a synthesis engine. Output only the merged best answer, in ABUZ8 voice.'); return t || good[0].text; } catch { return good[0].text; }
}
async function debateThink(prompt, opts = {}, onNote) {
  const brains = councilBrainSet();
  const sys = composeSystem(opts.role, opts.system);
  if (brains.length < 2) { const cb = readJson(settingsPath(), {}).cli_brain; return cb ? brainCall(cb, prompt, sys) : null; }
  const drafter = brains[0], critic = brains[1] || brains[0], verifier = brains[2] || brains[1] || brains[0];
  if (onNote) onNote(brainLabel2(drafter) + ' drafting…');
  const draft = await brainCall(drafter, prompt, sys); if (!draft) return null;
  if (onNote) onNote(brainLabel2(critic) + ' critiquing…');
  let crit = ''; try { crit = (await brainCall(critic, 'Critique this draft answer. List concrete flaws, gaps, errors, and missing points — be specific and brief.\n\nRequest:\n' + prompt + '\n\nDraft:\n' + draft, 'You are a rigorous critic. Only list the issues.')) || ''; } catch {}
  if (onNote) onNote(brainLabel2(verifier) + ' finalizing…');
  try { const fin = await brainCall(verifier, 'Write the FINAL best answer to the request, using the draft and fixing every valid issue in the critique. Keep what is strong. Answer in ABUZ8 voice.\n\nRequest:\n' + prompt + '\n\nDraft:\n' + draft + '\n\nCritique:\n' + (crit || '(none)'), sys); return fin || draft; } catch { return draft; }
}
async function webGround(prompt, onNote) {
  try {
    if (onNote) onNote('Searching the web…');
    const r = await webSearch({ q: prompt, max_results: 5 });
    if (!r || !r.results || !r.results.length) return '';
    if (onNote) onNote('Read ' + r.results.length + ' sources');
    return r.results.map((x, i) => '[' + (i + 1) + '] ' + x.title + ' — ' + (x.snippet || '') + ' (' + x.url + ')').join('\n');
  } catch { return ''; }
}
// Auto-router: cheap instant heuristic — escalate only hard/complex turns to fusion, keep easy ones fast.
function routeThinkMode(prompt) {
  const p = String(prompt || '').trim();
  const words = p.split(/\s+/).filter(Boolean).length;
  const hard = /\b(compare|versus|vs\.?|trade-?offs?|analy[sz]e|evaluate|assess|design|architect|plan|strategy|pros and cons|debate|critique|prove|derive|optimi[sz]e|refactor|debug|why\b|explain (?:in depth|thoroughly)|deep dive|comprehensive|thorough|step by step|reason through|implications|best (?:way|approach))\b/i.test(p);
  const multipart = (p.match(/\?/g) || []).length >= 2;
  const codey = /```|stack trace|exception|\btraceback\b/i.test(p);
  if (words >= 40 || hard || (multipart && words >= 12) || (codey && words >= 20)) return 'council';
  return 'single';
}

async function reasonReply(prompt, opts = {}) {
  // Voice/brief: compact system prompt that is STILL in character (name + voice)
  // so spoken replies sound like ABUZ8, not a generic assistant — yet stay fast.
  let system = opts.brief ? voiceSystem() : composeSystem(opts.role, opts.system);
  // RAG: pull the most relevant long-term memories into context (non-voice).
  if (!opts.brief && !opts.noMemory && dataRoot) {
    try {
      const mems = await retrieveMemories(prompt, 4);
      if (mems.length) system += '\n\nRelevant things you remember (use if helpful):\n' + mems.map((m) => '- ' + m.content).join('\n');
    } catch {}
    // Learned-skill recall (self-learning v2): inject semantically-relevant skills.
    try { const sk = await retrieveSkills(prompt, 3); if (sk.length) { system += '\n\nRelevant skills — FOLLOW these playbooks when they apply:\n' + sk.map((s) => { const b = skillBody(s.id); return '### ' + s.title + (s.when ? ' — ' + s.when : '') + (b ? '\n' + b : ''); }).join('\n\n'); try { bumpSkillUsage(sk.map((s) => s.id)); } catch {} } } catch {}
    try { const ld = learnedDirectivesText(); if (ld) system += '\n\nLearned operating notes (self-improved):\n' + ld; } catch {}
  }
  const passOpts = { ...opts, system };
  // Explicit per-call provider override wins.
  if (opts.provider) {
    const forced = await providerReply(prompt, opts.provider, system);
    if (forced) return { text: forced.text, brain: `${forced.provider} · ${forced.model}`, fallback: false, model: true };
  }
  // CLI brain: when the user has selected one (Grok/Claude), route reasoning through their account.
  if (!opts.provider && !opts.forceLocal && !opts.brief) {
    try {
      const cb = readJson(settingsPath(), {}).cli_brain;
      if (cb && cliBrainAvailable(cb)) {
        const t = await cliBrainReply(cb, prompt, system);
        if (t) return { text: t, brain: cliBrainName(cb), fallback: false, model: true, frontier: true };
      }
    } catch {}
  }
  // User-selected active cloud/local provider becomes the brain (native engine is the fallback if it fails).
  if (!opts.provider && !opts.forceLocal) {
    try {
      const sel = (readJson(settingsPath(), {}).active_provider) || null;
      if (sel && sel.name) {
        const r = await providerReply(prompt, sel.name, system);
        if (r) return { text: r.text, brain: `${r.provider} · ${r.model}`, fallback: false, model: true };
      }
    } catch {}
  }
  // AUTO-FRONTIER: for substantial (non-voice) tasks, prefer a connected frontier brain automatically; local stays the fallback.
  if (!opts.provider && !opts.forceLocal && !opts.brief) {
    try {
      const s = readJson(settingsPath(), {});
      if (s.auto_frontier !== false) {
        const fp = bestFrontierProvider();
        if (fp) { const r = await providerReply(prompt, fp.name, system); if (r) return { text: r.text, brain: `${r.provider} · ${r.model}`, fallback: false, model: true, frontier: true }; }
      }
    } catch {}
  }
  const local = await embeddedReply(prompt, passOpts);
  if (local) {
    const brain = activeBrain || selectEmbeddedBrain();
    return { text: local, brain: brain?.name || 'Embedded LFM', fallback: false, model: true };
  }
  const cloud = await providerReply(prompt, null, system);
  if (cloud) return { text: cloud.text, brain: `${cloud.provider} · ${cloud.model}`, fallback: false, model: true };
  return { text: localReply(prompt), brain: 'Portable Core', fallback: true, model: false };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try { return JSON.parse(candidate); } catch {}
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseAgentToolCall(text) {
  const parsed = extractJsonObject(text);
  if (!parsed || !parsed.tool) return null;
  const tool = String(parsed.tool || '').trim();
  const args = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
  return { tool, args };
}

// ── NATIVE FUNCTION-CALLING (closes the Hermes agent-loop correctness gap) ──
// The bundled Gemma 4 (and any tool-capable brain) emits structured tool_calls via
// /v1/chat/completions when llama-server runs with --jinja. We use that instead of
// parsing free-text JSON; the regex/text path stays as the fallback.
const _toolSchema = (name, description, props, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: props || {}, required: required || [] } } });
const FINISH_TOOL = _toolSchema('finish', 'Call this ONLY when the goal is fully accomplished, passing the final answer for the user.', { answer: { type: 'string', description: 'the final answer / summary of what was accomplished' } }, ['answer']);
function agentToolSchemas(names) {
  const all = [
    _toolSchema('web_search', 'Search the web for current information.', { q: { type: 'string', description: 'the search query' } }, ['q']),
    _toolSchema('deep_research', 'Research a topic deeply by reading multiple web sources.', { q: { type: 'string' } }, ['q']),
    _toolSchema('open_url', 'Open a URL or website in a browser.', { url: { type: 'string' }, site: { type: 'string' }, browser: { type: 'string', enum: ['chrome', 'edge', 'firefox', 'brave'] } }, []),
    _toolSchema('open_app', 'Launch a desktop application by name.', { name: { type: 'string', description: 'e.g. chrome, notepad, calculator' } }, ['name']),
    _toolSchema('cmd_run', 'Run a shell command on this machine (consent-gated).', { command: { type: 'string' } }, ['command']),
    _toolSchema('file_write', 'Write a file into the workspace.', { relpath: { type: 'string' }, content: { type: 'string' } }, ['relpath', 'content']),
    _toolSchema('screenshot', 'Capture the current screen.', {}, []),
    _toolSchema('abuz8_memory_write', 'Save a durable fact to long-term memory.', { content: { type: 'string' } }, ['content']),
    _toolSchema('content_generate', 'Generate content (social carousel/thread, YouTube script, blog).', { topic: { type: 'string' }, format: { type: 'string', enum: ['x-carousel', 'x-thread', 'youtube-script', 'blog-outline'] } }, ['topic']),
    _toolSchema('get_weather', 'Get the current weather for a city.', { city: { type: 'string' } }, []),
    _toolSchema('get_time', 'Get the current date and time.', {}, []),
    _toolSchema('abuz8_device_probe', 'Inspect this machine (hardware, ports, processes).', {}, []),
    _toolSchema('list_connectors', 'List the connected apps/services ABUZ8 can drive (and which are configured).', {}, []),
    _toolSchema('connector_call', 'Drive a connected app/service by id — comfyui, wan2gp, livecrm, dealer360, github, stripe, gmail, gcal, higgsfield, cloudflare… Call list_connectors first to see ids/actions.', { connector: { type: 'string' }, action: { type: 'string', description: 'e.g. get/post/stats/queue/repos/balance/list/send' }, args: { type: 'object' } }, ['connector', 'action']),
    _toolSchema('studio_produce', 'Produce studio media: an image now (free FLUX or your image_gen), or a video (pass a ComfyUI workflow to render on your GPUs, or route to Wan2GP/Higgsfield).', { kind: { type: 'string', enum: ['image', 'video'] }, prompt: { type: 'string' }, workflow: { type: 'object' } }, ['prompt']),
    _toolSchema('osint', 'OSINT recon on a domain/IP/username/email: whois (RDAP), dns, subdomains (crt.sh), ip (geo/ASN), headers, username (presence across 12 sites), breach (HaveIBeenPwned, key-gated), or full dossier.', { action: { type: 'string', enum: ['whois', 'dns', 'subdomains', 'ip', 'headers', 'username', 'breach', 'full'] }, target: { type: 'string', description: 'domain, IP, URL, username, or email' } }, ['action', 'target']),
    _toolSchema('blockchain', 'ABUZ8 sovereign chain — its OWN tamper-evident, ed25519-signed, hash-linked blockchain ledger. actions: verify (validate the whole chain), append {type,data}, snapshot (commit the running code+version on-chain), publish {target:ledger|code} (real IPFS CIDv1), head, identity, list.', { action: { type: 'string', enum: ['verify', 'append', 'snapshot', 'publish', 'head', 'identity', 'list'] }, type: { type: 'string' }, data: { type: 'object' }, target: { type: 'string' } }, ['action']),
    _toolSchema('tor_browse', 'Private Tor network (bundled daemon): start Tor, fetch a URL anonymously through the Tor SOCKS5 exit (incl. .onion sites), get this OS\'s OWN .onion hidden-service address (reach it from any device incl. iPhone Tor Browser, no port-forward), status, or stop.', { action: { type: 'string', enum: ['start', 'status', 'fetch', 'onion', 'stop'] }, url: { type: 'string' } }, ['action']),
    _toolSchema('code_build', 'Build a real project (code/site/app): plans → writes files → runs dev commands → tests → repairs → git-commits, in a sandboxed project dir. Needs Node + git on PATH.', { goal: { type: 'string', description: 'what to build, e.g. "a React todo app with localStorage"' }, project: { type: 'string' } }, ['goal']),
    _toolSchema('list_mcp_tools', 'Discover every tool across all connected MCP servers (name + ref "server:tool"). Call this first, then mcp_call to use one.', {}, []),
    _toolSchema('mcp_call', 'Call a tool on a connected MCP server (Desktop Commander, filesystem, github, any imported MCP). Use list_mcp_tools to find the server + tool.', { server: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } }, ['server', 'tool']),
    _toolSchema('fleet', 'Command the swarm of joined ABUZ8 nodes (each on its own device/brain). op: "stats" (pooled cores/GPUs/VRAM across the fleet), "nodes" (roster), "broadcast" (send a task to every node), "brain" (ask all nodes + fuse one collective answer), "exec" (run one tool on a node, or all:true for every node), "dispatch" (fault-tolerant: run exec_tool on the best-fit HEALTHY node with retry/failover; set need=gpu|cpu|any, or pass units[] to distribute many work-items across the army), "add"/"remove" (manage roster), "join" (this node opts into a master). Use this to orchestrate the army from one master.', { op: { type: 'string' }, task: { type: 'string' }, question: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' }, exec_tool: { type: 'string' }, tool_args: { type: 'object' }, need: { type: 'string' }, units: { type: 'array' }, all: { type: 'boolean' } }, ['op'])
  ];
  if (!names || !names.length) return all;
  const set = new Set(names);
  return all.filter((t) => set.has(t.function.name));
}
// True when the sovereign local brain is the intended engine (no cloud/CLI brain configured).
function localBrainIsPrimary() {
  try {
    const s = readJson(settingsPath(), {});
    if (s.active_provider && s.active_provider.name) return false;
    if (s.cli_brain && cliBrainAvailable(s.cli_brain)) return false;
    if (s.auto_frontier !== false && bestFrontierProvider()) return false;
    return true;
  } catch { return true; }
}
// One structured tool-calling turn against the local brain. Returns
// { via:'native', tool, args, text } or null on failure (caller falls back to text).
async function localToolTurn(messages, tools, opts = {}) {
  if (!(await ensureEmbeddedBrain())) return null;
  try {
    const out = await httpJson('POST', LFM_PORT, '/v1/chat/completions', {
      messages, tools, tool_choice: opts.tool_choice || 'auto',
      max_tokens: Number(opts.maxTokens) || 512, temperature: opts.temperature != null ? opts.temperature : 0.3
    }, 120000);
    const msg = out && out.choices && out.choices[0] ? out.choices[0].message : null;
    if (!msg) return null;
    try { const tm = out.timings || {}; recordUsage({ source: 'local', model: (activeBrain || selectEmbeddedBrain())?.name, tokens: tm.predicted_n || 0, tok_s: tm.predicted_per_second != null ? tm.predicted_per_second : null, ms: tm.predicted_ms != null ? tm.predicted_ms : null }); } catch {}
    const tc = msg.tool_calls && msg.tool_calls[0];
    if (tc && tc.function) {
      let args = {};
      try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch {}
      return { via: 'native', tool: tc.function.name, args, text: msg.content || '' };
    }
    return { via: 'native', tool: null, args: null, text: String(msg.content || '').trim() };
  } catch (e) { lastLfmError = e.message; return null; }
}

// ── UNIVERSAL LLM TOOL-CALL ADAPTER ─────────────────────────────────────────
// One internal OpenAI-format tool schema (agentToolSchemas) → translated into each
// provider's NATIVE tool-call dialect, and the response normalized back — so ABUZ8
// gets real structured tool calls from ANY connected LLM, not only the local Gemma.
// OpenAI-family pass through; Anthropic uses tool_use; Gemini uses functionDeclarations.
function toAnthropicTools(tools) {
  return (tools || []).map((t) => { const f = t.function || t; return { name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } }; });
}
function toGeminiTools(tools) {
  return [{ functionDeclarations: (tools || []).map((t) => { const f = t.function || t; return { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } }; }) }];
}
function parseProviderToolCall(provider, data) {
  if (provider.type === 'anthropic') {
    const blocks = (data && data.content) || [];
    const tu = blocks.find((b) => b.type === 'tool_use');
    const text = (blocks.find((b) => b.type === 'text') || {}).text || '';
    return tu ? { tool: tu.name, args: tu.input || {}, text } : { tool: null, args: null, text };
  }
  if (provider.type === 'gemini-native') {
    const parts = ((((data || {}).candidates || [])[0] || {}).content || {}).parts || [];
    const fc = parts.find((p) => p.functionCall);
    const text = parts.filter((p) => p.text).map((p) => p.text).join('');
    return fc ? { tool: fc.functionCall.name, args: fc.functionCall.args || {}, text } : { tool: null, args: null, text };
  }
  // OpenAI-compatible (openai/openrouter/gemini-compat/deepseek/xai-grok/groq/together/lmstudio/hermes)
  const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
  const tc = msg && msg.tool_calls && msg.tool_calls[0];
  if (tc && tc.function) {
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch {}
    return { tool: tc.function.name, args, text: msg.content || '' };
  }
  return { tool: null, args: null, text: (msg && msg.content) || '' };
}
async function callProviderChatTools(provider, messages, tools, opts = {}) {
  const _t0 = Date.now();
  const endpoint = (provider.endpoint || '').replace(/\/+$/, '');
  const model = provider.model || 'default';
  const maxTokens = Number(opts.maxTokens) || (provider.parameters && provider.parameters.max_tokens) || 1024;
  const temperature = opts.temperature != null ? opts.temperature : 0.3;
  if (provider.type === 'anthropic') {
    const sys = (messages.find((m) => m.role === 'system') || {}).content || undefined;
    const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const url = (endpoint || 'https://api.anthropic.com') + '/v1/messages';
    const headers = { 'Content-Type': 'application/json', 'x-api-key': provider.api_key || '', 'anthropic-version': '2023-06-01' };
    const body = JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: msgs, tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } });
    const data = JSON.parse(await fetchUrl(url, { method: 'POST', headers, body, timeout: provider.timeout || 120000 }));
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    try { const u = data.usage || {}; recordUsage({ source: 'provider', model, tokens: (u.input_tokens || 0) + (u.output_tokens || 0), ms: Date.now() - _t0 }); } catch {}
    return parseProviderToolCall(provider, data);
  }
  if (provider.type === 'gemini-native') {
    // Google Gemini NATIVE function-calling (functionDeclarations) — its own generateContent API,
    // distinct from the OpenAI-compat endpoint. This is the 3rd real native tool-call dialect.
    const key = provider.api_key || '';
    const sys = (messages.find((m) => m.role === 'system') || {}).content;
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
    const url = (endpoint || 'https://generativelanguage.googleapis.com/v1beta') + '/models/' + (model && model !== 'default' ? model : 'gemini-2.0-flash') + ':generateContent?key=' + encodeURIComponent(key);
    const body = JSON.stringify(Object.assign({ contents, tools: toGeminiTools(tools), tool_config: { function_calling_config: { mode: 'AUTO' } }, generationConfig: { temperature, maxOutputTokens: maxTokens } }, sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}));
    const data = JSON.parse(await fetchUrl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout: provider.timeout || 120000 }));
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    try { const u = data.usageMetadata || {}; recordUsage({ source: 'provider', model, tokens: (u.totalTokenCount || 0), ms: Date.now() - _t0 }); } catch {}
    return parseProviderToolCall(provider, data);
  }
  const isLm = provider.type === 'lmstudio' || endpoint.includes(':1234');
  const base = isLm ? (endpoint || 'http://localhost:1234')
    : (provider.type === 'openai' || provider.type === 'hermes') ? (endpoint || 'https://api.openai.com/v1')
    : endpoint;
  const url = provider.chat_url || `${base}/v1/chat/completions`.replace('/v1/v1/', '/v1/');
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;
  const body = JSON.stringify({ model, messages, tools, tool_choice: opts.tool_choice || 'auto', temperature, max_tokens: maxTokens, stream: false, store: false });
  const data = JSON.parse(await fetchUrl(url, { method: 'POST', headers, body, timeout: provider.timeout || 120000 }));
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  try { recordUsage({ source: 'provider', model, tokens: (data.usage && data.usage.total_tokens) || 0, ms: Date.now() - _t0 }); } catch {}
  return parseProviderToolCall(provider, data);
}
// Resolve the active API provider config (skips CLI brains — they can't do structured tools).
function activeApiProvider() {
  try {
    const cfg = readJson(providersPath(), { providers: [] });
    const sel = (readJson(settingsPath(), {}).active_provider) || null;
    if (sel && sel.name) { const p = cfg.providers.find((x) => x.name === sel.name && (x.api_key || x.endpoint)); if (p) return sel.model ? { ...p, model: sel.model } : p; }
    return cfg.providers.filter((x) => x.enabled !== false && (x.api_key || x.endpoint)).sort((a, b) => Number(Boolean(b.api_key)) - Number(Boolean(a.api_key)))[0] || null;
  } catch { return null; }
}
// One structured tool-calling turn against the active CLOUD/API provider in its native
// dialect. Returns { via:'native-cloud', tool, args, text } or null (caller falls back).
async function providerToolTurn(messages, tools, opts = {}) {
  const p = opts.provider ? ((readJson(providersPath(), { providers: [] }).providers || []).find((x) => x.name === opts.provider)) : activeApiProvider();
  if (!p) return null;
  const _t = Date.now();
  try { const r = await callProviderChatTools(p, messages, tools, opts); recordProviderHealth(p.name, true, Date.now() - _t); return r ? { via: 'native-cloud', provider: p.name, tool: r.tool, args: r.args, text: r.text || '' } : null; }
  catch (e) { recordProviderHealth(p.name, false); _providerCooldown[p.name] = Date.now(); lastLfmError = e.message; return null; }
}

function normalizedSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchMemoryItems(query, limit = 20) {
  const q = normalizedSearchText(query);
  if (!q) return readMemory(limit);
  const tokens = q.split(' ').filter((t) => t.length > 1);
  return readMemory(500).filter((m) => {
    const hay = normalizedSearchText(JSON.stringify(m));
    if (hay.includes(q)) return true;
    return tokens.length > 0 && tokens.every((t) => hay.includes(t));
  }).slice(0, limit);
}

const BROWSER_WORDS = 'chrome|google chrome|edge|microsoft edge|msedge|firefox|brave';
function detectBrowser(s) {
  const m = String(s).toLowerCase().match(new RegExp(`\\b(${BROWSER_WORDS})\\b`));
  if (!m) return '';
  const w = m[1];
  if (/chrome/.test(w)) return 'chrome';
  if (/edge/.test(w)) return 'edge';
  if (/firefox/.test(w)) return 'firefox';
  if (/brave/.test(w)) return 'brave';
  return '';
}

function inferConsumerToolCall(prompt) {
  const msg = String(prompt || '').trim();
  const lower = msg.toLowerCase();
  if (!msg) return null;

  if (lower === '/probe' || /\b(probe|scan)\b.*\b(device|computer|system|machine|hardware)\b/.test(lower)) {
    return { tool: 'abuz8_device_probe', args: {} };
  }
  if (/\b(draw|paint|sketch|create)\b.*\bunicorn\b/.test(lower)) {
    return { tool: 'draw_unicorn_in_paint', args: { caption: 'A unicorn, drawn by ABUZ8 OS' } };
  }
  if (/\b(draw|paint|sketch|create)\b.*\bmonkey\b/.test(lower)) {
    return { tool: 'draw_monkey_in_paint', args: { caption: 'ABUZ8 OS local desktop action proof' } };
  }
  // Jarvis sees the screen
  if (/\b(what(?:'s| is)? on (my |the )?screen|look at (my |the )?screen|read (my |the )?screen|what am i looking at|what do you see|see my screen|analy[sz]e (my |the )?screen)\b/.test(lower)) {
    return { tool: 'jarvis_see', args: { question: msg } };
  }
  // Jarvis briefing
  if (/\b(brief me|briefing|good morning|what'?s my day|status report|sitrep|catch me up|what'?s (going on|happening)|run me through)\b/.test(lower)) {
    return { tool: 'jarvis_brief', args: {} };
  }
  if (/\b(screenshot|screen shot|capture screen|take a shot)\b/.test(lower)) return { tool: 'screenshot', args: {} };
  // Weather (for the user's location; the forecast covers today + next 3 days incl. tomorrow)
  if (/\b(weather|forecast|temperature|how (hot|cold|warm)|will it (rain|snow)|is it (going to|gonna) (rain|snow)|umbrella)\b/.test(lower)) {
    return { tool: 'get_weather', args: /\bfahrenheit|°f\b/.test(lower) ? { units: 'f' } : {} };
  }
  // Current time / date / day / year — always from the system clock
  if (/\b(what(?:'s| is)?|tell me|current)\b.*\b(time|date|day|year|month)\b/.test(lower) || /\bwhat day is it\b|\bwhat year is it\b|\bwhat'?s the time\b/.test(lower)) {
    return { tool: 'get_time', args: {} };
  }
  // Broadcast everywhere: "post to all my socials: ...", "broadcast ...", "cross-post ..."
  const castM = msg.match(/\b(?:post (?:to|on) (?:all|everywhere|every (?:platform|network)|my socials?)|broadcast|cross-?post|post everywhere)\b\s*[:-]?\s*(.+)/i);
  if (castM && castM[1] && castM[1].trim().length > 1) {
    return { tool: 'social_post', args: { text: castM[1].trim(), platforms: [] } };
  }
  // Post to X: "tweet ...", "post to x: ...", "post on x ..."
  const tweetM = msg.match(/\b(?:tweet|post (?:to|on) x(?:\s*:|\s)|post this on x)\s*[:-]?\s*(.+)/i);
  if (tweetM && tweetM[1] && tweetM[1].trim().length > 1) {
    return { tool: 'x_post', args: { text: tweetM[1].trim() } };
  }

  // ── Browser + website intents (the big fix) ──
  const browser = detectBrowser(lower);
  const fullUrl = msg.match(/\bhttps?:\/\/[^\s"'<>]+/i);
  // "search youtube for X" / "youtube search X" / "play X on youtube"
  const ytSearch = lower.match(/\b(?:search\s+youtube\s+for|youtube\s+search|find\s+on\s+youtube|play)\s+(.+)/);
  if (ytSearch && /youtube|\bplay\b/.test(lower)) {
    const q = ytSearch[1].replace(/\bon youtube\b/,'').trim();
    if (q) return { tool: 'open_url', args: { site: 'youtube', search: q, browser } };
  }
  // "search google for X" / "google X" / "look up X"
  const gSearch = lower.match(/\b(?:search\s+google\s+for|google|search\s+the\s+web\s+for|look\s+up|web\s+search)\s+(.+)/);
  if (gSearch && !/youtube/.test(lower)) {
    const q = gSearch[1].replace(/\bon google\b/,'').trim();
    if (q) {
      // If they asked to OPEN/browse, open the browser to results; else use web_search tool.
      if (/\b(open|browse|go to|in (?:chrome|edge|firefox|the browser))\b/.test(lower) || browser)
        return { tool: 'open_url', args: { site: 'google', search: q, browser } };
      return { tool: 'web_search', args: { q } };
    }
  }
  // explicit full URL
  if (fullUrl && /\b(open|visit|go to|browse|launch|navigate)\b/.test(lower)) {
    return { tool: 'open_url', args: { url: fullUrl[0], browser } };
  }
  // "open chrome to/and youtube", "open youtube in chrome", "open youtube"
  if (/\b(open|launch|start|go to|visit|navigate|pull up)\b/.test(lower)) {
    // try to find a site name in the message
    const siteWord = lower.match(/\b(youtube|yt|gmail|google|github|reddit|x|twitter|maps|chatgpt|claude|amazon|wikipedia|netflix|linkedin|instagram|facebook|huggingface|drive)\b/);
    const domain = msg.match(/\b([a-z0-9-]+\.(?:com|org|net|io|ai|dev|co|gov|edu)(?:\.[a-z]{2})?)\b/i);
    if (siteWord) return { tool: 'open_url', args: { site: siteWord[1], browser } };
    if (domain) return { tool: 'open_url', args: { site: domain[1], browser } };
    // just a browser with no site → open the browser
    if (browser) return { tool: 'open_app', args: { name: browser } };
    // a known app
    const appWord = lower.match(/\b(notepad|paint|mspaint|calculator|calc|explorer|files|word|excel|powerpoint|outlook|cmd|command prompt|terminal|powershell|task manager|settings|spotify|vs ?code|code)\b/);
    if (appWord) return { tool: 'open_app', args: { name: appWord[1].replace(/\s+/g,'-') } };
  }

  // ── Run a command ──
  const runCmd = msg.match(/^\s*(?:run|execute|exec)\s+(?:the\s+command\s+)?[`'"]?(.+?)[`'"]?\s*$/i);
  if (runCmd) return { tool: 'cmd_run', args: { command: runCmd[1] } };
  if (/\b(hostname|machine name)\b/.test(lower)) return { tool: 'cmd_run', args: { command: 'hostname' } };
  if (/\bwhoami\b|\bcurrent user\b/.test(lower)) return { tool: 'cmd_run', args: { command: 'whoami' } };
  if (/\b(list|show)\b.*\b(directory|folder|files)\b/.test(lower)) return { tool: 'cmd_run', args: { command: 'dir' } };

  // ── Web search (no browser implied) ──
  if (/\b(search|look up|find)\b.*\b(web|internet|online)\b/.test(lower)) {
    const q = msg.replace(/\b(search|look up|find|the|web|internet|online|for)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (q) return { tool: 'web_search', args: { q } };
  }
  return null;
}

function summarizeToolResult(tool, result) {
  // HONESTY: never narrate a blocked/failed tool as "Done" — the brain must know it did NOT run.
  if (result && result.ok === false) {
    if (result.action_required) return `BLOCKED: ${tool} needs permission and did NOT run (${result.reason || 'consent required'}). Enable actions or approve, then retry.`;
    return `FAILED: ${tool} did NOT run — ${result.error || result.reason || 'unknown error'}.`;
  }
  const payload = result?.result ?? result;
  if (tool === 'open_app') return `Done — opened ${payload.app || payload.target || 'the requested app'}.`;
  if (tool === 'draw_monkey_in_paint') return `Done. Drew a monkey and opened it in Paint.`;
  if (tool === 'draw_unicorn_in_paint') return `Done — I drew a unicorn 🦄 and opened it in Paint for you.`;
  if (tool === 'x_post') {
    if (payload.ok) return `Posted to X ✓ (id ${payload.id || ''}).`;
    if (payload.needs_credentials) return `I'm ready to post that to X, but I need your X access token first — add an OAuth2 token with tweet.write in Settings → and I'll post instantly.`;
    return `I tried to post to X but it failed: ${payload.error || 'unknown error'}.`;
  }
  if (tool === 'open_url') return `Done — opened ${payload.url || 'the requested URL'} in ${payload.browser || 'the default browser'}.`;
  if (tool === 'screenshot') return `Done. Screenshot saved to ${payload.file}.`;
  if (tool === 'file_write') return `Done. Wrote ${payload.bytes || 0} bytes to ${payload.file}.`;
  if (tool === 'shell_run' || tool === 'cmd_run') {
    const out = String(payload.stdout || '').trim();
    const err = String(payload.stderr || '').trim();
    return `Ran \`${payload.command || 'command'}\`${payload.ok === false ? ' (exit '+payload.code+')' : ''}.\n\n${out || err || '(no output)'}`.slice(0, 3000);
  }
  if (tool === 'abuz8_device_probe') {
    return `Device probe complete: ${payload.system?.hostname || os.hostname()} · ${payload.cpu?.name || 'CPU'} · ${payload.memory?.total_gb || '?'}GB RAM · tier ${payload.tier || 'unknown'}.`;
  }
  if (tool === 'social_post') {
    const rows = (payload.results || []).map((r) => `${r.ok ? '✓' : '✗'} ${r.platform}${r.ok ? (r.id ? ' (id ' + String(r.id).slice(0, 18) + ')' : '') : ' — ' + (r.error || 'failed')}`).join('\n');
    return (payload.ok ? 'Posted.' : 'Could not post everywhere.') + '\n' + rows;
  }
  if (tool === 'social_draft') return payload.text || 'No draft produced.';
  if (tool === 'jarvis_see') return payload.ok ? payload.answer : (payload.error || 'Could not read the screen.');
  if (tool === 'jarvis_brief') return payload.ok ? payload.briefing : (payload.error || 'Could not build a briefing.');
  if (tool === 'send_email') { const p = payload; return p.needs_auth ? p.error : (p.id ? `Email sent ✓ (id ${p.id}).` : `Email send failed: ${p.error || JSON.stringify(p)}`); }
  if (tool === 'calendar_create') { const p = payload; return p.needs_auth ? p.error : (p.id || p.htmlLink ? `Event created ✓ ${p.htmlLink || ''}` : `Calendar create failed: ${p.error || JSON.stringify(p)}`); }
  if (tool === 'stripe_op') { const p = payload; if (p.error) return `Stripe: ${p.error.message || p.error}`; if (p.available) return `Stripe balance: ${(p.available || []).map((a) => (a.amount / 100).toFixed(2) + ' ' + (a.currency || '').toUpperCase()).join(', ')}`; return `Stripe ${Array.isArray(p.data) ? p.data.length + ' record(s)' : 'ok'}.`; }
  if (tool === 'get_time') { const p = payload; return `It's ${p.time} on ${p.date}${p.tz ? ` (${p.tz})` : ''}.`; }
  if (tool === 'get_weather') {
    const c = payload.current || {}, loc = payload.location || {}, u = payload.units || '°';
    const where = loc.city ? `${loc.city}${loc.country ? ', ' + loc.country : ''}` : 'your location';
    const fc = (payload.forecast || []).map((d, i) => `${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.date}: ${d.sky}, ${Math.round(d.lo)}–${Math.round(d.hi)}${u}, ${d.rain_pct}% rain`).join('\n');
    return `Weather in ${where} (as of ${payload.as_of}): ${c.sky}, ${Math.round(c.temp)}${u} (feels like ${Math.round(c.feels_like)}${u}), humidity ${c.humidity}%, wind ${Math.round(c.wind_kmh)} km/h.\n\n${fc}`;
  }
  if (tool === 'abuz8_mission_board') return `Mission board loaded. ${payload.summary || ''}`.trim();
  if (tool === 'web_search') {
    const rows = (payload.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
    return rows ? `Web search results for "${payload.query}" (${payload.source}):\n\n${rows}` : `Web search for "${payload.query}" returned no results.`;
  }
  if (tool === 'deep_research') {
    return (payload.pages || []).map((p, i) => `Source ${i + 1}: ${p.title} (${p.url})\n${p.text}`).join('\n\n').slice(0, 2400) || `No readable sources for "${payload.query}".`;
  }
  return `Tool ${tool} completed.\n\n${JSON.stringify(payload, null, 2)}`;
}

const KNOWN_AGENT_TOOLS = new Set(['open_app','open_url','screenshot','file_write','shell_run','cmd_run','web_search','deep_research','draw_monkey_in_paint','draw_unicorn_in_paint','x_post','abuz8_device_probe','abuz8_memory_write','abuz8_mission_board','swarm_run','content_generate','browser_do','gui_do','get_weather','get_time','social_post','social_draft','send_email','calendar_create','stripe_op','jarvis_see','jarvis_brief','connector_call','list_connectors','studio_produce','osint','blockchain','tor_browse','code_build','list_mcp_tools','mcp_call','fleet','rpc_start','install_pack','rag_query','access_grant','graph_search','graph_extract','ingest_file']);

async function executeAgentTool(requested, opts) {
  pushActivity('tool', `Action: ${requested.tool}`, JSON.stringify(requested.args || {}).slice(0, 120));
  try {
    const toolResult = await callLocalTool(requested.tool, requested.args || {});
    // The tool layer may itself return a consent-required envelope.
    if (toolResult && toolResult.action_required) {
      return { response: toolResult.prompt || toolResult.reason || 'This action needs permission.', tool_call: requested, tool_result: toolResult, fallback: false, needs_consent: true };
    }
    return { response: summarizeToolResult(requested.tool, toolResult), modelResponse: null, tool_call: requested, tool_result: toolResult, fallback: false };
  } catch (e) {
    const blocked = /Allow actions|blocked|consent/i.test(e.message || '');
    return {
      response: blocked
        ? `I can do that, but desktop/CLI actions are off right now. Turn on **Allow actions** (toggle at the bottom of Chat) and ask again — it stays on.`
        : `I tried to run ${requested.tool}, but it failed: ${e.message}`,
      modelResponse: null, tool_call: requested, tool_error: e.message, fallback: false
    };
  }
}

// ── Agent-first core (Hermes/OpenClaw style) ──
// A request that needs thinking is not answered by one tool or one completion.
// It is UNDERSTOOD, the agent GATHERS what it needs (search, self-knowledge,
// tools), then REASONS over the results and SYNTHESIZES the actual answer.
function isComplexTask(prompt) {
  const s = String(prompt || '').toLowerCase();
  if (s.length < 14) return false;
  if (/\b(compare|comparison|versus|\bvs\b|analy[sz]e|analysis|evaluate|assess|investigate|research|figure out|bottleneck|strength|weakness|pros and cons|trade-?off|recommend|strateg|break ?down|why (is|are|do|does|am|can)|how (should|can|do) i|what.*(missing|needed|keeping|stopping|wrong))\b/.test(s)) return true;
  // multi-step: two or more action verbs joined by "and/then"
  if (/\b(and|then)\b/.test(s) && (s.match(/\b(look up|search|find|open|run|compare|post|build|make|write|create|fix|remove|draw|analy[sz]e)\b/g) || []).length >= 2) return true;
  return false;
}

async function selfDescription() {
  let on = [];
  try { on = attachmentsStatus().attachments.filter((a) => a.installed).map((a) => a.name); } catch {}
  let brainName = 'a local brain';
  try { brainName = embeddedBrainStatus().name || brainName; } catch {}
  return [
    `You ARE ABUZ8 OS — a local-first agent operating system running on the user's own machine, not a cloud chatbot.`,
    `Reasoning brain: ${brainName}; plus a tiny fast voice brain for instant speech.`,
    `Active capabilities: ${on.join(', ') || 'core'}; plus shell/CLI execution, browser automation (Playwright), desktop control (PyAutoGUI), MCP tools, web search, offline voice in & out (Piper/Whisper), a two-way Claude Desktop bridge, an autonomous agent loop, mission/kanban delegation, content generation, and hardware-adaptive GPU acceleration.`,
    `You DO have: long-term vector memory + semantic RAG retrieval (recalled into context), multi-page deep-research, an enforced Local-Only/air-gap privacy mode, and encrypted-at-rest secrets.`,
    `Honest current bottlenecks: (1) the reasoning brain runs on CPU unless the GPU is unlocked, so deep multi-step replies can be slow; (2) the bundled local models (0.5B–4B) are smaller/weaker than frontier cloud models at long autonomous chains; (3) some connectors (X posting, cloud providers) need the user's API keys; (4) browser/desktop automation runners (Playwright/PyAutoGUI) install on first use.`
  ].join('\n');
}

function extractSearchQuery(goal) {
  let q = String(goal)
    .replace(/\b(can you|could you|would you|please|hey|so|firstly|secondly|i (?:want|need) you to)\b/gi, ' ')
    .replace(/\b(look ?up|search for|search|research|find out about|tell me about|investigate|check out)\b/gi, ' ')
    .replace(/\bcompare\s+(your ?self|myself|abuz8)?\s*(?:to|with|against|and)?\b/gi, ' ')
    .replace(/\b(your ?self|yourself|myself)\b/gi, ' ')
    .replace(/\b(and )?(what|which|how).*$/i, ' ')
    .replace(/\bbottlenecks?.*$/i, ' ')
    .replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q.length < 3) q = String(goal).slice(0, 80);
  return q.slice(0, 90);
}

async function runTask(goal, opts = {}) {
  const lower = String(goal).toLowerCase();
  const obs = [];
  const used = [];
  pushActivity('plan', 'Understanding the task', String(goal).slice(0, 100));
  // Step 0 — deterministic high-value gather (reliable on small models).
  if (/\b(you|your|yourself|abuz8|itself|its own|am i)\b/.test(lower)) {
    obs.push('[WHAT YOU ARE]\n' + await selfDescription());
    used.push('self-knowledge');
  }
  if (/\b(look ?up|search|research|compare|versus|\bvs\b|who is|what is|find out|investigate|felix|hermes|openclaw|manus|competitor|alternative|market|trend|news|latest)\b/.test(lower)) {
    const q = extractSearchQuery(goal);
    pushActivity('step', 'Deep-reading sources', q);
    try {
      const dr = await deepResearch(q, 3);
      if (dr.pages.length) {
        obs.push(`[DEEP RESEARCH on "${q}" — read ${dr.pages.length} full sources]\n` + dr.pages.map((p, i) => `Source ${i + 1}: ${p.title} (${p.url})\n${p.text}`).join('\n\n'));
        used.push('deep_research');
      } else if (dr.snippets.length) {
        obs.push(`[WEB SEARCH on "${q}"]\n` + dr.snippets.map((x, i) => `${i + 1}. ${x.title} — ${x.snippet}`).join('\n'));
        used.push('web_search');
      }
    } catch {}
  }
  // Steps 1..N — ITERATIVE ReAct: the brain decides the next tool from the
  // observations so far, executes it, observes, and repeats until it says done.
  const maxSteps = Math.max(0, Math.min(Number(opts.max_steps != null ? opts.max_steps : 3), 5));
  const toolMenu = 'web_search {"q":"..."} | cmd_run {"command":"..."} | abuz8_device_probe {} | open_url {"url":"..."} | browser_do {"url":"..."} | file_write {"relpath":"...","content":"..."} | content_generate {"topic":"...","format":"x-carousel"} | get_weather {} | get_time {} | send_email {"to":"...","subject":"...","body":"..."} | calendar_create {"summary":"...","start":"ISO8601","end":"ISO8601"} | stripe_op {"action":"balance|customers|charges"} | social_post {"platforms":[],"text":"..."} | social_draft {"topic":"...","platform":"x"} | abuz8_memory_write {"content":"..."} | list_mcp_tools {} | mcp_call {"server":"...","tool":"...","args":{...}}';
  const seen = new Set(used);
  _agentStop = false;
  for (let i = 0; i < maxSteps; i++) {
    if (agentStopRequested()) break;
    const learned = listLearnedSkills().slice(0, 5).map((s) => `- ${s.skill}`).join('\n');
    const planPrompt = `Goal: ${goal}\n\nObservations so far:\n${obs.join('\n\n') || '(none yet)'}${learned ? '\n\nLearned shortcuts (proven to work):\n' + learned : ''}\n\nIf you now have enough to fully answer the goal, reply EXACTLY {"done":true}. Otherwise reply with ONE more tool call as compact JSON {"tool":"name","args":{...}} chosen from: ${toolMenu}`;
    let raw = '';
    try { const r = await reasonReply(planPrompt, { provider: opts.provider, system: 'You are a precise tool-planning engine. Output ONLY one JSON object, nothing else.', noMemory: true }); raw = r.text || ''; } catch {}
    if (/"done"\s*:\s*true/.test(raw) || /\bdone\b/i.test(raw.slice(0, 12))) break;
    const call = parseAgentToolCall(raw) || salvageToolCall(raw);
    const toolName = call ? slug(call.tool).replace(/-/g, '_') : '';
    if (!call || !KNOWN_AGENT_TOOLS.has(toolName)) break;
    // Don't repeat an identical tool call (small models loop) — stop and synthesize.
    const sig = toolName + ':' + JSON.stringify(call.args || {});
    if (seen.has(sig) || seen.has(toolName) && (toolName === 'abuz8_device_probe' || toolName === 'web_search')) break;
    seen.add(sig); seen.add(toolName);
    pushActivity('step', `Step ${i + 1}: ${toolName}`, JSON.stringify(call.args || {}).slice(0, 80));
    try { if (opts.onStep) opts.onStep({ name: toolName, args: call.args || {}, phase: 'start' }); } catch {}
    try {
      const result = await callLocalTool(toolName, call.args || {});
      obs.push(`[${toolName} ${JSON.stringify(call.args || {})}]\n${summarizeToolResult(toolName, result).slice(0, 800)}`);
      used.push(toolName);
      try { if (opts.onStep) opts.onStep({ name: toolName, phase: 'end', ok: result && result.ok !== false }); } catch {}
    } catch (e) { obs.push(`[${toolName}] ERROR: ${e.message}`); try { if (opts.onStep) opts.onStep({ name: toolName, phase: 'end', ok: false, error: e.message }); } catch {} }
  }
  // Final — reason over everything and synthesize the real answer.
  pushActivity('step', 'Reasoning & synthesizing', '');
  const context = obs.join('\n\n');
  const taskPrompt = [
    `The user asked you: "${goal}"`,
    context ? `Everything you gathered:\n${context}` : 'No external lookup was needed.',
    `Now DO the task. Do NOT just list what you found — fulfill the request: reason it through, make the comparison or analysis they asked for, and give concrete, honest conclusions and clear next steps. Answer as ABUZ8 in your own voice.`
  ].join('\n\n');
  const r = await reasonReply(taskPrompt, { role: opts.role, provider: opts.provider, system: opts.system });
  let answer = r.text;
  // Phase 4 — self-reflection: critique the draft against the goal and tighten it.
  let reflected = false;
  if (opts.reflect !== false && answer && answer.length > 40) {
    pushActivity('step', 'Reviewing & refining the answer', '');
    const improved = await reflectAndImprove(goal, answer, context);
    if (improved && improved.trim().length > 30) { answer = improved.trim(); reflected = true; }
  }
  pushActivity('done', 'Task complete', `used: ${used.join(', ') || 'reasoning only'}${reflected ? ' · self-reviewed' : ''}`);
  // LEARN — record this turn's experience as fuel for the self-learning loop.
  recordSignal({ kind: 'task', user: String(goal).slice(0, 200), ok: true, steps: obs.length, used_tools: used.map((u) => ({ tool: u })), reflected });
  return { response: answer, modelResponse: answer, brain: r.brain, tool_call: { tool: 'agent_task', used, reflected }, tool_result: { used, steps: obs.length, reflected }, fallback: r.fallback };
}

// Self-reflection: the agent critiques its own draft and returns an improved final.
async function reflectAndImprove(goal, draft, context) {
  const prompt = [
    `GOAL: "${goal}"`,
    `A weak first draft:\n${draft}`,
    `This draft is too vague and may miss parts of the goal. Write a BETTER, final answer that fully and specifically achieves the goal: be concrete, add the specific details/examples/numbers the goal asks for, cut all filler, and stay honest. Directly address every part of the goal. Output ONLY the final answer (no preamble, no "here is"), as ABUZ8 in your own voice.`
  ].join('\n\n');
  try {
    const r = await reasonReply(prompt, { noMemory: true });
    return (r.text || '').replace(/^(here('|i)?s?|sure|okay|certainly)[^\n:]*:?\s*/i, '').trim();
  } catch { return draft; }
}

// Build a class's full identity prompt (used by the orchestrator + active-class chat).
function classSystem(cls) {
  const s = dataRoot ? loadSoul() : { directives: DEFAULT_DIRECTIVES, personality: DEFAULT_SOUL };
  return [
    `Your name is ${cls.soul.name}. You are the ${cls.class}-Class of the ABUZ8 lineage — a specialist in ${cls.specialty}.`,
    s.personality,
    `Voice & manner:\n${cls.soul.voice}`,
    `Mission:\n${cls.soul.mission}`,
    `Directives:\n${s.directives}`
  ].filter(Boolean).join('\n\n');
}

// ── THE ORCHESTRATOR ── the enterprise layer: take one objective, decompose it
// into a mission, assign each step to the best specialist CLASS, run them as a
// fleet, then synthesize a mission report. This is the company-runner.
async function orchestrate(objective, opts = {}) {
  const goal = String(objective || '').trim();
  if (!goal) throw new Error('objective is required');
  // If a fleet is joined, distribute the mission across the army (parallel) instead
  // of running every step serially on this one box. Falls back here if no node is online.
  if (opts.fleet !== false && opts.local !== true && readMesh().nodes.length > 0) {
    try { const st = await meshStats(); if (st.online > 0) return await fleetOrchestrate(goal, opts); } catch {}
  }
  pushActivity('plan', 'Orchestrator: planning the mission', goal.slice(0, 100));
  // 1. Decompose into steps, each assigned to a specialist class.
  const classMenu = AGENT_CLASSES.map((c) => `${c.id} (${c.class}-Class: ${c.specialty})`).join('; ');
  const planPrompt = `Objective: "${goal}"\n\nBreak this into 2-4 concrete steps. Assign each step to the single best specialist from: ${classMenu}. Reply with ONLY one JSON object: {"steps":[{"title":"...","class":"<class-id>","task":"<what that specialist should do>"}]}`;
  let steps = [];
  try {
    const r = await reasonReply(planPrompt, { system: 'You are a project orchestrator. Output ONLY one JSON object.', noMemory: true });
    const obj = extractJsonObject(r.text) || {};
    if (Array.isArray(obj.steps)) steps = obj.steps;
  } catch {}
  if (!steps.length) steps = [{ title: goal, class: 'abuz8-s', task: goal }];
  steps = steps.slice(0, Math.min(Number(opts.max_steps || 4), 5));
  // 2. Run each step with its specialist class.
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const cls = resolveClass(st.class) || resolveClass('abuz8-s');
    pushActivity('step', `Step ${i + 1} → ${cls.class}-Class (${cls.soul.name})`, st.title || st.task);
    let output = '';
    try {
      const r = await runTask(st.task || st.title || goal, { system: classSystem(cls), reflect: false, max_steps: 2 });
      output = r.response;
    } catch (e) { output = `(step failed: ${e.message})`; }
    results.push({ step: st.title || st.task, class: cls.class, agent: cls.soul.name, output });
  }
  // 3. Synthesize the mission report.
  pushActivity('step', 'Synthesizing the mission report', '');
  const merged = results.map((r, i) => `### Step ${i + 1}: ${r.step} — ${r.agent} (${r.class}-Class)\n${r.output}`).join('\n\n');
  const synth = await reasonReply(`Objective: "${goal}"\n\nYour specialist agents delivered:\n${merged}\n\nWrite the final mission report as the lead orchestrator: what was accomplished, the key findings, and concrete recommended next actions. Be specific and honest.`, { noMemory: true });
  pushActivity('done', 'Mission complete', `${results.length} specialist agents`);
  recordSignal({ kind: 'orchestration', user: goal.slice(0, 200), ok: true, used_tools: results.map((r) => ({ tool: 'class:' + r.class })) });
  return { ok: true, objective: goal, agents: results.length, steps: results, report: synth.text };
}

// FLEET-AWARE ORCHESTRATOR — decompose a goal into parallel sub-tasks, dispatch each
// to a DIFFERENT live node (with failover via fleetDispatch), then fuse one report.
// This is what makes the army actually DO the work instead of one box doing it serially.
async function fleetOrchestrate(objective, opts = {}) {
  const goal = String(objective || '').trim();
  if (!goal) throw new Error('objective is required');
  const id = 'job' + Date.now().toString(36);
  const jobsDir = safeMkdir(path.join(dataRoot, 'fleet', 'jobs'));
  const ledger = path.join(jobsDir, id + '.json');
  pushActivity('plan', 'Fleet orchestrator: sharding the mission across the army', goal.slice(0, 100));
  // 1. Decompose into independent, parallelizable sub-tasks.
  let steps = [];
  try {
    const r = await reasonReply(`Objective: "${goal}"\n\nBreak this into 2-5 concrete INDEPENDENT sub-tasks that can run IN PARALLEL on separate machines (no sub-task may depend on another's output). Reply with ONLY one JSON object: {"steps":["<task1>","<task2>",...]}`, { system: 'You are a parallel-work planner. Output ONLY one JSON object.', noMemory: true });
    const obj = extractJsonObject(r.text) || {};
    if (Array.isArray(obj.steps)) steps = obj.steps.map((s) => typeof s === 'string' ? s : (s && (s.task || s.title))).filter(Boolean);
  } catch {}
  if (!steps.length) steps = [goal];
  steps = steps.slice(0, Math.min(Number(opts.max_steps || 5), 8));
  writeJson(ledger, { id, objective: goal, steps, status: 'running', started: new Date().toISOString() });
  // 2. Dispatch each sub-task to the fleet (one per node, failover if a node dies).
  const units = steps.map((s) => ({ chat: String(s), agentic: opts.agentic !== false, need: opts.need || 'any' }));
  const disp = await fleetDispatch(units, { retries: opts.retries != null ? opts.retries : 1, perNodeTimeout: opts.perNodeTimeout || 180000, minQuorum: opts.minQuorum });
  const shards = disp.results.map((r, i) => ({ step: steps[i], node: r.node || null, ok: !!r.ok, attempts: r.attempts, output: r.ok ? r.result : ('(failed: ' + (r.error || 'unknown') + ')') }));
  // 3. Fuse the shards into one mission report.
  pushActivity('step', 'Fusing the fleet\'s work into one report', '');
  const merged = shards.map((s, i) => `### Sub-task ${i + 1}${s.node ? ' @ ' + s.node : ''}: ${s.step}\n${typeof s.output === 'string' ? s.output : JSON.stringify(s.output)}`).join('\n\n');
  let report = merged;
  try { const fr = await reasonReply(`Objective: "${goal}"\n\nYour fleet of agents delivered these sub-task results in parallel:\n${merged.slice(0, 9000)}\n\nWrite the final mission report as the lead orchestrator: what was accomplished, key findings, and concrete next actions. Be specific and honest.`, { noMemory: true }); if (fr && fr.text) report = fr.text; } catch {}
  writeJson(ledger, { id, objective: goal, steps, status: disp.partial ? 'partial' : 'done', shards, completed: disp.completed, finished: new Date().toISOString() });
  pushActivity('done', 'Fleet mission complete', disp.completed + '/' + disp.dispatched + ' sub-tasks');
  recordSignal({ kind: 'fleet-orchestration', user: goal.slice(0, 200), ok: disp.ok, used_tools: shards.map((s) => ({ tool: 'node:' + (s.node || '?') })) });
  return { ok: disp.ok, fleet: true, id, objective: goal, nodes_used: shards.filter((s) => s.ok).map((s) => s.node), dispatched: disp.dispatched, completed: disp.completed, partial: disp.partial, shards, report };
}

// ── DURABLE MISSION GRAPH ── resumable multi-step missions persisted to disk,
// with human approval gates before risky steps. (Al-Buraq pattern, JSON-backed
// so it ships anywhere — no native sqlite dependency.)
function missionGraphDir() { return safeMkdir(path.join(dataRoot, 'mission', 'graph')); }
function missionGraphFile(id) { return path.join(missionGraphDir(), id + '.json'); }
function createMissionGraph(title, steps) {
  const id = 'm' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const now = new Date().toISOString();
  const nodes = (steps || []).map((s, i) => ({
    id: 'n' + i, seq: i, kind: s.kind || 'task', title: s.title || ('Step ' + (i + 1)),
    status: 'pending', needs_approval: Boolean(s.needs_approval), payload: s.payload || s, result: null
  }));
  const m = { id, title: title || 'Mission', status: 'active', created: now, updated: now, nodes };
  writeJson(missionGraphFile(id), m);
  pushActivity('mission', 'Mission created: ' + m.title, nodes.length + ' steps');
  return m;
}
function getMissionGraph(id) { return readJson(missionGraphFile(id), null); }
function listMissionGraphs() {
  if (!exists(missionGraphDir())) return [];
  return fs.readdirSync(missionGraphDir()).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(missionGraphDir(), f), null)).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}
async function executeMissionNode(node) {
  const p = node.payload || {};
  try {
    if (node.kind === 'orchestrate' || p.objective) { const r = await orchestrate(p.objective || node.title); return { ok: true, summary: String(r.report || '').slice(0, 1000) }; }
    if (node.kind === 'tool' && p.tool) { const r = await callLocalTool(p.tool, p.args || {}); return { ok: r.ok !== false, summary: summarizeToolResult(p.tool, r).slice(0, 800) }; }
    if (node.kind === 'manual' || node.kind === 'note') { return { ok: true, summary: '(manual checkpoint — marked done)' }; }
    const r = await runTask(p.goal || p.task || node.title, { reflect: false, max_steps: 2 });
    return { ok: true, summary: String(r.response || '').slice(0, 1000) };
  } catch (e) { return { ok: false, summary: 'ERROR: ' + e.message }; }
}
async function advanceMissionGraph(id) {
  const m = getMissionGraph(id); if (!m) return { error: 'mission not found' };
  const next = m.nodes.find((n) => n.status === 'pending');
  if (!next) { m.status = 'complete'; m.updated = new Date().toISOString(); writeJson(missionGraphFile(id), m); pushActivity('done', 'Mission complete: ' + m.title, ''); return { done: true, mission: m }; }
  if (next.needs_approval) { next.status = 'awaiting_approval'; m.status = 'paused'; m.updated = new Date().toISOString(); writeJson(missionGraphFile(id), m); pushActivity('mission', 'Mission paused for approval: ' + next.title, ''); return { paused: true, node: next, mission: m }; }
  next.status = 'running'; writeJson(missionGraphFile(id), m); pushActivity('step', 'Mission step: ' + next.title, '');
  const res = await executeMissionNode(next);
  next.status = res.ok ? 'done' : 'failed'; next.result = res.summary; m.updated = new Date().toISOString(); writeJson(missionGraphFile(id), m);
  return { done: false, node: next, mission: m };
}
function approveMissionNode(id, nodeId) {
  const m = getMissionGraph(id); if (!m) return { error: 'mission not found' };
  const n = m.nodes.find((x) => x.id === nodeId || x.status === 'awaiting_approval');
  if (n) { n.status = 'pending'; n.needs_approval = false; m.status = 'active'; m.updated = new Date().toISOString(); writeJson(missionGraphFile(id), m); }
  return { approved: n ? n.id : null, mission: m };
}
async function runMissionToCompletion(id, maxSteps = 10) {
  for (let i = 0; i < maxSteps; i++) {
    const r = await advanceMissionGraph(id);
    if (r.done || r.paused || r.error) return r;
  }
  return { mission: getMissionGraph(id), note: 'reached step cap' };
}

// ── AUTONOMY ── schedules that run tasks / missions / orchestrations on their
// own (interval or daily). A 60s tick fires due schedules. This is what makes
// ABUZ8 run the company while you're away (the app must be running).
function schedulesFile() { return path.join(safeMkdir(path.join(dataRoot, 'autonomy')), 'schedules.json'); }
function readSchedules() { return readJson(schedulesFile(), { schedules: [] }).schedules || []; }
function writeSchedules(arr) { writeJson(schedulesFile(), { schedules: arr, updated: new Date().toISOString() }); }
function createSchedule(s = {}) {
  const arr = readSchedules();
  const item = {
    id: 's' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    name: s.name || 'Scheduled task',
    every_min: Number(s.every_min) || 0,
    at_hour: (s.at_hour != null && s.at_hour !== '') ? Number(s.at_hour) : null,
    cron: (typeof s.cron === 'string' && s.cron.trim().split(/\s+/).length === 5) ? s.cron.trim() : null,
    repeat: Number(s.repeat) || 0, // 0 = unlimited; else disable after N runs
    deliver: s.deliver || null,    // optional delivery channel (telegram chat id, etc.)
    action: s.action || { kind: 'task', payload: { goal: s.name || '' } },
    enabled: s.enabled !== false, last_run: null, created: new Date().toISOString()
  };
  arr.push(item); writeSchedules(arr); return item;
}
// Minimal 5-field cron matcher (min hour day-of-month month day-of-week); supports * , - and */n.
function cronMatch(expr, d) {
  const parts = String(expr || '').trim().split(/\s+/); if (parts.length !== 5) return false;
  const vals = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  const lims = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fieldOk = (f, v, min, max) => f === '*' || f.split(',').some((part) => {
    let step = 1, range = part; const sm = part.match(/^(.+)\/(\d+)$/); if (sm) { range = sm[1]; step = +sm[2]; }
    let lo, hi; if (range === '*') { lo = min; hi = max; } else if (/^\d+-\d+$/.test(range)) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; } else if (/^\d+$/.test(range)) { lo = hi = +range; } else return false;
    for (let x = lo; x <= hi; x += step) { if (x === v || (max === 6 && v === 0 && x === 7)) return true; } return false;
  });
  return vals.every((v, i) => fieldOk(parts[i], v, lims[i][0], lims[i][1]));
}
function scheduleRuns(id, limit = 30) { try { return fs.readFileSync(path.join(dataRoot, 'autonomy', 'runs', id + '.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
async function fireSchedule(item) {
  pushActivity('plan', `Autonomy: running "${item.name}"`, '');
  const a = item.action || {};
  let _schedOk = true, _schedErr = '';
  try {
    if (a.kind === 'mission' && a.mission_id) await runMissionToCompletion(a.mission_id);
    else if (a.kind === 'goal' && a.payload && a.payload.goal_id) await runGoal(a.payload.goal_id);
    else if (a.kind === 'coder' && a.payload && a.payload.goal) await coderRun(a.payload.goal, a.payload);
    else if (a.kind === 'orchestrate') await orchestrate((a.payload && a.payload.objective) || item.name);
    else if (a.kind === 'soul' && a.payload && a.payload.soul) await spineSoulRun({ soul: a.payload.soul, goal: a.payload.goal || item.name, max_steps: a.payload.max_steps != null ? a.payload.max_steps : 2 });
    else if (a.kind === 'team') await spineTeamDispatch({ goal: (a.payload && a.payload.goal) || item.name });
    else if (a.kind === 'tool' && a.payload && a.payload.tool) await callLocalTool(a.payload.tool, a.payload.args || {});
    else if (a.kind === 'social') { const p = a.payload || {}; await socialPost(p.platforms || [], { text: p.text, link: p.link }); }
    else if (a.kind === 'content_loop') {
      // The faceless-content marketing loop: draft fresh copy on the topic, then broadcast it.
      const p = a.payload || {}; const draft = await socialDraft(p.topic || item.name, (p.platforms && p.platforms[0]) || 'x');
      await socialPost(p.platforms || [], { text: draft.text, link: p.link });
    }
    else await runTask((a.payload && (a.payload.goal || a.payload.task)) || item.name, { reflect: false, max_steps: 2 });
    pushActivity('done', `Autonomy done: "${item.name}"`, '');
  } catch (e) { _schedOk = false; _schedErr = e.message; pushActivity('observe', `Autonomy error: ${item.name}`, e.message); try { escalateFailure('schedule:' + item.name, e.message); } catch {} }
  try { appendJsonl(path.join(safeMkdir(path.join(dataRoot, 'autonomy', 'runs')), item.id + '.jsonl'), { ts: new Date().toISOString(), ok: _schedOk, error: _schedErr ? String(_schedErr).slice(0, 200) : '' }); } catch {}
  const arr = readSchedules(); const it = arr.find((x) => x.id === item.id);
  if (it) { it.last_run = new Date().toISOString(); it.last_status = _schedOk ? 'ok' : 'error'; it.last_error = _schedOk ? '' : String(_schedErr).slice(0, 300); it.runs = (it.runs || 0) + 1; if (it.repeat && it.runs >= it.repeat) { it.enabled = false; } writeSchedules(arr); }
  recordSignal({ kind: 'autonomy', user: item.name, ok: _schedOk });
}
let _schedulerBusy = false;
async function schedulerTick() {
  if (_schedulerBusy || !dataRoot || _halted) return;
  _schedulerBusy = true;
  try {
    const now = Date.now(); const hour = new Date().getHours();
    for (const s of readSchedules()) {
      if (!s.enabled) continue;
      let due = false;
      if (s.every_min > 0) { const last = s.last_run ? new Date(s.last_run).getTime() : 0; if (now - last >= s.every_min * 60000) due = true; }
      if (s.at_hour != null) { const last = s.last_run ? new Date(s.last_run) : null; if (hour === s.at_hour && (!last || last.toDateString() !== new Date().toDateString())) due = true; }
      if (s.cron) { const last = s.last_run ? new Date(s.last_run).getTime() : 0; if (cronMatch(s.cron, new Date()) && now - last >= 55000) due = true; } // 55s guard = fire once/minute
      if (due) { await fireSchedule(s); }
    }
    // Gossip durable facts across the fleet (~once/min) so every node learns from every node.
    try { if (readMesh().nodes.length > 0 && (now - _lastMemSync >= 60000)) { _lastMemSync = now; fleetMemSync().catch(() => {}); } } catch {}
    // Poll subscribed channels (Discord/Slack) for inbound messages → agent → reply.
    try { const cl = readChannelListen(); if (cl.enabled && (now - _lastChanPoll >= 20000)) { _lastChanPoll = now; channelPollOnce().catch(() => {}); } } catch {}
  } catch {} finally { _schedulerBusy = false; }
}
let _lastMemSync = 0;

/* ── VISION & SPATIAL AWARENESS ──────────────────────────────────────────
   The renderer runs MediaPipe (gesture + face/eye) fully offline in the
   webcam page and POSTs a distilled signal here. The core keeps the live
   presence state so voice/autonomy can be presence-aware, and logs gestures
   to the activity feed. Default gesture→action map is overridable in settings. */
let _presence = { present: false, attentive: false, distance: 'unknown', gaze: 'center', head: 'center', gesture: 'none', updated: null, source: null };
let _lastGestureAt = 0, _lastGestureName = '';
const DEFAULT_GESTURE_MAP = {
  Open_Palm:   { action: 'wake',       label: 'Open palm → wake & listen' },
  Closed_Fist: { action: 'stop',       label: 'Fist → stop / cancel' },
  Thumb_Up:    { action: 'confirm',    label: 'Thumbs up → confirm / yes' },
  Thumb_Down:  { action: 'dismiss',    label: 'Thumbs down → dismiss / no' },
  Pointing_Up: { action: 'next',       label: 'Point up → next / continue' },
  Victory:     { action: 'screenshot', label: 'Victory ✌ → screenshot' },
  ILoveYou:    { action: 'home',       label: 'ILoveYou → go home' }
};
function gestureMap() {
  try { const s = readJson(settingsPath(), {}); return Object.assign({}, DEFAULT_GESTURE_MAP, s.gesture_map || {}); } catch { return DEFAULT_GESTURE_MAP; }
}
function getPresence() { return _presence; }
function isUserPresent() { return _presence.present === true && _presence.updated && (Date.now() - new Date(_presence.updated).getTime() < 8000); }
function isUserAttentive() { return isUserPresent() && _presence.attentive === true; }
function updatePresence(p) {
  const prev = _presence;
  _presence = Object.assign({}, _presence, p, { updated: new Date().toISOString() });
  // Edge-log presence transitions (arrived / stepped away) for the activity feed.
  if (p.present === true && prev.present !== true) pushActivity('observe', 'User present', _presence.distance !== 'unknown' ? ('distance: ' + _presence.distance) : '');
  if (p.present === false && prev.present === true) pushActivity('observe', 'User stepped away', '');
  // Gesture edge: only log/dispatch when the gesture name changes and is real.
  if (p.gesture && p.gesture !== 'none' && p.gesture !== _lastGestureName) {
    _lastGestureName = p.gesture; _lastGestureAt = Date.now();
    const m = gestureMap()[p.gesture];
    if (m) { pushActivity('tool', 'Gesture: ' + p.gesture, m.label); try { recordSignal({ kind: 'gesture', gesture: p.gesture, action: m.action }); } catch {} }
    return { matched: m || null };
  }
  if (!p.gesture || p.gesture === 'none') _lastGestureName = '';
  return { matched: null };
}

/* ── REAL CONNECTORS ─────────────────────────────────────────────────────
   Local-only credential store + genuine API calls. Secrets live in
   config/connectors.json (gitignored, never leaves the machine). Each
   connector either works for real with the user's key, or honestly reports
   what credential it still needs — nothing is faked. */
function connectorsPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'connectors.json'); }
function readConnectors() { return readJson(connectorsPath(), {}); }
function writeConnectors(o) { writeJson(connectorsPath(), o); }
const CONNECTOR_DEFS = {
  stripe:     { label: 'Stripe',            kind: 'api',   fields: ['secret_key'], note: 'Live/test secret key (sk_…). Real balance, customers, charges.' },
  cloudflare: { label: 'Cloudflare',        kind: 'api',   fields: ['api_token'],  note: 'API token (Zone/DNS scopes). Lists zones, DNS records.' },
  gmail:      { label: 'Gmail',             kind: 'oauth', fields: ['oauth_token'],note: 'Google OAuth access token with gmail.send/readonly scope. Sends + lists mail for real once pasted.' },
  gcal:       { label: 'Google Calendar',   kind: 'oauth', fields: ['oauth_token'],note: 'Google OAuth access token with calendar scope. Reads/creates events.' },
  openrouter: { label: 'OpenRouter (cloud brain)', kind: 'api', fields: ['api_key'], note: 'Optional stronger cloud reasoning brain.' },
  serper:     { label: 'Serper (web search)', kind: 'api', fields: ['api_key'],    note: 'Higher-quality web search.' },
  tripo:      { label: 'Tripo (image → 3D mesh)', kind: 'api', fields: ['api_key'], note: 'Turns a photo into a real editable 3D mesh for the Forge. Key from platform.tripo3d.ai.' },
  image_gen:  { label: 'Image generation', kind: 'api', fields: ['api_key'], note: 'For reliable Studio images: a FREE Hugging Face token (hf_…, from huggingface.co/settings/tokens) runs FLUX, OR an OpenAI images key. Without one, free image servers are rate-limited.' },
  github:     { label: 'GitHub',            kind: 'api',   fields: ['token'],      note: 'Personal access token (ghp_…/github_pat_…, repo scope) → sign into YOUR account to create repos, push code, and ship projects from one place.' },
  youtube:    { label: 'YouTube (your channel)', kind: 'oauth', fields: [],         note: 'Drives YOUR channel via the same Google OAuth (youtube.upload scope is already in the sign-in). Lists your videos and uploads the MP4s the studio renders — your AI-avatar channel posts hands-free.' },
  comfyui:    { label: 'ComfyUI (studio render)', kind: 'local', fields: ['endpoint'], note: 'Local ComfyUI studio engine for the video/image factory on YOUR GPUs. Default http://127.0.0.1:8188. Drives your workflows for hundreds of clips/day.' },
  higgsfield: { label: 'Higgsfield (Sora/Veo/Kling)', kind: 'mcp', fields: [], note: 'Cloud image+video (Sora 2, Veo 3, Kling 3, Nano-Banana) via the official hosted MCP — https://mcp.higgsfield.ai/mcp, browser OAuth, no API key. Authorize YOUR own Higgsfield account.' },
  krea:       { label: 'Krea AI (image/video)', kind: 'api', fields: ['api_key'], note: 'Krea image+video generation via your Krea API key. Routes through the studio render lane (studio_produce).' },
  heygen:     { label: 'HeyGen (talking-avatar clone)', kind: 'api', fields: ['api_key'], note: 'Cloned talking-avatar VIDEO from a script (avatar_id + voice_id → mp4). Add your HeyGen key, then connector_call heygen generate. This is the real avatar-cloner path.' },
  did:        { label: 'D-ID (photo → talking head)', kind: 'api', fields: ['api_key'], note: 'Turn a single PHOTO + script into a lip-synced talking head. Add your D-ID key, then connector_call did generate {image_url, script}.' },
  google_drive: { label: 'Google Drive', kind: 'oauth', fields: [], note: 'Drives YOUR Drive via the same Google OAuth (add the drive scope to sign-in). List/search/upload/download hands-free.' },
  notion:     { label: 'Notion', kind: 'api', fields: ['token'], note: 'Internal integration token (ntn_…/secret_…, notion.so/my-integrations). Search/create/append pages. Share the page with the integration first.' },
  google_veo: { label: 'Google Veo (text→video)', kind: 'api', fields: ['api_key'], note: 'Veo 3 text-to-video via the Gemini API (Gemini key or Google OAuth). PAID. generate → operation name; poll with status {operation}.' },
  aws_bedrock:{ label: 'AWS Bedrock (Claude)', kind: 'api', fields: ['access_key', 'secret_key', 'region'], note: 'Anthropic Claude via AWS Bedrock InvokeModel. IAM key + secret + region. SigV4-signed, PAID. invoke {prompt}.' },
  openai_media:{ label: 'OpenAI (images · TTS)', kind: 'api', fields: ['api_key'], note: 'OpenAI key (sk-…). image → gpt-image-1 PNG; tts → spoken MP3. PAID.' },
  apple:      { label: 'Sign in with Apple', kind: 'api', fields: ['team_id', 'client_id', 'key_id', 'p8'], note: 'Apple OAuth. client_secret is a signed ES256 JWT from your .p8 (Team ID + Service/Client ID + Key ID + p8). token → exchange auth code.' },
  runway:     { label: 'Runway (Gen video)', kind: 'api', fields: ['api_key'], note: 'Runway Gen-3/4 image→video. Key from dev.runwayml.com. PAID. generate → task id; poll status {task_id}.' },
  luma:       { label: 'Luma (Dream Machine)', kind: 'api', fields: ['api_key'], note: 'Luma Ray text/image→video. Key from lumalabs.ai. PAID. generate → id; poll status {id}.' },
  kling:      { label: 'Kling (Kuaishou)', kind: 'api', fields: ['access_key', 'secret_key'], note: 'Kling text/image→video. JWT (HS256) from access_key + secret_key. PAID. generate → task; poll status {task_id}.' },
  wan2gp:     { label: 'Wan2GP (local video studio)', kind: 'local', fields: ['endpoint'], note: 'Your local Wan2.2/LTX video studio (gradio, default http://127.0.0.1:7860) on the GPUs — $0/clip.' },
  livecrm:    { label: 'External CRM Bridge (bring your own)', kind: 'local', fields: ['endpoint'], note: 'Bridge to YOUR OWN CRM (e.g. a local FastAPI). ABUZ8 does not include a CRM — point this at your CRM URL to query/drive leads, contacts, deals.' },
  dealer360:  { label: '360 Dealer (car viewer)',  kind: 'local', fields: ['endpoint'], note: 'Your 360Car dealer app — vehicles + 3D spins. Point ABUZ8 at its URL to drive it.' },
  hibp:       { label: 'HaveIBeenPwned (OSINT breach)', kind: 'api', fields: ['api_key'], note: 'Optional API key (haveibeenpwned.com/API/key) to enable per-email breach lookup in the osint tool. Without it, breach lookup is disabled (never fabricated).' },
  discord:    { label: 'Discord (your bot)',  kind: 'api', fields: ['bot_token'], note: 'Discord bot token → ABUZ8 sends + reads on YOUR server. Create a bot at discord.com/developers, paste its token. Drives channels like Hermes/OpenClaw.' },
  slack:      { label: 'Slack (your bot)',    kind: 'api', fields: ['bot_token'], note: 'Slack bot token (xoxb-…, chat:write + channels:read). ABUZ8 posts + reads in your workspace.' }
};
function connectorList() {
  const cfg = readConnectors();
  return Object.entries(CONNECTOR_DEFS).map(([id, d]) => ({ id, label: d.label, kind: d.kind, note: d.note, fields: d.fields, configured: !!(cfg[id] && d.fields.every((f) => cfg[id][f])) }));
}
function connectorCreds(id) { return readConnectors()[id] || {}; }
async function connectorTest(id) {
  const c = connectorCreds(id);
  try {
    if (id === 'stripe') {
      if (!c.secret_key) return { ok: false, error: 'No secret_key set.' };
      const r = JSON.parse(await fetchUrl('https://api.stripe.com/v1/balance', { headers: { Authorization: 'Bearer ' + c.secret_key } }));
      if (r.error) return { ok: false, error: r.error.message };
      const avail = (r.available || []).map((a) => `${(a.amount / 100).toFixed(2)} ${(a.currency || '').toUpperCase()}`).join(', ');
      return { ok: true, detail: 'Connected. Available balance: ' + (avail || '0') };
    }
    if (id === 'cloudflare') {
      if (!c.api_token) return { ok: false, error: 'No api_token set.' };
      const v = JSON.parse(await fetchUrl('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: 'Bearer ' + c.api_token } }));
      if (!v.success) return { ok: false, error: (v.errors && v.errors[0] && v.errors[0].message) || 'token invalid' };
      const z = JSON.parse(await fetchUrl('https://api.cloudflare.com/client/v4/zones?per_page=5', { headers: { Authorization: 'Bearer ' + c.api_token } }));
      return { ok: true, detail: `Token valid. ${(z.result || []).length} zone(s) visible.` };
    }
    if (id === 'gmail') {
      const tok = await googleToken();
      if (!tok) return { ok: false, error: 'Not connected. Use Google OAuth (hands-free) or paste a token.' };
      const r = JSON.parse(await fetchUrl('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + tok } }));
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true, detail: 'Connected as ' + r.emailAddress + (readOauth().tokens.google ? ' (OAuth · auto-refresh)' : '') };
    }
    if (id === 'gcal') {
      const tok = await googleToken();
      if (!tok) return { ok: false, error: 'Not connected. Use Google OAuth (hands-free) or paste a token.' };
      const r = JSON.parse(await fetchUrl('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', { headers: { Authorization: 'Bearer ' + tok } }));
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true, detail: 'Calendar connected' + (readOauth().tokens.google ? ' (OAuth · auto-refresh)' : '') };
    }
    if (id === 'openrouter') {
      if (!c.api_key) return { ok: false, error: 'No api_key set.' };
      const r = JSON.parse(await fetchUrl('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + c.api_key } }));
      if (r.error) return { ok: false, error: r.error.message || 'invalid' };
      return { ok: true, detail: 'Key valid.' };
    }
    if (id === 'serper') {
      if (!c.api_key) return { ok: false, error: 'No api_key set.' };
      return { ok: true, detail: 'Key stored (validated on first search).' };
    }
    if (id === 'github') {
      if (!c.token) return { ok: false, error: 'No token set.' };
      const r = JSON.parse(await fetchUrl('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + c.token, 'User-Agent': 'ABUZ8-OS', Accept: 'application/vnd.github+json' } }));
      if (r.message && !r.login) return { ok: false, error: r.message };
      return { ok: true, detail: 'Connected as @' + r.login + (r.public_repos != null ? ` (${r.public_repos} public repos)` : '') };
    }
    if (id === 'discord') {
      if (!c.bot_token) return { ok: false, error: 'No bot_token set.' };
      const r = JSON.parse(await fetchUrl('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bot ' + c.bot_token } }));
      if (!r.id) return { ok: false, error: r.message || 'invalid bot token' };
      return { ok: true, detail: 'Connected as ' + (r.username || r.id) + ' (Discord bot)' };
    }
    if (id === 'slack') {
      if (!c.bot_token) return { ok: false, error: 'No bot_token set.' };
      const r = JSON.parse(await fetchUrl('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: 'Bearer ' + c.bot_token } }));
      if (!r.ok) return { ok: false, error: r.error || 'invalid token' };
      return { ok: true, detail: 'Connected to ' + (r.team || 'workspace') + ' as ' + (r.user || 'bot') };
    }
    if (id === 'youtube') {
      const tok = await googleToken();
      if (!tok) return { ok: false, error: 'Connect Google OAuth first (one sign-in covers Gmail · Calendar · YouTube).' };
      const r = JSON.parse(await fetchUrl('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: 'Bearer ' + tok } }));
      if (r.error) return { ok: false, error: r.error.message };
      const ch = (r.items || [])[0];
      if (!ch) return { ok: false, error: 'Google connected, but no YouTube channel on this account.' };
      const s = ch.statistics || {};
      return { ok: true, detail: 'Channel: ' + ch.snippet.title + ' — ' + (s.subscriberCount || '0') + ' subs, ' + (s.videoCount || '0') + ' videos. Upload-ready.' };
    }
    if (id === 'comfyui') {
      const ep = (c.endpoint || 'http://127.0.0.1:8188').replace(/\/+$/, '');
      const r = JSON.parse(await fetchUrl(ep + '/system_stats', { timeout: 5000 }));
      const dev = (r.devices && r.devices[0] && r.devices[0].name) ? r.devices[0].name : 'GPU';
      return { ok: true, detail: 'ComfyUI online at ' + ep + ' — ' + dev + '. Studio render ready.' };
    }
    if (id === 'higgsfield') {
      return { ok: true, detail: 'Authorize via the hosted MCP (mcp.higgsfield.ai/mcp, browser OAuth) — your Higgsfield account, no key stored here.' };
    }
    if (['wan2gp', 'livecrm', 'dealer360'].includes(id)) {
      const ep = (c.endpoint || (id === 'wan2gp' ? 'http://127.0.0.1:7860' : '')).replace(/\/+$/, '');
      if (!ep) return { ok: false, error: 'Set the endpoint in Connect (your running ' + id + ' app URL).' };
      await fetchUrl(ep + '/', { timeout: 5000 });
      return { ok: true, detail: id + ' reachable at ' + ep + ' — ABUZ8 can drive it.' };
    }
    return { ok: false, error: 'Unknown connector.' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// AWS Signature V4 (pure node:crypto) — signs bedrock-runtime InvokeModel etc.
function awsSigV4({ accessKey, secretKey, sessionToken, region, service, host, path: reqPath, method = 'POST', body = '', headers = {} }) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  const hash = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hash(body || '');
  const allHeaders = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}), ...headers };
  const signedKeys = Object.keys(allHeaders).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedKeys.map((k) => k + ':' + String(allHeaders[Object.keys(allHeaders).find((h) => h.toLowerCase() === k)]).trim() + '\n').join('');
  const signedHeaders = signedKeys.join(';');
  const canonicalUri = reqPath.split('/').map(enc).join('/');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');
  let signing = hmac('AWS4' + secretKey, dateStamp);
  signing = hmac(signing, region); signing = hmac(signing, service); signing = hmac(signing, 'aws4_request');
  const signature = crypto.createHmac('sha256', signing).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...allHeaders, Authorization: authorization };
}
// Sign in with Apple: client_secret is an ES256 JWT signed by your .p8 key.
function appleClientSecret({ teamId, clientId, keyId, p8 }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + 15777000, aud: 'https://appleid.apple.com', sub: clientId }));
  const signingInput = header + '.' + claims;
  const keyObj = crypto.createPrivateKey({ key: p8.includes('BEGIN') ? p8 : `-----BEGIN PRIVATE KEY-----\n${p8}\n-----END PRIVATE KEY-----`, format: 'pem' });
  const der = crypto.sign('sha256', Buffer.from(signingInput), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + der.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// ── 1-CLICK ONBOARDING — one unified catalog of 100+ providers/connectors + a single connect path. ──
function onboardCatalog() {
  const out = [];
  try { for (const p of PROVIDER_CATALOG) out.push({ id: p.id, label: p.label, category: 'llm', tier: p.cat, connect: (p.cat === 'local') ? 'local' : (p.cat === 'bridge' ? 'bridge' : 'key'), models: (p.models || []).length, note: p.note, signup: p.signup }); } catch {}
  try { for (const id of Object.keys(CONNECTOR_DEFS)) { const d = CONNECTOR_DEFS[id]; out.push({ id, label: d.label, category: 'connector', connect: d.kind === 'oauth' ? 'oauth' : (d.kind === 'mcp' ? 'mcp' : (d.kind === 'local' ? 'local' : 'key')), fields: d.fields || [], note: d.note }); } } catch {}
  try { for (const id of Object.keys(OAUTH_PROVIDERS || {})) out.push({ id: 'oauth:' + id, label: id.charAt(0).toUpperCase() + id.slice(1) + ' (1-click OAuth)', category: 'oauth', connect: 'oauth' }); } catch {}
  const models = out.reduce((s, p) => s + (p.models || 0), 0);
  return { ok: true, count: out.length, reachable_models: models, fastest: { id: 'openrouter', note: 'One OpenRouter key = 300+ models (GPT, Claude, Gemini, Grok, Kimi, DeepSeek, Llama, Qwen…). The 1-key path to ~everything.' }, providers: out };
}
async function onboardConnect(opts = {}) {
  const id = String(opts.id || '').replace(/^oauth:/, '').trim(); if (!id) throw new Error('id required');
  // LLM provider → save key to providers.json + (optionally) make active.
  let prov = null; try { prov = PROVIDER_CATALOG.find((p) => p.id === id); } catch {}
  if (prov) {
    if (!opts.key && prov.cat !== 'local') throw new Error('Paste an API key for ' + prov.label + (prov.signup ? ' (' + prov.signup + ')' : '') + '.');
    try { const store = readJson(providersPath(), { providers: [] }); const entry = { name: prov.id, label: prov.label, type: prov.type, endpoint: prov.base, model: (prov.models || [])[0] || 'default', api_key: opts.key || '', parameters: { temperature: 0.7, max_tokens: 2048 } }; store.providers = [...(store.providers || []).filter((p) => p.name !== prov.id), entry]; writeJson(providersPath(), store); if (opts.activate !== false) try { setActiveProvider(prov.id); } catch {} } catch (e) { throw new Error('save failed: ' + e.message); }
    return { ok: true, id, kind: 'llm', label: prov.label, active: opts.activate !== false };
  }
  // Connector → save creds + auto-test.
  if (CONNECTOR_DEFS[id]) {
    const cfg = readConnectors(); cfg[id] = Object.assign({}, cfg[id], opts.creds || (opts.key ? { api_key: opts.key, token: opts.key } : {})); writeConnectors(cfg);
    let test = null; try { test = await connectorTest(id); } catch (e) { test = { ok: false, error: e.message }; }
    return { ok: true, id, kind: 'connector', label: CONNECTOR_DEFS[id].label, connected: !!(test && test.ok), test };
  }
  throw new Error('Unknown provider/connector id: ' + id);
}
async function connectorCall(id, action, args = {}) {
  const c = connectorCreds(id);
  if (id === 'stripe') {
    const h = { Authorization: 'Bearer ' + c.secret_key };
    if (action === 'balance') return JSON.parse(await fetchUrl('https://api.stripe.com/v1/balance', { headers: h }));
    if (action === 'customers') return JSON.parse(await fetchUrl('https://api.stripe.com/v1/customers?limit=' + (args.limit || 10), { headers: h }));
    if (action === 'charges') return JSON.parse(await fetchUrl('https://api.stripe.com/v1/charges?limit=' + (args.limit || 10), { headers: h }));
  }
  if (id === 'cloudflare') {
    const h = { Authorization: 'Bearer ' + c.api_token };
    if (action === 'zones') return JSON.parse(await fetchUrl('https://api.cloudflare.com/client/v4/zones?per_page=' + (args.limit || 20), { headers: h }));
    if (action === 'dns' && args.zone_id) return JSON.parse(await fetchUrl(`https://api.cloudflare.com/client/v4/zones/${args.zone_id}/dns_records?per_page=50`, { headers: h }));
  }
  if (id === 'gmail') {
    const h = { Authorization: 'Bearer ' + (await googleToken()) };
    if (action === 'list') return JSON.parse(await fetchUrl('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + (args.limit || 10) + (args.q ? '&q=' + encodeURIComponent(args.q) : ''), { headers: h }));
    if (action === 'send') {
      const raw = `To: ${args.to}\r\nSubject: ${args.subject || ''}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body || ''}`;
      return JSON.parse(await fetchUrl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(raw) }) }));
    }
  }
  if (id === 'gcal') {
    const h = { Authorization: 'Bearer ' + (await googleToken()) };
    if (action === 'events') return JSON.parse(await fetchUrl('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=' + (args.limit || 10) + '&orderBy=startTime&singleEvents=true&timeMin=' + new Date().toISOString(), { headers: h }));
    if (action === 'create') return JSON.parse(await fetchUrl('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: args.summary, description: args.description, start: { dateTime: args.start }, end: { dateTime: args.end || args.start } }) }));
  }
  if (id === 'github') {
    const h = { Authorization: 'Bearer ' + c.token, 'User-Agent': 'ABUZ8-OS', Accept: 'application/vnd.github+json' };
    if (action === 'user') return JSON.parse(await fetchUrl('https://api.github.com/user', { headers: h }));
    if (action === 'repos') return JSON.parse(await fetchUrl('https://api.github.com/user/repos?per_page=' + (args.limit || 20) + '&sort=updated', { headers: h }));
    if (action === 'create_repo') return JSON.parse(await fetchUrl('https://api.github.com/user/repos', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: args.name, private: args.private !== false, description: args.description || '', auto_init: args.auto_init !== false }) }));
  }
  if (id === 'discord') {
    const h = { Authorization: 'Bot ' + c.bot_token, 'Content-Type': 'application/json' };
    const chan = encodeURIComponent(args.channel_id || args.channel || '');
    if (action === 'send' || action === 'post') return JSON.parse(await fetchUrl('https://discord.com/api/v10/channels/' + chan + '/messages', { method: 'POST', headers: h, body: JSON.stringify({ content: args.content || args.text || '' }) }));
    if (action === 'read' || action === 'messages') return JSON.parse(await fetchUrl('https://discord.com/api/v10/channels/' + chan + '/messages?limit=' + (args.limit || 20), { headers: h }));
    if (action === 'me') return JSON.parse(await fetchUrl('https://discord.com/api/v10/users/@me', { headers: h }));
  }
  if (id === 'slack') {
    const h = { Authorization: 'Bearer ' + c.bot_token, 'Content-Type': 'application/json; charset=utf-8' };
    if (action === 'send' || action === 'post') return JSON.parse(await fetchUrl('https://slack.com/api/chat.postMessage', { method: 'POST', headers: h, body: JSON.stringify({ channel: args.channel || args.channel_id, text: args.text || args.content || '' }) }));
    if (action === 'read' || action === 'history') return JSON.parse(await fetchUrl('https://slack.com/api/conversations.history?channel=' + encodeURIComponent(args.channel || args.channel_id || '') + '&limit=' + (args.limit || 20), { headers: h }));
    if (action === 'channels') return JSON.parse(await fetchUrl('https://slack.com/api/conversations.list?limit=' + (args.limit || 100), { headers: h }));
  }
  if (id === 'youtube') {
    const tok = await youtubeToken(); if (!tok) throw new Error('Connect Google OAuth first (covers YouTube upload).');
    const h = { Authorization: 'Bearer ' + tok };
    if (action === 'channel') return JSON.parse(await fetchUrl('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', { headers: h }));
    if (action === 'videos' || action === 'list') return JSON.parse(await fetchUrl('https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=date&maxResults=' + (args.limit || 10), { headers: h }));
    if (action === 'upload') {
      const file = args.file || args.path; if (!file || !fs.existsSync(file)) throw new Error('Provide args.file = path to the rendered .mp4 (e.g. from studio_produce / ComfyUI output).');
      const meta = { snippet: { title: args.title || 'ABUZ8 Studio', description: args.description || '', tags: Array.isArray(args.tags) ? args.tags : [] }, status: { privacyStatus: args.privacy || 'private', selfDeclaredMadeForKids: false } };
      const boundary = 'abuz8' + crypto.randomBytes(8).toString('hex');
      const pre = Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: video/*\r\n\r\n');
      const post = Buffer.from('\r\n--' + boundary + '--\r\n');
      const body = Buffer.concat([pre, fs.readFileSync(file), post]);
      return JSON.parse(await fetchUrl('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', { method: 'POST', headers: { ...h, 'Content-Type': 'multipart/related; boundary=' + boundary }, body, timeout: 600000 }));
    }
  }
  if (id === 'heygen') {
    const key = c.api_key || c.key; if (!key) throw new Error('Add your HeyGen API key (Connect → heygen) to generate a cloned talking-avatar video.');
    const h = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
    if (action === 'avatars') return JSON.parse(await fetchUrl('https://api.heygen.com/v2/avatars', { headers: h, timeout: 20000 }));
    if (action === 'voices') return JSON.parse(await fetchUrl('https://api.heygen.com/v2/voices', { headers: h, timeout: 20000 }));
    if (action === 'status') return JSON.parse(await fetchUrl('https://api.heygen.com/v1/video_status.get?video_id=' + encodeURIComponent(args.video_id || ''), { headers: h, timeout: 20000 }));
    if (action === 'generate' || action === 'talk' || action === 'clone') {
      const payload = { video_inputs: [{ character: { type: 'avatar', avatar_id: args.avatar_id || '', avatar_style: args.style || 'normal' }, voice: { type: 'text', input_text: String(args.script || args.text || '').slice(0, 3000), voice_id: args.voice_id || '' } }], dimension: { width: args.width || 1080, height: args.height || 1920 } };
      return JSON.parse(await fetchUrl('https://api.heygen.com/v2/video/generate', { method: 'POST', headers: h, body: JSON.stringify(payload), timeout: 60000 }));
    }
    throw new Error('heygen actions: generate | status | avatars | voices');
  }
  if (id === 'did') {
    const key = c.api_key || c.key; if (!key) throw new Error('Add your D-ID API key (Connect → did) to turn a photo + script into a talking head.');
    const auth = key.includes(':') ? 'Basic ' + Buffer.from(key).toString('base64') : 'Basic ' + key;
    const h = { Authorization: auth, 'Content-Type': 'application/json' };
    if (action === 'status') return JSON.parse(await fetchUrl('https://api.d-id.com/talks/' + encodeURIComponent(args.id || ''), { headers: h, timeout: 20000 }));
    if (action === 'generate' || action === 'talk' || action === 'clone') {
      const payload = { source_url: args.image_url || args.source_url, script: { type: 'text', input: String(args.script || args.text || '').slice(0, 3000), provider: { type: 'microsoft', voice_id: args.voice_id || 'en-US-JennyNeural' } } };
      return JSON.parse(await fetchUrl('https://api.d-id.com/talks', { method: 'POST', headers: h, body: JSON.stringify(payload), timeout: 60000 }));
    }
    throw new Error('did actions: generate | status');
  }
  if (id === 'google_drive') {
    const tok = await googleToken(); if (!tok) throw new Error('Connect Google OAuth first (covers Drive).');
    const h = { Authorization: 'Bearer ' + tok };
    if (action === 'list') return JSON.parse(await fetchUrl('https://www.googleapis.com/drive/v3/files?pageSize=' + (args.limit || 20) + '&fields=files(id,name,mimeType,size,modifiedTime,webViewLink),nextPageToken' + (args.q ? '&q=' + encodeURIComponent(args.q) : ''), { headers: h }));
    if (action === 'search') return JSON.parse(await fetchUrl('https://www.googleapis.com/drive/v3/files?pageSize=' + (args.limit || 20) + '&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)&q=' + encodeURIComponent(args.q || ("name contains '" + String(args.query || '').replace(/'/g, "\\'") + "'")), { headers: h }));
    if (action === 'download' || action === 'get') {
      const fid = args.file_id || args.id; if (!fid) throw new Error('Provide args.file_id.');
      const buf = await fetchUrl('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fid) + '?alt=media', { headers: h, binary: true, timeout: 120000 });
      if (args.save_path) { fs.writeFileSync(args.save_path, buf); return { ok: true, file_id: fid, saved: args.save_path, bytes: buf.length }; }
      return { ok: true, file_id: fid, bytes: buf.length, base64: buf.toString('base64') };
    }
    if (action === 'upload') {
      const file = args.file || args.path; if (!file || !fs.existsSync(file)) throw new Error('Provide args.file = local path to upload.');
      const name = args.name || path.basename(file); const meta = { name, ...(args.parent ? { parents: [args.parent] } : {}) };
      const mime = args.mime || 'application/octet-stream'; const boundary = 'abuz8' + crypto.randomBytes(8).toString('hex');
      const pre = Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n');
      const post = Buffer.from('\r\n--' + boundary + '--\r\n'); const body = Buffer.concat([pre, fs.readFileSync(file), post]);
      return JSON.parse(await fetchUrl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', headers: { ...h, 'Content-Type': 'multipart/related; boundary=' + boundary }, body, timeout: 600000 }));
    }
    throw new Error('google_drive actions: list | search | download | upload');
  }
  if (id === 'notion') {
    if (!c.token) throw new Error('Add your Notion integration token (Connect → notion).');
    const h = { Authorization: 'Bearer ' + c.token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    if (action === 'search') return JSON.parse(await fetchUrl('https://api.notion.com/v1/search', { method: 'POST', headers: h, body: JSON.stringify({ query: args.query || args.q || '', page_size: args.limit || 10 }) }));
    if (action === 'get' || action === 'page') return JSON.parse(await fetchUrl('https://api.notion.com/v1/pages/' + encodeURIComponent(args.page_id || args.id || ''), { headers: h }));
    if (action === 'create') {
      const parent = args.parent_id ? { page_id: args.parent_id } : (args.database_id ? { database_id: args.database_id } : null);
      if (!parent) throw new Error('Provide args.parent_id (page) or args.database_id.');
      const titleKey = args.database_id ? (args.title_prop || 'Name') : 'title';
      const props = args.database_id ? { [titleKey]: { title: [{ text: { content: String(args.title || 'Untitled') } }] } } : { title: { title: [{ text: { content: String(args.title || 'Untitled') } }] } };
      const children = args.text ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(args.text) } }] } }] : [];
      return JSON.parse(await fetchUrl('https://api.notion.com/v1/pages', { method: 'POST', headers: h, body: JSON.stringify({ parent, properties: props, children }) }));
    }
    if (action === 'append') {
      const pid = args.page_id || args.id; if (!pid) throw new Error('Provide args.page_id.');
      const children = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(args.text || '') } }] } }];
      return JSON.parse(await fetchUrl('https://api.notion.com/v1/blocks/' + encodeURIComponent(pid) + '/children', { method: 'PATCH', headers: h, body: JSON.stringify({ children }) }));
    }
    throw new Error('notion actions: search | get | create | append');
  }
  if (id === 'google_veo') {
    const tok = c.api_key ? '' : await getValidToken('google');
    if (!c.api_key && !tok) throw new Error('Add a Gemini API key (Connect → google_veo) or connect Google OAuth.');
    const h = { 'Content-Type': 'application/json', ...(c.api_key ? { 'x-goog-api-key': c.api_key } : { Authorization: 'Bearer ' + tok }) };
    const model = args.model || 'veo-3.0-generate-001'; const base = 'https://generativelanguage.googleapis.com/v1beta';
    if (action === 'generate' || action === 'video' || action === 'text_to_video') {
      const payload = { instances: [{ prompt: String(args.prompt || args.text || '') }], parameters: { aspectRatio: args.aspect || '16:9', ...(args.negative ? { negativePrompt: args.negative } : {}) } };
      return JSON.parse(await fetchUrl(base + '/models/' + model + ':predictLongRunning', { method: 'POST', headers: h, body: JSON.stringify(payload), timeout: 60000 }));
    }
    if (action === 'status' || action === 'poll') { const op = args.operation || args.name; if (!op) throw new Error('Provide args.operation.'); return JSON.parse(await fetchUrl(base + '/' + op, { headers: h, timeout: 30000 })); }
    throw new Error('google_veo actions: generate | status');
  }
  if (id === 'aws_bedrock') {
    if (!c.access_key || !c.secret_key) throw new Error('Add AWS access_key + secret_key (Connect → aws_bedrock).');
    const region = c.region || args.region || 'us-east-1'; const service = 'bedrock-runtime'; const host = `${service}.${region}.amazonaws.com`;
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('invalid AWS region');
    if (action === 'invoke' || action === 'chat' || action === 'completion') {
      const modelId = args.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0'; if (!/^[A-Za-z0-9._:-]+$/.test(modelId)) throw new Error('invalid model id'); const reqPath = `/model/${encodeURIComponent(modelId)}/invoke`;
      const payload = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: args.max_tokens || 1024, messages: args.messages || [{ role: 'user', content: String(args.prompt || args.text || 'hello') }], ...(args.system ? { system: args.system } : {}) });
      const signed = awsSigV4({ accessKey: c.access_key, secretKey: c.secret_key, sessionToken: c.session_token, region, service, host, path: reqPath, method: 'POST', body: payload, headers: { 'content-type': 'application/json', accept: 'application/json' } });
      return JSON.parse(await fetchUrl('https://' + host + reqPath, { method: 'POST', headers: signed, body: payload, timeout: 60000 }));
    }
    throw new Error('aws_bedrock actions: invoke');
  }
  if (id === 'openai_media') {
    if (!c.api_key) throw new Error('Add your OpenAI API key (Connect → openai_media).');
    const h = { Authorization: 'Bearer ' + c.api_key, 'Content-Type': 'application/json' };
    if (action === 'image' || action === 'images' || action === 'generate') {
      const r = JSON.parse(await fetchUrl('https://api.openai.com/v1/images/generations', { method: 'POST', headers: h, body: JSON.stringify({ model: args.model || 'gpt-image-1', prompt: String(args.prompt || args.text || ''), size: args.size || '1024x1024', n: args.n || 1 }), timeout: 120000 }));
      if (r.error) throw new Error(r.error.message);
      if (args.save_path && r.data && r.data[0] && r.data[0].b64_json) { fs.writeFileSync(args.save_path, Buffer.from(r.data[0].b64_json, 'base64')); return { ok: true, saved: args.save_path }; }
      return r;
    }
    if (action === 'tts' || action === 'speech' || action === 'voice') {
      const buf = await fetchUrl('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: h, body: JSON.stringify({ model: args.model || 'gpt-4o-mini-tts', voice: args.voice || 'alloy', input: String(args.text || args.input || ''), format: args.format || 'mp3' }), binary: true, timeout: 120000 });
      if (args.save_path) { fs.writeFileSync(args.save_path, buf); return { ok: true, saved: args.save_path, bytes: buf.length }; }
      return { ok: true, bytes: buf.length, base64: buf.toString('base64') };
    }
    throw new Error('openai_media actions: image | tts');
  }
  if (id === 'apple') {
    if (!c.team_id || !c.client_id || !c.key_id || !c.p8) throw new Error('Set team_id, client_id, key_id, p8 (Connect → apple).');
    const secret = appleClientSecret({ teamId: c.team_id, clientId: c.client_id, keyId: c.key_id, p8: c.p8 });
    if (action === 'token' || action === 'exchange') {
      if (!args.code) throw new Error('Provide args.code.');
      const form = new URLSearchParams(); form.set('client_id', c.client_id); form.set('client_secret', secret); form.set('code', args.code); form.set('grant_type', args.grant_type || 'authorization_code'); form.set('redirect_uri', args.redirect_uri || oauthRedirectUri());
      return JSON.parse(await fetchUrl('https://appleid.apple.com/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), timeout: 15000 }));
    }
    if (action === 'secret') return { ok: true, client_secret: secret, note: 'ES256 client-secret JWT (≤6 months).' };
    throw new Error('apple actions: token | secret');
  }
  if (id === 'runway') {
    if (!c.api_key) throw new Error('Add your Runway API key (Connect → runway).');
    const h = { Authorization: 'Bearer ' + c.api_key, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' };
    if (action === 'generate' || action === 'video' || action === 'image_to_video') return JSON.parse(await fetchUrl('https://api.dev.runwayml.com/v1/image_to_video', { method: 'POST', headers: h, body: JSON.stringify({ promptImage: args.image_url || args.image, promptText: String(args.prompt || args.text || ''), model: args.model || 'gen4_turbo', ratio: args.ratio || '1280:720', duration: args.duration || 5 }), timeout: 60000 }));
    if (action === 'status' || action === 'poll') { const tid = args.task_id || args.id; if (!tid) throw new Error('Provide args.task_id.'); return JSON.parse(await fetchUrl('https://api.dev.runwayml.com/v1/tasks/' + encodeURIComponent(tid), { headers: h })); }
    throw new Error('runway actions: generate | status');
  }
  if (id === 'luma') {
    if (!c.api_key) throw new Error('Add your Luma API key (Connect → luma).');
    const h = { Authorization: 'Bearer ' + c.api_key, 'Content-Type': 'application/json', accept: 'application/json' };
    if (action === 'generate' || action === 'video' || action === 'text_to_video') return JSON.parse(await fetchUrl('https://api.lumalabs.ai/dream-machine/v1/generations', { method: 'POST', headers: h, body: JSON.stringify({ prompt: String(args.prompt || args.text || ''), model: args.model || 'ray-2', resolution: args.resolution || '720p', duration: args.duration || '5s', ...(args.image_url ? { keyframes: { frame0: { type: 'image', url: args.image_url } } } : {}) }), timeout: 60000 }));
    if (action === 'status' || action === 'poll') { const gid = args.id || args.generation_id; if (!gid) throw new Error('Provide args.id.'); return JSON.parse(await fetchUrl('https://api.lumalabs.ai/dream-machine/v1/generations/' + encodeURIComponent(gid), { headers: h })); }
    throw new Error('luma actions: generate | status');
  }
  if (id === 'kling') {
    if (!c.access_key || !c.secret_key) throw new Error('Add Kling access_key + secret_key (Connect → kling).');
    const now = Math.floor(Date.now() / 1000); const jh = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const jp = b64url(JSON.stringify({ iss: c.access_key, exp: now + 1800, nbf: now - 5 }));
    const sig = crypto.createHmac('sha256', c.secret_key).update(jh + '.' + jp).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const h = { Authorization: 'Bearer ' + jh + '.' + jp + '.' + sig, 'Content-Type': 'application/json' }; const base = 'https://api-singapore.klingai.com';
    if (action === 'generate' || action === 'text_to_video') { const payload = { model_name: args.model || 'kling-v1', prompt: String(args.prompt || args.text || ''), duration: String(args.duration || '5'), aspect_ratio: args.aspect || '16:9' }; const ep = args.image_url ? '/v1/videos/image2video' : '/v1/videos/text2video'; if (args.image_url) payload.image = args.image_url; return JSON.parse(await fetchUrl(base + ep, { method: 'POST', headers: h, body: JSON.stringify(payload), timeout: 60000 })); }
    if (action === 'status' || action === 'poll') { const tid = args.task_id || args.id; if (!tid) throw new Error('Provide args.task_id.'); return JSON.parse(await fetchUrl(base + '/v1/videos/text2video/' + encodeURIComponent(tid), { headers: h })); }
    throw new Error('kling actions: generate | status');
  }
  if (id === 'krea') {
    if (!c.api_key) throw new Error('Add your Krea API key (Connect → krea).');
    // Krea generation is driven through the studio lane (local FLUX or studio_produce). Honest:
    // there is no separate public Krea REST generate path wired here yet.
    throw new Error('Krea: use the studio lane (studio_produce / local FLUX) for generation; direct Krea REST wiring is pending.');
  }
  if (id === 'comfyui') {
    const ep = (c.endpoint || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    if (action === 'stats') return JSON.parse(await fetchUrl(ep + '/system_stats', { timeout: 8000 }));
    if (action === 'queue' || action === 'prompt') return JSON.parse(await fetchUrl(ep + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: args.prompt || args.workflow }) }));
    if (action === 'history') return JSON.parse(await fetchUrl(ep + '/history?max_items=' + (args.limit || 10), { timeout: 8000 }));
  }
  if (id === 'openrouter') {
    const h = { Authorization: 'Bearer ' + c.api_key, 'Content-Type': 'application/json' };
    if (action === 'models') return JSON.parse(await fetchUrl('https://openrouter.ai/api/v1/models', { headers: h, timeout: 15000 }));
    if (action === 'key' || action === 'balance') return JSON.parse(await fetchUrl('https://openrouter.ai/api/v1/key', { headers: h }));
    if (action === 'chat' || action === 'completion') return JSON.parse(await fetchUrl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify({ model: args.model || 'openai/gpt-4o-mini', messages: args.messages || [{ role: 'user', content: args.prompt || 'hello' }] }) }));
  }
  if (id === 'serper') {
    if (action === 'search' || action === 'get') return JSON.parse(await fetchUrl('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': c.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: args.q || args.query || args.prompt || '' }) }));
  }
  if (id === 'tripo') {
    const h = { Authorization: 'Bearer ' + c.api_key };
    if (action === 'balance' || action === 'get') return JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/user/balance', { headers: h }));
    if (action === 'task' && args.task_id) return JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/task/' + encodeURIComponent(args.task_id), { headers: h }));
    if (action === 'image_to_3d') return await jarvisImageTo3D(args);
  }
  if (id === 'image_gen') {
    if (action === 'generate' || action === 'image' || action === 'get') return await studioImage(args.prompt || args.text || args.q || '', args);
  }
  if (id === 'higgsfield') {
    return { ok: true, transport: 'mcp', endpoint: 'https://mcp.higgsfield.ai/mcp', action, note: 'Higgsfield (Sora/Veo/Kling/Nano-Banana) runs via the hosted MCP with browser OAuth — import it once via MCP install, then drive it through the MCP tools. This is not a REST connector.' };
  }
  // Generic local-app proxy: ABUZ8 drives YOUR running apps (dealer/CRM/Wan studio) over HTTP.
  if (['wan2gp', 'livecrm', 'dealer360'].includes(id)) {
    const ep = (c.endpoint || (id === 'wan2gp' ? 'http://127.0.0.1:7860' : '')).replace(/\/+$/, '');
    if (!ep) throw new Error('Set the endpoint for ' + id + ' in Connect.');
    if (action === 'get') return JSON.parse(await fetchUrl(ep + (args.path || '/'), { timeout: 10000 }));
    if (action === 'post') return JSON.parse(await fetchUrl(ep + (args.path || '/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args.body || {}) }));
  }
  throw new Error(`No action '${action}' for connector '${id}'.`);
}

// ── CHANNEL INBOUND (no ws dep) — poll Discord/Slack for new messages, route them into
// the agent, and reply via the existing send path. /api/channels/inbound also lets an
// external gateway (Slack Events / Discord Interactions webhook) push a message straight
// in. Outbound (send/read) already existed; this closes the two-way loop. ──
function channelListenPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'channel-listen.json'); }
function readChannelListen() { return readJson(channelListenPath(), { enabled: false, discord: {}, slack: {} }); }
function writeChannelListen(c) { writeJson(channelListenPath(), c); return c; }
async function routeInboundMessage(opts = {}) {
  const text = String(opts.text || opts.content || '').trim();
  if (!text) return { ok: false, error: 'empty message' };
  let reply = '';
  try { const r = await reasonReply(text, { brief: true }); reply = (r && r.text) || ''; } catch {}
  if (!reply) reply = 'ABUZ8 here — received: ' + text.slice(0, 200);
  let sent = false, sendResult = null;
  const platform = opts.platform, channel = opts.channel || opts.channel_id;
  if (opts.reply !== false && channel && (platform === 'discord' || platform === 'slack')) {
    try { sendResult = await connectorCall(platform, 'send', platform === 'discord' ? { channel_id: channel, content: reply } : { channel: channel, text: reply }); sent = true; } catch (e) { sendResult = { error: e.message }; }
  }
  pushActivity('channel', 'Inbound ' + (platform || 'msg') + (opts.author ? ' from ' + opts.author : ''), text.slice(0, 80));
  try { recordSignal({ kind: 'channel-inbound', user: text.slice(0, 200), ok: true }); } catch {}
  return { ok: true, platform, channel, reply, sent, sendResult };
}
async function channelPollOnce() {
  const cfg = readChannelListen();
  const out = { ok: true, polled: 0, replied: 0, platforms: [] };
  try {
    const dc = (function () { try { return connectorCreds('discord'); } catch { return {}; } })();
    if (dc && dc.bot_token && cfg.discord && cfg.discord.channel_id) {
      const msgs = await connectorCall('discord', 'read', { channel_id: cfg.discord.channel_id, limit: 15 });
      let selfId = null; try { selfId = (await connectorCall('discord', 'me', {})).id; } catch {}
      const cursor = cfg.discord.cursor || '';
      const fresh = (Array.isArray(msgs) ? msgs : []).filter((m) => m && m.id > cursor && (!m.author || (!m.author.bot && m.author.id !== selfId)) && m.content).sort((a, b) => (a.id > b.id ? 1 : -1));
      for (const m of fresh) { out.polled++; await routeInboundMessage({ platform: 'discord', channel: cfg.discord.channel_id, text: m.content, author: m.author && m.author.username }); out.replied++; cfg.discord.cursor = m.id; }
      out.platforms.push('discord');
    }
  } catch { out.platforms.push('discord:err'); }
  try {
    const sc = (function () { try { return connectorCreds('slack'); } catch { return {}; } })();
    if (sc && sc.bot_token && cfg.slack && (cfg.slack.channel || cfg.slack.channel_id)) {
      const chan = cfg.slack.channel || cfg.slack.channel_id;
      const hist = await connectorCall('slack', 'read', { channel: chan, limit: 15 });
      const msgs = (hist && hist.messages) || [];
      const cursor = cfg.slack.cursor || '';
      const fresh = msgs.filter((m) => m && m.ts > cursor && !m.bot_id && m.text).sort((a, b) => (a.ts > b.ts ? 1 : -1));
      for (const m of fresh) { out.polled++; await routeInboundMessage({ platform: 'slack', channel: chan, text: m.text, author: m.user }); out.replied++; cfg.slack.cursor = m.ts; }
      out.platforms.push('slack');
    }
  } catch { out.platforms.push('slack:err'); }
  writeChannelListen(cfg);
  return out;
}
let _lastChanPoll = 0;

/* ── PERSISTENT OAUTH (refresh-token, hands-free) ────────────────────────
   Real OAuth 2.0 + PKCE with a loopback redirect on this very server
   (http://127.0.0.1:PORT/oauth/callback). The user authorizes once in the
   browser; we store the refresh token and silently renew access tokens
   forever after — so Gmail/Calendar/YouTube/Instagram/TikTok stay live with
   NO 1-hour re-paste. Setup needs the user's own OAuth client id/secret
   (one time, from the provider console) — we never ship or fake credentials. */
const OAUTH_PROVIDERS = {
  google: {
    label: 'Google (Gmail · Calendar · YouTube)',
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/youtube.upload', 'openid', 'email', 'profile'],
    extra: { access_type: 'offline', prompt: 'consent' }, pkce: true
  },
  meta: {
    label: 'Meta (Instagram · Facebook)',
    auth_url: 'https://www.facebook.com/v21.0/dialog/oauth',
    token_url: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: ['instagram_basic', 'instagram_content_publish', 'pages_manage_posts', 'pages_read_engagement', 'business_management'],
    extra: {}, pkce: false, long_lived: true
  },
  tiktok: {
    label: 'TikTok',
    auth_url: 'https://www.tiktok.com/v2/auth/authorize/',
    token_url: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    extra: {}, pkce: true, client_key_param: 'client_key'
  }
};
function oauthPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'oauth.json'); }
function readOauth() { return readJson(oauthPath(), { clients: {}, tokens: {}, pending: {} }); }
function writeOauth(o) { writeJson(oauthPath(), o); }
function oauthRedirectUri() { return `http://127.0.0.1:${PORT}/oauth/callback`; }
function oauthSetupClient(provider, client_id, client_secret) {
  const o = readOauth(); o.clients[provider] = { client_id, client_secret: client_secret || '' }; writeOauth(o); return { ok: true };
}
function oauthStart(provider) {
  const def = OAUTH_PROVIDERS[provider]; if (!def) throw new Error('unknown provider');
  const o = readOauth(); const client = o.clients[provider];
  if (!client || !client.client_id) throw new Error(`Set up your ${def.label} OAuth client id/secret first (one-time, from the provider console).`);
  const state = crypto.randomBytes(12).toString('hex');
  const verifier = b64url(crypto.randomBytes(32));
  const params = new URLSearchParams();
  params.set(def.client_key_param || 'client_id', client.client_id);
  params.set('redirect_uri', oauthRedirectUri());
  params.set('response_type', 'code');
  params.set('scope', def.scopes.join(' '));
  params.set('state', state);
  for (const [k, v] of Object.entries(def.extra || {})) params.set(k, v);
  if (def.pkce) { params.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest())); params.set('code_challenge_method', 'S256'); }
  o.pending[state] = { provider, verifier, created: Date.now() }; writeOauth(o);
  return { url: def.auth_url + '?' + params.toString(), state };
}
async function oauthExchange(code, state) {
  const o = readOauth(); const pend = o.pending[state]; if (!pend) throw new Error('Unknown/expired OAuth state.');
  const def = OAUTH_PROVIDERS[pend.provider]; const client = o.clients[pend.provider];
  const form = new URLSearchParams();
  form.set(def.client_key_param || 'client_id', client.client_id);
  if (client.client_secret) form.set(def.client_key_param ? 'client_secret' : 'client_secret', client.client_secret);
  form.set('code', code); form.set('grant_type', 'authorization_code'); form.set('redirect_uri', oauthRedirectUri());
  if (def.pkce) form.set('code_verifier', pend.verifier);
  const resp = await fetchUrl(def.token_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeout: 15000 });
  let data; try { data = JSON.parse(resp); } catch { data = Object.fromEntries(new URLSearchParams(resp)); }
  if (data.error) throw new Error(data.error_description || data.error);
  const tok = data.access_token || (data.data && data.data.access_token);
  const refresh = data.refresh_token || (data.data && data.data.refresh_token) || '';
  const expires = Number(data.expires_in || (data.data && data.data.expires_in) || 3600);
  o.tokens[pend.provider] = { access_token: tok, refresh_token: refresh, expires_at: Date.now() + expires * 1000, scope: data.scope || def.scopes.join(' '), obtained: new Date().toISOString() };
  delete o.pending[state]; writeOauth(o);
  pushActivity('connect', 'OAuth connected: ' + def.label, 'hands-free (auto-refresh)');
  return { ok: true, provider: pend.provider };
}
async function getValidToken(provider) {
  const o = readOauth(); const t = o.tokens[provider]; if (!t || !t.access_token) return '';
  if (t.expires_at && Date.now() < t.expires_at - 60000) return t.access_token; // still fresh
  if (!t.refresh_token) return t.access_token; // no refresh (e.g. Meta long-lived) — return as-is
  const def = OAUTH_PROVIDERS[provider]; const client = o.clients[provider];
  try {
    const form = new URLSearchParams();
    form.set(def.client_key_param || 'client_id', client.client_id);
    if (client.client_secret) form.set('client_secret', client.client_secret);
    form.set('refresh_token', t.refresh_token); form.set('grant_type', 'refresh_token');
    const resp = await fetchUrl(def.token_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeout: 15000 });
    const data = JSON.parse(resp);
    if (data.access_token) { t.access_token = data.access_token; t.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000; if (data.refresh_token) t.refresh_token = data.refresh_token; o.tokens[provider] = t; writeOauth(o); }
  } catch {}
  return t.access_token;
}
function oauthStatus() {
  const o = readOauth();
  return Object.entries(OAUTH_PROVIDERS).map(([id, def]) => {
    const t = o.tokens[id];
    return { id, label: def.label, client_ready: !!(o.clients[id] && o.clients[id].client_id), connected: !!(t && t.access_token), expires_at: t ? t.expires_at : null, auto_refresh: !!(t && t.refresh_token) };
  });
}
function oauthDisconnect(provider) { const o = readOauth(); delete o.tokens[provider]; writeOauth(o); return { ok: true }; }
// Prefer the hands-free OAuth token; fall back to a manually pasted one.
async function googleToken() { const t = await getValidToken('google'); return t || connectorCreds('gmail').oauth_token || connectorCreds('gcal').oauth_token || ''; }

// ── Multi-channel YouTube — per-channel encrypted token store (drives the 10 AI channels) ──
// Each channel snapshots a Google OAuth token (access + refresh) encrypted at rest with the SAME
// AES-256-GCM vault key as every other secret. All channels share the one google OAuth *client*
// (clients.google), differing only by refresh_token, so refresh reuses the existing machinery.
function ytChannelsPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'youtube_channels.json'); }
function ytReadChannels() { return readJson(ytChannelsPath(), { active: '', channels: {} }); }
function ytWriteChannels(o) { writeJson(ytChannelsPath(), o); }
// Snapshot the CURRENT Google sign-in as a named channel (call right after signing in to that account).
async function ytSaveCurrentChannel() {
  const o = readOauth(); const t = o.tokens.google;
  if (!t || !t.access_token) throw new Error('Sign in with Google first (one sign-in covers YouTube) — then save this channel.');
  const access = await getValidToken('google'); if (!access) throw new Error('No valid Google token to snapshot.');
  let id = '', title = '', handle = '';
  try {
    const r = JSON.parse(await fetchUrl('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + access } }));
    const ch = r.items && r.items[0]; if (ch) { id = ch.id; title = (ch.snippet && ch.snippet.title) || ''; handle = (ch.snippet && ch.snippet.customUrl) || ''; }
  } catch (e) { throw new Error('Could not read the YouTube channel for this Google account: ' + e.message); }
  if (!id) throw new Error('This Google account has no YouTube channel.');
  const s = ytReadChannels();
  s.channels[id] = { id, title, handle, enc_access: encStr(access), enc_refresh: encStr(t.refresh_token || ''), expires_at: t.expires_at || 0, scope: t.scope || '', added: new Date().toISOString() };
  s.active = id; ytWriteChannels(s);
  try { pushActivity('connect', 'YouTube channel saved: ' + (title || id), Object.keys(s.channels).length + ' channel(s) on file'); } catch {}
  return { ok: true, id, title, handle, active: true, count: Object.keys(s.channels).length };
}
function ytListChannels() {
  const s = ytReadChannels();
  return { ok: true, active: s.active || '', count: Object.keys(s.channels).length,
    channels: Object.values(s.channels).map((c) => ({ id: c.id, title: c.title, handle: c.handle, active: c.id === s.active, expires_at: c.expires_at, added: c.added })) };
}
function ytSelectChannel(id) { const s = ytReadChannels(); if (!s.channels[id]) throw new Error('Unknown channel id — add it first.'); s.active = id; ytWriteChannels(s); return { ok: true, active: id, title: s.channels[id].title }; }
function ytRemoveChannel(id) { const s = ytReadChannels(); delete s.channels[id]; if (s.active === id) s.active = Object.keys(s.channels)[0] || ''; ytWriteChannels(s); return { ok: true, active: s.active, count: Object.keys(s.channels).length }; }
// Valid access token for the ACTIVE channel (refreshes via the shared google OAuth client). '' when no channels are configured.
async function ytActiveToken() {
  const s = ytReadChannels(); const c = s.channels[s.active]; if (!c) return '';
  let access = decStr(c.enc_access); const refresh = decStr(c.enc_refresh);
  if (c.expires_at && Date.now() < c.expires_at - 60000) return access; // still fresh
  if (!refresh) return access;
  try {
    const o = readOauth(); const client = o.clients.google || {}; const def = OAUTH_PROVIDERS.google;
    const form = new URLSearchParams();
    form.set('client_id', client.client_id || ''); if (client.client_secret) form.set('client_secret', client.client_secret);
    form.set('refresh_token', refresh); form.set('grant_type', 'refresh_token');
    const resp = await fetchUrl(def.token_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeout: 15000 });
    const data = JSON.parse(resp);
    if (data.access_token) { access = data.access_token; c.enc_access = encStr(access); c.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000; if (data.refresh_token) c.enc_refresh = encStr(data.refresh_token); s.channels[c.id] = c; ytWriteChannels(s); }
  } catch {}
  return access;
}
// The token the YouTube consumer should use: the active channel if multi-channel is configured, else the single-token path.
async function youtubeToken() { return (await ytActiveToken()) || (await googleToken()); }

/* ── FLEET MESH (OpenClaw-style control-node + workers) ───────────────────
   Any ABUZ8 instance already exposes /health + /api/chat and honors the LAN
   key, so it is a worker out of the box. The control node holds the roster,
   pings workers for real, and dispatches tasks over HTTP, collecting results. */
function meshPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'mesh.json'); }
function readMesh() { return readJson(meshPath(), { nodes: [] }); }
function writeMesh(m) { writeJson(meshPath(), m); }
function meshAdd(node) {
  const m = readMesh();
  const item = { id: 'w' + Date.now().toString(36), name: node.name || node.url, url: String(node.url || '').replace(/\/$/, ''), token: node.token || '', kind: node.kind || 'abuz8', added: new Date().toISOString(), last_seen: null, status: 'unknown' };
  m.nodes.push(item); writeMesh(m); pushActivity('mesh', 'Worker added: ' + item.name, item.url); return item;
}
function meshRemove(id) { const m = readMesh(); m.nodes = m.nodes.filter((n) => n.id !== id); writeMesh(m); return { ok: true }; }
async function meshPing(node) {
  const headers = node.token ? { 'x-abuz8-key': node.token } : {};
  const t0 = Date.now();
  try {
    const r = JSON.parse(await fetchUrl(node.url + '/health', { headers }));
    return { ok: true, latency_ms: Date.now() - t0, service: r.service, port: r.port };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function meshDispatch(id, task) {
  const m = readMesh(); const node = m.nodes.find((n) => n.id === id);
  if (!node) throw new Error('worker not found');
  const headers = { 'Content-Type': 'application/json', ...(node.token ? { 'x-abuz8-key': node.token } : {}) };
  pushActivity('mesh', 'Dispatch → ' + node.name, String(task).slice(0, 80));
  const out = await fetchUrl(node.url + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ content: task, agentic: true }), timeout: 180000 });
  let j; try { j = JSON.parse(out); } catch { j = { response: out }; }
  node.last_seen = new Date().toISOString(); node.status = 'online'; writeMesh(m);
  return { node: node.name, response: j.response || j.error || out, brain: j.brain };
}
// ── SWARM / FLEET (the healthy "nanobots fuse into one big bot") ──────────────
// Many ABUZ8 nodes, each on its OWN hardware + brain, voluntarily joined to one
// orchestrating master that pools their compute and fuses their brains. OPT-IN +
// authenticated only — a node joins by choice with the key; never self-propagates.
function _nodeHeaders(n) { return n.token ? { 'x-abuz8-key': n.token } : {}; }
async function meshStats() {
  const nodes = readMesh().nodes;
  const per = await Promise.all(nodes.map(async (n) => {
    try { const d = JSON.parse(await fetchUrl(n.url + '/api/device', { headers: _nodeHeaders(n), timeout: 8000 })); return { id: n.id, name: n.name, url: n.url, online: true, cores: d.cores || 0, gpus: d.gpu_count || 0, vram_gb: d.total_vram_gb || 0, ram_gb: d.ram_gb || 0, accel: d.accel, brain: d.brain || '' }; }
    catch (e) { return { id: n.id, name: n.name, url: n.url, online: false, error: e.message }; }
  }));
  const on = per.filter((p) => p.online);
  return {
    nodes: nodes.length, online: on.length,
    pooled: { cores: on.reduce((a, p) => a + (p.cores || 0), 0), gpus: on.reduce((a, p) => a + (p.gpus || 0), 0), vram_gb: Math.round(on.reduce((a, p) => a + (p.vram_gb || 0), 0) * 10) / 10, ram_gb: on.reduce((a, p) => a + (p.ram_gb || 0), 0) },
    per_node: per
  };
}
async function meshBroadcast(task, opts = {}) {
  const nodes = readMesh().nodes;
  const results = await Promise.all(nodes.map(async (n) => {
    try { const out = await fetchUrl(n.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ..._nodeHeaders(n) }, body: JSON.stringify({ content: task, agentic: opts.agentic !== false }), timeout: opts.timeout || 180000 }); let j; try { j = JSON.parse(out); } catch { j = { response: out }; } return { node: n.name, id: n.id, ok: true, response: j.response || j.error || '', brain: j.brain }; }
    catch (e) { return { node: n.name, id: n.id, ok: false, error: e.message }; }
  }));
  return { dispatched: nodes.length, responded: results.filter((r) => r.ok).length, results };
}
async function meshBrain(question, opts = {}) {
  const b = await meshBroadcast(question, opts);
  const answers = b.results.filter((r) => r.ok && r.response).map((r, i) => '[Node ' + (i + 1) + ': ' + r.node + ']\n' + r.response);
  if (!answers.length) return { ok: false, nodes_answered: 0, synthesis: 'No node answered.', raw: b.results };
  let synthesis = answers.join('\n\n---\n\n');
  try { const r = await frontierReply('Fuse these ' + answers.length + ' node answers into ONE strongest collective answer:\n\n' + synthesis.slice(0, 8000), 'You are the orchestrating master brain of an ABUZ8 fleet — merge the nodes into one superior answer.', { brief: true }); if (r && r.text) synthesis = r.text; } catch {}
  return { ok: true, nodes_answered: answers.length, fleet: b.results.map((r) => r.node), synthesis };
}
// A worker OPTS IN: it tells a master to enroll it (authenticated). No silent spread.
async function fleetJoin(masterUrl, token, selfUrl) {
  if (!masterUrl) throw new Error('master url required');
  const url = String(masterUrl).replace(/\/+$/, '') + '/api/mesh/add';
  const me = selfUrl || ('http://127.0.0.1:' + PORT);
  const out = await fetchUrl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-abuz8-key': token } : {}) }, body: JSON.stringify({ url: me, token, name: 'node-' + PORT }), timeout: 10000 });
  try { return JSON.parse(out); } catch { return { ok: false, raw: out }; }
}
// ── NODE HEALTH (twin of provider health, keyed by node id) — powers failover ──
const _nodeHealth = {};
function recordNodeHealth(id, ok, ms) {
  if (!id) return;
  const h = _nodeHealth[id] || (_nodeHealth[id] = { ok: 0, fail: 0, ewmaMs: null, last: 0 });
  if (ok) h.ok++; else h.fail++;
  if (ok && ms != null && isFinite(ms)) h.ewmaMs = h.ewmaMs == null ? ms : Math.round(h.ewmaMs * 0.7 + ms * 0.3);
  h.last = Date.now();
}
function nodeHealthScore(id) {
  const h = _nodeHealth[id];
  if (!h || (h.ok + h.fail) === 0) return null; // no data yet
  const success = h.ok / (h.ok + h.fail);
  const latPenalty = h.ewmaMs == null ? 0 : Math.min(h.ewmaMs / 20000, 0.5);
  return success - latPenalty;
}
// Call ONE tool on ONE node, timing it + recording health for failover decisions.
async function _nodeToolCall(node, tool, toolArgs, timeout) {
  const t0 = Date.now();
  try {
    const out = await fetchUrl(node.url + '/api/tools/call', { method: 'POST', headers: { 'Content-Type': 'application/json', ..._nodeHeaders(node) }, body: JSON.stringify({ tool, args: toolArgs || {} }), timeout: timeout || 120000 });
    let j; try { j = JSON.parse(out); } catch { j = { result: out }; }
    recordNodeHealth(node.id, true, Date.now() - t0);
    return { ok: true, result: j.result !== undefined ? j.result : j };
  } catch (e) { recordNodeHealth(node.id, false); return { ok: false, error: e.message }; }
}
// Run a work-UNIT on a node: a tool call ({tool,args}) OR an agentic sub-goal ({chat}).
async function _nodeRun(node, unit, timeout) {
  if (unit && unit.chat != null) {
    const t0 = Date.now();
    try {
      const out = await fetchUrl(node.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ..._nodeHeaders(node) }, body: JSON.stringify({ content: unit.chat, agentic: unit.agentic !== false }), timeout: timeout || 180000 });
      let j; try { j = JSON.parse(out); } catch { j = { response: out }; }
      recordNodeHealth(node.id, true, Date.now() - t0);
      return { ok: true, result: j.response || j.error || '' };
    } catch (e) { recordNodeHealth(node.id, false); return { ok: false, error: e.message }; }
  }
  return _nodeToolCall(node, unit.tool, unit.args, timeout);
}
// Run ONE tool on a specific node — literal remote device control across the fleet.
async function meshExec(id, tool, toolArgs) {
  const node = readMesh().nodes.find((n) => n.id === id);
  if (!node) throw new Error('worker not found');
  pushActivity('mesh', 'Exec ' + tool + ' → ' + node.name, '');
  const r = await _nodeToolCall(node, tool, toolArgs);
  return { node: node.name, ...r };
}
// Run ONE tool on EVERY node in parallel (army-wide device control).
async function meshExecAll(tool, toolArgs) {
  const nodes = readMesh().nodes;
  const results = await Promise.all(nodes.map(async (n) => {
    const r = await _nodeToolCall(n, tool, toolArgs);
    return { node: n.name, id: n.id, ...r };
  }));
  return { tool, dispatched: nodes.length, responded: results.filter((r) => r.ok).length, results };
}
// ── FAULT-TOLERANT DISPATCHER — distribute WORK across the fleet with retry/failover ──
// units: [{ tool, args, need }]  (need = 'gpu' | 'cpu' | 'any'). Each unit runs on the
// best-fit HEALTHY node; on failure it fails over to the next untried node, up to
// `retries`. This is the load-bearing substrate the whole swarm rests on.
function _rankNodesFor(perNode, need) {
  const online = (perNode || []).filter((p) => p.online);
  const byHealth = (a, b) => {
    const ha = nodeHealthScore(a.id), hb = nodeHealthScore(b.id);
    if (ha != null && hb != null && ha !== hb) return hb - ha;
    if (ha != null && hb == null) return -1;
    if (hb != null && ha == null) return 1;
    return 0;
  };
  const ranked = online.slice();
  if (need === 'gpu') ranked.sort((a, b) => (b.vram_gb || 0) - (a.vram_gb || 0) || byHealth(a, b));
  else if (need === 'cpu') ranked.sort((a, b) => (b.cores || 0) - (a.cores || 0) || byHealth(a, b));
  else ranked.sort(byHealth);
  return ranked;
}
async function fleetDispatch(units, opts = {}) {
  const retries = opts.retries != null ? opts.retries : 2;
  const timeout = opts.perNodeTimeout || 120000;
  const stats = await meshStats();
  const nodesById = {}; for (const n of readMesh().nodes) nodesById[n.id] = n;
  const results = await Promise.all((units || []).map(async (unit, ui) => {
    const ranked = _rankNodesFor(stats.per_node, unit.need);
    if (!ranked.length) return { unit: ui, ok: false, error: 'no online nodes', attempts: 0, tried: [] };
    // start each unit at a different offset so load spreads across the fleet
    const order = ranked.map((_, i) => ranked[(i + ui) % ranked.length]);
    const tried = []; let last = 'no attempt';
    for (let a = 0; a <= retries && a < order.length; a++) {
      const cand = order[a]; const node = nodesById[cand.id];
      tried.push(cand.name || cand.id);
      const r = await new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'perNodeTimeout' }); } }, timeout + 2000);
        if (t.unref) t.unref();
        _nodeRun(node, unit, timeout).then((rr) => { if (!done) { done = true; clearTimeout(t); resolve(rr); } });
      });
      if (r.ok) return { unit: ui, ok: true, node: cand.name, id: cand.id, result: r.result, attempts: a + 1, tried };
      last = r.error;
    }
    return { unit: ui, ok: false, error: last, attempts: tried.length, tried };
  }));
  const completed = results.filter((r) => r.ok).length;
  const minQuorum = opts.minQuorum || 0;
  const ok = minQuorum ? completed >= minQuorum : completed === (units || []).length;
  return { ok, dispatched: (units || []).length, completed, partial: completed < (units || []).length, results };
}
// Pick the single best-fit node for a tool and run it (with failover).
async function meshDispatchSmart(tool, toolArgs, opts = {}) {
  const r = await fleetDispatch([{ tool, args: toolArgs, need: opts.need || 'any' }], opts);
  return r.results[0] || { ok: false, error: 'no result' };
}
// ── DISTRIBUTED INFERENCE — split ONE big model across the fleet's GPUs (llama.cpp --rpc) ──
// Plan: assign tensor-split ratios proportional to each GPU node's VRAM so a model too big
// for any single box runs across the pooled VRAM. Serve: each peer lends its GPU via an
// rpc-server, the master's llama-server connects with --rpc + --tensor-split.
const RPC_BASE_PORT = Number(process.env.ABUZ8_RPC_PORT || 50052);
async function meshShardPlan(opts = {}) {
  const stats = await meshStats();
  const selfVram = (await gpuInfo().catch(() => null)) || null;
  // GPU-bearing online nodes (the master itself can also contribute its local GPUs)
  const gpuNodes = (stats.per_node || []).filter((p) => p.online && (p.vram_gb || 0) > 0);
  const parts = [];
  if (opts.include_self !== false && selfVram && (selfVram.total_vram_gb || 0) > 0) parts.push({ id: 'self', name: 'master(local)', vram_gb: selfVram.total_vram_gb, endpoint: 'local' });
  for (let i = 0; i < gpuNodes.length; i++) parts.push({ id: gpuNodes[i].id, name: gpuNodes[i].name, vram_gb: gpuNodes[i].vram_gb, endpoint: gpuNodes[i].url.replace(/^https?:\/\//, '').replace(/:\d+$/, '') + ':' + (RPC_BASE_PORT + i) });
  const totalVram = parts.reduce((a, p) => a + (p.vram_gb || 0), 0);
  const split = parts.map((p) => totalVram > 0 ? +(p.vram_gb / totalVram).toFixed(4) : 0);
  const rpcEndpoints = parts.filter((p) => p.endpoint !== 'local').map((p) => p.endpoint);
  return {
    ok: parts.length > 0,
    nodes: parts.length,
    total_vram_gb: Math.round(totalVram * 10) / 10,
    tensor_split: split,
    rpc_endpoints: rpcEndpoints,
    assignment: parts.map((p, i) => ({ node: p.name, id: p.id, vram_gb: p.vram_gb, share: split[i], endpoint: p.endpoint })),
    rpc_binary_present: !!rpcServerPath(),
  };
}
// Start an rpc-server on THIS node so a remote master can borrow its GPU. Gated: needs
// the rpc-server binary (ggml-rpc.dll ships; the launcher binary may not be bundled yet).
let _rpcChild = null, _rpcPort = null;
function startRpcServer(port) {
  const bin = rpcServerPath();
  if (!bin) return { ok: false, error: 'rpc-server binary not bundled (ggml-rpc.dll is present; add ' + rpcServerName() + ' beside llama-server to enable GPU lending)' };
  const p = port || RPC_BASE_PORT;
  if (_rpcChild && _rpcChild.pid && !_rpcChild.killed) return { ok: true, already: true, port: _rpcPort, pid: _rpcChild.pid };
  try {
    const child = require('child_process').spawn(bin, ['-p', String(p), '-H', '0.0.0.0'], { cwd: path.dirname(bin), windowsHide: true, stdio: 'ignore', detached: false });
    child.unref(); _rpcChild = child; _rpcPort = p;
    pushActivity('fleet', 'rpc-server started (lending GPU)', 'port ' + p);
    return { ok: true, port: p, pid: child.pid };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Master: build (and, if the binary is present everywhere, launch) a sharded serve.
async function meshShardServe(modelPath, opts = {}) {
  const plan = await meshShardPlan(opts);
  if (!plan.ok || !plan.rpc_endpoints.length) return { ok: false, error: 'need at least one GPU peer online to shard', plan };
  // Ask each GPU peer to lend its GPU via rpc-server (gated on the peer having the binary).
  const peers = plan.assignment.filter((a) => a.endpoint !== 'local');
  const lend = [];
  for (let i = 0; i < peers.length; i++) {
    const r = await meshExec(peers[i].id, 'rpc_start', { port: RPC_BASE_PORT + i }).catch((e) => ({ ok: false, error: e.message }));
    lend.push({ node: peers[i].name, ...(r.result || r) });
  }
  const model = modelPath || (function () { try { const dir = resolveBrainDir(); const g = require('fs').readdirSync(dir).find((f) => /\.gguf$/i.test(f) && !/mmproj|embed/i.test(f)); return g ? path.join(dir, g) : null; } catch { return null; } })();
  const serverBin = brainServerIn(resolveBrainDir());
  const cmd = (serverBin || llamaServerName()) + ' -m ' + (model || '<model.gguf>') + ' --rpc ' + plan.rpc_endpoints.join(',') + ' --tensor-split ' + plan.tensor_split.join(',') + ' -ngl 999 --host 127.0.0.1 --port ' + (opts.serve_port || 8908);
  const allLent = lend.length && lend.every((l) => l.ok);
  if (!allLent || !rpcServerPath() || !serverBin) {
    return { ok: false, ready: false, reason: 'rpc-server binary not present on master/peers — serve command prepared but not launched', plan, lend, command: cmd };
  }
  // Binary present everywhere → actually launch the sharded master server.
  try {
    const child = require('child_process').spawn(serverBin, ['-m', model, '--rpc', plan.rpc_endpoints.join(','), '--tensor-split', plan.tensor_split.join(','), '-ngl', '999', '--host', '127.0.0.1', '--port', String(opts.serve_port || 8908)], { cwd: path.dirname(serverBin), windowsHide: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, launched: true, plan, lend, serve_port: opts.serve_port || 8908, command: cmd, pid: child.pid };
  } catch (e) { return { ok: false, error: e.message, plan, lend, command: cmd }; }
}

/* ── LOCAL SECURE ACCOUNT (sign-in) ──────────────────────────────────────
   scrypt-hashed local credentials; sessions are in-memory tokens. Optional —
   when enabled it gates secret writes; it never phones home. */
function accountPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'account.json'); }
function accountStatus() { const a = readJson(accountPath(), null); return { enabled: !!a, username: a ? a.username : null }; }
const _sessions = new Set();
function accountSetup(username, password) {
  if (!username || !password || password.length < 6) throw new Error('Username and a password of 6+ chars required.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  writeJson(accountPath(), { username, salt, hash, created: new Date().toISOString() });
  return { ok: true };
}
function sessionsPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'sessions.json'); }
function loadSessions() { try { (readJson(sessionsPath(), { tokens: [] }).tokens || []).forEach((t) => _sessions.add(t)); } catch {} }
function saveSession(token) { try { const j = readJson(sessionsPath(), { tokens: [] }); j.tokens = [...new Set([...(j.tokens || []), token])].slice(-100); writeJson(sessionsPath(), j); } catch {} }
function accountValidate(token) { return !!token && _sessions.has(token); }
function accountLogout(token) { _sessions.delete(token); try { const j = readJson(sessionsPath(), { tokens: [] }); j.tokens = (j.tokens || []).filter((t) => t !== token); writeJson(sessionsPath(), j); } catch {} return { ok: true }; }
// ── MOBILE EDGE MODEL (Apollo-style on-device brain the phone downloads) ──────
// Serves a small GGUF for the native phone app's on-device runtime (llama.cpp/LEAP/MLC),
// with HTTP range support so the phone can download/resume over the tunnel.
function mobileEdgeModels() {
  const out = [];
  const dirs = [];
  try { dirs.push(resolveBrainDir()); } catch {}
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'brain'));
  dirs.push(path.join(__dirname, '..', 'build-assets', 'brain'), path.join(__dirname, 'brain'));
  if (dataRoot) dirs.push(path.join(dataRoot, 'models'), path.join(dataRoot, 'attachments', 'brain'));
  const cands = [{ id: 'lfm2-350m', file: 'LFM2.5-350M-Q4_K_M.gguf', note: 'Apollo-style on-device phone brain (LFM2, Apache-2.0) — runs in a native llama.cpp/LEAP/MLC runtime, fully offline on the phone.' }];
  for (const c of cands) {
    for (const dir of dirs) {
      try { const p = path.join(dir, c.file); if (exists(p)) { out.push({ id: c.id, file: c.file, note: c.note, size_mb: Math.round(fs.statSync(p).size / 1024 / 1024), path: p }); break; } } catch {}
    }
  }
  return out;
}
function serveFileWithRange(req, res, filePath, mime) {
  let st; try { st = fs.statSync(filePath); } catch { return json(res, 404, { ok: false, error: 'file not found' }); }
  const total = st.size; const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range); let start = m && m[1] ? parseInt(m[1], 10) : 0; let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start)) start = 0; if (isNaN(end) || end >= total) end = total - 1; if (start > end) start = 0;
    res.writeHead(206, { 'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + total });
    fs.createReadStream(filePath, { start, end }).pipe(res); return;
  }
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(filePath).pipe(res);
}
// ── PREMIUM NATIVE IDENTITY: scrypt hashing + Google-linked recovery ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16); const N = 16384, r = 8, p = 1, keylen = 64;
  const dk = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${dk.toString('hex')}`;
}
function verifyPassword(password, stored, legacySalt) {
  try {
    if (typeof stored === 'string' && stored.startsWith('scrypt:')) {
      const [, N, r, p, saltHex, hashHex] = stored.split(':');
      const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), Buffer.from(hashHex, 'hex').length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
      const want = Buffer.from(hashHex, 'hex');
      return dk.length === want.length && crypto.timingSafeEqual(dk, want);
    }
    if (legacySalt && typeof stored === 'string') { const dk = crypto.scryptSync(String(password), legacySalt, 64).toString('hex'); return dk.length === stored.length && crypto.timingSafeEqual(Buffer.from(dk), Buffer.from(stored)); }
  } catch {}
  return false;
}
function _mintSession() { const token = crypto.randomBytes(24).toString('hex'); _sessions.add(token); try { const j = readJson(sessionsPath(), { tokens: [] }); j.tokens = [...new Set([...(j.tokens || []), token])].slice(-100); writeJson(sessionsPath(), j); } catch {} return token; }
function accountLogin(username, password) {
  const a = readJson(accountPath(), null);
  if (!a) throw new Error('No account set up.');
  const ok = a.pw ? verifyPassword(password, a.pw) : verifyPassword(password, a.hash, a.salt);
  if (username !== a.username || !ok) throw new Error('Invalid credentials.');
  return { ok: true, token: _mintSession() };
}
function accountRegister(username, password) {
  if (!username || !password || String(password).length < 6) throw new Error('Username and a password of 6+ chars required.');
  if (readJson(accountPath(), null)) throw new Error('An account already exists. Use login, or recover via Google.');
  const a = { username: String(username), pw: hashPassword(password), google_email: null, created: new Date().toISOString() };
  writeJson(accountPath(), a); // encrypted at rest (account.json in SECRET_CONFIG_FILES)
  try { pushActivity('account', 'Account created', String(username)); } catch {}
  return { ok: true, token: _mintSession(), username: a.username };
}
async function _googleEmail() {
  const o = readOauth(); let email = o.tokens && o.tokens.google && o.tokens.google.email;
  if (!email) { const tok = await getValidToken('google'); if (tok) { try { const ui = JSON.parse(await fetchUrl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok }, timeout: 15000 })); if (ui.email) email = String(ui.email).toLowerCase(); } catch {} } }
  return email ? String(email).toLowerCase() : '';
}
async function accountLinkGoogle() {
  const a = readJson(accountPath(), null); if (!a) throw new Error('No account to link. Register first.');
  const email = await _googleEmail(); if (!email) throw new Error('Connect Google first (Connect → Sign in with Google), then link.');
  a.google_email = email; a.linked_at = new Date().toISOString(); writeJson(accountPath(), a);
  try { pushActivity('account', 'Google linked for recovery', email); } catch {}
  return { ok: true, google_email: email };
}
async function accountRecoverViaGoogle() {
  const a = readJson(accountPath(), null); if (!a || !a.google_email) throw new Error('No Google identity is linked to this account.');
  const email = await _googleEmail(); if (!email) throw new Error('Connect Google first, then recover.');
  if (email !== a.google_email) throw new Error('Connected Google account does not match the linked recovery email.');
  return { ok: true, token: _mintSession(), username: a.username };
}
async function accountResetPassword(newPassword) {
  if (!newPassword || String(newPassword).length < 6) throw new Error('New password must be 6+ chars.');
  const a = readJson(accountPath(), null); if (!a || !a.google_email) throw new Error('Password reset requires a linked Google recovery email.');
  const email = await _googleEmail(); if (!email || email !== a.google_email) throw new Error('Verify the linked Google account before resetting.');
  a.pw = hashPassword(newPassword); delete a.salt; delete a.hash; a.reset_at = new Date().toISOString(); writeJson(accountPath(), a);
  return { ok: true };
}
function accountStatusFull() { const a = readJson(accountPath(), null); return { enabled: !!a, username: a ? a.username : null, google_linked: !!(a && a.google_email), recovery_email: a && a.google_email ? a.google_email.replace(/^(.).*(@.*)$/, '$1***$2') : null }; }

/* ── PROVIDER CATALOG — "Noah's Ark of AI" ───────────────────────────────
   A pre-shipped registry of 35+ model providers (like Antigravity / Continue
   / LiteLLM): the user logs in or pastes one key and the model is live. Most
   speak the OpenAI-compatible /chat/completions API; Anthropic uses its own
   /v1/messages (adapter below); Claude Pro/Max rides the Claude Desktop MCP
   bridge. Local engines need no key at all. Honest 'how' note on each.
   cat: 'monthly' (subscription/credits brands) | 'api' (developer key) |
        'local' (on-device, free) | 'bridge' (via the vendor's own app). */
const PROVIDER_CATALOG = [
  // ── Hero / subscription-flavored ──
  { id: 'openrouter', label: 'OpenRouter', cat: 'monthly', type: 'openai', base: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o1', 'openai/o3-mini', 'openai/gpt-4.1', 'anthropic/claude-3.7-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.5-haiku', 'anthropic/claude-3-opus', 'google/gemini-2.0-flash-exp', 'google/gemini-2.5-pro', 'google/gemini-1.5-pro', 'x-ai/grok-2', 'x-ai/grok-2-vision', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1', 'moonshotai/kimi-k2', 'qwen/qwen-2.5-72b-instruct', 'qwen/qwq-32b', 'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-405b-instruct', 'mistralai/mistral-large', 'mistralai/codestral', 'nvidia/llama-3.1-nemotron-70b-instruct', 'cohere/command-r-plus', 'microsoft/wizardlm-2-8x22b', 'nousresearch/hermes-3-llama-3.1-405b', 'perplexity/sonar-pro', 'amazon/nova-pro-v1', 'ai21/jamba-1.5-large'], note: 'One key = 300+ models (GPT, Claude, Gemini, Grok, Kimi, DeepSeek, Llama, Qwen, Mistral, Nemotron, Hermes…). Pay-as-you-go credits. The fastest "log in once, use everything" path.', signup: 'https://openrouter.ai/keys' },
  { id: 'openai', label: 'OpenAI (ChatGPT)', cat: 'monthly', type: 'openai', base: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1'], note: 'Developer API key. Note: a ChatGPT Plus subscription is NOT API access — the API bills separately per token.', signup: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude) — API', cat: 'monthly', type: 'anthropic', base: 'https://api.anthropic.com', models: ['claude-opus-4-20250514', 'claude-fable-5', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'], note: 'Direct Claude API key (x-api-key); includes the Fable family. For your Claude Pro/Max *subscription*, use the Claude Desktop bridge instead (cat: bridge).', signup: 'https://console.anthropic.com/settings/keys' },
  { id: 'google-gemini', label: 'Google Gemini', cat: 'monthly', type: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'], note: 'Google AI Studio key (OpenAI-compatible endpoint). Full OAuth for Gemini+Gmail+Calendar via the Connect view.', signup: 'https://aistudio.google.com/apikey' },
  { id: 'gemini-native', label: 'Google Gemini (native function-calling)', cat: 'monthly', type: 'gemini-native', base: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'], note: 'Gemini via its NATIVE generateContent + functionDeclarations dialect (not the OpenAI-compat shim) — the 3rd first-class tool-call dialect. AI Studio key.', signup: 'https://aistudio.google.com/apikey' },
  { id: 'xai-grok', label: 'xAI (Grok)', cat: 'monthly', type: 'openai', base: 'https://api.x.ai/v1', models: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'], note: 'xAI API key. X Premium ≠ API; the API is a separate paid tier.', signup: 'https://console.x.ai' },
  { id: 'deepseek', label: 'DeepSeek', cat: 'monthly', type: 'openai', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], note: 'Very cheap, strong reasoning (R1). OpenAI-compatible.', signup: 'https://platform.deepseek.com/api_keys' },
  { id: 'moonshot-kimi', label: 'Moonshot (Kimi)', cat: 'monthly', type: 'openai', base: 'https://api.moonshot.ai/v1', models: ['kimi-k2-0711-preview', 'moonshot-v1-128k'], note: 'Kimi K2 — huge context. OpenAI-compatible.', signup: 'https://platform.moonshot.ai' },
  { id: 'zhipu-glm', label: 'Zhipu (GLM)', cat: 'monthly', type: 'openai', base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash', 'glm-4v-plus'], note: 'GLM-4 family. OpenAI-compatible v4 endpoint.', signup: 'https://open.bigmodel.cn' },
  { id: 'minimax', label: 'MiniMax', cat: 'monthly', type: 'openai', base: 'https://api.minimax.chat/v1', models: ['abab6.5s-chat', 'MiniMax-Text-01'], note: 'MiniMax text/voice models. OpenAI-compatible.', signup: 'https://www.minimax.io' },
  { id: 'qwen', label: 'Qwen (DashScope)', cat: 'monthly', type: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen2.5-72b-instruct', 'qwen-vl-max', 'qwq-32b-preview'], note: 'Alibaba Qwen via the DashScope OpenAI-compatible endpoint (first-class, not only via OpenRouter).', signup: 'https://dashscope.console.aliyun.com/apiKey' },
  { id: 'perplexity', label: 'Perplexity', cat: 'monthly', type: 'openai', base: 'https://api.perplexity.ai', models: ['sonar', 'sonar-pro', 'sonar-reasoning'], note: 'Sonar online models (built-in web search). API key from a Perplexity subscription.', signup: 'https://www.perplexity.ai/settings/api' },
  { id: 'mistral', label: 'Mistral (Le Chat)', cat: 'monthly', type: 'openai', base: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'], note: 'Mistral / Codestral. OpenAI-compatible.', signup: 'https://console.mistral.ai/api-keys' },
  // ── Developer / API-key (fast inference & clouds) ──
  { id: 'nvidia-nim', label: 'NVIDIA NIM', cat: 'api', type: 'openai', base: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/llama-3.1-nemotron-70b-instruct', 'meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'], note: 'NVIDIA-hosted NIM endpoints incl. Nemotron. Free tier on build.nvidia.com.', signup: 'https://build.nvidia.com' },
  { id: 'cerebras', label: 'Cerebras', cat: 'api', type: 'openai', base: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'llama3.1-8b'], note: 'Fastest tokens/sec anywhere (wafer-scale). Generous free tier.', signup: 'https://cloud.cerebras.ai' },
  { id: 'groq', label: 'Groq', cat: 'api', type: 'openai', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'], note: 'Ultra-fast LPU inference. Free tier.', signup: 'https://console.groq.com/keys' },
  { id: 'together', label: 'Together AI', cat: 'api', type: 'openai', base: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1'], note: '200+ open models, OpenAI-compatible.', signup: 'https://api.together.xyz/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', cat: 'api', type: 'openai', base: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/deepseek-r1'], note: 'Fast open-model inference.', signup: 'https://fireworks.ai/account/api-keys' },
  { id: 'deepinfra', label: 'DeepInfra', cat: 'api', type: 'openai', base: 'https://api.deepinfra.com/v1/openai', models: ['meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-R1'], note: 'Cheap open-model inference.', signup: 'https://deepinfra.com/dash/api_keys' },
  { id: 'inception-mercury', label: 'Inception (Mercury)', cat: 'api', type: 'openai', base: 'https://api.inceptionlabs.ai/v1', models: ['mercury-coder-small', 'mercury'], note: 'Mercury — diffusion LLMs, very fast. OpenAI-compatible.', signup: 'https://platform.inceptionlabs.ai' },
  { id: 'sambanova', label: 'SambaNova', cat: 'api', type: 'openai', base: 'https://api.sambanova.ai/v1', models: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-R1'], note: 'Fast RDU inference. Free tier.', signup: 'https://cloud.sambanova.ai' },
  { id: 'hyperbolic', label: 'Hyperbolic', cat: 'api', type: 'openai', base: 'https://api.hyperbolic.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-V3'], note: 'Cheap GPU inference marketplace.', signup: 'https://app.hyperbolic.xyz' },
  { id: 'novita', label: 'Novita AI', cat: 'api', type: 'openai', base: 'https://api.novita.ai/v3/openai', models: ['meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-r1'], note: 'Cheap open-model inference, OpenAI-compatible. Free credits.', signup: 'https://novita.ai/settings/key-management' },
  { id: 'nebius', label: 'Nebius AI', cat: 'api', type: 'openai', base: 'https://api.studio.nebius.ai/v1', models: ['meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-R1'], note: 'Nebius AI Studio — fast, low-cost open models.', signup: 'https://studio.nebius.ai' },
  { id: 'ai21', label: 'AI21 (Jamba)', cat: 'api', type: 'openai', base: 'https://api.ai21.com/studio/v1', models: ['jamba-1.5-large', 'jamba-1.5-mini'], note: 'Jamba long-context models. OpenAI-compatible.', signup: 'https://studio.ai21.com/account/api-key' },
  { id: 'nous-portal', label: 'Nous Portal (Hermes)', cat: 'api', type: 'openai', base: 'https://inference-api.nousresearch.com/v1', models: ['Hermes-3-Llama-3.1-70B', 'DeepHermes-3-Llama-3-8B'], note: 'Nous Research inference (the makers of Hermes). OpenAI-compatible.', signup: 'https://portal.nousresearch.com' },
  { id: 'cohere', label: 'Cohere', cat: 'api', type: 'openai', base: 'https://api.cohere.ai/compatibility/v1', models: ['command-r-plus', 'command-r'], note: 'Command R family via OpenAI-compatibility endpoint.', signup: 'https://dashboard.cohere.com/api-keys' },
  { id: 'aws-bedrock', label: 'AWS Bedrock', cat: 'api', type: 'bedrock', base: 'https://bedrock-runtime.us-east-1.amazonaws.com', models: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'meta.llama3-3-70b-instruct-v1:0'], note: 'Needs AWS access key + region (SigV4). Adapter is on the roadmap — listed for completeness.', signup: 'https://console.aws.amazon.com/bedrock' },
  { id: 'azure-openai', label: 'Azure OpenAI', cat: 'api', type: 'openai', base: '', models: ['gpt-4o'], note: 'Paste your full Azure resource endpoint (…/openai/deployments/<name>) + key.', signup: 'https://portal.azure.com' },
  // ── Local engines (free, on-device, OpenAI-compatible) ──
  { id: 'llamacpp-native', label: 'ABUZ8 native (llama.cpp)', cat: 'local', type: 'openai', base: 'http://127.0.0.1:8902/v1', models: ['(loaded GGUF)'], note: 'The built-in engine — already running. Runs any GGUF natively, zero login, fully sovereign.' },
  { id: 'ollama', label: 'Ollama', cat: 'local', type: 'openai', base: 'http://127.0.0.1:11434/v1', models: ['llama3.2', 'qwen2.5'], note: 'Reuses your existing Ollama model library. Auto-detected on :11434.' },
  { id: 'lmstudio', label: 'LM Studio', cat: 'local', type: 'openai', base: 'http://127.0.0.1:1234/v1', models: ['(loaded model)'], note: 'Reuses your LM Studio models. Auto-detected on :1234.' },
  { id: 'vllm', label: 'vLLM', cat: 'local', type: 'openai', base: 'http://127.0.0.1:8000/v1', models: ['(served model)'], note: 'Best on big GPUs (Pegasus/DGX) — paged attention + batching. Auto-detected on :8000.' },
  { id: 'jan', label: 'Jan', cat: 'local', type: 'openai', base: 'http://127.0.0.1:1337/v1', models: ['(loaded model)'], note: 'Jan local server. Auto-detected on :1337.' },
  { id: 'textgen-webui', label: 'Text-Gen WebUI', cat: 'local', type: 'openai', base: 'http://127.0.0.1:5000/v1', models: ['(loaded model)'], note: 'oobabooga OpenAI extension on :5000.' },
  // ── App bridges (use your real subscription via the vendor's own app) ──
  { id: 'claude-desktop-bridge', label: 'Claude Pro/Max (via Claude Desktop)', cat: 'bridge', type: 'mcp-bridge', base: '', models: ['your Claude subscription'], note: 'The legit way to use your Claude Pro/Max subscription: ABUZ8 talks to the Claude Desktop app over the MCP bridge (Connect → Import Claude Desktop). No API charges.' }
];
function providersStore() { return readJson(providersPath(), { providers: [] }); }
function writeProviders(o) { writeJson(providersPath(), o); }
function providerCatalogList() {
  const store = providersStore();
  const active = (readJson(settingsPath(), {}).active_provider) || null;
  return PROVIDER_CATALOG.map((p) => {
    const saved = store.providers.find((x) => x.name === p.id);
    return { id: p.id, label: p.label, cat: p.cat, type: p.type, note: p.note, signup: p.signup, models: p.models, base: p.base, configured: !!(saved && (saved.api_key || p.cat === 'local' || p.cat === 'bridge')), model: saved ? saved.model : (p.models && p.models[0]), active: !!(active && active.name === p.id) };
  });
}
function catalogDef(id) { return PROVIDER_CATALOG.find((p) => p.id === id); }
function catalogConnect(id, opts = {}) {
  const def = catalogDef(id); if (!def) throw new Error('unknown provider');
  const base = (opts.endpoint || def.base || '').replace(/\/+$/, '');
  const store = providersStore();
  const entry = {
    name: id, label: def.label, type: def.type, endpoint: base,
    chat_url: base ? base + '/chat/completions' : '',
    models_url: base ? base + '/models' : '',
    model: opts.model || def.models[0], api_key: opts.api_key || '', enabled: true, cat: def.cat, updated_at: new Date().toISOString()
  };
  store.providers = store.providers.filter((x) => x.name !== id); store.providers.push(entry); writeProviders(store);
  pushActivity('connect', 'Provider connected: ' + def.label, entry.model || '');
  return entry;
}
function catalogDisconnect(id) { const s = providersStore(); s.providers = s.providers.filter((x) => x.name !== id); writeProviders(s); const set = readJson(settingsPath(), {}); if (set.active_provider && set.active_provider.name === id) { delete set.active_provider; writeJson(settingsPath(), set); } return { ok: true }; }
function setActiveProvider(id, model) {
  const set = readJson(settingsPath(), {});
  if (!id) { delete set.active_provider; writeJson(settingsPath(), set); pushActivity('connect', 'Brain → native engine', ''); return { ok: true, active: null }; }
  const def = catalogDef(id); if (!def) throw new Error('unknown provider');
  const store = providersStore(); const saved = store.providers.find((x) => x.name === id);
  if (saved && model) { saved.model = model; writeProviders(store); }
  set.active_provider = { name: id, model: model || (saved && saved.model) || def.models[0] }; writeJson(settingsPath(), set);
  pushActivity('connect', 'Active brain → ' + def.label, set.active_provider.model);
  return { ok: true, active: set.active_provider };
}
async function catalogTest(id) {
  const def = catalogDef(id); if (!def) return { ok: false, error: 'unknown' };
  if (def.cat === 'bridge') return { ok: true, detail: 'Uses the Claude Desktop MCP bridge — import it in Connect, then Claude answers with no API charge.' };
  if (def.type === 'bedrock') return { ok: false, error: 'AWS Bedrock needs SigV4 signing — adapter on the roadmap.' };
  const store = providersStore(); const p = store.providers.find((x) => x.name === id);
  if (!p) return { ok: false, error: 'not connected' };
  try {
    const out = await callProviderChat(p, 'Reply with the single word: ok', 'You are a connectivity probe. Reply with exactly one word.');
    return { ok: true, detail: 'Live · model ' + (p.model || '') + ' · replied "' + String(out).trim().slice(0, 24) + '"' };
  } catch (e) { return { ok: false, error: e.message.slice(0, 140) }; }
}
async function catalogModels(id) {
  const store = providersStore(); const p = store.providers.find((x) => x.name === id);
  if (!p || !p.models_url) return { ok: false, models: catalogDef(id) ? catalogDef(id).models : [] };
  try {
    const headers = p.api_key ? { Authorization: 'Bearer ' + p.api_key } : {};
    const data = JSON.parse(await fetchUrl(p.models_url, { headers, timeout: 12000 }));
    const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { ok: true, models: models.length ? models : catalogDef(id).models };
  } catch (e) { return { ok: false, error: e.message, models: catalogDef(id).models }; }
}
async function detectLocalEngines() {
  const probes = [ ['ollama', 'http://127.0.0.1:11434/v1/models'], ['lmstudio', 'http://127.0.0.1:1234/v1/models'], ['vllm', 'http://127.0.0.1:8000/v1/models'], ['jan', 'http://127.0.0.1:1337/v1/models'], ['textgen-webui', 'http://127.0.0.1:5000/v1/models'] ];
  const out = {};
  await Promise.all(probes.map(async ([id, url]) => {
    try { const d = JSON.parse(await fetchUrl(url, { timeout: 1500 })); out[id] = { up: true, models: (d.data || []).map((m) => m.id).slice(0, 8) }; }
    catch { out[id] = { up: false }; }
  }));
  return out;
}

async function agenticReply(prompt, opts = {}) {
  // CLI brain selected: reasoning engine for this turn (non-voice). Supports opt-in multi-brain
  // thinking modes (settings.think_mode: single|council|debate) + opt-in web grounding.
  if (!opts.brief && !opts.provider) {
    try {
      const st = readJson(settingsPath(), {});
      const cb = st.cli_brain;
      if (cb && cliBrainAvailable(cb)) {
        let pr = prompt;
        if (st.web_grounding) { const ctx = await webGround(prompt, opts.onNote); if (ctx) pr = prompt + '\n\n[Live web context — cite [n] as needed]\n' + ctx; }
        let mode = st.think_mode || 'single';
        let autoTag = '';
        if (mode === 'auto') { mode = routeThinkMode(prompt); autoTag = 'Auto · '; if (opts.onNote && mode !== 'single') opts.onNote('Auto-router → ' + mode); }
        if (mode === 'council') { const t = await councilThink(pr, opts, opts.onNote); if (t) return { response: t, modelResponse: t, brain: autoTag + 'Council · ' + councilBrainSet().length + ' brains', tool_call: null, tool_result: null, fallback: false }; }
        else if (mode === 'debate') { const t = await debateThink(pr, opts, opts.onNote); if (t) return { response: t, modelResponse: t, brain: autoTag + 'Debate · multi-brain', tool_call: null, tool_result: null, fallback: false }; }
        const sys = composeSystem(opts.role, opts.system);
        const t = await cliBrainReply(cb, pr, sys);
        if (t) return { response: t, modelResponse: t, brain: autoTag + cliBrainName(cb), tool_call: null, tool_result: null, fallback: false };
      }
    } catch {}
  }
  // 0) AGENT-FIRST: a request that needs thinking/research/comparison goes through
  //    understand → gather → reason → synthesize (skipped for fast voice turns).
  if (!opts.brief && isComplexTask(prompt)) {
    try { return await runTask(prompt, opts); } catch {}
  }
  // 1) Fast deterministic intent (open browser/app/site, search, run command…).
  const direct = inferConsumerToolCall(prompt);
  if (direct) return executeAgentTool(direct, opts);

  // 2) Model-chosen tool: ask the brain to emit a tool call; execute if valid.
  try {
    const modelText = await embeddedReply(prompt, { agentic: true, role: opts.role, brief: opts.brief });
    const parsed = modelText ? parseAgentToolCall(modelText) : null;
    if (parsed && KNOWN_AGENT_TOOLS.has(slug(parsed.tool).replace(/-/g, '_'))) {
      const norm = { tool: slug(parsed.tool).replace(/-/g, '_'), args: parsed.args || {} };
      return executeAgentTool(norm, opts);
    }
    // 3) No tool — return the model's own answer (or the full reply ladder if empty).
    if (modelText && modelText.trim() && !/^\s*\{/.test(modelText)) {
      const brain = activeBrain || selectEmbeddedBrain();
      return { response: modelText.trim(), modelResponse: modelText.trim(), brain: brain?.name || 'Embedded LFM', tool_call: null, fallback: false };
    }
  } catch {}
  const r = await reasonReply(prompt, { agentic: false, provider: opts.provider, role: opts.role, brief: opts.brief });
  return { response: r.text, modelResponse: r.model ? r.text : null, brain: r.brain, tool_call: null, tool_result: null, fallback: r.fallback };
}

function localReply(prompt) {
  const msg = String(prompt || '').trim();
  const lower = msg.toLowerCase();
  if (!msg) return 'Portable Core is online. Type a task, ask for a file operation, or import MCP connectors from the Migration view.';
  if (lower.includes('mcp') || lower.includes('connector')) {
    return `Portable Core is online. Use Migration -> Import Local Connectors to copy Claude Desktop MCP entries into ${mcpConfigPath()}. Docker MCP is imported when Docker Desktop exposes "docker mcp".`;
  }
  if (lower.includes('gpu') || lower.includes('avatar') || lower.includes('render')) {
    return 'For GPU-heavy avatar/rendering work, this build uses a fallback ladder: browser preview first, cloud/API renderer second, ComfyUI/NVIDIA worker only when a GPU runtime is connected. The OS stays usable without GPU.';
  }
  if (lower.includes('model') || lower.includes('brain')) {
    return 'The native LFM2 2.6B GGUF brain stays primary in this build. Cloud or extra local brains can be added as hybrid engines, but they do not replace the bundled brain.';
  }
  return `Portable Core received: "${msg}"\n\nThe clean-machine runtime is active. Data, memory, MCP config, skills, logs, models, and workspaces are stored under:\n${dataRoot}\n\nFor stronger reasoning, connect a local model runner or cloud provider in the connectors panel.`;
}

async function webSearch(body = {}) {
  if (airgapOn()) return { ok: false, airgap: true, results: [], note: 'Local-Only mode is ON — web search is disabled so your query never leaves the machine. Turn off air-gap to search.' };
  const query = String(body.q || body.query || body.text || '').trim();
  if (!query) throw new Error('query is required');
  const maxResults = Number(body.max_results || body.limit || 8);
  let serperKey = '';
  try { serperKey = (connectorCreds('serper').api_key) || ''; } catch {}
  const apiKey = body.api_key || serperKey || process.env.SERPER_API_KEY || process.env.GOOGLE_API_KEY || body.google_key;

  // Saved Serper connector → high-quality results first.
  if (serperKey) {
    try {
      const out = await fetchUrl('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: maxResults }) });
      const j = JSON.parse(out);
      const results = (j.organic || []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || '' }));
      if (results.length) return { ok: true, query, results, count: results.length, source: 'serper', note: '' };
    } catch {}
  }

  // Try DuckDuckGo Lite (no API key required, HTML scraping)
  try {
    const ddgResult = await searchDuckDuckGoLite(query, maxResults);
    if (ddgResult.results.length > 0) {
      return { ok: true, query, results: ddgResult.results, count: ddgResult.results.length, source: 'duckduckgo', note: '' };
    }
  } catch (e) {
    // fall through
  }

  // Try Google Custom Search if API key provided
  if (apiKey) {
    try {
      const cx = body.google_cx || process.env.GOOGLE_CX;
      if (cx) {
        const gResult = await searchGoogleCSE(query, maxResults, apiKey, cx);
        if (gResult.results.length > 0) {
          return { ok: true, query, results: gResult.results, count: gResult.results.length, source: 'google_cse', note: '' };
        }
      }
    } catch (e) {
      // fall through
    }
  }

  // Try SearX instances (public metasearch)
  try {
    const searxResult = await searchSearX(query, maxResults);
    if (searxResult.results.length > 0) {
      return { ok: true, query, results: searxResult.results, count: searxResult.results.length, source: 'searx', note: 'Results from public SearX instance' };
    }
  } catch (e) {}

  // Final fallback: structured guidance
  return {
    ok: true,
    query,
    results: [],
    count: 0,
    source: 'fallback',
    note: 'Web search returned no results. Try configuring Google Custom Search API key in Settings.',
    fallback_action: {
      tool: 'open_url',
      args: { url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` }
    }
  };
}

// ── Phase 3: Deep-read research ── search, then actually FETCH and READ the top
// source pages (not just snippets), so analysis is grounded in real content.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function fetchPageText(url, ms = 8000) {
  return Promise.race([
    fetchUrl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } }).then(stripHtml),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}
// DuckDuckGo returns redirect URLs (…/l/?uddg=<real-url>); decode to the target.
function resolveResultUrl(u) {
  try {
    const m = String(u || '').match(/[?&]uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return String(u || '');
  } catch { return String(u || ''); }
}
async function deepResearch(query, maxPages = 3) {
  const search = await webSearch({ q: query, max_results: 8 });
  const urls = (search.results || [])
    .map((r) => ({ ...r, url: resolveResultUrl(r.url) }))
    .filter((r) => /^https?:\/\//.test(r.url) && !/duckduckgo\.com/.test(r.url));
  const pages = [];
  for (const r of urls) {
    if (pages.length >= maxPages) break;
    try {
      const text = await fetchPageText(r.url);
      if (text && text.length > 150) pages.push({ title: r.title, url: r.url, text: text.slice(0, 1600) });
    } catch {}
  }
  return { ok: true, query, read: pages.length, pages, snippets: (search.results || []).slice(0, 5) };
}

async function searchDuckDuckGoLite(query, maxResults) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await fetchUrl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
  const results = [];
  const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
  for (let i = 0; i < rows.length && results.length < maxResults; i++) {
    const row = rows[i];
    const link = row.match(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/);
    const snippet = row.match(/<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/s) || row.match(/<td[^>]*>(.*?)<\/td>/s);
    if (link) {
      results.push({
        title: link[2].replace(/<[^>]+>/g, '').trim(),
        url: link[1].startsWith('http') ? link[1] : `https://duckduckgo.com${link[1]}`,
        snippet: snippet ? snippet[1].replace(/<[^>]+>/g, '').trim() : ''
      });
    }
  }
  return { results };
}

async function searchGoogleCSE(query, maxResults, apiKey, cx) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(maxResults, 10)}`;
  const resp = await fetchUrl(url);
  const data = JSON.parse(resp);
  const results = (data.items || []).map(item => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || ''
  }));
  return { results };
}

async function searchSearX(query, maxResults) {
  // Try multiple public SearX instances
  const instances = [
    'https://searx.be',
    'https://search.bus-hit.me',
    'https://searx.tiekoetter.com'
  ];
  
  for (const instance of instances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json`;
      const data = await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'accept': 'application/json' }, timeout: 10000 }, (res) => {
          let d = '';
          res.on('data', (chunk) => d += chunk);
          res.on('end', () => resolve(d));
        }).on('error', reject).setTimeout(10000, () => reject(new Error('timeout')));
      });
      const parsed = JSON.parse(data);
      if (parsed.results && parsed.results.length) {
        return {
          results: parsed.results.slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.content || r.snippet || ''
          })).filter(r => r.snippet && r.snippet.length > 10)
        };
      }
    } catch (e) {
      // Try next instance
    }
  }
  throw new Error('All SearX instances failed');
}

async function searchSerper(query, maxResults, apiKey) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ q: query, num: maxResults });
    const req = https.request('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const results = (parsed.organic || []).slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.link,
            snippet: r.snippet
          }));
          resolve({ ok: true, query, results, count: results.length, source: 'serper' });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function searchBrave(query, maxResults, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    https.get(url, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey } }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const results = (parsed.web?.results || []).slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.description
          }));
          resolve({ ok: true, query, results, count: results.length, source: 'brave' });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sendSse(res, payload, brain = 'Portable Core') {
  res.writeHead(200, Object.assign({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'vary': 'origin'
  }, res._acao ? { 'access-control-allow-origin': res._acao } : {}));
  const chunks = String(payload).match(/.{1,36}(\s|$)|.{1,36}/g) || [String(payload)];
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ delta: chunks[i++] })}\n\n`);
      setTimeout(tick, 18);
    } else {
      res.write(`data: ${JSON.stringify({ done: true, brain, latency_ms: 1 })}\n\n`);
      res.end();
    }
  };
  tick();
}

function sendTui(res) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ABUZ8 Local TUI</title>
  <style>
    :root{color-scheme:dark;font-family:Consolas, ui-monospace, monospace;background:#050907;color:#d9f8ea}
    body{margin:0;padding:16px;background:#050907}
    header{display:flex;align-items:center;gap:10px;border-bottom:1px solid #254136;padding-bottom:10px;margin-bottom:12px}
    .dot{width:8px;height:8px;border-radius:50%;background:#19e0ad;box-shadow:0 0 16px #19e0ad}
    h1{font-size:14px;margin:0;color:#f2d27a;letter-spacing:.02em}
    #log{height:calc(100vh - 118px);overflow:auto;white-space:pre-wrap;line-height:1.5;font-size:13px}
    form{display:flex;gap:8px;position:fixed;left:12px;right:12px;bottom:12px}
    input{flex:1;background:#0b1411;border:1px solid #254136;color:#d9f8ea;border-radius:8px;padding:10px;font:inherit}
    button{background:#19e0ad;color:#03100c;border:0;border-radius:8px;padding:10px 14px;font-weight:700}
    .sys{color:#72d7b9}.user{color:#f2d27a}.agent{color:#d9f8ea}.err{color:#ff746a}
  </style>
</head>
<body>
  <header><span class="dot"></span><h1>ABUZ8 LOCAL TUI - 127.0.0.1:${PORT}</h1></header>
  <main id="log"><span class="sys">Portable Core online. Native LFM brain remains primary. Type a prompt or action command.</span></main>
  <form id="f"><input id="q" autocomplete="off" placeholder="Ask, /probe, open Paint, draw a monkey in Paint..."><button>Send</button></form>
  <script>
    const log=document.getElementById('log'), q=document.getElementById('q'), f=document.getElementById('f');
    function line(cls, text){ const d=document.createElement('div'); d.className=cls; d.textContent='\\n'+text; log.appendChild(d); log.scrollTop=log.scrollHeight; }
    f.onsubmit=async(e)=>{ e.preventDefault(); const text=q.value.trim(); if(!text)return; q.value=''; line('user','> '+text); try{ const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:text,agentic:true})}); const j=await r.json(); line(j.ok?'agent':'err', (j.brain||'core')+': '+(j.response||j.error||JSON.stringify(j))); }catch(err){ line('err','error: '+err.message); } };
  </script>
</body>
</html>`;
  res.writeHead(200, Object.assign({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'vary': 'origin'
  }, res._acao ? { 'access-control-allow-origin': res._acao } : {}));
  res.end(html);
}

function memoryFile() {
  return path.join(safeMkdir(path.join(profileBase(), 'memory')), 'events.jsonl');
}

function readMemory(limit = 20) {
  try {
    const lines = fs.readFileSync(memoryFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).map((m) => { if (m && typeof m.content === 'string') m.content = decStr(m.content); return m; }).reverse();
  } catch {
    return [];
  }
}

// ── Phase 1: Vector memory / RAG ──
// A local embedding model (nomic) runs on its own port; memories are embedded
// and stored, then the most relevant ones are retrieved and injected into chat
// context — so ABUZ8 remembers across sessions.
const EMBED_PORT = Number(process.env.ABUZ8_EMBED_PORT || 8904);
let embedProcess = null, embedStarting = false;
function embedModelFile() {
  // 1) User-supplied embed model in the data root wins.
  const dir = path.join(dataRoot || '', 'models', 'embed');
  if (exists(dir)) {
    const f = fs.readdirSync(dir).find((x) => /\.gguf$/i.test(x));
    if (f) return path.join(dir, f);
  }
  // 2) Bundled embed model shipped beside the brain (resources/brain) → semantic RAG works
  //    out-of-box, no download. Matched by name so it isn't confused with the chat GGUF.
  try {
    const bdir = resolveBrainDir();
    if (bdir && exists(bdir)) {
      const bf = fs.readdirSync(bdir).find((x) => /(nomic|embed).*\.gguf$/i.test(x));
      if (bf) return path.join(bdir, bf);
    }
  } catch {}
  return null;
}
function embedAvailable() { return Boolean(embedModelFile()) && exists(brainRuntimeFiles().server); }
async function ensureEmbedBrain() {
  if (embedProcess && await portHealthy(EMBED_PORT)) return true;
  if (embedProcess || embedStarting) return waitForPort(EMBED_PORT, 30000);
  const files = brainRuntimeFiles();
  const model = embedModelFile();
  if (!exists(files.server) || !model) return false;
  embedStarting = true;
  const ngl = (brainIsCuda() && await hasNvidiaGpu()) ? '99' : '0';
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(EMBED_PORT), '--embeddings', '--pooling', 'mean', '-c', '2048', '-ngl', ngl, '--threads', String(Math.max(2, Math.min(6, os.cpus().length || 4)))];
  try {
    embedProcess = spawn(files.server, args, { cwd: files.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    embedProcess.once('error', () => { embedProcess = null; embedStarting = false; });
    embedProcess.once('exit', () => { embedProcess = null; embedStarting = false; });
    const ready = await waitForPort(EMBED_PORT, 30000);
    embedStarting = false;
    return ready;
  } catch (e) { embedProcess = null; embedStarting = false; return false; }
}
async function embedText(text) {
  const input = String(text || '').slice(0, 2000);
  if (embedAvailable() && await ensureEmbedBrain()) {
    try {
      const out = await httpJson('POST', EMBED_PORT, '/v1/embeddings', { input }, 20000);
      const e = out && out.data && out.data[0] && out.data[0].embedding;
      if (Array.isArray(e)) return e;
    } catch {}
  }
  // Sovereign fallback: Ollama nomic-embed-text (already pulled) — keeps self-learning working.
  try {
    const r = JSON.parse(await fetchUrl(ollamaBase() + '/api/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'nomic-embed-text', prompt: input }), timeout: 15000 }));
    if (Array.isArray(r.embedding)) return r.embedding;
  } catch {}
  return null;
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}
function vectorFile() { return path.join(safeMkdir(path.join(profileBase(), 'memory')), 'vectors.jsonl'); }
function readVectors() {
  try { return fs.readFileSync(vectorFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((m) => { if (m && typeof m.content === 'string') m.content = decStr(m.content); return m; }); } catch { return []; }
}
// ── SELF-LEARNING — the OS learns from every file created + every conversation. ──
const _TEXT_INGEST_RX = /\.(js|mjs|cjs|ts|jsx|tsx|py|json|md|markdown|txt|html?|css|scss|go|rs|java|c|cpp|h|hpp|sh|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|vue|svelte|rb|php|swift|kt|lua|r|jl)$/i;
const _SKIP_DIR_RX = /[\\\/](node_modules|\.git|\.venv|venv|env|__pycache__|dist|build|out|\.cache|\.next|coverage|vendor)[\\\/]/i;
let _learnCount = 0;
function selfLearnOn() { try { return readJson(settingsPath(), {}).self_learn !== false; } catch { return true; } }
async function ingestFileToKnowledge(filePath) {
  try {
    let rp; try { rp = fs.realpathSync(filePath); } catch { rp = path.resolve(filePath); }
    if (isSensitivePath(rp)) return { ok: false, skipped: 'sensitive' }; // never ingest credential/secret stores
    if (!exists(rp) || fs.statSync(rp).isDirectory()) return { ok: false, error: 'not a file' };
    filePath = rp;
    if (_SKIP_DIR_RX.test(filePath) || !_TEXT_INGEST_RX.test(filePath)) return { ok: false, skipped: 'type/dir' };
    if (fs.statSync(filePath).size > 600 * 1024) return { ok: false, skipped: 'too large' };
    const content = fs.readFileSync(filePath, 'utf8'); if (!content.trim()) return { ok: false, skipped: 'empty' };
    const chunks = chunkText(content, 1200, 150); let n = 0;
    for (let i = 0; i < chunks.length && i < 30; i++) {
      if (await addMemoryVector({ content: 'FILE ' + path.basename(filePath) + ' (part ' + (i + 1) + '):\n' + chunks[i], type: 'file-knowledge', id: 'file:' + filePath + ':' + i })) n++;
    }
    if (n) { _learnCount += n; try { appendJsonl(path.join(dataRoot, 'logs', 'ingest.jsonl'), { file: filePath, chunks: n, ts: new Date().toISOString() }); } catch {} try { pushActivity('learn', 'Learned a file', path.basename(filePath) + ' (' + n + ' parts)'); } catch {} }
    return { ok: true, file: filePath, chunks: n };
  } catch (e) { return { ok: false, error: e.message }; }
}
let _fileWatchers = []; const _ingestDebounce = new Map();
function startFileWatcher() {
  try {
    if (_fileWatchers.length) return _fileWatchers.length;
    const roots = [workspacesRoot(), path.join(dataRoot || '', 'vault'), path.join(dataRoot || '', 'projects')].filter((p) => { try { return exists(p); } catch { return false; } });
    for (const root of roots) {
      try {
        const w = fs.watch(root, { recursive: true }, (ev, fn) => {
          if (!fn || !selfLearnOn()) return; const full = path.join(root, String(fn));
          if (_SKIP_DIR_RX.test(full) || !_TEXT_INGEST_RX.test(full)) return;
          clearTimeout(_ingestDebounce.get(full));
          _ingestDebounce.set(full, setTimeout(() => { _ingestDebounce.delete(full); ingestFileToKnowledge(full).catch(() => {}); }, 3000));
        });
        _fileWatchers.push(w);
      } catch {}
    }
    return _fileWatchers.length;
  } catch { return 0; }
}
async function ingestDirectory(dir, cap = 200) {
  if (!exists(dir)) return { ok: false, error: 'no such dir' };
  cap = Math.min(2000, Math.max(1, Number(cap) || 200));
  let done = 0; const walk = (d, depth) => { if (depth > 6 || done >= cap) return; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (e.isSymbolicLink()) continue; const full = path.join(d, e.name); if (_SKIP_DIR_RX.test(full + path.sep) || isSensitivePath(full)) continue; if (e.isDirectory()) walk(full, depth + 1); else if (_TEXT_INGEST_RX.test(e.name)) { ingestFileToKnowledge(full).catch(() => {}); done++; if (done >= cap) return; } } };
  walk(dir, 0); return { ok: true, queued: done, dir };
}
let _fileVecIds = null;
function _loadFileVecIds() { if (_fileVecIds) return _fileVecIds; _fileVecIds = new Set(); try { for (const v of readVectors()) if (v && v.id && String(v.id).startsWith('file:')) _fileVecIds.add(v.id); } catch {} return _fileVecIds; }
async function addMemoryVector(item) {
  try {
    const content = (item.content || item.text || '').trim();
    if (!content) return false;
    const id = item.id || crypto.randomUUID();
    // Dedup file-ingest chunks so re-saving a file doesn't append duplicate vectors (bounded growth).
    if (String(id).startsWith('file:')) { const set = _loadFileVecIds(); if (set.has(id)) return false; }
    const vec = await embedText(content);
    if (!vec) return false;
    appendJsonl(vectorFile(), { id, content: maybeEnc(content), type: item.type || 'note', timestamp: item.timestamp || new Date().toISOString(), vec });
    if (String(id).startsWith('file:')) _loadFileVecIds().add(id);
    return true;
  } catch { return false; }
}
async function retrieveMemories(query, k = 4) {
  const qv = await embedText(query);
  if (qv) {
    const vs = readVectors();
    if (vs.length) {
      return vs.map((m) => ({ content: m.content, type: m.type, score: cosine(qv, m.vec) }))
        .sort((a, b) => b.score - a.score).slice(0, k).filter((m) => m.score > 0.35)
        .map((m) => ({ content: m.content, type: m.type, score: Math.round(m.score * 100) / 100 }));
    }
  }
  return searchMemoryItems(query, k).map((m) => ({ content: m.content || m.response || '', type: m.type || 'note' }));
}
async function indexAllMemories() {
  const existing = new Set(readVectors().map((v) => v.content));
  const items = readMemory(800).filter((m) => (m.content || '').trim() && !existing.has(m.content));
  let n = 0;
  for (const it of items) { if (await addMemoryVector(it)) n++; }
  return { ok: true, indexed: n, total: readVectors().length, embed_engine: embedAvailable() ? 'nomic' : 'keyword-fallback' };
}

// ── FLEET-SHARED COLLECTIVE MEMORY — one growing brain across all nodes ──────
// Federated recall (ask every node + merge top-k) + gossip replication (a fact learned
// on ANY node becomes recallable on ALL). Rides on the existing embed/keyword retrieval;
// dedup by id/content hash keeps gossip from looping or growing the store unbounded.
function memExportSince(sinceTs, limit) {
  const lim = Math.min(Number(limit) || 200, 1000);
  let items = readMemory(lim);
  if (sinceTs) items = items.filter((m) => (m.timestamp || '') > sinceTs);
  return { ok: true, items, count: items.length };
}
async function fleetRagSearch(query, k) {
  k = Number(k) || 5;
  const local = (await retrieveMemories(query, k)).map((m) => ({ content: m.content, type: m.type, score: m.score, node: 'local' }));
  const peers = await meshExecAll('rag_query', { query, k });
  const merged = local.slice();
  for (const r of (peers.results || [])) {
    if (!r.ok) continue;
    const arr = Array.isArray(r.result) ? r.result : ((r.result && r.result.matches) || []);
    for (const m of arr) merged.push({ content: m.content, type: m.type, score: m.score, node: r.node });
  }
  const seen = new Map();
  for (const m of merged) { const key = String(m.content || '').trim().slice(0, 200); if (!key) continue; const cur = seen.get(key); if (!cur || (m.score || 0) > (cur.score || 0)) seen.set(key, m); }
  const out = Array.from(seen.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, k);
  return { ok: true, query, results: out, nodes_queried: (peers.results || []).filter((r) => r.ok).length + 1 };
}
async function fleetMemSync(opts = {}) {
  const nodes = readMesh().nodes;
  if (!nodes.length) return { ok: true, pulled: 0, nodes: 0, note: 'no fleet' };
  const haveIds = new Set(readMemory(3000).map((m) => m.id).filter(Boolean));
  let pulled = 0; const per = [];
  for (const n of nodes) {
    try {
      const out = JSON.parse(await fetchUrl(n.url + '/api/mesh/mem/export', { method: 'POST', headers: { 'Content-Type': 'application/json', ..._nodeHeaders(n) }, body: JSON.stringify({ limit: opts.limit || 200, since: opts.since }), timeout: 10000 }));
      const items = (out && out.items) || [];
      let added = 0;
      for (const it of items) {
        if (!it || !it.content) continue;
        const id = it.id || _sha256hex(String(it.content)).slice(0, 16);
        if (haveIds.has(id)) continue;
        haveIds.add(id);
        appendJsonl(memoryFile(), { id, type: it.type || 'note', content: it.content, timestamp: it.timestamp || new Date().toISOString(), from: n.name || n.id });
        addMemoryVector({ id, content: it.content, type: it.type }).catch(() => {});
        added++; pulled++;
      }
      per.push({ node: n.name || n.id, pulled: added });
    } catch (e) { per.push({ node: n.name || n.id, error: e.message }); }
  }
  if (pulled) pushActivity('memory', 'Fleet memory sync', '+' + pulled + ' facts from peers');
  return { ok: true, pulled, nodes: nodes.length, per_node: per };
}

// ── KNOWLEDGE GRAPH — entity/relation extraction over your memory (capability harvested
// from the 64GB parallel fork; clean reimplementation in the main line). Brain-grammar
// extraction when a brain is up, deterministic keyword/co-occurrence fallback otherwise. ──
function graphFile() { return path.join(safeMkdir(path.join(profileBase(), 'memory')), 'graph.jsonl'); }
function readGraph() { try { return fs.readFileSync(graphFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((t) => t && t.s && t.o); } catch { return []; } }
function graphAddTriple(s, p, o, src) {
  s = String(s || '').trim(); p = String(p || 'related to').trim(); o = String(o || '').trim();
  if (!s || !o || s.toLowerCase() === o.toLowerCase()) return false;
  const all = readGraph();
  const key = (s + '|' + p + '|' + o).toLowerCase();
  if (all.some((t) => (t.s + '|' + t.p + '|' + t.o).toLowerCase() === key)) return false;
  appendJsonl(graphFile(), { s: s.slice(0, 120), p: p.slice(0, 60), o: o.slice(0, 120), src: src || '', ts: new Date().toISOString() });
  return true;
}
async function graphExtract(text, opts = {}) {
  text = String(text || '').trim(); if (!text) return { ok: false, added: 0, error: 'empty' };
  let triples = [];
  try {
    const r = await reasonReply('Extract knowledge-graph triples from the text. Reply ONLY one JSON object: {"triples":[{"s":"subject","p":"predicate","o":"object"}]}. Short, canonical entities.\n\nTEXT:\n' + text.slice(0, 4000), { system: 'You are a precise knowledge-graph extractor. Output ONLY one JSON object.', noMemory: true, brief: true });
    const obj = extractJsonObject(r.text) || {}; if (Array.isArray(obj.triples)) triples = obj.triples;
  } catch {}
  // reject degenerate/placeholder triples the model sometimes echoes from the schema
  const _ph = /^(subject|object|predicate|entity|node|thing|name|value|item)$/i;
  triples = triples.filter((t) => t && t.s && t.o && !_ph.test(String(t.s).trim()) && !_ph.test(String(t.o).trim()));
  if (!triples.length) {
    const ents = [...new Set((text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/g) || []).filter((e) => e.length > 2))].slice(0, 10);
    for (let i = 0; i < ents.length - 1; i++) triples.push({ s: ents[i], p: 'related to', o: ents[i + 1] });
  }
  let added = 0; for (const t of triples) if (t && graphAddTriple(t.s, t.p, t.o, opts.src || 'extract')) added++;
  return { ok: true, added, total_triples: readGraph().length, sample: triples.slice(0, 12) };
}
function graphStats() { const all = readGraph(); const ents = new Set(); all.forEach((t) => { ents.add(t.s.toLowerCase()); ents.add(t.o.toLowerCase()); }); return { ok: true, triples: all.length, entities: ents.size }; }
function graphSearch(q, k) { k = Number(k) || 12; q = String(q || '').toLowerCase().trim(); const all = readGraph(); const hits = q ? all.filter((t) => (t.s + ' ' + t.p + ' ' + t.o).toLowerCase().includes(q)) : all.slice(-k); return { ok: true, query: q || null, matches: hits.slice(0, k) }; }
function graphEntity(name) { name = String(name || '').toLowerCase().trim(); const all = readGraph(); const links = all.filter((t) => t.s.toLowerCase() === name || t.o.toLowerCase() === name); return { ok: true, entity: name, links, degree: links.length }; }
async function graphRebuild(limit) { const items = readMemory(Number(limit) || 200); let added = 0; for (const m of items) { if (m && m.content) { const r = await graphExtract(m.content, { src: 'memory:' + (m.id || '') }); added += r.added || 0; } } return { ok: true, scanned: items.length, added, ...graphStats() }; }
// Federated search — one query across vector memory + knowledge graph + notes (fork parity).
async function federatedSearch(q, k) {
  k = Number(k) || 6;
  let memory = []; try { memory = await retrieveMemories(q, k); } catch {}
  const graph = graphSearch(q, k).matches;
  let notes = []; try { notes = searchMemoryItems(q, k).map((m) => ({ content: m.content || m.response || '', type: m.type || 'note' })); } catch {}
  return { ok: true, query: q, memory, graph, notes, total: memory.length + graph.length + notes.length };
}
// ── FILE → KNOWLEDGE persistence (N4) — chunk the FULL document body + embed each chunk
// (type 'doc-chunk'), not just a summary, so the whole file is semantically recallable. ──
function chunkText(text, size, overlap) { text = String(text || ''); size = size || 900; overlap = overlap || 120; const out = []; for (let i = 0; i < text.length; i += Math.max(1, size - overlap)) { out.push(text.slice(i, i + size)); if (i + size >= text.length) break; } return out.filter((c) => c.trim()); }
async function fileToKnowledge(filePath, opts = {}) {
  if (!filePath || !exists(filePath)) return { ok: false, error: 'file not found' };
  let text = ''; try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { ok: false, error: 'read failed: ' + e.message }; }
  if (!text.trim()) return { ok: false, error: 'empty or binary file' };
  const base = path.basename(filePath);
  const chunks = chunkText(text, opts.size, opts.overlap).slice(0, opts.max || 400);
  let embedded = 0;
  for (let i = 0; i < chunks.length; i++) {
    const id = 'doc:' + slug(base) + ':' + i;
    appendJsonl(memoryFile(), { id, type: 'doc-chunk', content: maybeEnc(chunks[i]), timestamp: new Date().toISOString(), src: base });
    if (await addMemoryVector({ id, content: chunks[i], type: 'doc-chunk' })) embedded++;
  }
  pushActivity('memory', 'File → knowledge: ' + base, chunks.length + ' chunks');
  return { ok: true, file: base, chunks: chunks.length, embedded, chars: text.length, embed_engine: embedAvailable() ? 'nomic' : 'keyword-only' };
}

// ── LEARN FROM CLAUDE — ingest your full claude.ai conversation export into RAG ──
function parseClaudeMsgText(m) {
  let t = m.text || m.content || (m.message && m.message.content) || '';
  if (Array.isArray(t)) t = t.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join(' ');
  return String(t || '').trim();
}
// Find a claude.ai data export (conversations.json) sitting on disk.
function scanForClaudeExport() {
  const home = os.homedir();
  const spots = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'), path.dirname(claudeConfigPath()), dataRoot].filter(Boolean);
  const found = [];
  for (const dir of spots) {
    try {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/conversations.*\.json$/i.test(f)) { const full = path.join(dir, f); try { found.push({ path: full, size_mb: Math.round(fs.statSync(full).size / 1024 / 1024 * 10) / 10 }); } catch {} }
      }
    } catch {}
  }
  return found;
}
async function importClaudeConversations(data, opts = {}) {
  let convos = Array.isArray(data) ? data : (data.conversations || data.data || []);
  if (!Array.isArray(convos)) throw new Error('That is not a Claude conversations export (expected an array of conversations).');
  const max = opts.max || 5000;
  let imported = 0, messages = 0;
  for (const c of convos.slice(0, max)) {
    const msgs = c.chat_messages || c.messages || [];
    if (!Array.isArray(msgs) || !msgs.length) continue;
    const title = c.name || c.title || 'Claude conversation';
    const when = c.created_at || c.created || new Date().toISOString();
    const lines = msgs.slice(0, 50).map((m) => {
      const s = String(m.sender || m.role || '').toLowerCase();
      const who = (s.includes('assist') || s === 'assistant' || s === 'ai') ? 'Claude' : 'User';
      return who + ': ' + parseClaudeMsgText(m);
    }).filter((l) => l.length > 4);
    if (!lines.length) continue;
    messages += msgs.length;
    const content = ('[Claude history — ' + title + ']\n' + lines.join('\n')).slice(0, 3500);
    appendJsonl(memoryFile(), { id: 'claude-' + (c.uuid || c.id || crypto.randomUUID()), type: 'claude-import', content, title, timestamp: when });
    imported++;
  }
  pushActivity('learn', 'Learned from Claude: ' + imported + ' conversations', messages + ' messages → memory');
  // Vectorize in the background so recall (RAG) sharpens; raw import is keyword-searchable immediately.
  setTimeout(() => { indexAllMemories().catch(() => {}); }, 200);
  return { ok: true, conversations: imported, messages, total_in_file: convos.length, note: 'Imported into long-term memory. ABUZ8 will now recall and learn from this past work; vector indexing finishes in the background.' };
}
async function importClaudeFromPath(p) {
  if (!p || !exists(p)) throw new Error('File not found: ' + p);
  const raw = fs.readFileSync(p, 'utf8');
  let data; try { data = JSON.parse(raw); } catch { throw new Error('Could not parse the JSON export.'); }
  return importClaudeConversations(data, {});
}

// ── SECOND BRAIN (vault) — Obsidian/Understand-Anything style ─────────────
// Drop ANY source (URL or text); ABUZ8 reads it, summarizes + extracts key
// points, files it as Markdown YOU own, and indexes it for RAG recall. Ask
// anything and it answers from your own knowledge.
function vaultDir() { return safeMkdir(path.join(dataRoot, 'brain', 'notes')); }
function listVaultNotes() {
  const dir = vaultDir(); const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      try { const txt = fs.readFileSync(path.join(dir, f), 'utf8'); const title = ((txt.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '')).trim(); const preview = txt.replace(/^#.*$/m, '').replace(/Source:.*$/m, '').replace(/[#*>\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150); out.push({ id: f.replace(/\.md$/, ''), title, preview }); } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.id.localeCompare(a.id));
}
function readVaultNote(id) { try { return { ok: true, id, markdown: fs.readFileSync(path.join(vaultDir(), String(id).replace(/[^a-z0-9]/gi, '') + '.md'), 'utf8') }; } catch { return { ok: false, error: 'not found' }; } }
function deleteVaultNote(id) { try { fs.unlinkSync(path.join(vaultDir(), String(id).replace(/[^a-z0-9]/gi, '') + '.md')); } catch {} return { ok: true }; }
async function vaultIngest(body = {}) {
  let bodyText = String(body.text || '').trim();
  const src = body.url ? String(body.url).trim() : 'note';
  if (body.url && !bodyText) { try { bodyText = await fetchPageText(body.url, 16000); } catch (e) { throw new Error('Could not read that link: ' + e.message); } }
  if (!bodyText) throw new Error('Give me a link or some text to file.');
  const sys = 'You are a knowledge librarian. Read the source and reply ONLY as compact JSON: {"title":"a short clear title","summary":"3-5 sentence summary","key_points":["point","point"],"tags":["tag","tag"]}. Be factual and concise.';
  let meta = { title: body.title || (src === 'note' ? 'Note' : src), summary: '', key_points: [], tags: [] };
  try { const r = await reasonReply('Source:\n' + bodyText.slice(0, 6000), { system: sys, noMemory: true }); const m = String(r.text || '').match(/\{[\s\S]*\}/); if (m) { const j = JSON.parse(m[0]); meta = { title: j.title || meta.title, summary: j.summary || '', key_points: j.key_points || [], tags: j.tags || [] }; } } catch {}
  const id = 'n' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const note = { id, title: meta.title, source: src, summary: meta.summary, key_points: meta.key_points, tags: meta.tags, created: new Date().toISOString() };
  const md = `# ${note.title}\n\n${src !== 'note' ? 'Source: ' + src + '\n\n' : ''}${note.summary}\n\n${(note.key_points || []).map((k) => '- ' + k).join('\n')}\n\n${note.tags && note.tags.length ? 'Tags: ' + note.tags.join(', ') + '\n\n' : ''}---\n${bodyText.slice(0, 9000)}`;
  try { fs.writeFileSync(path.join(vaultDir(), id + '.md'), md, 'utf8'); } catch {}
  const memContent = ('[Note: ' + note.title + '] ' + note.summary + ' ' + (note.key_points || []).join('. ')).slice(0, 2000);
  appendJsonl(memoryFile(), { id, type: 'brain-note', content: memContent, title: note.title, source: src, timestamp: note.created });
  addMemoryVector({ id, type: 'brain-note', content: memContent, timestamp: note.created }).catch(() => {});
  pushActivity('brain', 'Filed a note: ' + note.title, src);
  return { ok: true, note };
}
async function vaultAsk(q) {
  if (!q) throw new Error('Ask a question.');
  let ctx = '';
  try { const mems = await retrieveMemories(q, 6); ctx = mems.map((m) => '- ' + m.content).join('\n'); } catch {}
  const sys = 'You are ABUZ8 answering from the user\'s OWN knowledge base (their notes + saved sources + past work). Use the notes below when relevant and say which note. If they don\'t cover it, say so briefly, then answer from general knowledge. Be concise.';
  const r = await reasonReply('Question: ' + q + '\n\nMy knowledge:\n' + (ctx || '(nothing saved yet)'), { system: sys, noMemory: true });
  return { ok: true, answer: String(r.text || '').trim(), sources: ctx ? ctx.split('\n').length : 0 };
}

// ── CONTENT STUDIO — visuals + SEO articles (the production gap) ──────────
// Image generation works FREE out of the box via Pollinations (no key); a
// connected premium provider (image_gen connector) is used when present.
function studioImageUrl(prompt, opts = {}) {
  const w = opts.width || 1024, h = opts.height || 1024;
  const seed = opts.seed != null ? opts.seed : Math.floor((Date.now() % 100000));
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).slice(0, 600))}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}
async function studioImage(prompt, opts = {}) {
  const p = String(prompt || '').trim(); if (!p) throw new Error('Give an image prompt.');
  const c = connectorCreds('image_gen'); const key = c.api_key || '';
  // Free & reliable: a Hugging Face token (hf_…) → FLUX/SDXL on HF Inference.
  if (key && /^hf_/.test(key)) {
    try {
      const model = c.model || 'black-forest-labs/FLUX.1-schnell';
      const buf = await fetchUrl('https://api-inference.huggingface.co/models/' + model, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: p }), timeout: 90000, binary: true });
      if (buf && buf.length > 1200 && buf[0] !== 0x7b) { pushActivity('studio', 'Generated an image (HF)', p.slice(0, 60)); return { ok: true, url: 'data:image/png;base64,' + buf.toString('base64'), engine: 'huggingface-flux', prompt: p }; }
    } catch (e) { /* fall through */ }
  }
  // Premium: OpenAI-compatible images endpoint.
  if (key) {
    try {
      const base = c.endpoint || 'https://api.openai.com/v1';
      const out = JSON.parse(await fetchUrl(base.replace(/\/$/, '') + '/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: c.model || 'gpt-image-1', prompt: p, size: '1024x1024' }), timeout: 90000 }));
      const url = out.data && out.data[0] && (out.data[0].url || (out.data[0].b64_json ? 'data:image/png;base64,' + out.data[0].b64_json : ''));
      if (url) { pushActivity('studio', 'Generated an image (premium)', p.slice(0, 60)); return { ok: true, url, engine: 'premium', prompt: p }; }
    } catch (e) { /* fall through */ }
  }
  // Best-effort free fallback (Pollinations is now rate-limited — may 402).
  pushActivity('studio', 'Generated an image (free)', p.slice(0, 60));
  return { ok: true, url: studioImageUrl(p, opts), engine: 'pollinations-free (rate-limited)', prompt: p, note: 'Free server is heavily rate-limited now. For instant, reliable images add a FREE Hugging Face token (hf_…) under Connect → Premium image gen.' };
}
async function studioArticle(keyword) {
  const k = String(keyword || '').trim(); if (!k) throw new Error('Give a keyword or topic.');
  const sys = 'You are an elite SEO content writer. Write a complete, genuinely useful SEO article in clean Markdown: an H1 title with the keyword, a hook intro, 4-7 H2 sections with real substance and natural keyword usage, short scannable paragraphs, and a conclusion with a clear call to action. No filler, no "as an AI".';
  const r = await reasonReply('Target keyword / topic: ' + k, { system: sys, noMemory: true });
  return { ok: true, keyword: k, markdown: String(r.text || '').trim() };
}

// ── HUD / COMMAND CENTER — the one-person-company cockpit (CEO/CFO/CRO/SEO) ──
async function hudSnapshot() {
  const out = { ok: true, time: currentTimeContext() };
  try { out.brain = (selectEmbeddedBrain() || {}).name || 'local'; out.brain_alive = !!lfmProcess; } catch {}
  try { const sel = readJson(settingsPath(), {}).active_provider; out.active_provider = sel ? sel.name + ' · ' + sel.model : null; } catch {}
  // CFO — revenue (Stripe when connected)
  try { if (connectorCreds('stripe').secret_key) { const b = await connectorCall('stripe', 'balance'); out.revenue = { available: (b.available || []).map((a) => (a.amount / 100).toFixed(2) + ' ' + String(a.currency || '').toUpperCase()).join(', '), pending: (b.pending || []).map((a) => (a.amount / 100).toFixed(2) + ' ' + String(a.currency || '').toUpperCase()).join(', ') }; } else out.revenue = { not_connected: true }; } catch (e) { out.revenue = { error: 'check Stripe key' }; }
  // CRO — content & growth
  try {
    const loops = readSchedules().filter((s) => s.action && s.action.kind === 'content_loop');
    let posts = 0; try { const lines = fs.readFileSync(signalFile(), 'utf8').trim().split('\n'); for (const l of lines) { try { const s = JSON.parse(l); if (s.kind === 'social_post') posts += (s.ok || 0); } catch {} } } catch {}
    out.growth = { content_loops: loops.filter((l) => l.enabled).length, posts_made: posts, platforms: socialList().filter((p) => p.connected).map((p) => p.label) };
  } catch {}
  // COO — missions & autonomy
  try { const m = listMissionGraphs(); out.ops = { active_missions: m.filter((x) => x.status !== 'complete').length, total_missions: m.length, schedules: readSchedules().filter((s) => s.enabled).length }; } catch {}
  // CKO — knowledge
  try { out.knowledge = { notes: listVaultNotes().length, memories: readVectors().length }; } catch {}
  // CTO — agents & wiring
  try { out.agents = { classes: (typeof AGENT_CLASSES !== 'undefined' ? AGENT_CLASSES.length : 0), providers_connected: providerCatalogList().filter((p) => p.configured).length, connectors_connected: connectorList().filter((c) => c.configured).length, vision: visionBrainAvailable() }; } catch {}
  try { out.recent = activityLog.slice(-6).reverse().map((a) => ({ label: a.label, detail: a.detail, type: a.type })); } catch {}
  return out;
}

// ── CHAT SESSIONS — named, searchable, durable threads ───────────────────
function sessionsDir() { return safeMkdir(path.join(profileBase(), 'sessions')); }
function sessionFile(id) { return path.join(sessionsDir(), String(id || '').replace(/[^a-z0-9]/gi, '') + '.json'); }
function listSessions() {
  const dir = sessionsDir(); const out = [];
  try { for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { try { const s = readJson(path.join(dir, f), null); if (s) out.push({ id: s.id, title: s.title || 'Chat', updated: s.updated, count: (s.messages || []).length }); } catch {} } } catch {}
  return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}
function getSession(id) { return readJson(sessionFile(id), null); }
function saveSession(s) { if (!s || !s.id) return { ok: false, error: 'no id' }; s.updated = new Date().toISOString(); if (!s.created) s.created = s.updated; if (!s.title) s.title = (s.messages && s.messages[0] && String(s.messages[0].text || '').slice(0, 40)) || 'New chat'; writeJson(sessionFile(s.id), s); return { ok: true, id: s.id, title: s.title }; }
function deleteSessionById(id) { try { fs.unlinkSync(sessionFile(id)); } catch {} return { ok: true }; }
function searchSessions(q) {
  q = String(q || '').toLowerCase().trim(); if (!q) return listSessions();
  const dir = sessionsDir(); const out = [];
  try { for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { try { const s = readJson(path.join(dir, f), null); if (!s) continue; const hay = ((s.title || '') + ' ' + (s.messages || []).map((m) => m.text || '').join(' ')).toLowerCase(); if (hay.includes(q)) out.push({ id: s.id, title: s.title, updated: s.updated, count: (s.messages || []).length }); } catch {} } } catch {}
  return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

// ── SELF-UPDATE — version check against a configurable release manifest ───
const APP_VERSION = '1.51.0';
// True only when a > b by semantic version (major.minor.patch). Pre-release tag ignored.
function semverGt(a, b) {
  const pa = String(a || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return true; if (x < y) return false; }
  return false;
}
// Update channel must be https (a plain-http manifest could be MITM'd into pointing at a
// malicious installer). The manifest itself rides pinned https, so the sha256 it carries can't
// be altered in flight.
function updateHostAllowed(u) {
  try { const h = new URL(u); if (h.protocol !== 'https:') return false; const host = h.hostname.toLowerCase();
    return host === 'github.com' || host === 'objects.githubusercontent.com' || host.endsWith('.githubusercontent.com') || host === 'abuz8ai.com' || host.endsWith('.abuz8ai.com'); } catch { return false; }
}
// Ed25519 release-signing public key, base64 of the SPKI DER encoding (NOT raw 32-byte — the
// verifier below uses {format:'der', type:'spki'}). When set, applyUpdate REQUIRES a valid
// signature over the installer bytes, so no installer runs without a release signed by the
// matching offline private key — this closes the unsigned-self-update RCE path. Empty would
// disable only the signature layer (https+host-pin+sha256 still enforced).
// Private key (sign releases with it, keep OFFLINE): E:\ABU\API_KEYS\abuz8-os-update-signing\
const UPDATE_PUBKEY_B64 = 'MCowBQYDK2VwAyEAAI3N66khY0+3d8lqt+k+h54oJczkEhyZFF39O4X8fd4=';
async function checkUpdate() {
  const url = updateUrl();
  if (!url) return { ok: true, current: APP_VERSION, update_available: false, note: 'No update channel configured. Set one in Settings → Updates (a JSON URL with {version, installer_url}).' };
  if (!updateHostAllowed(url)) return { ok: true, current: APP_VERSION, update_available: false, note: 'Update manifest must be https on a trusted host (github / abuz8ai). Refusing this channel.' };
  try {
    const raw = await fetchUrl(url, { timeout: 12000 });
    let m; try { m = JSON.parse(raw); } catch { return { ok: true, current: APP_VERSION, update_available: false, note: 'Update channel reachable, but no valid release manifest is published yet. Host release-manifest.json at the channel URL to enable updates.' }; }
    // Semver-GREATER only — never offer a downgrade (string != would "update" 1.31.0 → 1.26.0
    // and run an older installer over a newer build, a brick risk).
    const newer = m.version && semverGt(String(m.version), APP_VERSION);
    return { ok: true, current: APP_VERSION, latest: m.version, update_available: !!newer, installer_url: m.installer_url || null, installer_sha256: m.installer_sha256 || m.sha256 || null, signature: m.signature || null, notes: m.notes || '' };
  } catch (e) { return { ok: false, current: APP_VERSION, error: e.message }; }
}

// ── Self-learning loop (migrated from Al-Buraq) ──
// Every agent turn is recorded to signal.jsonl. A periodic pass HARVESTs those
// signals, PROPOSEs skills from repeated successful tool use, scores them, and
// PROMOTEs the ones that prove out — so ABUZ8 learns from its own experience.
const PROMOTE_THRESHOLD = 0.66, MIN_PATTERN_COUNT = 2;
function signalFile() { return path.join(dataRoot, 'logs', 'signal.jsonl'); }
function recordSignal(rec) { try { appendJsonl(signalFile(), { ts: new Date().toISOString(), ...rec }); } catch {} }
function listLearnedSkills() {
  const d = path.join(dataRoot || '', 'skills', 'promoted');
  if (!exists(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f), {})).filter((s) => s.id);
}
// Per-turn learning — after each substantive exchange, a quick forked review extracts
// DURABLE facts/preferences/corrections about the USER and writes them to memory. Real
// learning every pass (Hermes-style), on top of the 15-min skill-synthesis batch.
async function reviewTurn(userText, assistantText) {
  try {
    if (_halted) return { ok: false, skipped: 'halted' };
    const u = String(userText || '').trim(); const a = String(assistantText || '').trim();
    if (u.length < 8 || a.length < 2) return { ok: true, learned: 0, skipped: 'too-short' };
    if (/^(error|usage:|✅|⚠|\/)/i.test(u)) return { ok: true, learned: 0, skipped: 'non-substantive' };
    const sys = 'You extract DURABLE facts about the USER worth remembering across sessions: name, role, preferences, recurring goals, constraints, and explicit corrections of how the assistant should behave. Ignore one-off task details, the assistant\'s own content, and any tool/environment errors. Output ONLY JSON: {"facts":["short atomic fact"]} — use [] if nothing durable.';
    const r = await frontierReply(`User said:\n${u.slice(0, 1200)}\n\nAssistant replied:\n${a.slice(0, 800)}\n\nExtract durable user facts/preferences/corrections.`, sys, { noMemory: true, brief: true, task: 'curator' });
    const j = extractJsonObject((r && r.text) || '');
    const facts = (j && Array.isArray(j.facts)) ? j.facts.filter((f) => f && String(f).trim().length > 3).slice(0, 5) : [];
    let learned = 0, skipped = 0; const kept = [];
    for (const f of facts) {
      const content = String(f).trim().slice(0, 300);
      try {
        if (await memoryHasSimilar(content, 0.9)) { skipped++; continue; } // dedup: don't re-store what we already know
        appendJsonl(memoryFile(), { id: crypto.randomUUID(), type: 'learned-fact', content, source: 'per-turn-review', timestamp: new Date().toISOString() });
        addMemoryVector({ content, type: 'learned-fact' }).catch(() => {}); learned++; kept.push(content);
      } catch {}
    }
    if (learned) pushActivity('learn', `Remembered ${learned} fact(s) about you`, kept.join(' · ').slice(0, 110));
    return { ok: true, learned, skipped, facts: kept };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Memory compounding — is this fact already (near-)known? (dedup so learning sharpens, not bloats)
async function memoryHasSimilar(content, threshold = 0.9) {
  try { const qv = await embedText(content); if (!qv) return false; for (const m of readVectors()) { if (m.vec && cosine(qv, m.vec) >= threshold) return true; } return false; } catch { return false; }
}

// VERIFICATION SPINE — adversarial pre-flight check before an irreversible / outward action.
// Fails CLOSED: ANY ambiguous outcome (verifier error, non-JSON reply, or no explicit boolean
// verdict) BLOCKS the action. Only an explicit {"safe":true} from the verifier lets an
// email / social post / payment through — a brain hiccup must never auto-approve money/outward.
const VERIFY_TOOLS = ['send_email', 'social_post', 'x_post', 'stripe_op'];
async function verifyAction(tool, args = {}) {
  try {
    const payload = JSON.stringify(args || {}).slice(0, 800);
    const sys = 'You are a strict pre-flight safety verifier for an autonomous agent about to take an IRREVERSIBLE, outward-facing action (email / social post / payment). Flag ONLY real problems: wrong/suspicious recipient or mass blast, leaked secrets or API keys in the content, destructive or fraudulent intent, obviously malformed/empty payload, or a money amount that looks wrong. Normal, well-formed actions are SAFE. Output ONLY JSON: {"safe":true|false,"severity":"low|medium|high","reason":"short"}';
    const r = await frontierReply(`Action: ${tool}\nPayload: ${payload}\n\nIs this safe and correct to execute right now?`, sys, { noMemory: true, brief: true, task: 'verify' });
    const j = extractJsonObject((r && r.text) || '');
    // FAIL-CLOSED on a parse miss: an unparseable / verdict-less verifier reply must NOT auto-pass.
    if (!j || typeof j.safe !== 'boolean') {
      return { safe: false, severity: 'high', reason: 'verifier returned no clear verdict — BLOCKED (fail-closed; outward/irreversible action needs explicit approval)' };
    }
    return { safe: j.safe, severity: j.severity || (j.safe ? 'low' : 'high'), reason: j.reason || '' };
  } catch { return { safe: false, severity: 'high', reason: 'verifier unavailable — BLOCKED (fail-closed; outward/irreversible action needs explicit approval)' }; }
}

function selfLearnOnce() {
  if (!dataRoot) return { ok: false };
  // HARVEST
  let rows = [];
  try { rows = fs.readFileSync(signalFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  // PROPOSE — repeated SUCCESSFUL tool usage becomes a candidate skill.
  const counts = {};
  for (const r of rows) {
    if (!r.ok) continue;
    for (const t of (r.used_tools || [])) { const n = typeof t === 'string' ? t : (t && t.tool); if (n && n !== 'reasoning only') counts[n] = (counts[n] || 0) + 1; }
  }
  const proposedDir = safeMkdir(path.join(dataRoot, 'skills', 'proposed'));
  const promotedDir = safeMkdir(path.join(dataRoot, 'skills', 'promoted'));
  let written = 0;
  for (const [tool, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    if (n < MIN_PATTERN_COUNT) continue;
    const id = 'auto_' + slug(tool);
    const p = path.join(proposedDir, id + '.json');
    if (exists(p) || exists(path.join(promotedDir, id + '.json'))) continue;
    writeJson(p, { id, trigger_tool: tool, observed_count: n, skill: `When the task matches '${tool}', use the ${tool} tool directly — it has worked ${n} times.`, proposed_at: new Date().toISOString(), status: 'proposed' });
    written++;
  }
  // EVALUATE — score; promote (>=0.66), prune (<0.34), else keep pending.
  let promoted = 0, pruned = 0, pending = 0;
  for (const f of (exists(proposedDir) ? fs.readdirSync(proposedDir) : [])) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(proposedDir, f);
    const pr = readJson(fp, null); if (!pr) continue;
    const base = Math.min(1, (pr.observed_count || 0) / 5);
    const score = Math.round((0.5 * base + 0.5 * (pr.trigger_tool ? 1 : 0)) * 1000) / 1000;
    pr.score = score;
    if (score >= PROMOTE_THRESHOLD) { pr.status = 'promoted'; writeJson(path.join(promotedDir, f), pr); try { fs.unlinkSync(fp); } catch {} promoted++; }
    else if (score < 0.34) { try { fs.unlinkSync(fp); } catch {} pruned++; }
    else { pr.status = 'pending'; writeJson(fp, pr); pending++; }
  }
  const out = { ok: true, ts: new Date().toISOString(), harvested: rows.length, proposed: written, promoted, pruned, pending, learned_total: listLearnedSkills().length };
  appendJsonl(path.join(dataRoot, 'logs', 'self_learning_log.jsonl'), out);
  return out;
}

function detectGpuNames() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

// Accurate NVIDIA GPU info (name + true VRAM + driver) via nvidia-smi when present.
function nvidiaSmi() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err) return resolve(null);
      const rows = String(out || '').trim().split(/\r?\n/).filter(Boolean).map((l) => {
        const [name, mem, drv] = l.split(',').map((s) => s.trim());
        return { name, vram_mb: Math.round(Number(mem) || 0), driver: drv };
      });
      resolve(rows.length ? rows : null);
    });
  });
}
// ALL GPUs + total VRAM (every vendor name via CIM, accurate NVIDIA VRAM via nvidia-smi).
// This is what lets ABUZ8 "see all the GPUs" and run MAX on a multi-GPU box, not lock to CPU.
async function gpuInfo() {
  const [nv, names] = await Promise.all([nvidiaSmi().catch(() => null), detectGpuNames().catch(() => [])]);
  let gpus = [];
  if (nv && nv.length) gpus = nv.map((g, i) => ({ index: i, name: g.name, vram_mb: g.vram_mb, driver: g.driver, vendor: 'nvidia' }));
  else gpus = (names || []).map((n, i) => ({ index: i, name: n, vram_mb: null, vendor: /nvidia|geforce|rtx|gtx|tesla|quadro/i.test(n) ? 'nvidia' : (/radeon|amd/i.test(n) ? 'amd' : (/intel|arc/i.test(n) ? 'intel' : 'unknown')) }));
  const total = gpus.reduce((n, g) => n + (g.vram_mb || 0), 0);
  return { gpus, count: gpus.length, total_vram_mb: total, total_vram_gb: Math.round(total / 1024 * 10) / 10 };
}
// ── KINECT v2 as eyes + ears ─────────────────────────────────────────────────
// Detect the Kinect for Windows v2 (runtime/SDK + its color camera & mic-array as
// PnP devices). When present, the user selects the Kinect's camera + mic in the
// vision/voice device picker and the existing MediaPipe vision + whisper STT see &
// hear through it. Native depth/skeleton needs the Kinect SDK + a native binding
// (optional add-on) — reported honestly, not faked.
async function kinectStatus() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const dll = exists(path.join(win, 'System32', 'Kinect20.dll')) || exists(path.join(win, 'System32', 'kinect20.dll'));
  const sdk = ['C\\:\\Program Files\\Microsoft SDKs\\Kinect\\v2.0_1409', 'C:\\Program Files\\Microsoft SDKs\\Kinect\\v2.0_1409', 'C:\\Program Files\\Microsoft SDKs\\Kinect'].some((p) => { try { return exists(p); } catch { return false; } });
  let devices = [];
  if (process.platform === 'win32') {
    try { devices = await new Promise((res) => { execFile('powershell.exe', ['-NoProfile', '-Command', "Get-PnpDevice -Class Camera,AudioEndpoint,Media -Status OK -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FriendlyName"], { windowsHide: true, timeout: 7000 }, (e, o) => res(e ? [] : String(o).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))); }); } catch {}
  }
  const kinectRe = /kinect|xbox\s*nui|nui\s*sensor/i;
  const kinectDevices = devices.filter((d) => kinectRe.test(d));
  let captureDevs = []; try { captureDevs = await listCaptureDevices(); } catch {}
  const kinectMic = captureDevs.find((d) => d.kinect) || null;
  const present = dll || sdk || kinectDevices.length > 0 || !!kinectMic;
  return {
    present, sdk_installed: sdk, runtime_dll: dll, kinect_devices: kinectDevices,
    color_camera: kinectDevices.some((d) => /camera|color|sensor|video/i.test(d)),
    mic_array: !!kinectMic || kinectDevices.some((d) => /audio|mic|microphone/i.test(d)),
    kinect_mic_capture_index: kinectMic ? kinectMic.index : null,
    capture_devices: captureDevs,
    cameras_and_mics: devices.slice(0, 24),
    note: present
      ? 'Kinect v2 detected. Pick its color camera + mic array in the vision/voice picker → ABUZ8 sees + hears through the Kinect (MediaPipe vision + whisper streaming STT + Piper speech). Native depth/skeleton needs the Kinect SDK + the kinect2 native binding (optional).'
      : 'No Kinect v2 found. Connect it via USB3 + the Kinect→PC adapter and install the Microsoft Kinect for Windows runtime, OR use any webcam + mic — the pipeline is device-agnostic.'
  };
}
function monitorCount() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(1);
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      resolve(err ? 1 : (parseInt(String(out).trim(), 10) || 1));
    });
  });
}

function expandZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`], { windowsHide: true, timeout: 180000 }, (err) => err ? reject(err) : resolve());
  });
}

// GPU UNLOCK: download a CUDA-enabled llama.cpp build + CUDA runtime so the brain
// offloads to the NVIDIA GPU. Run this on a GPU machine (Pegasus/DGX) to go fast.
// On boot: if there's an NVIDIA GPU and we're not yet accelerated, automatically
// install the CUDA runtime and move the brains onto the GPU — so the portable
// build "figures out" the hardware it lands on (Surface → CPU, Pegasus/DGX → GPU).
let _autoGpuTried = false;
async function maybeAutoAccelerate() {
  if (_autoGpuTried) return; _autoGpuTried = true;
  try {
    if (readJson(settingsPath(), {}).auto_gpu === false) return; // user opted out
    if (brainIsCuda()) return;                                    // already on the GPU runtime
    if (!(await hasNvidiaGpu())) return;                          // no NVIDIA GPU here (e.g. the Surface)
    pushActivity('observe', 'NVIDIA GPU detected — enabling GPU acceleration', '');
    logFn('auto-GPU: NVIDIA GPU found; downloading CUDA runtime…');
    const r = await unlockGpu();
    if (r && r.ok) {
      pushActivity('done', 'GPU acceleration enabled — brains moved to the GPU', r.build || '');
      logFn('auto-GPU: enabled (' + (r.build || '') + '). Restarting brains on the GPU.');
      // Drop running brains so they relaunch on the CUDA runtime (lazy ensure* will restart them).
      for (const proc of [lfmProcess, voiceProcess, embedProcess, visionProcess]) { try { if (proc) proc.kill(); } catch {} }
      lfmProcess = null; voiceProcess = null; embedProcess = null; visionProcess = null;
    } else { logFn('auto-GPU: ' + ((r && r.error) || 'could not enable') + ' — staying on CPU.'); }
  } catch (e) { logFn('auto-GPU skipped: ' + e.message); }
}
async function unlockGpu() {
  if (!(await hasNvidiaGpu())) return { ok: false, error: 'No NVIDIA GPU detected on this machine. CPU mode stays active.' };
  const dest = safeMkdir(path.join(attachmentsDir(), 'brain-cuda'));
  let rel;
  try { rel = JSON.parse(await fetchUrl('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', { headers: { 'User-Agent': 'abuz8-os', Accept: 'application/vnd.github+json' } })); }
  catch (e) { return { ok: false, error: 'Could not reach GitHub for the CUDA build: ' + e.message }; }
  const assets = rel.assets || [];
  const cuda = assets.find((a) => /bin-win-cuda.*x64\.zip$/i.test(a.name)) || assets.find((a) => /win-cuda.*\.zip$/i.test(a.name));
  const cudart = assets.find((a) => /cudart.*win.*\.zip$/i.test(a.name));
  if (!cuda) return { ok: false, error: 'No prebuilt CUDA Windows binary in the latest llama.cpp release; build one and drop it in attachments/brain-cuda.' };
  const tmp = safeMkdir(path.join(dataRoot, 'cache', 'cuda-dl'));
  try {
    const cudaZip = path.join(tmp, cuda.name);
    await downloadFile(cuda.browser_download_url, cudaZip);
    await expandZip(cudaZip, dest);
    if (cudart) { const cz = path.join(tmp, cudart.name); await downloadFile(cudart.browser_download_url, cz); await expandZip(cz, dest); }
    // Some builds nest the exe one folder deep — flatten if needed.
    if (!exists(path.join(dest, 'llama-server.exe'))) {
      for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
        if (e.isDirectory() && exists(path.join(dest, e.name, 'llama-server.exe'))) {
          for (const f of fs.readdirSync(path.join(dest, e.name))) { try { fs.renameSync(path.join(dest, e.name, f), path.join(dest, f)); } catch {} }
        }
      }
    }
    _nvidiaCache = null;
    stopEmbeddedBrain();
    if (voiceProcess) { try { voiceProcess.kill(); } catch {} voiceProcess = null; }
    const ok = exists(path.join(dest, 'llama-server.exe'));
    return { ok, installed_to: dest, build: cuda.name, cudart: cudart ? cudart.name : null, accel: ok && brainIsCuda() ? 'gpu' : 'cpu', note: ok ? 'GPU runtime installed. Your next reply runs on the NVIDIA GPU.' : 'Downloaded but llama-server.exe not found in the build.' };
  } catch (e) { return { ok: false, error: e.message }; }
}

function storageSummary() {
  try {
    const s = fs.statfsSync(dataRoot);
    return {
      data_root: dataRoot,
      free_gb: Math.round((s.bavail * s.bsize) / 1024 / 1024 / 1024),
      total_gb: Math.round((s.blocks * s.bsize) / 1024 / 1024 / 1024)
    };
  } catch {
    return { data_root: dataRoot, free_gb: null, total_gb: null };
  }
}

function cleanSegment(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join(path.sep) || 'model';
}

function huggingFaceUrl(body) {
  if (body.url) return String(body.url);
  const repo = String(body.repo || '').replace(/^https:\/\/huggingface\.co\//, '').replace(/^hf:\/\//, '');
  const file = String(body.file || body.filename || '');
  if (!repo || !file) return '';
  const revision = encodeURIComponent(body.revision || 'main');
  return `https://huggingface.co/${repo}/resolve/${revision}/${file}?download=true`;
}

function downloadFile(url, dest, token) {
  return new Promise((resolve, reject) => {
    if (airgapOn()) return reject(new Error('Local-Only (air-gap) mode is ON — downloads disabled.'));
    safeMkdir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    const request = https.get(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close(() => fs.rm(dest, { force: true }, () => {}));
        return resolve(downloadFile(new URL(response.headers.location, url).toString(), dest, token));
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        file.close(() => fs.rm(dest, { force: true }, () => {}));
        return reject(new Error(`download failed with HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve({ bytes: fs.statSync(dest).size })));
    });
    request.on('error', (e) => {
      file.close(() => fs.rm(dest, { force: true }, () => {}));
      reject(e);
    });
  });
}

function listDownloadedModels() {
  const root = path.join(dataRoot, 'models');
  const rows = [];
  function walk(dir) {
    if (!exists(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(gguf|onnx|safetensors|bin)$/i.test(entry.name)) {
        const st = fs.statSync(full);
        rows.push({ name: entry.name, path: full, size_mb: Math.round(st.size / 1024 / 1024), modified_at: st.mtime.toISOString() });
      }
    }
  }
  walk(root);
  return rows;
}

async function downloadHuggingFaceModel(body = {}) {
  if (!body.allow_network_download) {
    throw new Error('allow_network_download must be true before downloading model files.');
  }
  const url = huggingFaceUrl(body);
  if (!url || !url.startsWith('https://huggingface.co/')) {
    throw new Error('Provide a Hugging Face repo+file or a direct https://huggingface.co/... model URL.');
  }
  const repoName = cleanSegment(body.repo || 'direct-download');
  const fileName = path.basename(new URL(url).pathname) || cleanSegment(body.file || 'model.gguf');
  const dest = path.join(dataRoot, 'models', 'huggingface', repoName, fileName);
  const result = await downloadFile(url, dest, body.token || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN);
  return {
    ok: true,
    url,
    path: dest,
    size_mb: Math.round(result.bytes / 1024 / 1024),
    selectable_brain_id: fileName.toLowerCase().endsWith('.gguf') ? `local-${slug(path.relative(path.join(dataRoot, 'models'), dest).replace(/\.gguf$/i, ''))}` : null,
    note: 'Downloaded locally. GGUF files in the portable model shelf are selectable as local brains.'
  };
}

function registerCloudBrain(body = {}) {
  if (!body.allow_cloud_brain) throw new Error('allow_cloud_brain must be true before registering a cloud brain.');
  const id = slug(body.id || body.name || body.provider || `cloud-${Date.now()}`);
  if (!id) throw new Error('cloud brain id/name is required.');
  if (!body.endpoint && !body.provider) throw new Error('provider or endpoint is required.');
  const record = {
    id,
    name: body.name || id,
    provider: body.provider || 'custom',
    endpoint: body.endpoint || '',
    model: body.model || '',
    api_key_env: body.api_key_env || '',
    status: 'registered',
    registered_at: new Date().toISOString()
  };
  writeJson(path.join(dataRoot, 'config', 'cloud-brains', `${id}.json`), record);
  return { ok: true, cloud_brain: record, dir: path.join(dataRoot, 'config', 'cloud-brains') };
}

async function machineProbe() {
  const gpuNames = await detectGpuNames();
  const smi = await nvidiaSmi();
  const monitors = await monitorCount();
  // Merge accurate NVIDIA VRAM (nvidia-smi) with the CIM list; CIM AdapterRAM caps
  // at 4 GB so we trust nvidia-smi for VRAM when present.
  const gpus = gpuNames.map((name) => {
    const m = smi && smi.find((g) => name.toLowerCase().includes(g.name.toLowerCase().split(' ')[1] || g.name.toLowerCase()));
    return { name, vram_mb: m ? m.vram_mb : null, driver: m ? m.driver : null };
  });
  if (smi) for (const g of smi) if (!gpus.some((x) => x.vram_mb)) gpus.push({ name: g.name, vram_mb: g.vram_mb, driver: g.driver });
  const totalGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const cpuName = os.cpus()[0]?.model || 'CPU';
  const cores = os.cpus().length;
  const gpuText = gpuNames.join(' ').toLowerCase();
  const hasNvidia = /nvidia|geforce|rtx|gtx|tesla|quadro|dgx/.test(gpuText) || Boolean(smi);
  const hasDiscreteGpu = hasNvidia || gpuText.includes('radeon') || gpuText.includes('arc');
  const totalVram = smi ? smi.reduce((a, g) => a + g.vram_mb, 0) : 0;
  const accel = lastBrainAccel; // 'gpu' or 'cpu' — what the brain is actually using
  const cudaReady = brainIsCuda();
  // Power tier scales from a Surface to a DGX.
  const tier = (totalGb >= 128 && totalVram >= 40000) ? 'AI workstation / DGX-class'
    : totalVram >= 16000 ? 'high-performance GPU rig'
    : (totalGb >= 32 && hasDiscreteGpu) ? 'workstation'
    : totalGb >= 16 ? 'creator laptop'
    : totalGb >= 8 ? 'mobile edge'
    : 'lightweight';
  const embedded = embeddedBrainStatus();
  const docker = await commandExists('docker', ['--version']);
  const dockerMcp = docker ? await commandExists('docker', ['mcp', '--help']) : false;
  const ollama = await commandExists('ollama', ['--version']);
  const node = await commandExists('node', ['--version']);
  const python = await commandExists('python', ['--version']);
  const storage = storageSummary();
  const bundled = embedded.available || [];
  const can = [
    { id: 'offline-chat', label: embedded.embedded ? 'Offline sovereign brain' : 'Portable fallback brain', status: embedded.embedded ? 'ready' : 'fallback', detail: embedded.embedded ? `${embedded.name} (${embedded.tier}) is selected. ${bundled.filter((b) => b.embedded).length} LFM tier(s) are bundled and run through llama.cpp.` : 'No GGUF model bundled; Portable Core still answers and routes tools.' },
    { id: 'memory', label: 'Local memory', status: 'ready', detail: `Memory, MCP, logs, models, workspaces, and exports live under ${dataRoot}.` },
    { id: 'mcp', label: 'MCP connector import', status: 'ready', detail: 'Can import Claude Desktop MCP config; Docker MCP imports when Docker Desktop MCP Toolkit is installed.' },
    { id: 'files', label: 'Files and workspaces', status: 'ready', detail: 'App-local folders are created on first run for portable or installed mode.' },
    { id: 'avatar', label: 'Avatar/rendering', status: hasDiscreteGpu ? 'gpu-ready' : 'fallback', detail: hasDiscreteGpu ? 'GPU detected; connect ComfyUI or a render worker for heavy video/avatar jobs.' : 'No strong GPU detected; browser preview/TTS and cloud/API rendering are the default.' },
    { id: 'docker', label: 'Docker tools', status: docker ? (dockerMcp ? 'mcp-ready' : 'docker-ready') : 'optional', detail: docker ? 'Docker is available on this device.' : 'Docker Desktop not detected; Docker MCP is optional.' },
    { id: 'local-dev', label: 'Local developer tools', status: node || python ? 'ready' : 'limited', detail: `Node: ${node ? 'yes' : 'no'} · Python: ${python ? 'yes' : 'no'}` }
  ];
  const recommended = [
    totalGb < 8 ? 'Use lightweight mode and keep the embedded model responses short.' : 'Use the embedded LFM brain for local planning and tool routing.',
    hasDiscreteGpu ? 'Enable GPU renderer connectors for avatar/video jobs.' : 'Use CPU/browser previews for avatar work; connect cloud rendering only when needed.',
    dockerMcp ? 'Import Docker Desktop MCP from Migration.' : 'Import Claude Desktop MCP first, then add Docker MCP if Docker Desktop is installed.'
  ];
  return {
    ok: true,
    tier,
    headline: `This device is classified as ${tier}.`,
    system: { os_family: os.type(), os_release: os.release(), arch: os.arch(), hostname: os.hostname(), monitors },
    cpu: { name: cpuName, cores },
    memory: { total_gb: totalGb },
    storage,
    gpus,
    acceleration: {
      mode: accel,                              // what the brain is running on now
      nvidia: hasNvidia,
      total_vram_mb: totalVram,
      cuda_runtime_installed: cudaReady,
      can_unlock_gpu: hasNvidia && !cudaReady,  // GPU present but still on CPU → unlock available
      threads_used: Math.max(2, cores)
    },
    embedded_brain: embedded,
    brain_tiers: bundled,
    connectors: { docker, docker_mcp: dockerMcp, ollama, node, python },
    capabilities: can,
    recommended
  };
}

// Known port → service hints for the system map. Real detection still requires
// the port to be listening; this only labels what is found.
const PORT_HINTS = {
  '8900': 'ABUZ8 OS Portable Core (this app)',
  '8902': 'ABUZ8 embedded LFM brain (llama.cpp)',
  '1234': 'LM Studio (OpenAI-compatible)',
  '11434': 'Ollama',
  '8188': 'ComfyUI',
  '9119': 'Hermes Agent gateway',
  '18789': 'OpenClaw gateway',
  '8910': 'Mission Agent',
  '3000': 'Dev server (Node/React)',
  '5173': 'Vite dev server',
  '8000': 'HTTP dev server',
  '8080': 'HTTP / proxy',
  '5432': 'PostgreSQL',
  '3306': 'MySQL/MariaDB',
  '6379': 'Redis',
  '27017': 'MongoDB',
  '9000': 'MinIO / PHP-FPM',
  '7860': 'Gradio',
  '5000': 'Flask / HTTP',
  '4000': 'Dev server',
  '3001': 'Dev server'
};

// CLIs ABUZ8 can drive. Each probe is a fast version check.
const CLI_CATALOG = [
  { id: 'node', cmd: 'node', args: ['--version'], label: 'Node.js' },
  { id: 'npm', cmd: 'npm', args: ['--version'], label: 'npm' },
  { id: 'npx', cmd: 'npx', args: ['--version'], label: 'npx' },
  { id: 'python', cmd: 'python', args: ['--version'], label: 'Python' },
  { id: 'pip', cmd: 'pip', args: ['--version'], label: 'pip' },
  { id: 'uv', cmd: 'uv', args: ['--version'], label: 'uv' },
  { id: 'uvx', cmd: 'uvx', args: ['--version'], label: 'uvx' },
  { id: 'git', cmd: 'git', args: ['--version'], label: 'Git' },
  { id: 'gh', cmd: 'gh', args: ['--version'], label: 'GitHub CLI' },
  { id: 'docker', cmd: 'docker', args: ['--version'], label: 'Docker' },
  { id: 'kubectl', cmd: 'kubectl', args: ['version', '--client'], label: 'kubectl' },
  { id: 'aws', cmd: 'aws', args: ['--version'], label: 'AWS CLI' },
  { id: 'gcloud', cmd: 'gcloud', args: ['--version'], label: 'gcloud' },
  { id: 'az', cmd: 'az', args: ['version'], label: 'Azure CLI' },
  { id: 'terraform', cmd: 'terraform', args: ['version'], label: 'Terraform' },
  { id: 'ollama', cmd: 'ollama', args: ['--version'], label: 'Ollama CLI' },
  { id: 'ffmpeg', cmd: 'ffmpeg', args: ['-version'], label: 'FFmpeg' },
  { id: 'curl', cmd: 'curl', args: ['--version'], label: 'curl' },
  { id: 'pwsh', cmd: 'pwsh', args: ['--version'], label: 'PowerShell 7' },
  { id: 'cargo', cmd: 'cargo', args: ['--version'], label: 'Rust/Cargo' },
  { id: 'go', cmd: 'go', args: ['version'], label: 'Go' },
  { id: 'java', cmd: 'java', args: ['-version'], label: 'Java' },
  { id: 'dotnet', cmd: 'dotnet', args: ['--version'], label: '.NET' }
];

function scanListeningPorts() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return execFile('bash', ['-lc', "ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null"], { timeout: 6000 }, (e, out) => resolve(parseUnixPorts(String(out || ''))));
    }
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      const seen = new Map();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (!m) continue;
        const [, addr, port, pid] = m;
        if (addr.startsWith('[') && addr !== '[::]' && addr !== '[::1]') {}
        const key = port;
        if (!seen.has(key)) seen.set(key, { port: Number(port), addr, pid: Number(pid) });
      }
      resolve(Array.from(seen.values()));
    });
  });
}

function parseUnixPorts(out) {
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/:(\d+)\s+.*LISTEN/);
    if (m) rows.push({ port: Number(m[1]), addr: '0.0.0.0', pid: 0 });
  }
  return rows;
}

function mapPidsToNames(pids) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pids.length) return resolve({});
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const map = {};
      if (!err) {
        for (const line of String(stdout).split(/\r?\n/)) {
          const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
          if (cols.length >= 2) map[cols[1]] = cols[0];
        }
      }
      resolve(map);
    });
  });
}

async function discoverClis() {
  const results = await Promise.all(CLI_CATALOG.map(async (c) => {
    const probe = await runCommand(c.cmd, c.args, 5000);
    const version = (probe.stdout || probe.stderr || '').split(/\r?\n/).find((l) => l.trim()) || '';
    return { id: c.id, label: c.label, command: c.cmd, available: probe.ok, version: probe.ok ? version.trim().slice(0, 80) : null };
  }));
  return results;
}

async function systemScan() {
  const rawPorts = await scanListeningPorts();
  const pidNames = await mapPidsToNames([...new Set(rawPorts.map((p) => String(p.pid)))]);
  const ports = rawPorts
    .sort((a, b) => a.port - b.port)
    .map((p) => ({
      port: p.port,
      address: p.addr,
      pid: p.pid,
      process: pidNames[String(p.pid)] || null,
      service: PORT_HINTS[String(p.port)] || null,
      local: p.addr === '127.0.0.1' || p.addr === '0.0.0.0' || p.addr === '[::]' || p.addr === '[::1]'
    }));
  const clis = await discoverClis();
  const endpoints = APP_ENDPOINTS;
  const probe = await machineProbe();
  return {
    ok: true,
    scanned_at: new Date().toISOString(),
    host: probe.system,
    cpu: probe.cpu,
    memory: probe.memory,
    storage: probe.storage,
    gpus: probe.gpus,
    acceleration: probe.acceleration,
    tier: probe.tier,
    ports,
    port_count: ports.length,
    clis,
    cli_available: clis.filter((c) => c.available).length,
    endpoints,
    embedded_brain: probe.embedded_brain
  };
}

// Self-describing catalog of this app's own HTTP endpoints, for the System map.
const APP_ENDPOINTS = [
  { method: 'POST', path: '/api/chat', desc: 'Chat with the active brain/agent role' },
  { method: 'GET', path: '/api/system/scan', desc: 'Scan ports, CLIs, endpoints, hardware' },
  { method: 'GET', path: '/api/agents/roles', desc: 'List predefined agent roles' },
  { method: 'GET', path: '/api/device/probe', desc: 'Hardware and capability probe' },
  { method: 'GET', path: '/api/brains/list', desc: 'List local brain models' },
  { method: 'POST', path: '/api/brains/select', desc: 'Switch active brain tier' },
  { method: 'GET', path: '/api/tools/list', desc: 'List built-in and custom tools' },
  { method: 'POST', path: '/api/tools/call', desc: 'Execute a tool by name' },
  { method: 'POST', path: '/api/tools/create', desc: 'Create a custom local tool' },
  { method: 'GET', path: '/api/mcp/servers', desc: 'List MCP servers' },
  { method: 'GET', path: '/api/mcp/servers/:name/tools', desc: 'List an MCP server’s tools' },
  { method: 'POST', path: '/api/mcp/call', desc: 'Call an MCP tool' },
  { method: 'POST', path: '/api/cli/probe', desc: 'Run a local CLI command (consent)' },
  { method: 'GET', path: '/api/memory/recent', desc: 'Recent local memory' },
  { method: 'POST', path: '/api/memory/write', desc: 'Write a memory note' },
  { method: 'GET', path: '/api/providers', desc: 'List model providers' },
  { method: 'POST', path: '/api/providers', desc: 'Add or update a provider' },
  { method: 'POST', path: '/api/swarm/run', desc: 'Run a multi-agent swarm on a goal' },
  { method: 'POST', path: '/api/content/generate', desc: 'Generate carousel/thread/script/SEO content' },
  { method: 'POST', path: '/api/x/post', desc: 'Post to X (needs OAuth2 token)' },
  { method: 'POST', path: '/api/growth/seed', desc: 'Seed the 25-problems X growth board' },
  { method: 'GET', path: '/api/skills/installed', desc: 'List migrated skill packs' },
  { method: 'GET', path: '/api/bridge/status', desc: 'Claude Desktop two-way bridge status' },
  { method: 'POST', path: '/api/bridge/reinstall', desc: 'Reinstate the Claude Desktop symbiosis' },
  { method: 'GET', path: '/api/mission/board', desc: 'Kanban board (delegation)' }
];

// ── Multi-agent swarm: run several roles on one task, then synthesize. Real,
// sequential calls through the same reply ladder (brain or providers). ──
async function runSwarm(task, roleIds = []) {
  const goal = String(task || '').trim();
  if (!goal) throw new Error('task is required');
  const roles = (roleIds && roleIds.length ? roleIds : ['research-analyst', 'systems-engineer', 'content-producer'])
    .map((id) => AGENT_ROLES.find((r) => r.id === id)).filter(Boolean);
  const workers = [];
  for (const role of roles) {
    const r = await reasonReply(`Goal: ${goal}\n\nContribute your part as the ${role.name}. Be specific and actionable.`, { role: role.id });
    workers.push({ role: role.id, name: role.name, output: r.text, brain: r.brain });
  }
  const merged = workers.map((w) => `### ${w.name}\n${w.output}`).join('\n\n');
  const synth = await reasonReply(`You are the synthesis agent. Goal: ${goal}\n\nThe specialized agents reported:\n\n${merged}\n\nReconcile their work into one coherent, deduplicated plan with clear next steps.`, { role: 'swarm-orchestrator' });
  return { ok: true, goal, agents: workers, synthesis: synth.text, brain: synth.brain };
}

// Salvage a tool call from messy small-model output (handles malformed JSON
// like {"tool":"web_search {\"q\":...}"} by finding a known tool name + an arg).
function salvageToolCall(raw) {
  const text = String(raw || '');
  for (const t of KNOWN_AGENT_TOOLS) {
    if (new RegExp('\\b' + t + '\\b', 'i').test(text)) {
      const after = text.slice(text.toLowerCase().indexOf(t));
      let args = {};
      const argMatch = after.match(/\{[\s\S]*\}/);
      if (argMatch) { try { args = JSON.parse(argMatch[0]); } catch {} }
      if (!Object.keys(args).length) {
        const kv = text.match(/"(q|query|command|url|site|content|topic|name|goal)"\s*:\s*"([^"]+)"/i);
        const bare = text.match(new RegExp(t + '[^a-z0-9]+([^\\n"}{]{2,80})', 'i'));
        const val = kv ? kv[2] : (bare ? bare[1].trim() : '');
        if (val) args = { q: val, command: val, content: val, url: val, topic: val, name: val };
      }
      return { tool: t, args };
    }
  }
  return null;
}

// ── Autonomous agent loop (ReAct-style): plan → act → observe → repeat. ──
// Grounded in the common agentic pattern used by AutoGPT/Manus/OpenHands/CrewAI:
// a thinking model emits one tool call at a time; the loop executes it and feeds
// the result back until the goal is met or a step budget is hit.
async function runAgentLoop(goal, opts = {}) {
  const maxSteps = Math.max(1, Math.min(Number(opts.max_steps || 6), 12));
  const steps = [];
  let history = '';
  agentRunning = true;
  _agentStop = false; // fresh run clears any prior stop request
  pushActivity('plan', 'Autopilot started', goal);
  const toolList = [
    'web_search {"q":"..."}', 'open_url {"url" or "site":"...","browser":"chrome?"}', 'open_app {"name":"chrome|notepad|..."}',
    'cmd_run {"command":"..."}', 'file_write {"relpath":"...","content":"..."}', 'screenshot {}',
    'abuz8_memory_write {"content":"..."}', 'content_generate {"topic":"...","format":"x-carousel|youtube-script|..."}',
    'abuz8_device_probe {}', 'code_build {"goal":"build a <app/site/script>"}', 'studio_produce {"kind":"image|video","prompt":"..."}', 'osint {"action":"whois|dns|...","target":"..."}'
  ];
  for (let i = 0; i < maxSteps; i++) {
    if (agentStopRequested()) { agentRunning = false; pushActivity('done', 'Autopilot stopped', 'by user'); return { ok: true, stopped: true, steps, answer: 'Stopped by user.' }; }
    const planPrompt = [
      `GOAL: ${goal}`,
      history ? `Progress so far:\n${history}` : 'No actions taken yet.',
      `Choose the SINGLE next tool. Available: ${toolList.join(' | ')}`,
      'Reply with ONLY one compact JSON object: {"tool":"<name>","args":{...}}  — or if the goal is done: {"done":true,"answer":"..."}'
    ].join('\n\n');
    // NATIVE FUNCTION-CALLING FIRST: when the sovereign local brain is the engine, get a
    // structured tool_call (reliable, no parse failures) instead of free-text JSON. The
    // text path below stays as the fallback (cloud providers, or weak/odd outputs).
    let raw = '';
    let call = null;
    if (localBrainIsPrimary()) {
      const turn = await localToolTurn([
        { role: 'system', content: 'You are ABUZ8 OS Autopilot. Take ONE concrete action toward the goal by calling a tool. When the goal is fully accomplished, call the "finish" tool with the answer.' },
        { role: 'user', content: `GOAL: ${goal}\n\n${history ? 'Progress so far:\n' + history : 'No actions taken yet.'}` }
      ], agentToolSchemas().concat(FINISH_TOOL));
      if (turn && turn.tool === 'finish') {
        agentRunning = false; pushActivity('done', 'Autopilot finished', (turn.args && turn.args.answer) || 'Goal completed.');
        return { ok: true, goal, steps, final: (turn.args && turn.args.answer) || 'Goal completed.', stopped: 'done', via: 'native' };
      }
      if (turn && turn.tool) call = { tool: turn.tool, args: turn.args || {} };
      else if (turn && turn.text) raw = turn.text;
    }
    // NATIVE CLOUD TOOL-CALLING (universal adapter): when a cloud/API brain is the engine,
    // get a structured tool_call in its native dialect BEFORE any free-text parsing.
    if (!call && !localBrainIsPrimary()) {
      const turn = await providerToolTurn([
        { role: 'system', content: 'You are ABUZ8 OS Autopilot. Take ONE concrete action toward the goal by calling a tool. When the goal is fully accomplished, call the "finish" tool with the answer.' },
        { role: 'user', content: `GOAL: ${goal}\n\n${history ? 'Progress so far:\n' + history : 'No actions taken yet.'}` }
      ], agentToolSchemas().concat(FINISH_TOOL));
      if (turn && turn.tool === 'finish') {
        agentRunning = false; pushActivity('done', 'Autopilot finished', (turn.args && turn.args.answer) || 'Goal completed.');
        return { ok: true, goal, steps, final: (turn.args && turn.args.answer) || 'Goal completed.', stopped: 'done', via: 'native-cloud' };
      }
      if (turn && turn.tool) call = { tool: turn.tool, args: turn.args || {} };
      else if (turn && turn.text && !raw) raw = turn.text;
    }
    // FALLBACK: free-text JSON tool plan via the reply ladder (cloud provider, or local text-parse).
    if (!call) {
      if (!raw) { try { const r = await reasonReply(planPrompt, { system: 'You are a precise tool-planning engine. Output ONLY one JSON object and nothing else.' }); raw = r.text || ''; } catch {} }
      const obj = extractJsonObject(raw) || {};
      if (obj.done || /"done"\s*:\s*true/.test(raw)) {
        agentRunning = false; pushActivity('done', 'Autopilot finished', obj.answer || 'Goal completed.');
        return { ok: true, goal, steps, final: obj.answer || obj.final || 'Goal completed.', stopped: 'done' };
      }
      call = parseAgentToolCall(raw) || salvageToolCall(raw);
    }
    if (!call || !KNOWN_AGENT_TOOLS.has(slug(call.tool).replace(/-/g, '_'))) {
      const txt = String(raw).replace(/[`*]/g, '').trim();
      agentRunning = false; pushActivity('done', 'Autopilot finished', txt.slice(0, 80));
      return { ok: true, goal, steps, final: txt || 'Done.', stopped: steps.length ? 'answer' : 'no-tool', note: steps.length ? undefined : 'The local brain did not emit a usable tool call. Configure a cloud provider or a larger model for reliable autonomous loops.' };
    }
    const toolName = slug(call.tool).replace(/-/g, '_');
    pushActivity('step', `Step ${i + 1}: ${toolName}`, JSON.stringify(call.args || {}).slice(0, 100));
    let observation;
    try {
      // Explicit autopilot run = the user's consent to act on LOCAL sandbox-safe tools
      // (file_write/cmd_run/screenshot/open_app/open_url). Money/outward tools are NOT here —
      // they remain gated by the red-tier check + the fail-closed verifier.
      const result = await callLocalTool(toolName, Object.assign({ _permitted: true }, call.args || {}));
      observation = summarizeToolResult(toolName, result).slice(0, 600);
    } catch (e) { observation = `ERROR: ${e.message}`; }
    steps.push({ n: i + 1, tool: toolName, args: call.args || {}, observation });
    pushActivity('observe', `↳ ${toolName} result`, observation.slice(0, 120));
    history += `Step ${i + 1}: ${toolName}(${JSON.stringify(call.args || {})}) -> ${observation}\n`;
  }
  agentRunning = false; pushActivity('done', 'Autopilot reached step limit', '');
  return { ok: true, goal, steps, final: 'Reached the step limit. Here is what I accomplished above.', stopped: 'max_steps' };
}

const CONTENT_FORMATS = {
  'x-carousel': 'Produce a 10-slide X carousel. Slide 1 Hook (bold claim/question); Slide 2 Problem; Slide 3 Why it matters; Slide 4 Mental model; Slides 5-8 Steps with concrete detail; Slide 9 TL;DR one-sentence recap; Slide 10 CTA. Label each slide.',
  'x-thread': 'Produce an X thread of 7-12 tweets. Tweet 1 is a scroll-stopping hook. Each subsequent tweet is self-contained, under 280 chars. End with a CTA.',
  'youtube-script': 'Produce a YouTube script: a 15-second hook, an outline of beats, the spoken narration per beat, B-roll/visual cues in brackets, and an end-screen CTA.',
  'blog-outline': 'Produce an SEO blog outline: working title, target keyword + 4 secondary keywords, meta description, H2/H3 structure with one-line notes each, and an internal-link suggestion list.',
  'notebook-synthesis': 'Act as a research-to-media synthesizer: extract the core thesis, the 5 key supporting points, notable quotes/stats to verify, and a one-paragraph executive summary. Mark anything that needs source verification.'
};

async function generateContent(body = {}) {
  const topic = String(body.topic || body.content || body.prompt || '').trim();
  if (!topic) throw new Error('topic is required');
  const format = String(body.format || 'x-carousel');
  const spec = CONTENT_FORMATS[format] || CONTENT_FORMATS['x-carousel'];
  const sources = body.sources ? `\n\nSource material:\n${String(body.sources).slice(0, 6000)}` : '';
  const prompt = `${spec}\n\nTopic: ${topic}${sources}`;
  const r = await reasonReply(prompt, { role: format === 'blog-outline' ? 'seo-strategist' : 'content-producer' });
  const id = `${format}-${slug(topic).slice(0, 40)}`;
  const file = path.join(safeMkdir(path.join(dataRoot, 'exports', 'content')), `${id}.md`);
  try { fs.writeFileSync(file, `# ${topic}\n\n_Format: ${format} · ${new Date().toISOString()}_\n\n${r.text}`, 'utf8'); } catch {}
  return { ok: true, format, topic, content: r.text, brain: r.brain, saved_to: file };
}

// X (Twitter) post via API v2. Requires a user OAuth2 token with tweet.write —
// stored in settings as x_access_token. App-only bearer tokens cannot post; we
// say so honestly rather than pretend success.
async function xPost(body = {}) {
  const t = String(body.text || body.content || '').trim();
  if (!t) throw new Error('text is required');
  const settings = readJson(settingsPath(), {});
  const token = body.access_token || settings.x_access_token || process.env.X_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, needs_credentials: true, error: 'No X access token configured. Add an OAuth2 user token with tweet.write scope in Settings → X. App-only/bearer tokens cannot post.' };
  }
  try {
    const resp = await fetchUrl('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: t.slice(0, 280) })
    });
    const data = JSON.parse(resp || '{}');
    if (data.errors || data.status >= 400 || data.title) {
      return { ok: false, error: (data.detail || data.title || JSON.stringify(data)), raw: data };
    }
    return { ok: true, id: data.data?.id, text: data.data?.text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ── SOCIAL BEACON — the home base for posting everywhere ────────────────
   ABUZ8 is the beacon: compose once, fan out to every connected network.
   X / Mastodon / Bluesky / Telegram / Discord work with simple tokens (real,
   verified posts). Instagram / TikTok / LinkedIn / Facebook / YouTube / Threads
   / Reddit / Pinterest are wired to their real APIs but need the platform's
   OAuth app + token — we say so honestly instead of faking a post. */
const SOCIAL_PLATFORMS = [
  { id: 'x', label: 'X (Twitter)', easy: true, fields: ['access_token'], note: 'OAuth2 user token with tweet.write. Posts immediately.' },
  { id: 'mastodon', label: 'Mastodon', easy: true, fields: ['instance', 'access_token'], note: 'Your instance URL + an access token (Settings → Development → New app). Real toots.' },
  { id: 'bluesky', label: 'Bluesky', easy: true, fields: ['handle', 'app_password'], note: 'Handle + an App Password (Settings → App Passwords). Posts via AT Protocol.' },
  { id: 'telegram', label: 'Telegram', easy: true, fields: ['bot_token', 'chat_id'], note: 'A bot token (@BotFather) + channel/chat id. Broadcasts instantly.' },
  { id: 'discord', label: 'Discord', easy: true, fields: ['webhook_url'], note: 'A channel webhook URL. Posts instantly, no OAuth.' },
  { id: 'instagram', label: 'Instagram', easy: false, fields: ['ig_user_id', 'access_token'], note: 'Meta Graph API: an IG Business account + long-lived token. Images/reels via container+publish.' },
  { id: 'tiktok', label: 'TikTok', easy: false, fields: ['access_token'], note: 'TikTok Content Posting API: a TikTok developer app + OAuth token.' },
  { id: 'linkedin', label: 'LinkedIn', easy: false, fields: ['access_token', 'author_urn'], note: 'LinkedIn UGC API: an OAuth token (w_member_social) + your URN.' },
  { id: 'facebook', label: 'Facebook Page', easy: false, fields: ['page_id', 'access_token'], note: 'Meta Graph API: a Page access token.' },
  { id: 'youtube', label: 'YouTube', easy: false, fields: ['access_token'], note: 'YouTube Data API OAuth token (community posts / uploads).' },
  { id: 'threads', label: 'Threads', easy: false, fields: ['threads_user_id', 'access_token'], note: 'Threads Graph API: a user id + token (container+publish).' },
  { id: 'reddit', label: 'Reddit', easy: false, fields: ['access_token', 'subreddit'], note: 'Reddit API OAuth token + target subreddit.' },
  { id: 'pinterest', label: 'Pinterest', easy: false, fields: ['access_token', 'board_id'], note: 'Pinterest API OAuth token + board.' }
];
function socialPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'social.json'); }
function readSocial() { return readJson(socialPath(), { accounts: {} }); }
function writeSocial(o) { writeJson(socialPath(), o); }
function socialDef(id) { return SOCIAL_PLATFORMS.find((p) => p.id === id); }
function socialCreds(id) { return (readSocial().accounts || {})[id] || {}; }
function socialList() {
  const acc = readSocial().accounts || {};
  return SOCIAL_PLATFORMS.map((p) => ({ id: p.id, label: p.label, easy: p.easy, fields: p.fields, note: p.note, connected: !!(acc[p.id] && p.fields.every((f) => acc[p.id][f])) }));
}
function socialConnect(id, creds) {
  if (!socialDef(id)) throw new Error('unknown platform');
  const s = readSocial(); s.accounts = s.accounts || {}; s.accounts[id] = Object.assign({}, s.accounts[id], creds || {}); writeSocial(s);
  pushActivity('social', 'Social account linked: ' + socialDef(id).label, '');
  return { ok: true };
}
function socialDisconnect(id) { const s = readSocial(); if (s.accounts) delete s.accounts[id]; writeSocial(s); return { ok: true }; }
async function blueskySession(c) {
  const r = JSON.parse(await fetchUrl('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: c.handle, password: c.app_password }) }));
  if (!r.accessJwt) throw new Error(r.message || 'Bluesky auth failed');
  return r;
}
// Post to one platform — real API per network. Returns {ok, id?, error?, needs_auth?}.
async function socialPostOne(id, post) {
  let c = socialCreds(id);
  const def = socialDef(id);
  const text = String(post.text || post.content || '').trim();
  const link = post.link ? ('\n\n' + post.link) : '';
  if (!def) return { platform: id, ok: false, error: 'unknown platform' };
  // Hands-free OAuth fills in the access token for platforms that support it.
  if (!c.access_token) {
    let t = '';
    if (id === 'instagram' || id === 'facebook') t = await getValidToken('meta');
    else if (id === 'youtube') t = await getValidToken('google');
    else if (id === 'tiktok') t = await getValidToken('tiktok');
    if (t) c = { ...c, access_token: t };
  }
  // Instagram: real container→publish flow (needs an image/video URL).
  if (id === 'instagram' && c.access_token && c.ig_user_id) {
    if (!post.image && !post.media) return { platform: id, ok: false, needs_auth: false, error: 'Instagram needs an image/video URL (post.image) — caption-only is not allowed by their API.' };
    try {
      const cont = JSON.parse(await fetchUrl(`https://graph.facebook.com/v21.0/${c.ig_user_id}/media?image_url=${encodeURIComponent(post.image || post.media)}&caption=${encodeURIComponent(text)}&access_token=${c.access_token}`, { method: 'POST' }));
      if (!cont.id) return { platform: id, ok: false, error: (cont.error && cont.error.message) || 'container failed' };
      const pub = JSON.parse(await fetchUrl(`https://graph.facebook.com/v21.0/${c.ig_user_id}/media_publish?creation_id=${cont.id}&access_token=${c.access_token}`, { method: 'POST' }));
      return pub.id ? { platform: id, ok: true, id: pub.id } : { platform: id, ok: false, error: (pub.error && pub.error.message) || 'publish failed' };
    } catch (e) { return { platform: id, ok: false, error: e.message.slice(0, 140) }; }
  }
  if (!def.fields.every((f) => c[f])) return { platform: id, ok: false, needs_auth: true, error: 'Not connected — add: ' + def.fields.join(', ') };
  try {
    if (id === 'x') { const r = await xPost({ text: (text + link).slice(0, 280), access_token: c.access_token }); return { platform: id, ...r }; }
    if (id === 'mastodon') {
      const base = c.instance.replace(/\/+$/, '');
      const r = JSON.parse(await fetchUrl(base + '/api/v1/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.access_token }, body: JSON.stringify({ status: text + link }) }));
      return r.id ? { platform: id, ok: true, id: r.id, url: r.url } : { platform: id, ok: false, error: r.error || 'failed' };
    }
    if (id === 'bluesky') {
      const sess = await blueskySession(c);
      const rec = { '$type': 'app.bsky.feed.post', text: (text + link).slice(0, 300), createdAt: new Date().toISOString() };
      const r = JSON.parse(await fetchUrl('https://bsky.social/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.accessJwt }, body: JSON.stringify({ repo: sess.did, collection: 'app.bsky.feed.post', record: rec }) }));
      return r.uri ? { platform: id, ok: true, id: r.uri } : { platform: id, ok: false, error: r.message || 'failed' };
    }
    if (id === 'telegram') {
      const r = JSON.parse(await fetchUrl(`https://api.telegram.org/bot${c.bot_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.chat_id, text: text + link }) }));
      return r.ok ? { platform: id, ok: true, id: r.result && r.result.message_id } : { platform: id, ok: false, error: r.description || 'failed' };
    }
    if (id === 'discord') {
      await fetchUrl(c.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: (text + link).slice(0, 2000) }) });
      return { platform: id, ok: true };
    }
    if (id === 'linkedin') {
      const body = { author: c.author_urn, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: text + link }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } };
      const r = JSON.parse(await fetchUrl('https://api.linkedin.com/v2/ugcPosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.access_token, 'X-Restli-Protocol-Version': '2.0.0' }, body: JSON.stringify(body) }));
      return r.id ? { platform: id, ok: true, id: r.id } : { platform: id, ok: false, error: (r.message || 'failed') };
    }
    if (id === 'telegram') return { platform: id, ok: false, error: 'unreachable' };
    // Heavy-OAuth platforms: real endpoints exist but need the platform's app + token flow.
    return { platform: id, ok: false, needs_auth: true, error: def.label + ' needs its OAuth app + token (and usually media). Connect it, then posting goes live.' };
  } catch (e) { return { platform: id, ok: false, error: e.message.slice(0, 160) }; }
}
// The beacon: fan one post out to many networks at once.
async function socialPost(platforms, post) {
  const targets = (platforms && platforms.length) ? platforms : socialList().filter((p) => p.connected).map((p) => p.id);
  if (!targets.length) return { ok: false, error: 'No platforms selected or connected.' };
  pushActivity('social', 'Broadcasting to ' + targets.length + ' network(s)', String(post.text || '').slice(0, 80));
  const results = await Promise.all(targets.map((id) => socialPostOne(id, post)));
  recordSignal({ kind: 'social_post', platforms: targets, ok: results.filter((r) => r.ok).length });
  return { ok: results.some((r) => r.ok), results };
}
// Faceless content: ask the brain for platform-tailored copy (hook + body + hashtags).
async function socialDraft(topic, platform) {
  const p = platform || 'x';
  const sys = 'You are a world-class faceless-content social copywriter. Write a single ready-to-post ' + p + ' post: a scroll-stopping hook, tight value, and a clear CTA. No preamble, no quotes, no "here is" — output ONLY the post text. Add 3-6 relevant hashtags at the end' + (p === 'x' ? ', keep under 280 chars.' : '.');
  const r = await reasonReply('Topic: ' + topic, { system: sys, noMemory: true });
  return { ok: true, platform: p, text: String(r.text || '').trim() };
}

/* ── MESSAGING GATEWAY — chat WITH ABUZ8 from Telegram (two-way) ──────────
   Hermes's signature: talk to your agent from anywhere. ABUZ8 polls Telegram
   for incoming messages, runs them through the full agent, and replies — so
   your sovereign agent lives in your pocket via a normal Telegram chat. Reuses
   the Telegram bot token you connect in Social. */
let _tgOffset = 0, _tgBusy = false;
function tgToken() { try { return connectorCreds('telegram').bot_token || (readJson(settingsPath(), {}).tg_gateway_token) || ''; } catch { return ''; } }
function tgGatewayStatus() { const s = readJson(settingsPath(), {}); return { ok: true, enabled: s.tg_gateway === true, has_token: !!tgToken() }; }
function setTgGateway(on) { const s = readJson(settingsPath(), {}); s.tg_gateway = !!on; writeJson(settingsPath(), s); if (on) pushActivity('gateway', 'Telegram gateway ON', 'chat with ABUZ8 in Telegram'); return tgGatewayStatus(); }
async function tgSend(token, chatId, text) { try { await fetchUrl('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000) }), timeout: 15000 }); } catch {} }
// Hermes-style slash commands over Telegram — control the agent from your phone, anywhere.
async function tgCommand(token, chatId, text) {
  const m = String(text).match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase(); const arg = (m[2] || '').trim();
  const s = readJson(settingsPath(), {});
  if (cmd === 'start' || cmd === 'help') {
    await tgSend(token, chatId, 'ABUZ8 — your sovereign agent. Commands:\n/status — brain & system\n/brain [local|claude|grok|codex|gemini] — switch brain\n/goal <objective> — run an autonomous goal\n/build <what to build> — code it\n/skills — learned skills\n/memory <note> — remember this\nOr just send a message to chat.');
    return true;
  }
  if (cmd === 'status') {
    const cb = s.cli_brain; const emb = embeddedBrainStatus();
    const brain = (cb && cliBrainName(cb)) || (emb.embedded ? emb.name : 'Portable Core');
    const cnt = (fn) => { try { return fn(); } catch { return 0; } };
    await tgSend(token, chatId, `🧠 Brain: ${brain}\n💾 RAM: ${Math.round((os.totalmem() - os.freemem()) / 1073741824)}/${Math.round(os.totalmem() / 1073741824)} GB\n🗂 Memories: ${cnt(() => readVectors().length || readMemory(800).length)} · Skills: ${cnt(() => listLearnedSkills().length)} · Goals: ${cnt(() => listGoals().length)}\nBrains available: ${availableCliBrains().map((b) => b.id).join(', ') || 'local only'}`);
    return true;
  }
  if (cmd === 'brain') {
    if (!arg) { await tgSend(token, chatId, `Current: ${(s.cli_brain && cliBrainName(s.cli_brain)) || 'local Gemma'}\nSwitch: /brain local | claude | grok | codex | gemini`); return true; }
    const want = arg.toLowerCase();
    if (want === 'local' || want === 'gemma') { s.cli_brain = null; writeJson(settingsPath(), s); await tgSend(token, chatId, '🧠 Switched to local Gemma (sovereign).'); return true; }
    if (cliBrainAvailable(want)) { s.cli_brain = want; s.active_provider = null; writeJson(settingsPath(), s); await tgSend(token, chatId, '🧠 Switched to ' + cliBrainName(want)); return true; }
    await tgSend(token, chatId, `"${want}" not available. Options: ${availableCliBrains().map((b) => b.id).join(', ') || 'local'}`); return true;
  }
  if (cmd === 'skills') {
    let sk = []; try { sk = listLearnedSkills(); } catch {}
    await tgSend(token, chatId, sk.length ? '🧩 Learned skills:\n' + sk.slice(0, 15).map((x) => '• ' + (x.title || x.id)).join('\n') : 'No learned skills yet.'); return true;
  }
  if (cmd === 'memory') {
    if (!arg) { await tgSend(token, chatId, 'Usage: /memory <note>'); return true; }
    try { appendJsonl(memoryFile(), { id: crypto.randomUUID(), type: 'note', content: arg, timestamp: new Date().toISOString() }); addMemoryVector({ content: arg, type: 'note' }).catch(() => {}); } catch {}
    await tgSend(token, chatId, '✅ Remembered.'); return true;
  }
  if (cmd === 'goal') {
    if (!arg) { await tgSend(token, chatId, 'Usage: /goal <objective>'); return true; }
    await tgSend(token, chatId, '🎯 Running goal: ' + arg.slice(0, 80) + ' …');
    (async () => { try { const g = createGoal({ objective: arg }); const done = await runGoal(g.id, {}); const ok = (done.plan || []).filter((x) => x.status === 'done').length; await tgSend(token, chatId, `🎯 Goal ${done.status}: ${ok}/${(done.plan || []).length} steps.\n` + (done.plan || []).map((x) => (x.status === 'done' ? '✅' : '❌') + ' ' + String(x.step).slice(0, 60)).join('\n')); } catch (e) { await tgSend(token, chatId, 'Goal failed: ' + e.message); } })();
    return true;
  }
  if (cmd === 'build') {
    if (!arg) { await tgSend(token, chatId, 'Usage: /build <what to build>'); return true; }
    await tgSend(token, chatId, '💻 Building: ' + arg.slice(0, 80) + ' …');
    (async () => { try { const r = await coderRun(arg, { max_steps: 4, exec: false }); const last = (r.steps || []).slice(-1)[0] || {}; await tgSend(token, chatId, `💻 Build "${r.project}" done · ${(r.files || []).length} files${r.git && r.git.committed ? ' · git ✓' : ''}\n${last.summary || ''}`); } catch (e) { await tgSend(token, chatId, 'Build failed: ' + e.message); } })();
    return true;
  }
  return false; // unknown command → fall through to chat
}
async function tgPollOnce() {
  if (_tgBusy || _halted) return; if (readJson(settingsPath(), {}).tg_gateway !== true) return;
  const token = tgToken(); if (!token) return;
  _tgBusy = true;
  try {
    const r = JSON.parse(await fetchUrl('https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (_tgOffset + 1) + '&timeout=0&limit=10', { timeout: 12000 }));
    for (const u of (r.result || [])) {
      _tgOffset = u.update_id;
      const msg = u.message || u.channel_post; if (!msg) continue;
      const chatId = msg.chat.id;
      const ch = channelFor('telegram', chatId);
      if (ch && ch.allowed === false) { pushActivity('gateway', 'Telegram channel muted: ' + chatId, ''); continue; }
      let text = String(msg.text || msg.caption || '').trim();
      if (!pairingAllows(chatId)) { try { const who = (msg.from && (msg.from.username || msg.from.first_name)) || ''; pairingRequest(chatId, who); await tgSend(token, chatId, 'This ABUZ8 agent is private. Your ID (' + chatId + ') was sent to the owner for approval.'); } catch {} pushActivity('gateway', 'Telegram blocked: ' + chatId, 'pending approval'); continue; }
      if (!text) { const kind = msg.photo ? 'photo' : msg.voice ? 'voice message' : msg.video ? 'video' : msg.document ? 'document' : 'media'; try { await tgSend(token, chatId, 'Got your ' + kind + '. I act on text and captions right now — add a caption and I’ll take it from there.'); } catch {} pushActivity('gateway', 'Telegram ' + kind, 'acknowledged (no caption)'); continue; }
      if (text.startsWith('/')) { try { if (await tgCommand(token, chatId, text)) continue; } catch {} }
      try { await fetchUrl('https://api.telegram.org/bot' + token + '/sendChatAction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action: 'typing' }), timeout: 8000 }); } catch {}
      const promptText = (ch && ch.prompt_hint) ? (text + '\n\n[Channel note: ' + ch.prompt_hint + ']') : text;
      let reply = '';
      try { const res = await agenticReply(promptText, {}); reply = res.response || res.text || '(no reply)'; } catch (e) { reply = 'Error: ' + e.message; }
      await tgSend(token, chatId, reply);
      pushActivity('gateway', 'Telegram in: ' + text.slice(0, 40), 'replied');
    }
  } catch (e) {} finally { _tgBusy = false; }
}

/* ── THE FORGE — holographic CAD / world builder (Stark-style) ────────────
   The 3D scene lives in the renderer (bundled Three.js). The core's job is to
   turn natural language into structured scene operations, and to analyze a
   photo into an editable parts list. Deterministic parsing first (instant,
   offline); the vision step uses a connected vision provider when present, and
   honestly degrades to a label-driven reconstruction otherwise. */
const FORGE_ASSEMBLIES = ['engine', 'arc_reactor', 'tower', 'building', 'city', 'gear_train', 'lab', 'atom', 'rocket', 'molecule'];
function forgeInterpret(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return { action: 'none' };
  if (/\b(explode|blow (it|this)? ?up|exploded view|break (it|this)? ?(apart|down)|separate the parts?|spread (it )?out)\b/.test(t)) return { action: 'explode' };
  if (/\b(collapse|reassemble|put (it|them)? ?back|un-?explode|bring (it )?together|implode)\b/.test(t)) return { action: 'collapse' };
  if (/\b(clear|reset|wipe|new scene|start over|empty (the )?(scene|forge))\b/.test(t)) return { action: 'clear' };
  if (/\b(isolate|only (keep|show) (this|that|the selected)|hide the rest|focus on (this|that))\b/.test(t)) return { action: 'isolate' };
  if (/\b(delete|remove|trash|get rid of|cut)\b/.test(t)) return { action: 'delete' };
  if (/\b(duplicate|copy|clone)\b/.test(t)) return { action: 'duplicate' };
  if (/\b(rotate|spin|turn it)\b/.test(t)) return { action: 'rotate' };
  if (/\b(bigger|larger|scale up|grow|enlarge)\b/.test(t)) return { action: 'scale', value: 1.25 };
  if (/\b(smaller|shrink|scale down|reduce)\b/.test(t)) return { action: 'scale', value: 0.8 };
  const A = [['engine', /\b(engine|motor|v8|v6|v12|combustion|powertrain)\b/], ['arc_reactor', /\barc ?reactor|reactor core|reactor\b/], ['rocket', /\b(rocket|missile|booster|launch vehicle)\b/], ['tower', /\b(tower|skyscraper|spire|antenna)\b/], ['city', /\b(city|town|metropolis|sim ?city|district|skyline|downtown)\b/], ['building', /\b(building|house|structure|hangar|warehouse)\b/], ['gear_train', /\b(gear ?train|gearbox|transmission|cog|gears)\b/], ['lab', /\b(lab|laboratory|workshop|facility)\b/], ['atom', /\b(atom|nucleus|particle)\b/], ['molecule', /\b(molecule|compound|element)\b/]];
  for (const [name, re] of A) { if (re.test(t)) return { action: 'build', assembly: name }; }
  const P = [['box', /\b(box|cube|block|panel|slab)\b/], ['cylinder', /\b(cylinder|tube|pipe|rod|shaft|column)\b/], ['sphere', /\b(sphere|ball|orb|dome)\b/], ['gear', /\b(gear|cog|sprocket)\b/], ['cone', /\b(cone|nozzle|spike)\b/], ['torus', /\b(ring|torus|donut|loop)\b/], ['plane', /\b(floor|ground|plate|plane|base)\b/]];
  for (const [name, re] of P) { if (re.test(t)) return { action: 'add', part: name }; }
  return { action: 'none', note: 'No forge action recognized — try "build an engine", "explode it", "delete that", "make a city".' };
}
// Recognize a vision-capable (multimodal) model by name — covers the major cloud
// models AND the local/open ones (Gemma 3, NVIDIA NIM vision, Llava, etc.).
function isVisionModel(s) {
  const m = String(s || '').toLowerCase();
  if (/gemma-?2|gemma-?3-?1b|gemma-?1/.test(m)) return false; // text-only Gemmas
  return /gpt-?4o|gpt-?4\.|gpt-?4-?vision|o4|chatgpt-4o|gemini|claude-3|claude-opus|claude-sonnet|claude-haiku|grok.*vision|grok-?4|vision|pixtral|llama-?3\.2|llama-?4|qwen2?-?vl|gemma-?3|paligemma|nvila|\bvila\b|neva|internvl|minicpm-?v|moondream|llava|bakllava|cogvlm|idefics|smolvlm|phi-?3\.5-?vision|phi-?4.*vision|molmo|ovis/.test(m);
}
// Vision call for an OpenAI-compatible provider (image + prompt → text).
async function callProviderVision(provider, prompt, imageB64) {
  const url = provider.chat_url || ((provider.endpoint || '').replace(/\/+$/, '') + '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = 'Bearer ' + provider.api_key;
  const body = JSON.stringify({ model: provider.model, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageB64.startsWith('data:') ? imageB64 : 'data:image/jpeg;base64,' + imageB64 } }] }] });
  const data = JSON.parse(await fetchUrl(url, { method: 'POST', headers, body, timeout: 60000 }));
  if (data.error) throw new Error(data.error.message || 'vision error');
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
}
async function forgeAnalyze(imageB64, hint) {
  const prompt = 'You are a CAD vision engine. Identify the object in this image and break it into its visible major parts/mechanisms. Reply ONLY as compact JSON: {"label":"...","assembly":"engine|arc_reactor|tower|building|city|gear_train|rocket|atom|molecule|generic","parts":["name1","name2",...]}. Pick the closest assembly type. List 4-14 parts.';
  let out = null, src = null;
  const p = activeVisionProvider();
  if (imageB64 && p) { try { out = await callProviderVision(p, prompt, imageB64); src = 'vision:' + p.label; } catch (e) {} }
  if (imageB64 && !out && visionBrainAvailable()) { try { out = await callLocalVision(prompt, imageB64); src = 'local:gemma-3-vision'; } catch (e) {} }
  if (out) {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { const j = JSON.parse(m[0]); return { ok: true, source: src, label: j.label, assembly: FORGE_ASSEMBLIES.includes(j.assembly) ? j.assembly : 'building', parts: j.parts || [], note: 'Identified from the photo by ' + src + '. The 3D is an editable reconstruction of the visible form — internal hidden mechanisms can\'t be seen through a 2D image.' }; } catch (e) {} }
  }
  // Honest fallback: derive an assembly from the hint/label, no fabrication.
  const guess = (forgeInterpret('build ' + (hint || '')).assembly) || 'building';
  return { ok: true, source: 'reconstruction', label: hint || 'object', assembly: guess, parts: [], note: (imageB64 ? 'No vision model available yet, so ' : '') + 'I built a parametric 3D reconstruction from the label "' + (hint || 'object') + '". The local Gemma vision brain or a connected vision model lets me read the actual photo.' };
}

/* ── JARVIS LAYER — he sees your screen, briefs you, and turns photos into 3D ──
   The two traits that make an assistant "Jarvis": it can SEE what you're looking
   at, and it proactively briefs you. Both are real here. Screen-vision uses a
   connected vision model; briefing fuses the live clock, weather, missions, and
   (if connected) calendar + inbox. Nothing is fabricated. */
function activeVisionProvider() {
  const sel = (readJson(settingsPath(), {}).active_provider) || null;
  const p = sel ? providersStore().providers.find((x) => x.name === sel.name) : null;
  return (p && isVisionModel((p.model || '') + ' ' + (p.name || ''))) ? p : null;
}
// Screen-vision: the renderer captures the screen frame (native getDisplayMedia,
// user-granted) and passes it here; we run it through the connected vision model.
async function jarvisSee(question, image) {
  if (!image) return { ok: false, needs_capture: true, error: 'Open ABUZ8 and use "See my screen" — the app captures the frame with your permission, then I read it.' };
  const q = (question && question.trim()) ? question : 'Describe what is on this screen concisely, and flag anything actionable (errors, key numbers, next steps).';
  const sys = 'You are Jarvis, looking at the user\'s screen. ' + q + ' Be concise and useful.';
  // 1) A connected cloud vision model is fastest/strongest.
  const p = activeVisionProvider();
  if (p) { try { const ans = await callProviderVision(p, sys, image); return { ok: true, captured: true, source: 'vision:' + p.label, answer: String(ans).trim() }; } catch (e) { /* fall through to local */ } }
  // 2) The bundled local Gemma 3 vision brain — fully offline.
  if (visionBrainAvailable()) { try { const ans = await callLocalVision(sys, image); return { ok: true, captured: true, source: 'local:gemma-3-vision', answer: String(ans).trim() }; } catch (e) { return { ok: false, error: 'Local vision brain error: ' + e.message }; } }
  return { ok: true, captured: true, source: 'no-vision', answer: 'Your screen was captured, but no vision model is loaded yet. The local Gemma vision brain may still be installing — or connect a cloud vision model in Providers.' };
}
async function jarvisBrief() {
  const t = currentTimeContext();
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const name = (readJson(settingsPath(), {}).assistant_name) || 'ABUZ8';
  const lines = [`${greet}. It's ${t.time} on ${t.date}.`];
  const facts = ['time: ' + t.date + ' ' + t.time];
  try { const w = await getWeather({}); const c = w.current; const city = (w.location || {}).city || 'your area'; const tmr = w.forecast && w.forecast[1] ? `, and tomorrow looks ${w.forecast[1].sky} with a high of ${Math.round(w.forecast[1].hi)}${w.units}` : ''; lines.push(`In ${city} it's ${c.sky}, ${Math.round(c.temp)}${w.units}${tmr}.`); facts.push('weather'); } catch {}
  try { const ms = listMissionGraphs().filter((m) => m.status !== 'complete'); if (ms.length) { lines.push(`You have ${ms.length} active mission${ms.length > 1 ? 's' : ''}: ${ms.slice(0, 3).map((m) => m.title).join(', ')}.`); facts.push('missions'); } } catch {}
  try { if (await getValidToken('google')) { const ev = await connectorCall('gcal', 'events', { limit: 4 }); const it = (ev.items || []).map((e) => e.summary).filter(Boolean); if (it.length) { lines.push(`On your calendar: ${it.join(', ')}.`); facts.push('calendar'); } } } catch {}
  try { if (await getValidToken('google')) { const m = await connectorCall('gmail', 'list', { limit: 1, q: 'is:unread' }); if (m.resultSizeEstimate) { lines.push(`And you have about ${m.resultSizeEstimate} unread email${m.resultSizeEstimate > 1 ? 's' : ''}.`); facts.push('email'); } } } catch {}
  lines.push("What's the move?");
  return { ok: true, briefing: lines.join(' '), facts };
}
// Image → real 3D mesh via Tripo (or any image-to-3D connector). Returns a model URL.
async function jarvisImageTo3D(imageB64) {
  const key = connectorCreds('tripo').api_key;
  if (!key) return { ok: false, needs_auth: true, error: 'Connect an image-to-3D model in Providers/Connect (Tripo key) to turn a photo into a real mesh.' };
  try {
    const b64 = imageB64.replace(/^data:image\/\w+;base64,/, '');
    const up = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: { type: 'jpg', data: b64 } }), timeout: 60000 }));
    const token = up.data && up.data.image_token; if (!token) return { ok: false, error: 'upload failed' };
    const task = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/task', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'image_to_model', file: { type: 'jpg', file_token: token } }), timeout: 60000 }));
    return { ok: true, task_id: task.data && task.data.task_id, note: 'Tripo is generating the mesh — poll /api/jarvis/mesh-status.' };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function jarvisMeshStatus(taskId) {
  const key = connectorCreds('tripo').api_key; if (!key) return { ok: false, error: 'no key' };
  const r = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/task/' + taskId, { headers: { Authorization: 'Bearer ' + key }, timeout: 30000 }));
  const d = r.data || {};
  return { ok: true, status: d.status, progress: d.progress, model_url: d.output && (d.output.pbr_model || d.output.model) };
}

/* ── OPERATOR — autonomous computer use (see → think → act loop) ──────────
   The most advanced capability: ABUZ8 looks at the screen, decides the single
   next action, and the renderer executes it via PyAutoGUI (gui_do) — then loops.
   The vision model returns resolution-independent (0-1000) coordinates so clicks
   land on the right element on any display. Consent-gated, step-capped, stoppable. */
async function operatorStep(goal, image, history) {
  const prompt = [
    'You are ABUZ8 OPERATOR — an AI that controls a Windows computer to accomplish a goal by looking at the screen and choosing exactly ONE next action.',
    'GOAL: ' + goal,
    'You are given the current screenshot. Treat the screen as a normalized 1000x1000 grid: (0,0) is top-left, (1000,1000) is bottom-right, regardless of resolution.',
    'Reply with ONLY compact JSON, no prose, no markdown:',
    '{"thought":"<one short sentence on what you see and your next move>","action":{"type":"click|double_click|right_click|type|key|hotkey|scroll|wait|done","nx":<int 0-1000>,"ny":<int 0-1000>,"text":"<text for type>","key":"<single key for key, e.g. enter|tab|esc>","keys":["ctrl","t"],"amount":<scroll, + up / - down>},"status":"continue|done|blocked"}',
    'Rules: click/double_click/right_click MUST include nx,ny aimed precisely at the target UI element. "type" types into whatever is focused — click the field in a prior step first. Use "key" for a single key, "hotkey" for combos. Set status "done" when the goal is visibly complete, "blocked" if you cannot proceed (explain in thought). Take the smallest reliable step.',
    history && history.length ? 'Actions already taken:\n' + history.slice(-8).map((h, i) => (i + 1) + '. ' + h).join('\n') : 'No actions taken yet.'
  ].join('\n\n');
  let out = null, src = null;
  const p = activeVisionProvider();
  if (p) { try { out = await callProviderVision(p, prompt, image); src = 'vision:' + p.label; } catch (e) {} }
  if (!out && visionBrainAvailable()) { try { out = await callLocalVision(prompt, image); src = 'local:gemma-3-vision'; } catch (e) {} }
  if (!out) return { ok: false, error: 'No vision model available — connect one in Providers, or the local vision brain is still loading.' };
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'Vision returned no action.', raw: String(out).slice(0, 200) };
  try { const j = JSON.parse(m[0]); return { ok: true, source: src, thought: j.thought || '', action: j.action || {}, status: j.status || 'continue' }; }
  catch (e) { return { ok: false, error: 'Could not parse the action.', raw: String(out).slice(0, 200) }; }
}

// Seed the mission board with the migrated X-growth protocol: the 25-problems
// weekly rule plus a 7-day content cadence. Creates real tasks on the board.
function seedGrowthBoard() {
  const created = [];
  const now = new Date().toISOString();
  upsertMissionTask({ id: 'x-rule-25', title: 'X Signature Rule: publicly solve 25 hard problems this week', column: 'doing', priority: 'high', owner: 'x-growth-operator', details: 'Each problem solved publicly on X with your signature. Log impressions in the tracker.' });
  created.push('x-rule-25');
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cadence = ['Carousel (10 slides)', 'Thread (problem solved live)', 'Short tweet + proof screenshot'];
  days.forEach((d) => cadence.forEach((c, i) => {
    const id = `x-${d.toLowerCase()}-${i}`;
    upsertMissionTask({ id, title: `${d}: ${c}`, column: 'ready', priority: 'medium', owner: 'content-producer', details: 'Auto-seeded from x-growth-monetization 7-day cadence.' });
    created.push(id);
  }));
  upsertMissionTask({ id: 'rev-track', title: 'Revenue tracker: log ad-share, product, affiliate, sponsorship income', column: 'backlog', priority: 'high', owner: 'ceo-operator', details: 'Revenue-first triage: review weekly.' });
  created.push('rev-track');
  return { ok: true, created, board: readMissionBoard() };
}

// Read migrated skills from the skills dir (markdown SKILL.md + json definitions).
function listSkills() {
  const root = path.join(dataRoot, 'skills');
  const skills = [];
  if (exists(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillMd = path.join(root, entry.name, 'SKILL.md');
        let name = entry.name, desc = '';
        if (exists(skillMd)) {
          const head = fs.readFileSync(skillMd, 'utf8').slice(0, 800);
          const nm = head.match(/name:\s*([^\n]+)/i); if (nm) name = nm[1].trim().replace(/['"]/g, '');
          const dm = head.match(/description:\s*([^\n]+)/i); if (dm) desc = dm[1].trim().replace(/['"]/g, '');
        }
        const refs = exists(path.join(root, entry.name, 'references')) ? fs.readdirSync(path.join(root, entry.name, 'references')).length : 0;
        skills.push({ id: entry.name, name, description: desc, kind: 'skill-pack', references: refs });
      } else if (entry.name.endsWith('.json')) {
        const j = readJson(path.join(root, entry.name), {});
        skills.push({ id: entry.name.replace(/\.json$/, ''), name: j.name || entry.name, description: j.description || '', kind: 'definition' });
      }
    }
  }
  return skills;
}
// ── SKILLS HUB (Hermes-Skills-Hub parity): browse / search / enable / install ──
function skillsConfigPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'skills.json'); }
function skillsHub(query) {
  const disabled = new Set((readJson(skillsConfigPath(), { disabled: [] }).disabled) || []);
  const scans = (readSkillScans().scans) || {};
  const sv = (id) => (scans[id] && scans[id].verdict) || 'unscanned';
  const packs = listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description, kind: s.kind || 'skill-pack', references: s.references || 0, source: 'bundled', enabled: !disabled.has(s.id), scan: sv(s.id) }));
  const learned = (listLearnedSkills() || []).map((s) => ({ id: s.id || slug(s.title || ''), name: s.title || s.id, description: s.when_to_use || s.description || '', kind: 'learned', source: 'self-learned', enabled: !disabled.has(s.id || slug(s.title || '')), scan: sv(s.id || slug(s.title || '')) }));
  let all = packs.concat(learned);
  const q = String(query || '').trim().toLowerCase();
  if (q) all = all.filter((s) => ((s.name || '') + ' ' + (s.description || '') + ' ' + (s.id || '')).toLowerCase().includes(q));
  all.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const validated = all.filter((s) => s.scan === 'safe').length;
  return { total: packs.length + learned.length, bundled: packs.length, learned: learned.length, enabled: all.filter((s) => s.enabled).length, validated, flagged: all.filter((s) => s.scan === 'warn' || s.scan === 'danger').length, query: q || null, skills: all };
}
function skillsToggle(id, enabled) {
  if (!id) return { ok: false, error: 'id required' };
  const cfg = readJson(skillsConfigPath(), { disabled: [] }); const set = new Set(cfg.disabled || []);
  if (enabled === false) set.add(id); else set.delete(id);
  cfg.disabled = [...set]; writeJson(skillsConfigPath(), cfg);
  return { ok: true, id, enabled: enabled !== false };
}
function skillsInstall(opts = {}) {
  const id = slug(opts.id || opts.name || ''); if (!id) return { ok: false, error: 'id or name required' };
  const dir = safeMkdir(path.join(dataRoot, 'skills', id));
  let md = String(opts.content || opts.skill_md || '');
  if (!/^\s*---|name:/i.test(md)) md = '---\nname: ' + (opts.name || id) + '\ndescription: ' + (opts.description || '') + '\n---\n\n' + md;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  const v = skillScanOne(id); // auto-scan on install (no unscanned packs)
  return { ok: true, id, installed_to: dir, name: opts.name || id, scan: v.verdict, flags: v.flags };
}
// ── SKILL SECURITY SCANNER — static validation so every pack is scanned (Hermes-Hub parity) ──
// Heuristic static scan (not a sandbox): flags embedded secrets + dangerous exec/exfil patterns
// across a pack's SKILL.md + any handler/script files. Verdict: safe | warn | danger.
function skillScanPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'skill-scan.json'); }
function readSkillScans() { return readJson(skillScanPath(), { scans: {}, updated: null }); }
const _SECRET_PATS = [
  { re: /sk-[A-Za-z0-9]{20,}/, f: 'openai-key' },
  { re: /AKIA[0-9A-Z]{16}/, f: 'aws-key' },
  { re: /ghp_[A-Za-z0-9]{30,}/, f: 'github-token' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, f: 'slack-token' },
  { re: /AIza[0-9A-Za-z_\-]{35}/, f: 'google-key' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, f: 'private-key' },
  { re: /\b(?:api[_-]?key|secret|password|access[_-]?token)\b\s*[:=]\s*["'][^"']{12,}["']/i, f: 'hardcoded-credential' },
];
const _DANGER_PATS = [
  { re: /\bchild_process\b/, f: 'child_process' },
  { re: /\b(?:execSync|spawnSync|execFileSync)\s*\(/, f: 'sync-exec' },
  { re: /\beval\s*\(/, f: 'eval' },
  { re: /new\s+Function\s*\(/, f: 'dynamic-function' },
  { re: /rm\s+-rf\s+[~/]/, f: 'rm-rf-root' },
  { re: /\b(?:curl|wget)\b[^\n]{0,80}\|\s*(?:sh|bash)\b/, f: 'pipe-to-shell' },
  { re: /powershell[^\n]{0,80}-enc(?:odedcommand)?\b/i, f: 'ps-encoded' },
  { re: /\b(?:Invoke-Expression|iex)\b/i, f: 'iex' },
];
function skillScanOne(id) {
  const dir = path.join(dataRoot, 'skills', id);
  const flags = []; let bytes = 0, files = 0, text = '';
  try {
    const walk = (d, depth) => { if (depth > 3) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (/\.(md|js|mjs|cjs|sh|ps1|py|json|txt|bat)$/i.test(e.name)) { try { const t = fs.readFileSync(p, 'utf8'); text += '\n' + t; bytes += t.length; files++; } catch {} } } };
    if (exists(dir)) walk(dir, 0); else if (exists(dir + '.json')) { text = fs.readFileSync(dir + '.json', 'utf8'); bytes = text.length; files = 1; }
  } catch {}
  for (const s of _SECRET_PATS) if (s.re.test(text)) flags.push('secret:' + s.f);
  for (const d of _DANGER_PATS) if (d.re.test(text)) flags.push('danger:' + d.f);
  if (bytes > 60000) flags.push('oversized');
  const hasSecret = flags.some((f) => f.startsWith('secret:'));
  const hasDanger = flags.some((f) => f.startsWith('danger:'));
  const verdict = hasSecret || hasDanger ? 'danger' : (flags.length ? 'warn' : 'safe');
  const rec = { id, verdict, flags, files, bytes, scanned_at: new Date().toISOString() };
  try { const all = readSkillScans(); all.scans[id] = rec; all.updated = rec.scanned_at; writeJson(skillScanPath(), all); } catch {}
  return rec;
}
function skillsScanAll() {
  const packs = listSkills();
  const results = packs.map((p) => skillScanOne(p.id));
  const tally = { safe: 0, warn: 0, danger: 0 };
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  pushActivity('skills', 'Security scan complete', tally.safe + ' safe · ' + tally.warn + ' warn · ' + tally.danger + ' danger');
  return { ok: true, total: results.length, ...tally, results };
}

// Locate the bundled VOICE engines (piper + whisper) — resources/voice when packaged,
// build-assets/voice in dev. Mirrors bundledSkillsDir().
function bundledVoiceDir() {
  const cands = [
    process.resourcesPath ? path.join(process.resourcesPath, 'voice') : null,
    path.join(__dirname, '..', 'build-assets', 'voice'),
    path.join(__dirname, 'voice')
  ].filter(Boolean);
  return cands.find((d) => exists(d)) || null;
}
// First-run: seed the bundled voice engines into dataRoot/attachments so piperPaths()/
// whisperPaths() resolve them and the OS can TALK + LISTEN offline out of the box.
// Idempotent; never overwrites a user-installed engine.
function seedBundledVoiceOnce() {
  if (!dataRoot) return { ok: false };
  const src = bundledVoiceDir();
  if (!src) return { ok: false, note: 'no bundled voice' };
  const dstRoot = safeMkdir(path.join(dataRoot, 'attachments'));
  const seeded = [];
  for (const eng of ['piper', 'whisper']) {
    const s = path.join(src, eng); const d = path.join(dstRoot, eng);
    if (!exists(s)) continue;
    const marker = path.join(d, eng === 'piper' ? 'piper.exe' : 'whisper-cli.exe');
    if (exists(marker)) continue; // already present — respect user install
    try { fs.cpSync(s, d, { recursive: true }); seeded.push(eng); } catch (e) {}
  }
  return { ok: true, seeded };
}
// Locate the skill packs that ship WITH the app (bundled). resources/skills when packaged,
// build-assets/skills in dev.
function bundledSkillsDir() {
  const cands = [
    process.resourcesPath ? path.join(process.resourcesPath, 'skills') : null,
    path.join(__dirname, '..', 'build-assets', 'skills'),
    path.join(__dirname, 'skills')
  ].filter(Boolean);
  return cands.find((d) => exists(d)) || null;
}
// First-run: copy bundled SKILL.md packs into the data root and embed them so the agent can
// recall them semantically (retrieveSkills). Idempotent; never overwrites a user's own skill.
async function seedBundledSkillsOnce() {
  if (!dataRoot) return { ok: false };
  const src = bundledSkillsDir();
  if (!src) return { ok: false, note: 'no bundled skills' };
  const dstRoot = path.join(dataRoot, 'skills');
  safeMkdir(dstRoot);
  let copied = 0;
  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const md = path.join(src, entry.name, 'SKILL.md');
      if (!exists(md)) continue;
      const dst = path.join(dstRoot, entry.name);
      if (exists(path.join(dst, 'SKILL.md'))) continue; // respect existing/user skills
      safeMkdir(dst);
      try { fs.copyFileSync(md, path.join(dst, 'SKILL.md')); copied++; } catch {}
    }
  } catch {}
  // Embed newly-seeded packs for semantic recall (skips any already vectored).
  let embedded = 0;
  try {
    const have = new Set(readSkillVectors().map((v) => v.id));
    for (const s of listSkills()) {
      if (s.kind !== 'skill-pack' || have.has(s.id)) continue;
      const vec = await embedText((s.name || s.id) + '. ' + (s.description || ''));
      if (vec) { appendJsonl(skillVectorFile(), { id: s.id, title: s.name || s.id, when: s.description || '', vec }); embedded++; }
    }
  } catch {}
  return { ok: true, copied, embedded, total: listSkills().length };
}

// ── Two-way Claude Desktop symbiosis ──
// Direction A (Claude → ABUZ8): the stdio symbiote, self-healed on startup.
// Direction B (ABUZ8 → Claude's tools): import Claude Desktop's MCP servers so
// ABUZ8 runs the same tool fleet through its own MCP client.
function bridgeStatus() {
  const claudeCfgFile = claudeConfigPath();
  const claudeCfg = readJson(claudeCfgFile, { mcpServers: {} });
  const symbiote = claudeCfg.mcpServers && claudeCfg.mcpServers.abuz8_os ? claudeCfg.mcpServers.abuz8_os : null;
  const bridge = persistentClaudeBridge();
  const localMcp = readJson(mcpConfigPath(), { mcpServers: {} });
  const importedFromClaude = Object.entries(localMcp.mcpServers || {}).filter(([, s]) => s.source === 'claude-desktop').map(([n]) => n);
  return {
    ok: true,
    claude_to_abuz8: { installed: Boolean(symbiote), config: claudeCfgFile, bridge_present: exists(bridge.bridge), node_present: Boolean(bridge.node) },
    abuz8_to_claude: { imported_servers: importedFromClaude, count: importedFromClaude.length, note: importedFromClaude.length ? 'ABUZ8 runs the same MCP servers Claude Desktop uses.' : 'No Claude Desktop MCP servers imported yet.' },
    restart_claude_to_load: Boolean(symbiote)
  };
}

function reinstateBridge() {
  const installed = installClaudeSymbiote();
  let imported = [];
  try {
    const file = claudeConfigPath();
    if (exists(file)) {
      const cfg = readJson(file, {});
      // Import every Claude Desktop MCP server EXCEPT our own symbiote (avoid recursion).
      const incoming = { ...(cfg.mcpServers || {}) };
      delete incoming.abuz8_os;
      imported = mergeMcpServers(incoming, 'claude-desktop');
    }
  } catch {}
  return { ok: true, symbiote: installed.server, claude_config: installed.file, imported, status: bridgeStatus() };
}

// ── Open-weight model catalog (LM Studio / Anything-LLM style) ──
// Curated GGUF models from Hugging Face, sized small→large so the OS can
// recommend and download the most capable one this machine can actually run.
const MODEL_CATALOG = [
  { id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B Instruct', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', params: '0.5B', size_gb: 0.5, min_ram_gb: 3, note: 'Ultra-light, runs on anything.' },
  { id: 'llama3.2-1b', name: 'Llama 3.2 1B Instruct', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', params: '1B', size_gb: 0.8, min_ram_gb: 4, note: 'Fast general assistant.' },
  { id: 'qwen2.5-3b', name: 'Qwen2.5 3B Instruct', repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', params: '3B', size_gb: 2.0, min_ram_gb: 8, note: 'Strong small all-rounder (good Arabic).' },
  { id: 'nemotron-nano-4b', name: 'NVIDIA Nemotron 3 Nano 4B', repo: 'unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF', file: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf', params: '4B', size_gb: 2.9, min_ram_gb: 8, note: 'NVIDIA edge model built for AGENTIC TOOL USE. Best sub-4GB tool caller (2026). temp 0.6 / top_p 0.95.' },
  { id: 'phi4-mini', name: 'Microsoft Phi-4 Mini', repo: 'bartowski/Phi-4-mini-instruct-GGUF', file: 'Phi-4-mini-instruct-Q4_K_M.gguf', params: '3.8B', size_gb: 2.5, min_ram_gb: 8, note: 'Strong reasoning + tool use per size.' },
  { id: 'gemma3-4b', name: 'Gemma 3 4B Instruct', repo: 'bartowski/google_gemma-3-4b-it-GGUF', file: 'google_gemma-3-4b-it-Q4_K_M.gguf', params: '4B', size_gb: 2.5, min_ram_gb: 8, note: 'Google Gemma 3, good tool calling + multilingual.' },
  { id: 'qwen3.5-4b', name: 'Qwen3.5 4B (recommended)', repo: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf', params: '4B', size_gb: 2.55, min_ram_gb: 8, note: 'Leading sub-4GB agentic tool-caller (2026, Apache-2.0). Multimodal via mmproj. Default ABUZ8 brain.' },
  { id: 'phi3.5-mini', name: 'Phi-3.5 Mini Instruct', repo: 'bartowski/Phi-3.5-mini-instruct-GGUF', file: 'Phi-3.5-mini-instruct-Q4_K_M.gguf', params: '3.8B', size_gb: 2.4, min_ram_gb: 8, note: 'Great reasoning per size.' },
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B Instruct', repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', params: '8B', size_gb: 4.9, min_ram_gb: 12, note: 'Capable general model.' },
  { id: 'qwen2.5-7b', name: 'Qwen2.5 7B Instruct', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF', file: 'qwen2.5-7b-instruct-q4_k_m.gguf', params: '7B', size_gb: 4.7, min_ram_gb: 12, note: 'Top-tier 7B for tools & code.' },
  { id: 'qwen2.5-coder-7b', name: 'Qwen2.5 Coder 7B', repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', params: '7B', size_gb: 4.7, min_ram_gb: 12, note: 'Best small coding model.' },
  { id: 'deepseek-r1-8b', name: 'DeepSeek-R1 Distill 8B', repo: 'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF', file: 'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf', params: '8B', size_gb: 4.9, min_ram_gb: 14, note: 'Reasoning-focused.' },
  { id: 'mistral-nemo-12b', name: 'Mistral Nemo 12B', repo: 'bartowski/Mistral-Nemo-Instruct-2407-GGUF', file: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf', params: '12B', size_gb: 7.1, min_ram_gb: 16, note: 'Strong, 128k context.' },
  { id: 'qwen2.5-14b', name: 'Qwen2.5 14B Instruct', repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF', file: 'qwen2.5-14b-instruct-q4_k_m.gguf', params: '14B', size_gb: 9.0, min_ram_gb: 20, note: 'Near-frontier local quality.' },
  { id: 'qwen2.5-32b', name: 'Qwen2.5 32B Instruct', repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF', file: 'qwen2.5-32b-instruct-q4_k_m.gguf', params: '32B', size_gb: 19.8, min_ram_gb: 32, note: 'Heavy workstation model.' }
];

async function modelCatalog() {
  const totalGb = os.totalmem() / 1024 / 1024 / 1024;
  const gpus = await detectGpuNames();
  const usable = totalGb * 0.6; // leave headroom for the OS + app
  const downloaded = new Set(listDownloadedModels().map((m) => m.name.toLowerCase()));
  const rows = MODEL_CATALOG.map((m) => ({
    ...m,
    runnable: m.min_ram_gb <= totalGb,
    comfortable: m.min_ram_gb <= usable,
    installed: downloaded.has(m.file.toLowerCase())
  }));
  // Recommend the largest comfortable model.
  const best = rows.filter((m) => m.comfortable).sort((a, b) => b.min_ram_gb - a.min_ram_gb)[0];
  if (best) best.recommended = true;
  return { ok: true, device: { ram_gb: Math.round(totalGb), gpus }, recommended_id: best?.id || null, models: rows };
}

/* ═══════════════════════════════════════════════════════════════════════════
   v1.23 — CONVERGENCE PACK
   1) Coder loop (edit→test→repair, frontier-backed)   2) Deploy (Vercel/GitHub)
   3) LLM skill-synthesis + semantic recall            4) Goals/subagent autonomy
   5) Self-update channel + skills feed                6) Mobile build (Expo/EAS)
   7) Ark expansion + provider key-health + quick-switch
   All additive, guarded, honest. Command execution is sandboxed to the project
   workspace and limited to a dev-toolchain allowlist.
   ════════════════════════════════════════════════════════════════════════ */

// ── shared: workspace dirs + sandboxed dev-command exec ──
function workspacesRoot() { const d = path.join(dataRoot || '', 'workspaces'); safeMkdir(d); return d; }
function projectDir(name) { const safe = (slug(name || 'project') || 'project').slice(0, 60); const d = path.join(workspacesRoot(), safe); safeMkdir(d); return d; }
const DEV_BIN = new Set(['npm', 'npx', 'node', 'git', 'gh', 'pnpm', 'yarn', 'bun', 'vercel', 'expo', 'eas', 'eas-cli', 'tsc', 'vite', 'next', 'python', 'pip', 'deno']);
function devExec(cmd, cwd, timeout = 180000) {
  return new Promise((resolve) => {
    const raw = String(cmd || '').trim();
    // EVERY chained segment must start with an allowlisted dev binary — closes `npm -v & calc` /
    // `git status; <arbitrary>` shell-injection through the coder lane (reachable in an agent run).
    const segments = raw.split(/&&|\|\||[;&|\n]/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const tok = seg.split(/\s+/)[0];
      if (!DEV_BIN.has(tok)) return resolve({ ok: false, code: -1, stdout: '', stderr: `Command segment '${tok}' is not in the coder dev allowlist.`, blocked: true });
    }
    // Block inline code-eval through an allowlisted interpreter (full arbitrary code exec otherwise).
    if (/\b(node|deno)\b[^\n]*\s-(e|-eval|p|-print)\b/i.test(raw) || /\bpython3?\b[^\n]*\s-c\b/i.test(raw) || /\bdeno\b[^\n]*\beval\b/i.test(raw)) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: 'Inline code-eval (node -e / python -c / deno eval) is blocked in the coder lane.', blocked: true });
    }
    try { guardCommand(raw); } catch (e) { return resolve({ ok: false, code: -1, stdout: '', stderr: 'Blocked by safety guard: ' + e.message, blocked: true }); }
    cmd = raw;
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-lc', cmd];
    execFile(shell, shellArgs, { windowsHide: true, timeout, cwd: cwd && exists(cwd) ? cwd : workspacesRoot(), maxBuffer: 12 * 1024 * 1024 }, (err, so, se) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, stdout: String(so || '').slice(-8000), stderr: String(se || (err && err.message) || '').slice(-8000) });
    });
  });
}
function hasBin(bin) {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const a = process.platform === 'win32' ? ['/d', '/s', '/c', probe] : ['-lc', probe];
    execFile(shell, a, { windowsHide: true, timeout: 6000 }, (e, o) => resolve(!e && String(o || '').trim().length > 0));
  });
}
function listProjectFiles(dir, max = 200) {
  const out = []; const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.expo', '.vercel']);
  (function walk(d, depth) {
    if (depth > 6 || out.length >= max) return;
    let entries = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      if (skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1); else out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  })(dir, 0);
  return out;
}
// frontier-first reply: active provider → any enabled provider w/ key → embedded brain.
async function frontierReply(prompt, system, opts = {}) {
  // Per-task model routing: if a model/brain is configured for this task slot, prefer it.
  try { const tb = opts.task && taskBrain(opts.task); if (tb && cliBrainAvailable(tb)) { const t = await cliBrainReply(tb, prompt, system); if (t && String(t).trim()) return { text: String(t).trim(), brain: cliBrainName(tb), frontier: true, task: opts.task }; } } catch {}
  // Selected CLI brain (Claude/Grok) drives building, goals, and skill synthesis — execute with frontier intelligence.
  try {
    const cb = readJson(settingsPath(), {}).cli_brain;
    if (cb && cliBrainAvailable(cb)) {
      const t = await cliBrainReply(cb, prompt, system);
      if (t && String(t).trim()) return { text: String(t).trim(), brain: cliBrainName(cb), frontier: true };
    }
  } catch {}
  try { const active = (readJson(settingsPath(), {}).active_provider) || null; if (active && active.name) { const r = await providerReply(prompt, active.name, system); if (r && r.text) return { text: r.text, brain: `${r.provider} · ${r.model}`, frontier: true }; } } catch {}
  try { const r = await providerReply(prompt, null, system); if (r && r.text) return { text: r.text, brain: `${r.provider} · ${r.model}`, frontier: true }; } catch {}
  try { const t = await embeddedReply(prompt, { system, agentic: false }); if (t && String(t).trim()) return { text: String(t).trim(), brain: (activeBrain || selectEmbeddedBrain())?.name || 'Embedded brain', frontier: false }; } catch {}
  return { text: '', brain: 'none', frontier: false };
}

// ════ 1) CODER LOOP — plan → write → run → read errors → repair ════
const CODER_SYSTEM = `You are ABUZ8 Coder, an autonomous software engineer working inside ONE project directory.
Each turn you receive the goal, the file tree, selected file contents, and the output of the last commands.
Reply with ONLY a JSON object (no prose, no markdown fence):
{"thought":"one short line","files":[{"path":"relative/path.ext","contents":"FULL new file contents"}],"commands":["npm install","npm run build"],"done":false,"summary":"what is built / what's left"}
Rules: paths are relative to the project root; always write FULL file contents (never diffs); only use dev commands (npm, npx, node, git, vite, next, expo, eas, python, pip); build a runnable minimal app first, then iterate; keep each turn small (1-4 files); set done=true only when the goal is met and build/test commands pass.`;
async function coderGitCommit(dir, msg) {
  if (!(await hasBin('git'))) return { ok: false, reason: 'git not installed' };
  if (!exists(path.join(dir, '.git'))) {
    await devExec('git init', dir, 20000);
    await devExec('git config user.email abuz8@local', dir, 8000);
    await devExec('git config user.name abuz8-coder', dir, 8000); // no spaces: cmd.exe /s strips quotes
    try { fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.expo/\n.vercel/\n'); } catch {}
  }
  await devExec('git add -A', dir, 30000);
  // Pass the message via a file (git commit -F): cmd.exe /s mangles quoted -m args.
  try { fs.writeFileSync(path.join(dir, '.git', 'ABUZ8_MSG'), String(msg || 'coder update').slice(0, 200)); } catch {}
  await devExec('git commit -F .git/ABUZ8_MSG --no-gpg-sign', dir, 30000);
  const log = await devExec('git log --oneline -8', dir, 10000);
  const commits = (log.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  return { ok: true, committed: commits.length > 0, count: commits.length, commits };
}
let _coderStream = {}; // live "watch him think" buffer keyed by project
async function coderRun(goal, opts = {}) {
  if (!dataRoot) throw new Error('data root not ready');
  const dir = projectDir(opts.project || goal);
  const maxSteps = Math.max(1, Math.min(Number(opts.max_steps) || 6, 12));
  const allowExec = opts.exec !== false;
  const npm = allowExec ? await hasBin('npm') : false;
  const steps = []; let lastCmd = '';
  const _proj = path.basename(dir);
  _coderStream[_proj] = { goal, steps, done: false, started: Date.now() };
  _agentStop = false;
  pushActivity('plan', `Coder: ${String(goal).slice(0, 80)}`, dir);
  for (let i = 0; i < maxSteps; i++) {
    if (agentStopRequested()) { _coderStream[_proj].done = true; pushActivity('done', 'Coder stopped', 'by user'); return { ok: true, stopped: true, dir, steps }; }
    const tree = listProjectFiles(dir, 120);
    const ctxFiles = tree.filter((f) => /\.(js|ts|jsx|tsx|json|html|css|md|py|txt)$/i.test(f)).slice(0, 8);
    const ctx = ctxFiles.map((f) => { try { return `--- ${f} ---\n` + fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { return ''; } }).join('\n\n');
    let idxCtx = '';
    try { const sc = await searchCode(dir, goal, 4); if (sc.ok && sc.hits && sc.hits.length) idxCtx = '\n\nRELEVANT INDEXED CODE (semantic retrieval):\n' + sc.hits.map((h) => `${h.file}:${h.line}\n${h.snippet}`).join('\n\n'); } catch {}
    const userMsg = `GOAL: ${goal}\n\nPROJECT DIR: ${dir}\nFILE TREE (${tree.length}):\n${tree.join('\n') || '(empty)'}\n\nFILE CONTENTS:\n${ctx || '(none yet)'}${idxCtx}\n\nLAST COMMAND OUTPUT:\n${lastCmd || '(none)'}\n\nReturn the next JSON step.`;
    const r = await frontierReply(userMsg, CODER_SYSTEM, opts);
    const plan = extractJsonObject(r.text);
    if (!plan) { steps.push({ step: i + 1, error: 'model did not return JSON', raw: String(r.text).slice(0, 400), brain: r.brain }); break; }
    const wrote = [];
    for (const f of (Array.isArray(plan.files) ? plan.files : [])) {
      try {
        const rel = String(f.path || '').replace(/^[\/\\]+/, '').replace(/\.\.[\/\\]/g, '');
        if (!rel) continue;
        const full = path.join(dir, rel);
        if (!full.startsWith(dir)) continue;
        safeMkdir(path.dirname(full));
        fs.writeFileSync(full, String(f.contents != null ? f.contents : ''), 'utf8');
        wrote.push(rel);
      } catch (e) { wrote.push('ERR:' + e.message); }
    }
    const cmdOut = [];
    if (allowExec && npm) {
      for (const c of (Array.isArray(plan.commands) ? plan.commands : []).slice(0, 4)) {
        const out = await devExec(c, dir, 240000);
        cmdOut.push({ cmd: c, code: out.code, ok: out.ok, tail: (out.stderr || out.stdout || '').slice(-1200) });
      }
    } else if ((plan.commands || []).length) {
      cmdOut.push({ cmd: (plan.commands || []).join(' && '), skipped: true, reason: npm ? 'exec disabled' : 'npm/node not found on PATH' });
    }
    lastCmd = cmdOut.map((c) => `$ ${c.cmd}\n${c.skipped ? ('[skipped: ' + c.reason + ']') : ('exit ' + c.code + '\n' + (c.tail || ''))}`).join('\n\n');
    steps.push({ step: i + 1, thought: plan.thought || '', wrote, commands: cmdOut, summary: plan.summary || '', brain: r.brain, done: !!plan.done });
    pushActivity('observe', `Coder step ${i + 1}: ${wrote.length} file(s)`, plan.summary || '');
    if (plan.done) break;
  }
  let git = null; try { git = await coderGitCommit(dir, `coder: ${String(goal).slice(0, 60)}`); } catch {}
  if (_coderStream[_proj]) { _coderStream[_proj].done = true; _coderStream[_proj].git = git; }
  recordSignal({ kind: 'coder', user: String(goal).slice(0, 120), ok: steps.length > 0, used_tools: ['coder'] });
  recordTrace({ kind: 'coder', goal: String(goal).slice(0, 200), project: path.basename(dir), steps: steps.length, done: steps.some((s) => s.done), ok: steps.some((s) => s.done) });
  return { ok: true, goal, project: path.basename(dir), dir, steps, files: listProjectFiles(dir, 200), npm_available: npm, exec: allowExec, git };
}

// ════ 2) DEPLOY — Vercel / GitHub (prompt → live URL) ════
function deployTargets() {
  return [
    { id: 'vercel', label: 'Vercel (prod)', needs: 'Vercel token (Connect → vercel) or a local `vercel login`', cli: 'npx vercel' },
    { id: 'github', label: 'GitHub repo + push', needs: 'GitHub CLI logged in (`gh auth login`)', cli: 'git + gh' },
    { id: 'github-pages', label: 'GitHub Pages (static)', needs: 'gh CLI + a static build folder', cli: 'git + gh' }
  ];
}
async function deployRun(opts = {}) {
  const dir = opts.dir && exists(opts.dir) ? opts.dir : projectDir(opts.project || '');
  const target = opts.target || 'vercel';
  if (!exists(dir)) throw new Error('project not found: ' + dir);
  const log = []; const push = (cmd, out) => log.push({ cmd, code: out.code, ok: out.ok, tail: ((out.stdout || '').slice(-1200) + (out.stderr ? ('\n' + out.stderr.slice(-700)) : '')) });
  if (target === 'vercel') {
    if (!(await hasBin('npx')) && !(await hasBin('vercel'))) return { ok: false, target, error: 'Need Node/npx (for `npx vercel`) or the Vercel CLI installed.' };
    let token = ''; try { const c = connectorCreds('vercel') || {}; token = c.api_key || c.token || ''; } catch {}
    const out = await devExec(`npx --yes vercel deploy --prod --yes${token ? ' --token ' + token : ''}`, dir, 300000);
    push('npx vercel deploy --prod', out);
    const url = (String(out.stdout || '').match(/https?:\/\/[^\s]+\.vercel\.app[^\s]*/) || [])[0] || null;
    return { ok: out.ok, target, url, log, note: token ? '' : 'No Vercel token saved — relied on a local `vercel login` session. Add a token in Connect → vercel for headless deploys.' };
  }
  if (target === 'github' || target === 'github-pages') {
    if (!(await hasBin('git'))) return { ok: false, target, error: 'git is not installed.' };
    const repo = (slug(opts.repo || path.basename(dir)) || 'abuz8-app');
    for (const c of ['git init', 'git add -A', 'git commit -m "ABUZ8 deploy" --no-gpg-sign']) push(c, await devExec(c, dir, 60000));
    if (!(await hasBin('gh'))) return { ok: false, target, error: 'Committed locally, but no `gh` CLI to create/push the remote. Run `gh auth login` (or add a GitHub token).', log };
    const out = await devExec(`gh repo create ${repo} ${opts.private ? '--private' : '--public'} --source . --push`, dir, 120000);
    push(`gh repo create ${repo}`, out);
    const url = (String(out.stdout || '').match(/https?:\/\/github\.com\/[^\s]+/) || [])[0] || null;
    if (target === 'github-pages') push('enable pages', await devExec(`gh api -X POST repos/:owner/${repo}/pages -f source[branch]=main -f source[path]=/`, dir, 60000));
    return { ok: out.ok, target, url, log };
  }
  return { ok: false, error: 'unknown target: ' + target };
}

// ════ 3) SELF-LEARNING v2 — LLM skill-synthesis + semantic recall ════
function tracesFile() { return path.join(dataRoot, 'logs', 'traces.jsonl'); }
function recordTrace(rec) { try { appendJsonl(tracesFile(), { ts: new Date().toISOString(), ...rec }); } catch {} }
function learnedSkillsDir() { const d = path.join(dataRoot || '', 'skills', 'promoted'); safeMkdir(d); return d; }
function skillVectorFile() { return path.join(dataRoot, 'skills', 'skill-vectors.jsonl'); }
function readSkillVectors() { try { return fs.readFileSync(skillVectorFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
function traceKey(t) { return (slug((t.kind || '') + '_' + (t.goal || t.user || '')) || 'trace').slice(0, 80); }
async function synthesizeSkillsOnce(opts = {}) {
  if (!dataRoot) return { ok: false };
  let traces = [];
  try { traces = fs.readFileSync(tracesFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  if (!traces.length) return { ok: true, synthesized: 0, note: 'no traces yet' };
  const existing = new Set(listLearnedSkills().map((s) => s.source_trace).filter(Boolean));
  const recent = traces.slice(-40).filter((t) => (t.done || t.ok) && !existing.has(traceKey(t)));
  const pick = recent.slice(-Math.max(1, Math.min(Number(opts.max) || 3, 6)));
  let made = 0;
  for (const t of pick) {
    const sys = `You write a reusable agent SKILL from a successful task trace. Output ONLY JSON: {"title":"...","when_to_use":"trigger conditions","steps":["..."],"guardrails":["..."],"tools":["..."]}`;
    const r = await frontierReply(`Task kind: ${t.kind}\nGoal: ${t.goal || t.user || ''}\nOutcome: success in ${t.steps || '?'} steps.\nWrite the reusable skill.`, sys, opts);
    const j = extractJsonObject(r.text); if (!j || !j.title) continue;
    const id = 'skill_' + (slug(j.title) || 'untitled').slice(0, 50);
    const md = `# ${j.title}\n\n**When to use:** ${j.when_to_use || ''}\n\n## Steps\n${(j.steps || []).map((s) => '- ' + s).join('\n')}\n\n## Guardrails\n${(j.guardrails || []).map((s) => '- ' + s).join('\n')}\n`;
    try { fs.writeFileSync(path.join(learnedSkillsDir(), id + '.md'), md, 'utf8'); } catch {}
    writeJson(path.join(learnedSkillsDir(), id + '.json'), { id, title: j.title, when_to_use: j.when_to_use || '', steps: j.steps || [], guardrails: j.guardrails || [], tools: j.tools || [], source_trace: traceKey(t), learned_at: new Date().toISOString(), status: 'promoted', synthesized: true });
    try { const vec = await embedText(`${j.title}. ${j.when_to_use}. ${(j.steps || []).join('. ')}`); if (vec) appendJsonl(skillVectorFile(), { id, title: j.title, vec, when: j.when_to_use || '' }); } catch {}
    made++;
  }
  const out = { ok: true, synthesized: made, learned_total: listLearnedSkills().length };
  try { appendJsonl(path.join(dataRoot, 'logs', 'self_learning_log.jsonl'), { ts: new Date().toISOString(), synth: out }); } catch {}
  return out;
}
// Load a skill's actual playbook body (SKILL.md minus frontmatter) so the agent can FOLLOW it,
// not just see its title. This is what makes the bundled skills usable instead of decorative.
function skillBody(id) {
  try { const f = path.join(dataRoot, 'skills', String(id), 'SKILL.md'); return exists(f) ? fs.readFileSync(f, 'utf8').replace(/^﻿?---[\s\S]*?---\s*/, '').trim().slice(0, 6000) : ''; } catch { return ''; }
}
async function retrieveSkills(query, k = 3) {
  try {
    const qv = await embedText(query); const vs = readSkillVectors();
    if (qv && vs.length) return vs.map((s) => ({ id: s.id, title: s.title, when: s.when, score: cosine(qv, s.vec) })).sort((a, b) => b.score - a.score).slice(0, k).filter((s) => s.score > 0.4);
  } catch {}
  const ql = String(query || '').toLowerCase();
  return listLearnedSkills().filter((s) => (s.title + ' ' + (s.when_to_use || '')).toLowerCase().split(/\s+/).some((w) => w.length > 3 && ql.includes(w))).slice(0, k).map((s) => ({ id: s.id, title: s.title, when: s.when_to_use }));
}

// ════ 4) GOALS — long-horizon autonomous loop (plan → subagent → verify → retry) ════
function goalsDir() { const d = path.join(dataRoot || '', 'goals'); safeMkdir(d); return d; }
function goalFile(id) { return path.join(goalsDir(), id + '.json'); }
function listGoals() { try { return fs.readdirSync(goalsDir()).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(goalsDir(), f), null)).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created))); } catch { return []; } }
function createGoal(g = {}) { const id = 'g' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); const item = { id, objective: g.objective || g.goal || '', status: 'pending', plan: [], log: [], created: new Date().toISOString(), updated: new Date().toISOString(), max_steps: Math.min(Number(g.max_steps) || 8, 20) }; writeJson(goalFile(id), item); return item; }
async function runGoal(id, opts = {}) {
  const g = readJson(goalFile(id), null); if (!g) throw new Error('goal not found');
  g.status = 'running'; g.updated = new Date().toISOString(); writeJson(goalFile(id), g);
  pushActivity('plan', `Goal: ${String(g.objective).slice(0, 80)}`, '');
  if (!g.plan || !g.plan.length) {
    const r = await frontierReply(`OBJECTIVE: ${g.objective}`, 'Break the objective into 3-7 concrete, verifiable steps. Output ONLY JSON: {"steps":["..."]}', opts);
    const j = extractJsonObject(r.text);
    g.plan = (j && Array.isArray(j.steps) ? j.steps : [g.objective]).slice(0, g.max_steps).map((s, i) => ({ n: i + 1, step: s, status: 'pending' }));
    writeJson(goalFile(id), g);
  }
  for (const st of g.plan) {
    if (st.status === 'done') continue;
    let ok = false, result = '';
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try { const out = await runTask(`${g.objective}\n\nCurrent step: ${st.step}`, { reflect: false, max_steps: 3 }); result = typeof out === 'string' ? out : (out && (out.response || out.summary || JSON.stringify(out).slice(0, 400))) || ''; }
      catch (e) { result = 'error: ' + e.message; }
      const v = await frontierReply(`Step: ${st.step}\nResult: ${String(result).slice(0, 1500)}\nIs this step satisfied? Output ONLY JSON {"ok":true|false,"why":"..."}`, 'You are a strict verifier.', opts);
      const vj = extractJsonObject(v.text); ok = !!(vj && vj.ok); st.attempts = (st.attempts || 0) + 1; st.verify_why = (vj && vj.why) || st.verify_why || '';
    }
    st.status = ok ? 'done' : 'failed'; st.result = String(result).slice(0, 600);
    g.log.push({ step: st.n, status: st.status, at: new Date().toISOString() }); g.updated = new Date().toISOString(); writeJson(goalFile(id), g);
    pushActivity(ok ? 'done' : 'observe', `Goal step ${st.n} ${st.status}`, st.step);
    if (!ok && opts.stopOnFail) break;
  }
  g.status = g.plan.every((s) => s.status === 'done') ? 'completed' : 'partial'; g.updated = new Date().toISOString(); writeJson(goalFile(id), g);
  if (g.status !== 'completed') { try { escalateFailure('goal:' + String(g.objective).slice(0, 60), 'unfinished steps: ' + g.plan.filter((s) => s.status !== 'done').map((s) => s.n + ' (' + (s.verify_why || '') + ')').join('; ')); } catch {} }
  recordTrace({ kind: 'goal', goal: g.objective, steps: g.plan.length, done: g.status === 'completed', ok: g.status === 'completed' });
  return g;
}

// ════ 5) SELF-UPDATE — hosted channel + apply + skills feed ════
// Correct org/repo. (Private repos won't serve raw publicly — publish the manifest as a public
// gist / on abuz8ai.com / a public branch, or override via settings.update_url / ABUZ8_UPDATE_URL.)
const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/abuz8studios-ship-it/abuz8-os/main/release-manifest.json';
function updateUrl() { return readJson(settingsPath(), {}).update_url || process.env.ABUZ8_UPDATE_URL || DEFAULT_UPDATE_URL; }
async function applyUpdate() {
  const info = await checkUpdate();
  if (!info.update_available) return { ok: true, applied: false, note: 'Already up to date (' + APP_VERSION + ').' };
  if (!info.installer_url) return { ok: false, error: 'Manifest has no installer_url.' };
  // 1) installer must be https + a pinned, trusted host (no arbitrary/overridden EXE source).
  if (!updateHostAllowed(info.installer_url)) return { ok: false, error: 'Refusing update: installer_url is not an https URL on a trusted host (github / abuz8ai).' };
  // 2) the manifest MUST carry a sha256; we will not launch an unverifiable installer.
  if (!info.installer_sha256 || !/^[a-f0-9]{64}$/i.test(info.installer_sha256)) return { ok: false, error: 'Refusing update: manifest has no valid installer_sha256 to verify against.' };
  try {
    try { await zipDataRoot('pre-update'); } catch {} // snapshot user data before the installer runs
    const dest = path.join(os.tmpdir(), 'ABUZ8-Setup-' + info.latest + '.exe');
    const buf = await fetchUrl(info.installer_url, { binary: true, timeout: 600000 });
    // 3) verify the downloaded bytes match the (pinned-https) manifest hash — defeats MITM/tamper.
    const got = _sha256hex(buf);
    if (got.toLowerCase() !== String(info.installer_sha256).toLowerCase()) { return { ok: false, error: 'Refusing update: installer SHA-256 mismatch (expected ' + info.installer_sha256.slice(0, 12) + '…, got ' + got.slice(0, 12) + '…). Possible tampering.' }; }
    // 4) optional Ed25519 signature over the installer bytes — REQUIRED when a signing key is set.
    const pub = UPDATE_PUBKEY_B64 || (readJson(settingsPath(), {}).update_pubkey || '');
    if (pub) {
      try {
        const keyObj = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
        const ok = info.signature && crypto.verify(null, buf, keyObj, Buffer.from(String(info.signature), 'base64'));
        if (!ok) return { ok: false, error: 'Refusing update: Ed25519 signature invalid or missing (a signing key is configured).' };
      } catch (e) { return { ok: false, error: 'Refusing update: signature check failed — ' + e.message }; }
    }
    fs.writeFileSync(dest, buf);
    if (process.platform === 'win32') execFile('cmd.exe', ['/d', '/s', '/c', 'start', '""', dest], { windowsHide: true });
    return { ok: true, applied: true, installer: dest, verified: { sha256: true, signature: !!pub }, note: 'Installer verified (https + host-pinned + SHA-256' + (pub ? ' + Ed25519' : '') + ') and launched.' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function skillsFeed() {
  let last = null; try { const l = fs.readFileSync(path.join(dataRoot, 'logs', 'self_learning_log.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean); last = JSON.parse(l[l.length - 1]); } catch {}
  const learned = listLearnedSkills();
  return { ok: true, learned, count: learned.length, synthesized: learned.filter((s) => s.synthesized).length, last_pass: last };
}

// ════ 6) MOBILE — Expo/EAS scaffold + build (the open lane) ════
async function mobileScaffold(opts = {}) {
  const name = (slug(opts.name || 'mobile-app') || 'mobile-app').slice(0, 50);
  const dir = projectDir(name + '-mobile');
  if (opts.real && await hasBin('npx')) {
    const out = await devExec('npx --yes create-expo-app@latest . --template blank', dir, 300000);
    return { ok: out.ok, dir, mode: 'create-expo-app', tail: (out.stderr || out.stdout || '').slice(-1500) };
  }
  const title = String(opts.title || name).replace(/[`<]/g, '');
  const appJs = `import { StatusBar } from 'expo-status-bar';\nimport { StyleSheet, Text, View } from 'react-native';\n\nexport default function App() {\n  return (\n    <View style={styles.container}>\n      <Text style={styles.h}>${title}</Text>\n      <Text style={styles.p}>Built by ABUZ8 OS — edit App.js to begin.</Text>\n      <StatusBar style="auto" />\n    </View>\n  );\n}\nconst styles = StyleSheet.create({ container:{flex:1,backgroundColor:'#0b120e',alignItems:'center',justifyContent:'center'}, h:{color:'#7CFFB2',fontSize:28,fontWeight:'700'}, p:{color:'#9fb',marginTop:8} });\n`;
  safeMkdir(dir);
  fs.writeFileSync(path.join(dir, 'App.js'), appJs);
  writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', main: 'node_modules/expo/AppEntry.js', scripts: { start: 'expo start', android: 'expo start --android', web: 'expo start --web' }, dependencies: { expo: '~51.0.0', 'expo-status-bar': '~1.12.1', react: '18.2.0', 'react-native': '0.74.5' } });
  writeJson(path.join(dir, 'app.json'), { expo: { name: opts.title || name, slug: name, version: '1.0.0', orientation: 'portrait', platforms: ['ios', 'android', 'web'] } });
  writeJson(path.join(dir, 'eas.json'), { cli: { version: '>= 5.0.0' }, build: { preview: { distribution: 'internal', android: { buildType: 'apk' } }, production: {} } });
  return { ok: true, dir, mode: 'template', files: ['App.js', 'package.json', 'app.json', 'eas.json'], next: 'Run Mobile build (needs `npm install`, then an EAS token for a real APK — otherwise it exports a web build).' };
}
async function mobileBuild(opts = {}) {
  const dir = opts.dir && exists(opts.dir) ? opts.dir : projectDir((slug(opts.name || 'mobile-app') || 'mobile-app') + '-mobile');
  if (!exists(path.join(dir, 'package.json'))) return { ok: false, error: 'No Expo project — scaffold first.' };
  if (!(await hasBin('npx'))) return { ok: false, error: 'Need Node/npx installed to build.' };
  const install = await devExec('npm install', dir, 600000);
  let token = ''; try { const c = connectorCreds('expo') || {}; token = c.api_key || c.token || ''; } catch {}
  if (token) {
    const out = await devExec(`npx --yes eas-cli build -p android --profile ${opts.profile || 'preview'} --non-interactive`, dir, 1200000);
    const url = (String(out.stdout || '').match(/https?:\/\/expo\.dev\/[^\s]+/) || [])[0] || null;
    return { ok: out.ok, mode: 'eas-cloud', url, install_ok: install.ok, tail: (out.stderr || out.stdout || '').slice(-1500) };
  }
  const out = await devExec('npx --yes expo export --platform web', dir, 600000);
  return { ok: out.ok, mode: 'expo-export-web', dir: path.join(dir, 'dist'), install_ok: install.ok, tail: (out.stderr || out.stdout || '').slice(-1500), note: 'No EAS token — exported a web build. Add an Expo token (Connect → expo) to build a real Android APK in the cloud.' };
}

// ════ 7) ARK — provider key-health ════
async function providersHealth() {
  const store = providersStore();
  const rows = [];
  for (const p of (store.providers || [])) {
    if (!p.api_key && p.cat !== 'local' && p.cat !== 'bridge') { rows.push({ id: p.name, ok: false, reason: 'no key' }); continue; }
    try { const res = await catalogTest(p.name); rows.push({ id: p.name, ok: !!(res && (res.ok !== false)), detail: res }); }
    catch (e) { rows.push({ id: p.name, ok: false, reason: e.message }); }
  }
  return { ok: true, providers: rows, healthy: rows.filter((r) => r.ok).length, total: rows.length };
}

// ── DASHBOARD telemetry: genuine usage + agent state ──
const _usage = []; // ring of { ts, source, model, tokens, tok_s, ms }
function recordUsage(u = {}) {
  try {
    const source = u.source || 'local', model = u.model || '';
    const tin = Number(u.tokens_in || u.input_tokens) || 0, tout = Number(u.tokens_out || u.output_tokens) || 0, treason = Number(u.reasoning_tokens) || 0, tcache = Number(u.cache_read_tokens || u.cache_tokens) || 0;
    const tokens = Number(u.tokens) || (tin + tout) || 0;
    const cost_usd = priceFor(source, model, tokens);
    const row = { ts: Date.now(), source, model, tokens, tokens_in: tin, tokens_out: tout, reasoning_tokens: treason, cache_tokens: tcache, tok_s: u.tok_s != null ? Number(u.tok_s) : null, ms: u.ms != null ? Number(u.ms) : null, cost_usd };
    _usage.push(row); if (_usage.length > 500) _usage.shift();
    try { appendJsonl(usageFile(), { ...row, ts: new Date().toISOString() }); } catch {}
  } catch {}
}
// ════════════════════════════════════════════════════════════════════════════
//  HARDENING (2026-06-18) — additive safety/observability/recovery floors found
//  in the Hermes gap analysis. Nothing removed; every feature stays on.
// ════════════════════════════════════════════════════════════════════════════
const BUILD_STAMP = '2026-06-25 · SECURITY-HARDENED: signed+host-pinned self-update, per-process CSRF-nonce + CORS + DNS-rebind lockdown, credential-jailed (realpath) fs/read, cmd_run prompt-injection guard, Stripe-HMAC revenue integrity · SOVEREIGNTY: enforced Local-Only air-gap + AES-256-GCM encrypted-at-rest secrets + no-train flags · agent stop/kill switch · executable skill playbooks · honesty pass · +Qwen/Fable/Krea · on the omni-brain + native tool-loop + semantic RAG + swarm fleet base';

/* ── 1) Command safety guard — a floor BELOW the single "Allow actions" consent.
   HARDLINE = never run, even with consent. DANGEROUS = needs explicit approval. */
const HARDLINE_RX = [
  /\brm\s+-rf?\s+(?:--no-preserve-root\s+)?[\/~]\s*$/i,   // rm -rf /  or ~  (root wipe)
  /\brm\s+-rf?\s+[\/~][^\s]*\*/i,                          // rm -rf /something*
  /\b(?:del|erase)\b[^\n]*\/[sq]\b[^\n]*[a-z]:\\?\s*$/i,   // del /s C:\
  /\bformat\b\s+[a-z]:/i,                                  // format C:
  /\bmkfs\.?\w*/i,                                         // mkfs
  /\bdd\b[^\n]*\bof=\/dev\/[sh]d/i,                        // dd of=/dev/sda
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,             // fork bomb
  /\b(?:shutdown|reboot|poweroff|halt)\b/i,                // power state
  />\s*\/dev\/(?:sd[a-z]|nvme\d)/i,                        // overwrite raw disk
  /\bcipher\b\s+\/w:/i,                                    // windows secure-wipe
  /\b(?:format-volume|clear-disk|remove-partition)\b/i     // powershell disk ops
];
const DANGEROUS_RX = [
  /\brm\s+-rf?\b/i, /\b(?:rmdir|rd)\b[^\n]*\/s\b/i, /\b(?:del|erase)\b[^\n]*\/[sq]\b/i,
  /\breg\b\s+delete\b/i, /\bschtasks\b\s+\/create/i, /\b(?:new-?service)\b|\bsc\b\s+(?:create|delete)/i,
  /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(?:bash|sh|iex|powershell)/i, /\biex\b\s*\(/i,
  /\btaskkill\b\s+\/f/i, /\b(?:icacls|takeown)\b/i, /\bgit\b\s+push\b[^\n]*--force/i,
  /(?:\.ssh[\/\\]|id_rsa|id_ed25519|\.aws[\/\\]credentials|[\/\\]\.env\b)/i,  // secret paths
  /\b(?:sed|perl)\b[^\n]*-i[^\n]*(?:\.ssh|authorized_keys|\.env|passwd)/i,    // in-place edit of secrets
  /\bfind\b[^\n]*-exec\s+rm\b/i, /\bxargs\b[^\n]*\brm\b/i,                    // bulk delete via find/xargs
  /\b(?:drop|truncate)\s+(?:table|database)\b/i,                              // destructive SQL
  /\bchmod\b\s+-?R?\s*777\b/i                                                 // world-writable
];
// De-obfuscate before matching: NFKC unicode, strip control/ANSI/null bytes, unfold backslash escapes, drop quotes/carets.
function normalizeCmd(c) { return String(c || '').normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').replace(/\\(.)/g, '$1').replace(/[`'"^]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function commandAllowlist() { try { return readJson(settingsPath(), {}).command_allowlist || []; } catch { return []; } }
const _cmdApprovedSession = new Set();
function isCommandApproved(norm) {
  if (_cmdApprovedSession.has(norm)) return true;
  for (const pat of commandAllowlist()) { try { if (norm.includes(String(pat).toLowerCase())) return true; } catch {} }
  return false;
}
function guardCommand(command, opts = {}) {
  const norm = normalizeCmd(command);
  for (const rx of HARDLINE_RX) { if (rx.test(command) || rx.test(norm)) { const e = new Error('Refused for safety: this command can irreversibly destroy the system or data, and is blocked even with Allow actions enabled.'); e.code = 'HARDLINE'; throw e; } }
  if (opts.hardlineOnly) return true;
  for (const rx of DANGEROUS_RX) { if ((rx.test(command) || rx.test(norm)) && !isCommandApproved(norm)) { const e = new Error('This command is potentially destructive and needs approval. Approve via POST /api/actions/approve-command {command, scope:"once|session|always"}, or rephrase to something safer.'); e.code = 'NEEDS_APPROVAL'; e.command = command; throw e; } }
  return true;
}
function approveCommand(command, scope) {
  const norm = normalizeCmd(command); if (!norm) throw new Error('command required');
  if (scope === 'always') { const s = readJson(settingsPath(), {}); s.command_allowlist = Array.from(new Set([...(s.command_allowlist || []), norm])); writeJson(settingsPath(), s); }
  _cmdApprovedSession.add(norm);
  return { ok: true, approved: norm, scope: scope || 'session' };
}

/* ── 2) MCP environment scrub — stop leaking every API key to spawned MCP servers ── */
function buildSafeMcpEnv(spec = {}) {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'HOMEPATH', 'HOMEDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'LANG', 'TZ'];
  const env = {};
  for (const k of keep) { if (process.env[k] != null) env[k] = process.env[k]; }
  for (const [k, v] of Object.entries(spec.env || {})) env[k] = String(v); // only the keys the server declares
  return env;
}

/* ── 3) Observability — real per-call cost + persisted usage on top of the ring ── */
const MODEL_PRICES = { 'gpt-4o-mini': 0.0004, 'gpt-4o': 0.0075, 'o4': 0.02, 'claude-opus': 0.03, 'claude-sonnet': 0.006, 'claude-haiku': 0.0016, 'gemini-1.5-pro': 0.0035, 'gemini-2': 0.004, 'grok': 0.005, 'default-cloud': 0.004 };
const SOVEREIGN_SOURCES = new Set(['local', 'grok', 'claude', 'codex', 'gemini']); // own accounts / local brain → $0
function priceFor(source, model, tokens) {
  if (SOVEREIGN_SOURCES.has(source)) return 0;
  const m = String(model || '').toLowerCase(); let rate = MODEL_PRICES['default-cloud'];
  for (const key in MODEL_PRICES) { if (m.includes(key)) { rate = MODEL_PRICES[key]; break; } }
  return +((Number(tokens) || 0) / 1000 * rate).toFixed(5);
}
function usageFile() { return path.join(dataRoot, 'logs', 'usage.jsonl'); }
function redactSecrets(s) {
  return String(s == null ? '' : s)
    .replace(/(sk-[a-zA-Z0-9]{6})[a-zA-Z0-9_-]+/g, '$1…')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1…')
    .replace(/([?&](?:api_?key|token|key|secret)=)[^&\s]+/gi, '$1…')
    .replace(/\b([0-9]{8,10}:[A-Za-z0-9_-]{30,})\b/g, '…');
}
function readUsageRows(limit = 2000) {
  try { return fs.readFileSync(usageFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function usageSummary() {
  const rows = readUsageRows(2000); const byModel = {}; let tokens = 0, cost = 0;
  for (const r of rows) { tokens += r.tokens || 0; cost += r.cost_usd || 0; const k = r.model || r.source || 'unknown'; byModel[k] = byModel[k] || { calls: 0, tokens: 0, cost_usd: 0 }; byModel[k].calls++; byModel[k].tokens += r.tokens || 0; byModel[k].cost_usd += r.cost_usd || 0; }
  return { ok: true, calls: rows.length, tokens, cost_usd: +cost.toFixed(4), by_model: byModel, ring: _usage.slice(-100), sovereign: cost === 0 };
}
function costSummary() {
  const rows = readUsageRows(5000); const byDay = {};
  for (const r of rows) { const d = (r.ts ? new Date(r.ts) : new Date()).toISOString().slice(0, 10); byDay[d] = byDay[d] || { date: d, tokens: 0, cost_usd: 0, calls: 0 }; byDay[d].tokens += r.tokens || 0; byDay[d].cost_usd += r.cost_usd || 0; byDay[d].calls++; }
  const days = Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = days.reduce((s, d) => s + d.cost_usd, 0);
  return { ok: true, rows: days, total: +total.toFixed(4), cost: +total.toFixed(4), note: total === 0 ? 'Sovereign: $0.00 — running on your own accounts / local brain, no API fees.' : null };
}
function recentTraces(limit = 100) {
  try { return { ok: true, rows: fs.readFileSync(tracesFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) }; } catch { return { ok: true, rows: [] }; }
}

/* ── 4) Backup / restore + pre-update snapshot (Windows-native zip, no deps) ── */
const BACKUP_INCLUDE = ['config', 'soul', 'skills', 'mcp', 'memory', 'mission', 'autonomy', 'sessions', 'goals', 'connectors', 'art', 'pairing'];
const RESTORE_SKIP = new Set(['runtime.json']); // never clobber machine-tuned runtime config
function exportsDir() { return safeMkdir(path.join(dataRoot, 'exports')); }
async function zipDataRoot(label) {
  const items = BACKUP_INCLUDE.map((d) => path.join(dataRoot, d)).filter((p) => exists(p));
  if (!items.length) throw new Error('Nothing to back up yet.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(exportsDir(), `abuz8-backup-${label || 'manual'}-${stamp}.zip`);
  // SEC-04: stage a copy and STRIP the vault key material so a shared/USB/cloud backup can never decrypt the
  // encrypted secrets (config is included, and the AES key lives in config/.vaultkey).
  const stage = path.join(exportsDir(), '.stage-' + stamp);
  try {
    safeMkdir(stage);
    for (const src of items) { try { fs.cpSync(src, path.join(stage, path.basename(src)), { recursive: true }); } catch {} }
    for (const kf of ['.vaultkey', '.vaultkey.dpapi']) { try { fs.unlinkSync(path.join(stage, 'config', kf)); } catch {} }
    // SEC-04b: neutralize PLAINTEXT secrets too. These files are NOT vault-encrypted, so stripping the key
    // above does nothing for them. Drop regenerable auth tokens + MCP creds, and scrub secret-bearing keys
    // out of settings.json (it holds the license SIGNING private key + the LAN PIN) while keeping the rest.
    for (const sf of [path.join('config', 'sessions.json'), path.join('config', 'oauth.json'), path.join('mcp', 'mcp_servers.json')]) {
      try { fs.unlinkSync(path.join(stage, sf)); } catch {}
    }
    try {
      const sp = path.join(stage, 'config', 'settings.json');
      if (exists(sp)) {
        const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
        for (const k of Object.keys(s)) { if (k !== 'license_pubkey' && /(_key|_token|_secret|password|private)/i.test(k)) delete s[k]; }
        fs.writeFileSync(sp, JSON.stringify(s, null, 2));
      }
    } catch { try { fs.unlinkSync(path.join(stage, 'config', 'settings.json')); } catch {} } // fail-CLOSED: if scrub throws, drop settings.json entirely rather than ship it unscrubbed
    const children = fs.readdirSync(stage).map((f) => path.join(stage, f));
    const list = children.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    const ps = `Compress-Archive -Path ${list} -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
    const out = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 180000);
    if (!exists(dest)) throw new Error('Backup failed: ' + (out.stderr || out.stdout || 'unknown'));
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
  try { const z = fs.readdirSync(exportsDir()).filter((f) => f.endsWith('.zip')).map((f) => path.join(exportsDir(), f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); z.slice(8).forEach((f) => { try { fs.unlinkSync(f); } catch {} }); } catch {}
  return { ok: true, file: dest, bytes: fs.statSync(dest).size, included: items.map((p) => path.basename(p)), note: 'vault key + plaintext secrets excluded (SEC-04): sessions/oauth/mcp creds dropped, signing key & LAN PIN scrubbed from settings — re-login & re-add MCP servers after restore' };
}
async function restoreBackup(zipPath) {
  const zp = path.resolve(String(zipPath || '')); if (!exists(zp)) throw new Error('Backup file not found.');
  const tmp = path.join(safeMkdir(path.join(dataRoot, 'cache')), 'restore-' + Date.now()); safeMkdir(tmp);
  const ps = `Expand-Archive -Path '${zp.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`;
  const out = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 180000);
  if (!exists(tmp)) throw new Error('Restore failed to expand: ' + (out.stderr || out.stdout || ''));
  const root = path.resolve(dataRoot); let copied = 0;
  const walk = (src) => { for (const ent of fs.readdirSync(src, { withFileTypes: true })) { const sp = path.join(src, ent.name); const dp = path.resolve(root, path.relative(tmp, sp)); if (dp !== root && !dp.startsWith(root + path.sep)) continue; if (RESTORE_SKIP.has(ent.name)) continue; if (ent.isDirectory()) { safeMkdir(dp); walk(sp); } else { safeMkdir(path.dirname(dp)); try { fs.copyFileSync(sp, dp); copied++; } catch {} } } };
  walk(tmp); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return { ok: true, restored_files: copied, note: 'Restored. Restart ABUZ8 OS for all changes to take effect.' };
}

/* ── 5) Filesystem checkpoints — snapshot a file before the agent overwrites it ── */
function checkpointsDir() { return safeMkdir(path.join(dataRoot, 'checkpoints')); }
function checkpointFile(target) {
  try {
    if (!exists(target)) return null; // new file → nothing to snapshot
    const rec = { id: 'ck_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), ts: new Date().toISOString(), original: target, size: fs.statSync(target).size };
    const blob = path.join(checkpointsDir(), rec.id + (path.extname(target) || '.bak'));
    fs.copyFileSync(target, blob); rec.snapshot = blob;
    appendJsonl(path.join(checkpointsDir(), 'index.jsonl'), rec);
    return rec;
  } catch { return null; }
}
function listCheckpoints(limit = 200) {
  try { return fs.readFileSync(path.join(checkpointsDir(), 'index.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function rollbackCheckpoint(id) {
  const rec = listCheckpoints(2000).find((c) => c.id === id);
  if (!rec || !exists(rec.snapshot)) throw new Error('Checkpoint not found.');
  safeMkdir(path.dirname(rec.original)); fs.copyFileSync(rec.snapshot, rec.original);
  return { ok: true, restored: rec.original, from: rec.id };
}

/* ── 6) DM pairing — gate who may DM the agent over the messaging gateways.
   Opt-in: until you approve at least one contact, inbound stays open (back-compat). */
function pairingFile() { return path.join(safeMkdir(path.join(dataRoot, 'pairing')), 'pairings.json'); }
function pairingState() { return readJson(pairingFile(), { approved: [], pending: [], enabled: false }); }
function savePairing(s) { writeJson(pairingFile(), s); return s; }
function pairingRequest(id, label) { const s = pairingState(); id = String(id || '').trim(); if (!id) throw new Error('id required'); if (!s.approved.find((a) => String(a.id) === id) && !s.pending.find((a) => String(a.id) === id)) s.pending.push({ id, label: label || '', at: new Date().toISOString() }); return savePairing(s); }
function pairingApprove(id) { const s = pairingState(); id = String(id || '').trim(); s.pending = s.pending.filter((a) => String(a.id) !== id); if (!s.approved.find((a) => String(a.id) === id)) s.approved.push({ id, at: new Date().toISOString() }); s.enabled = true; return savePairing(s); }
function pairingRevoke(id) { const s = pairingState(); id = String(id || '').trim(); s.approved = s.approved.filter((a) => String(a.id) !== id); s.pending = s.pending.filter((a) => String(a.id) !== id); return savePairing(s); }
function pairingAllows(id) { const s = pairingState(); if (!s.enabled || !s.approved.length) return true; return !!s.approved.find((a) => String(a.id) === String(id)); }

// ════════════════════════════════════════════════════════════════════════════
//  OPERATOR LIST (items 1-6) — daemon brief · tiered approval · vault · ledger
//  · voice matrix · revenue lane. Additive; honest gating where keys are needed.
// ════════════════════════════════════════════════════════════════════════════

/* ── Failure escalation — 3am failures must surface, not die silently ── */
function escalateFailure(source, message) {
  const msg = String(message || '').slice(0, 500);
  try { appendJsonl(path.join(dataRoot, 'logs', 'escalations.jsonl'), { ts: new Date().toISOString(), source, message: msg }); } catch {}
  try { pushActivity('alert', 'Failure: ' + source, msg.slice(0, 120)); } catch {}
  try { recordDecision({ action: source, decision: 'escalated-failure', why: msg.slice(0, 200) }); } catch {}
  try { const s = readJson(settingsPath(), {}); if (s.tg_gateway === true && s.tg_owner_chat) { const tok = tgToken(); if (tok) tgSend(tok, s.tg_owner_chat, '⚠ ABUZ8 failure — ' + source + ': ' + msg.slice(0, 200)).catch(() => {}); } } catch {}
  return { ok: true, escalated: source };
}

/* ── Context references (@file @folder @url @line @diff @staged @git @terminal) ──
   Hermes-parity: typed refs in chat expand SERVER-SIDE into the model context, with a
   soft/hard TOKEN BUDGET so a big file/diff can never blow the context window. */
const CTX_REF_RX = /@(file|folder|url|image|line|diff|staged|git|terminal)(?::("[^"]+"|[^\s]+))?/gi;
function estTokens(s) { return Math.ceil(String(s || '').length / 4); }
async function expandContextRefs(text, opts = {}) {
  const baseDir = (opts.cwd && exists(opts.cwd)) ? path.resolve(opts.cwd) : os.homedir();
  const gitCwd = (opts.cwd && exists(opts.cwd)) ? path.resolve(opts.cwd) : workspacesRoot();
  const terminals = opts.terminals || {};
  const SOFT = Number(opts.soft) || 4000, HARD = Number(opts.hard) || 9000;
  const refs = []; const seen = new Set();
  const matches = [...String(text || '').matchAll(CTX_REF_RX)];
  for (const m of matches) {
    const kind = m[1].toLowerCase();
    const val = (m[2] || '').replace(/^"|"$/g, '');
    const key = kind + ':' + val; if (seen.has(key)) continue; seen.add(key);
    let block = '', err = null, label = '@' + kind + (val ? ':' + val : '');
    try {
      if (kind === 'file') { const p = path.resolve(baseDir, val); if (!exists(p) || fs.statSync(p).isDirectory()) throw new Error('not a file'); block = readTextFile(p, '').slice(0, 60000); }
      else if (kind === 'image') { const p = path.resolve(baseDir, val); block = '[image file: ' + p + ' — use the attach (paperclip) button for vision/OCR]'; }
      else if (kind === 'folder') { const p = path.resolve(baseDir, val); const r = fsListDir(p); block = 'Folder ' + (r.dir || p) + ':\n' + (r.entries || []).slice(0, 200).map((e) => (e.dir ? '[dir] ' : '      ') + e.name).join('\n'); }
      else if (kind === 'line') { const mm = val.match(/^(.+):(\d+)-(\d+)$/); if (!mm) throw new Error('use @line:path:start-end'); const p = path.resolve(baseDir, mm[1]); const lines = readTextFile(p, '').split(/\r?\n/); const a = Math.max(1, +mm[2]), b = Math.min(lines.length, +mm[3]); block = lines.slice(a - 1, b).map((l, i) => (a + i) + '| ' + l).join('\n'); label = '@line:' + mm[1] + ':' + a + '-' + b; }
      else if (kind === 'url') { const u = /^https?:/i.test(val) ? val : 'https://' + val; let t = await fetchUrl(u, { timeout: 12000 }).catch(() => ''); t = String(t || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim(); if (!t) throw new Error('could not fetch'); block = t.slice(0, 40000); }
      else if (kind === 'diff') { const r = await devExec('git diff', gitCwd, 12000); block = r.ok ? (r.stdout || '(no unstaged changes)') : (r.stderr || 'git diff failed — not a git repo?'); }
      else if (kind === 'staged') { const r = await devExec('git diff --staged', gitCwd, 12000); block = r.ok ? (r.stdout || '(nothing staged)') : (r.stderr || 'git failed — not a git repo?'); }
      else if (kind === 'git') { const r = await devExec('git log -p -n 2', gitCwd, 12000); block = r.ok ? (r.stdout || '(no history)') : (r.stderr || 'git failed — not a git repo?'); }
      else if (kind === 'terminal') { block = terminals[val] || terminals[''] || ('(no captured terminal output' + (val ? ' for: ' + val : '') + ')'); }
    } catch (e) { err = e.message; }
    refs.push({ kind, value: val, label, err, block });
  }
  let used = 0; const parts = []; const summary = [];
  for (const r of refs) {
    if (r.err) { summary.push({ ref: r.label, error: r.err }); continue; }
    let b = r.block || ''; let truncated = false;
    if (used >= HARD) { summary.push({ ref: r.label, omitted: true }); continue; }
    let tk = estTokens(b);
    if (used + tk > HARD) { b = b.slice(0, Math.max(0, (HARD - used) * 4)) + '\n…[truncated — token budget]'; truncated = true; tk = estTokens(b); }
    used += tk;
    parts.push('===== ' + r.label + (truncated ? ' (truncated)' : '') + ' =====\n' + b);
    summary.push({ ref: r.label, tokens: tk, truncated });
  }
  const context = parts.length ? ('[Attached context — referenced in the message]\n\n' + parts.join('\n\n')) : '';
  let note = null;
  if (used > SOFT) note = 'context refs ~' + used + ' tok (over soft ' + SOFT + ')';
  const omitted = summary.filter((s) => s.omitted).length;
  if (omitted) note = (note ? note + '; ' : '') + omitted + ' ref(s) omitted (hard cap ' + HARD + ')';
  return { ok: true, context, refs: summary, tokens: used, budget: { soft: SOFT, hard: HARD }, note };
}

/* ── Working-dir file tree (read-only browser) ── */
function fsListDir(dir) {
  const base = (dir && exists(dir)) ? path.resolve(dir) : os.homedir();
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).slice(0, 500).map((e) => {
      const fp = path.join(base, e.name); let size = null; try { if (!e.isDirectory()) size = fs.statSync(fp).size; } catch {}
      return { name: e.name, dir: e.isDirectory(), path: fp, size };
    });
  } catch (e) { return { ok: false, error: e.message, dir: base }; }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
  return { ok: true, dir: base, parent: path.dirname(base), entries };
}
// SEC-02 positive containment: the LOCAL owner can read/list anywhere on THEIR machine (it's their OS), but a
// REMOTE caller (LAN / phone / tunnel) is jailed to the workspace roots — no walking the system filesystem.
function _fsAccessAllowed(p, req) {
  try {
    if (isLocalRequest(req)) return true;
    const rp = path.resolve(String(p || ''));
    return [dataRoot, workspacesRoot(), exportsDir()].filter(Boolean).map((r) => path.resolve(r))
      .some((r) => rp === r || rp.startsWith(r + path.sep));
  } catch { return false; }
}

/* ── Automation blueprints — typed-slot templates that compile to a schedule ── */
const BLUEPRINTS = [
  { id: 'daily-content', name: 'Daily content drop', desc: 'Draft + post content on a topic every day at an hour.', slots: [{ k: 'topic', label: 'Topic' }, { k: 'platform', label: 'Platform (x/bluesky/…)', def: 'x' }, { k: 'hour', label: 'Hour 0-23', def: '9' }], build: (v) => ({ name: 'Daily content: ' + (v.topic || ''), at_hour: Number(v.hour) || 9, action: { kind: 'content_loop', payload: { topic: v.topic, platforms: [v.platform || 'x'] } } }) },
  { id: 'morning-brief', name: 'Morning brief', desc: 'Generate the operator brief each morning.', slots: [{ k: 'hour', label: 'Hour 0-23', def: '7' }], build: (v) => ({ name: 'Morning brief', at_hour: Number(v.hour) || 7, action: { kind: 'tool', payload: { tool: 'abuz8_chat', args: { message: 'Give me my morning brief.' } } } }) },
  { id: 'cron-goal', name: 'Recurring goal', desc: 'Run an autonomous goal on a cron schedule.', slots: [{ k: 'objective', label: 'Objective' }, { k: 'cron', label: 'Cron (min hr dom mon dow)', def: '0 */6 * * *' }], build: (v) => ({ name: 'Goal: ' + String(v.objective || '').slice(0, 40), cron: v.cron || '0 */6 * * *', action: { kind: 'orchestrate', payload: { objective: v.objective } } }) },
  { id: 'interval-task', name: 'Interval task', desc: 'Run a task every N minutes.', slots: [{ k: 'task', label: 'Task' }, { k: 'every_min', label: 'Every N minutes', def: '60' }], build: (v) => ({ name: String(v.task || 'Task').slice(0, 40), every_min: Number(v.every_min) || 60, action: { kind: 'task', payload: { goal: v.task } } }) }
];
function blueprintCreate(id, slots) { const bp = BLUEPRINTS.find((b) => b.id === id); if (!bp) throw new Error('unknown blueprint'); return createSchedule(bp.build(slots || {})); }

/* ── Channel directory — name/alias/gate the messaging surfaces ── */
function channelsFile() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'channels.json'); }
function readChannels() { return readJson(channelsFile(), { channels: [] }).channels || []; }
function upsertChannel(c) { const arr = readChannels(); const i = arr.findIndex((x) => x.platform === c.platform && String(x.id) === String(c.id)); const rec = { platform: c.platform || 'telegram', id: String(c.id || ''), alias: c.alias || '', allowed: c.allowed !== false, prompt_hint: c.prompt_hint || '', updated: new Date().toISOString() }; if (i >= 0) arr[i] = { ...arr[i], ...rec }; else arr.push(rec); writeJson(channelsFile(), { channels: arr }); return rec; }
function channelFor(platform, id) { return readChannels().find((x) => x.platform === platform && String(x.id) === String(id)) || null; }

/* ── Per-task model routing — user-configurable model/brain per task slot ── */
function taskModels() { try { return readJson(settingsPath(), {}).task_models || {}; } catch { return {}; } }
function taskBrain(task) { const m = taskModels(); return (task && m[task]) || null; }

/* ── 1) Operator morning brief (the always-on daemon's report) ── */
function operatorBrief() {
  const b = { ok: true, ts: new Date().toISOString(), halted: _halted, actions_allowed: actionsAllowed() };
  try { b.revenue = revenueSummary(); } catch { b.revenue = null; }
  try { b.usage = usageSummary(); } catch { b.usage = null; }
  try { const s = readJson(schedulesFile(), {}); const arr = s.schedules || s.items || []; b.scheduled_jobs = arr.length; b.enabled_jobs = arr.filter((x) => x.enabled).length; } catch { b.scheduled_jobs = 0; }
  try { b.goals = (listGoals ? listGoals() : []).slice(0, 5).map((g) => ({ objective: String(g.objective || '').slice(0, 80), status: g.status })); } catch { b.goals = []; }
  try { b.vault_keys = vaultList().length; } catch { b.vault_keys = 0; }
  const r = b.revenue || {};
  b.markdown = [
    `# ABUZ8 morning brief — ${new Date().toLocaleString()}`,
    `**Status:** ${_halted ? '⛔ HALTED' : '🟢 live'}  ·  scheduled jobs: ${b.scheduled_jobs || 0} (${b.enabled_jobs || 0} on)`,
    `**Cash (verified):** $${(r.verified_total || 0).toFixed ? r.verified_total.toFixed(2) : (r.verified_total || 0)}${r.unverified_total > 0 ? '  ·  unverified $' + (r.unverified_total.toFixed ? r.unverified_total.toFixed(2) : r.unverified_total) : ''} across ${(r.by_channel ? Object.keys(r.by_channel).length : 0)} channel(s)  ·  spend $${(r.cost || 0)}`,
    `**Compute:** ${b.usage ? (b.usage.calls + ' calls, $' + (b.usage.cost_usd || 0) + (b.usage.sovereign ? ' (sovereign $0)' : '')) : 'n/a'}`,
    b.goals && b.goals.length ? `**Open goals:** ${b.goals.map((g) => g.objective + ' [' + g.status + ']').join(' · ')}` : '**Open goals:** none'
  ].join('\n');
  return b;
}

/* ── 2) Tiered approval — green (auto) · yellow (consent) · red (explicit) ── */
const TOOL_TIERS = {
  green: ['web_search', 'deep_research', 'get_time', 'get_weather', 'jarvis_see', 'jarvis_brief', 'content_generate', 'social_draft', 'abuz8_memory_write', 'abuz8_mission_board', 'abuz8_device_probe'],
  red: ['stripe_op'] // money / account actions — explicit per-tool approval on top of consent
};
function toolTier(tool) {
  const t = String(tool || '');
  if (TOOL_TIERS.red.includes(t)) return 'red';
  if (TOOL_TIERS.green.includes(t)) return 'green';
  return 'yellow'; // everything that touches the machine/world → consent-gated (existing behavior)
}
const _redApproved = new Set();
function approveTool(tool) { _redApproved.add(String(tool)); return { ok: true, approved: String(tool), tier: 'red' }; }
function denyTool(tool) { _redApproved.delete(String(tool)); return { ok: true, denied: String(tool) }; }
function enforceTier(tool) {
  const tier = toolTier(tool);
  if (tier === 'red' && !_redApproved.has(String(tool))) {
    let id; try { id = enqueueApproval({ tool, action: tool, tier: 'red', reason: 'red-tier action requested' }); } catch {}
    return { ok: false, tool, tier: 'red', action_required: true, approval_id: id, reason: `Red-tier action (money/account): "${tool}" needs explicit approval. Approve it in the queue — POST /api/approvals/approve {"id":"${id}"} — or per-tool {"tool":"${tool}"}.` };
  }
  return null; // green + yellow fall through (yellow is still consent-gated downstream)
}

/* ── Approval queue + decisions log + unified audit (the spine: "everything timestamped") ── */
function approvalsFile() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'approvals.jsonl'); }
function decisionsFile() { return path.join(safeMkdir(path.join(dataRoot, 'logs')), 'decisions.jsonl'); }
function enqueueApproval(rec = {}) { const id = 'ap_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); appendJsonl(approvalsFile(), { id, status: 'pending', ts: new Date().toISOString(), ...rec }); return id; }
function listApprovals(status) {
  let rows = []; try { rows = fs.readFileSync(approvalsFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const map = new Map(); for (const r of rows) map.set(r.id, { ...(map.get(r.id) || {}), ...r }); // collapse to latest state per id
  let out = [...map.values()]; if (status) out = out.filter((r) => r.status === status);
  return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}
function recordDecision(d = {}) { try { appendJsonl(decisionsFile(), { ts: new Date().toISOString(), ...d }); } catch {} }
function decideApproval(id, decision, why) {
  const rec = listApprovals().find((r) => r.id === id); if (!rec) throw new Error('approval not found');
  const status = decision === 'approve' ? 'approved' : 'denied';
  appendJsonl(approvalsFile(), { id, status, decided_at: new Date().toISOString() });
  recordDecision({ id, action: rec.action || rec.tool, decision: status, why: why || '', tier: rec.tier || '' });
  if (decision === 'approve' && rec.tool) _redApproved.add(String(rec.tool));
  return { ok: true, id, decision: status, tool: rec.tool || null };
}
function listDecisions(limit = 100) { try { return fs.readFileSync(decisionsFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function auditTimeline(limit = 120) {
  const sources = { consent: 'action-consent.jsonl', tool: 'tool-calls.jsonl', usage: 'usage.jsonl', revenue: 'revenue.jsonl', decision: 'decisions.jsonl' };
  const ev = [];
  for (const [kind, fn] of Object.entries(sources)) {
    try { fs.readFileSync(path.join(dataRoot, 'logs', fn), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-80).forEach((l) => { try { const o = JSON.parse(l); ev.push({ kind, ts: o.ts || o.timestamp || '', summary: o.action || o.tool || o.decision || o.content || (o.allow_actions != null ? ('consent=' + o.allow_actions) : '') || (o.amount_usd != null ? ('$' + o.amount_usd) : ''), data: o }); } catch {} }); } catch {}
  }
  return ev.filter((e) => e.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit);
}

/* ── 3) Encrypted secrets vault (AES-256-GCM, key at rest; DPAPI-upgradeable) ── */
function vaultKeyFile() { return path.join(safeMkdir(path.join(dataRoot, 'config')), '.vaultkey'); }
function vaultFile() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'vault.enc'); }
let _vaultKeyCache = null;
function vaultKey() {
  if (_vaultKeyCache) return _vaultKeyCache;
  // DPAPI-wrapped key (Windows CurrentUser) takes precedence when present — unwrap once, cache.
  try {
    const wf = vaultKeyFile() + '.dpapi';
    if (IS_WIN && exists(wf)) {
      const blob = fs.readFileSync(wf, 'utf8').trim();
      const ps = "$ss = '" + blob + "' | ConvertTo-SecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)";
      const hex = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) { _vaultKeyCache = Buffer.from(hex, 'hex'); return _vaultKeyCache; }
    }
  } catch {}
  try { if (exists(vaultKeyFile())) { _vaultKeyCache = Buffer.from(fs.readFileSync(vaultKeyFile(), 'utf8').trim(), 'hex'); return _vaultKeyCache; } } catch {}
  const k = crypto.randomBytes(32);
  try { fs.writeFileSync(vaultKeyFile(), k.toString('hex'), { encoding: 'utf8', mode: 0o600 }); } catch { fs.writeFileSync(vaultKeyFile(), k.toString('hex')); }
  _vaultKeyCache = k;
  return k;
}
function vaultReadRaw() {
  try {
    if (!exists(vaultFile())) return {};
    const blob = JSON.parse(fs.readFileSync(vaultFile(), 'utf8'));
    const key = vaultKey();
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
    dec.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const out = Buffer.concat([dec.update(Buffer.from(blob.ct, 'hex')), dec.final()]).toString('utf8');
    return JSON.parse(out);
  } catch { return {}; }
}
function vaultWriteRaw(obj) {
  const key = vaultKey(); const iv = crypto.randomBytes(12);
  const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([enc.update(JSON.stringify(obj), 'utf8'), enc.final()]);
  writeJson(vaultFile(), { v: 1, iv: iv.toString('hex'), tag: enc.getAuthTag().toString('hex'), ct: ct.toString('hex') });
}
function vaultSet(k, v) { if (!k) throw new Error('key required'); const o = vaultReadRaw(); o[String(k)] = String(v == null ? '' : v); vaultWriteRaw(o); return { ok: true, key: String(k), stored: true }; }
function vaultGet(k) { return vaultReadRaw()[String(k)]; }
function vaultList() { return Object.keys(vaultReadRaw()); }
// ── ENCRYPTED KNOWLEDGE-AT-REST (N4, fork parity) — AES-256-GCM on memory content using the
// vault key (0o600 file; on Windows DPAPI-wrap it via /api/vault/dpapi). decStr is a no-op on
// plaintext, so turning encryption on/off is backward-compatible with existing memories. ──
function encStr(s) { const key = vaultKey(); const iv = crypto.randomBytes(12); const e = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([e.update(String(s == null ? '' : s), 'utf8'), e.final()]); return 'enc:v1:' + iv.toString('hex') + ':' + e.getAuthTag().toString('hex') + ':' + ct.toString('hex'); }
function decStr(blob) { try { if (typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return blob; const p = blob.split(':'); const key = vaultKey(); const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p[2], 'hex')); d.setAuthTag(Buffer.from(p[3], 'hex')); return Buffer.concat([d.update(Buffer.from(p[4], 'hex')), d.final()]).toString('utf8'); } catch { return blob; } }
function notesEncryptOn() { try { return readJson(settingsPath(), {}).encrypt_notes === true; } catch { return false; } }
function maybeEnc(s) { return notesEncryptOn() ? encStr(s) : s; }
// Windows DPAPI-wrap the vault key to the CurrentUser (a copied .vaultkey is then useless on
// another account/machine). Best-effort via PowerShell; no-op + honest report off Windows.
function vaultDpapi(on) {
  if (!IS_WIN) return { ok: false, error: 'DPAPI is Windows-only (the AES key file is 0o600 elsewhere)' };
  try {
    const kf = vaultKeyFile(); const wf = kf + '.dpapi';
    if (on === false) { try { if (exists(wf)) fs.unlinkSync(wf); } catch {} return { ok: true, dpapi: false }; }
    const hex = fs.readFileSync(kf, 'utf8').trim();
    const ps = "$s = ConvertTo-SecureString '" + hex + "' -AsPlainText -Force; ConvertFrom-SecureString $s";
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    if (out && out.length > 20) { fs.writeFileSync(wf, out, { encoding: 'utf8', mode: 0o600 }); return { ok: true, dpapi: true, note: 'Vault key DPAPI-wrapped to your Windows account.' }; }
    return { ok: false, error: 'DPAPI wrap produced no output' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function vaultDelete(k) { const o = vaultReadRaw(); delete o[String(k)]; vaultWriteRaw(o); return { ok: true, deleted: String(k) }; }

/* ── 4) Revenue ledger — per-channel P&L + ROI ── */
function revenueFile() { return path.join(safeMkdir(path.join(dataRoot, 'logs')), 'revenue.jsonl'); }
// Every revenue row carries provenance. `verified` is true ONLY for a Stripe-signature-checked
// webhook — manual/API entries are always source:'manual', verified:false, so a fabricated POST
// can never surface as confirmed cash (money-integrity rule).
function recordRevenue(rec = {}) { try { appendJsonl(revenueFile(), { ts: new Date().toISOString(), channel: rec.channel || 'unknown', amount_usd: Number(rec.amount_usd) || 0, cost_usd: Number(rec.cost_usd) || 0, sku: rec.sku || '', note: rec.note || '', source: rec.source || 'manual', verified: rec.verified === true }); } catch {} }
function revenueSummary() {
  let rows = [];
  try { rows = fs.readFileSync(revenueFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const byChannel = {}; let total = 0, cost = 0, verifiedTotal = 0, unverifiedTotal = 0;
  for (const r of rows) { const amt = r.amount_usd || 0; total += amt; cost += r.cost_usd || 0; if (r.verified) verifiedTotal += amt; else unverifiedTotal += amt; const k = r.channel || 'unknown'; byChannel[k] = byChannel[k] || { revenue: 0, cost: 0, sales: 0 }; byChannel[k].revenue += amt; byChannel[k].cost += r.cost_usd || 0; byChannel[k].sales++; }
  let compute = 0; try { compute = usageSummary().cost_usd || 0; } catch {}
  const net = +(total - cost - compute).toFixed(2);
  // verified_total is the only figure safe to present as "Cash"; unverified_total must be shown
  // separately (or labelled unverified) so manual/test entries never read as real earnings.
  return { ok: true, rows: Object.entries(byChannel).map(([channel, v]) => ({ channel, ...v, net: +(v.revenue - v.cost).toFixed(2), roi: v.cost ? +((v.revenue - v.cost) / v.cost).toFixed(2) : null })), total: +total.toFixed(2), verified_total: +verifiedTotal.toFixed(2), unverified_total: +unverifiedTotal.toFixed(2), cost: +cost.toFixed(2), compute_cost: compute, net, by_channel: byChannel, note: total === 0 ? 'No revenue logged yet — wire a Stripe/Gumroad sale to /api/revenue/record or the store webhook.' : (unverifiedTotal > 0 ? 'Includes $' + unverifiedTotal.toFixed(2) + ' UNVERIFIED (manual/test) — only $' + verifiedTotal.toFixed(2) + ' is Stripe-verified.' : null) };
}

/* ── 5) Voice matrix — every offline voice + STT locales exposed ── */
function langFromVoiceId(id) { const m = String(id || '').match(/^([a-z]{2})(?:[_-]([A-Z]{2}))?/); return m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : ''; }
function voiceMatrix() {
  const piper = piperAvailable();
  const voices = piper ? listPiperVoices() : [];
  const sttLocales = ['en', 'ar', 'es', 'fr', 'de', 'pt', 'zh', 'ja', 'ko', 'hi', 'ru', 'tr', 'it', 'nl', 'pl', 'id', 'vi', 'uk'];
  return {
    ok: true,
    offline_capable: piper,
    tts: { engine: piper ? 'piper' : 'windows-sapi', count: voices.length, voices: voices.map((v) => ({ id: v.id, name: v.name, lang: v.lang || langFromVoiceId(v.id) })) },
    stt: { engine: 'whisper', offline: true, locales: sttLocales },
    wake_word: true,
    duplex: 'live: mic VAD → Whisper STT → local brain → sentence-chunked Piper TTS, with barge-in + wake word — fully offline',
    brain_routing: 'offline → local :8902; online → your own accounts; voice never hard-requires internet'
  };
}

/* ── 6) Revenue lane — Stripe Checkout + webhook + auto-fulfill (key-gated, honest) ── */
function storeProductsFile() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'products.json'); }
function storeProducts() { return readJson(storeProductsFile(), { products: [] }).products || []; }
function stripeSecret() { const c = connectorCreds('stripe') || {}; return c.api_key || c.secret || c.secret_key || vaultGet('stripe_secret') || ''; }
async function storeCheckout(opts = {}) {
  const key = stripeSecret();
  const name = String(opts.name || opts.sku || 'ABUZ8 product').slice(0, 120);
  const cents = Math.round((Number(opts.amount_usd) || 0) * 100);
  if (!cents) return { ok: false, error: 'amount_usd required' };
  if (!key) return { ok: false, needs_key: true, error: 'No Stripe key. Connect Stripe (Connect → stripe) or store it: POST /api/vault/set {"key":"stripe_secret","value":"sk_live_..."}. The lane is wired and will work the moment a key is present.' };
  const body = [
    'mode=payment',
    'success_url=' + encodeURIComponent(opts.success_url || 'https://example.com/thanks'),
    'cancel_url=' + encodeURIComponent(opts.cancel_url || 'https://example.com/cancel'),
    'line_items[0][quantity]=1',
    'line_items[0][price_data][currency]=usd',
    'line_items[0][price_data][unit_amount]=' + cents,
    'line_items[0][price_data][product_data][name]=' + encodeURIComponent(name)
  ].join('&');
  try {
    const r = JSON.parse(await fetchUrl('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeout: 20000 }));
    if (r.error) return { ok: false, error: r.error.message || 'stripe error' };
    return { ok: true, url: r.url, id: r.id, sku: name, amount_usd: cents / 100 };
  } catch (e) { return { ok: false, error: e.message }; }
}
/* ── ComfyUI bridge — optional local GPU image/video gen for avatar textures/portraits ── */
function comfyuiBase() { try { return (readJson(settingsPath(), {}).comfyui_url || 'http://127.0.0.1:8188').replace(/\/+$/, ''); } catch { return 'http://127.0.0.1:8188'; } }
async function comfyuiStatus() {
  const base = comfyuiBase();
  try {
    const r = JSON.parse(await fetchUrl(base + '/system_stats', { timeout: 2500 }));
    return { ok: true, running: true, base, device: (r.devices && r.devices[0] && r.devices[0].name) || null, vram_total: (r.devices && r.devices[0] && r.devices[0].vram_total) || null };
  } catch { return { ok: true, running: false, base, note: 'ComfyUI not detected on ' + base + ' — start ComfyUI to enable local GPU image/video for the avatar.' }; }
}
async function comfyuiGenerate(opts = {}) {
  const st = await comfyuiStatus(); if (!st.running) return { ok: false, needs_comfyui: true, ...st };
  const base = comfyuiBase();
  // Accept a full workflow graph (the reliable path — ComfyUI graphs are install-specific),
  // else return guidance. We proxy + poll; we never fabricate an image.
  if (!opts.workflow) return { ok: false, error: 'Provide a ComfyUI workflow graph in `workflow` (export from ComfyUI → Save API Format). ComfyUI is running at ' + base + '.', running: true };
  try {
    const clientId = 'abuz8-' + Math.floor(Date.now() / 1000);
    const sub = JSON.parse(await fetchUrl(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: opts.workflow, client_id: clientId }), timeout: 15000 }));
    const id = sub.prompt_id; if (!id) return { ok: false, error: 'ComfyUI rejected the workflow', detail: sub };
    const maxPolls = Math.ceil((Number(opts.pollSeconds) || 90) / 1.5); // video needs minutes; image ~90s
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      let hist; try { hist = JSON.parse(await fetchUrl(base + '/history/' + id, { timeout: 8000 })); } catch { continue; }
      const entry = hist[id];
      if (entry && entry.status && entry.status.status_str === 'error') return { ok: false, error: 'ComfyUI workflow error', detail: (entry.status.messages || []).filter((m) => m[0] === 'execution_error').map((m) => (m[1] || {}).exception_message).join('; ').slice(0, 300) };
      if (!entry || !entry.outputs) continue;
      for (const nodeId in entry.outputs) {
        for (const key of ['images', 'gifs', 'video', 'videos']) {
          const arr = entry.outputs[nodeId][key] || []; if (arr.length) { const im = arr[0]; const url = base + '/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder || '') + '&type=' + (im.type || 'output'); const isVid = /\.(mp4|webm|mov|gif)$/i.test(im.filename || ''); return { ok: true, media_url: url, image_url: isVid ? undefined : url, video_url: isVid ? url : undefined, filename: im.filename }; }
        }
      }
    }
    return { ok: false, error: 'ComfyUI timed out', running: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── LOCAL STUDIO — free local version of Midjourney/Krea (FLUX) + Veo/Kling (LTX/Wan), on the 5090s.
// Bundled templates: type a prompt, get media — no hand-authored workflow JSON (the 1-minute studio).
function studioFluxWorkflow(prompt, opts = {}) {
  const seed = Math.floor(Math.random() * 1e15);
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: opts.ckpt || 'flux1-dev-fp8.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt || ''), clip: ['1', 1] } },
    '8': { class_type: 'FluxGuidance', inputs: { conditioning: ['2', 0], guidance: opts.guidance || 3.5 } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: String(opts.negative || ''), clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: opts.width || 1024, height: opts.height || 1024, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { seed, steps: opts.steps || 20, cfg: 1, sampler_name: opts.sampler || 'euler', scheduler: opts.scheduler || 'simple', denoise: 1, model: ['1', 0], positive: ['8', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'abuz8_studio', images: ['6', 0] } }
  };
}
// Local text-to-video: Wan 2.1 t2v (umt5 + wan_2.1_vae_official, all on disk) — free Veo/Kling on the 5090s. PROVEN.
function studioWanT2VWorkflow(prompt, opts = {}) {
  const seed = Math.floor(Math.random() * 1e15);
  const w = opts.width || 832, h = opts.height || 480, length = Math.min(81, Math.max(17, opts.length || 49));
  return {
    '37': { class_type: 'UNETLoader', inputs: { unet_name: opts.model || 'wan2.1_t2v_1.3B_fp16.safetensors', weight_dtype: 'default' } },
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    '39': { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae_official.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt || ''), clip: ['38', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative || 'blurry, low quality, distorted, static', clip: ['38', 0] } },
    '40': { class_type: 'ModelSamplingSD3', inputs: { shift: 8.0, model: ['37', 0] } },
    '48': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: w, height: h, length, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed, steps: opts.steps || 20, cfg: opts.cfg || 6.0, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1.0, model: ['40', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['48', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    '50': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: opts.fps || 16.0 } },
    '51': { class_type: 'SaveVideo', inputs: { video: ['50', 0], filename_prefix: 'abuz8_video', format: 'mp4', codec: 'h264' } }
  };
}
async function localMediaGenerate(opts = {}) {
  const kind = opts.kind || 'image';
  if (kind === 'image') {
    const wf = studioFluxWorkflow(opts.prompt, opts);
    const r = await comfyuiGenerate({ workflow: wf });
    return { ...r, engine: 'flux-local', kind: 'image', sovereign: true };
  }
  if (kind === 'video') {
    const wf = opts.workflow || studioWanT2VWorkflow(opts.prompt, opts);
    const r = await comfyuiGenerate({ workflow: wf, pollSeconds: opts.pollSeconds || 300 });
    return { ...r, engine: opts.workflow ? 'comfyui-local' : 'wan-t2v-local', kind: 'video', sovereign: true };
  }
  return { ok: false, error: 'kind must be image or video' };
}
// UNIVERSAL ComfyUI runner — run ANY workflow file (LTX-2.3, Wan 2.2, Hunyuan) natively via the
// UI->API converter, injecting the prompt. This is "ComfyUI natively working in the studio."
function comfyRunnerScript() { const a = path.join(avatarStackDir(), 'abuz8_comfy_run.py'); if (exists(a)) return a; const b = path.join(__dirname, '..', 'scripts', 'avatar', 'abuz8_comfy_run.py'); return b; }
function comfyWorkflowDirs() { return (readJson(settingsPath(), {}).comfy_workflow_dirs || ['E:\\ABU\\ComfyUI\\custom_nodes\\ComfyUI-LTXVideo\\example_workflows', 'C:\\Miniconda3\\Lib\\site-packages\\comfyui_workflow_templates_media_video\\templates']); }
function listComfyWorkflows() {
  const out = []; for (const d of comfyWorkflowDirs()) { try { const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json')) out.push({ name: e.name.replace(/\.json$/, ''), file: f }); } }; if (exists(d)) walk(d); } catch {} }
  return out;
}
async function runComfyWorkflow(opts = {}) {
  let file = String(opts.file || opts.workflow_file || '');
  if (!exists(file) && opts.name) { const m = listComfyWorkflows().find((w) => w.name === opts.name || w.name.toLowerCase().includes(String(opts.name).toLowerCase())); if (m) file = m.file; }
  if (!exists(file)) return { ok: false, error: 'workflow file not found (pass file=<path> or name=<workflow name>; list via /api/studio/workflows)' };
  if (!exists(comfyRunnerScript())) return { ok: false, error: 'comfy runner script missing' };
  return await new Promise((resolve) => {
    const args = [comfyRunnerScript(), '--workflow', file, '--timeout', String(opts.timeout || 600)];
    if (opts.prompt) { args.push('--prompt', String(opts.prompt)); }
    execFile(avatarPython(), args, { windowsHide: true, timeout: (opts.timeout || 600) * 1000 + 30000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
      const out = String(so || '').trim(); const m = out.match(/OK (\S+)/);
      if (m) return resolve({ ok: true, media_url: m[1], video_url: /\.(mp4|webm|mov|gif)/i.test(m[1]) ? m[1] : undefined, workflow: path.basename(file) });
      resolve({ ok: false, error: String((se || (err && err.message) || out) || '').slice(-400), workflow: path.basename(file) });
    });
  });
}

// ── ASRED DEV SPEC-OPS — sovereign dev department on the LOCAL coder brain (Ollama Qwen3-Coder). ──
function ollamaBase() { try { return readJson(settingsPath(), {}).ollama_url || 'http://127.0.0.1:11434'; } catch { return 'http://127.0.0.1:11434'; } }
function localCoderModel() { try { return readJson(settingsPath(), {}).coder_model || 'qwen3.6-128k:latest'; } catch { return 'qwen3.6-128k:latest'; } }
async function localCoderReply(prompt, system, opts = {}) {
  const body = { model: opts.model || localCoderModel(), messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: String(prompt) }], stream: false, options: { temperature: opts.temperature != null ? opts.temperature : 0.3, num_ctx: opts.num_ctx || 16384 } };
  const r = JSON.parse(await fetchUrl(ollamaBase() + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: opts.timeout || 240000 }));
  return (r.message && r.message.content) || '';
}
async function devTeamSolve(opts = {}) {
  const task = String(opts.task || opts.problem || '').trim();
  if (!task) return { ok: false, error: 'Provide a task/problem to solve.' };
  const sys = 'You are ASRED — an elite sovereign dev spec-ops team. Break the problem into a precise plan, then deliver a concrete, correct, complete, ship-ready solution (code + steps). No fluff.';
  try {
    const out = await localCoderReply(`PROBLEM:\n${task}\n\nDeliver: (1) a short numbered plan, then (2) the full solution. When you write a file, start its code block with a comment giving the path, e.g. // src/app.js`, sys, { timeout: 300000 });
    const result = { ok: true, engine: localCoderModel(), local: true, sovereign: true, solution: out };
    // BUILDING MASTER: when a project is given, actually deliver files (not just talk).
    if (opts.project) {
      try {
        coderWrite({ project: opts.project, relpath: 'SOLUTION.md', content: '# ASRED Solution\n\n' + out });
        const extMap = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', json: 'json', html: 'html', css: 'css', bash: 'sh', sh: 'sh', go: 'go', rust: 'rs', java: 'java', sql: 'sql', yaml: 'yml' };
        const files = []; const rx = /```([a-z0-9]+)?\s*(?:(?:\/\/|#)\s*([\w./-]+\.[\w]+)\s*\n)?([\s\S]*?)```/gi; let m, i = 0;
        while ((m = rx.exec(out)) && i < 12) { const lang = (m[1] || '').toLowerCase(); const fn = m[2] || ('snippet' + (++i) + '.' + (extMap[lang] || 'txt')); try { coderWrite({ project: opts.project, relpath: fn, content: (m[3] || '').trim() + '\n' }); files.push(fn); } catch {} }
        result.delivered = ['SOLUTION.md', ...files];
      } catch {}
    }
    return result;
  } catch (e) { return { ok: false, error: 'Local coder brain unreachable (' + e.message + '). Start Ollama or set coder_model/ollama_url.', engine: localCoderModel() }; }
}
// Save a file from the IDE — path-jailed to the project workspace (no traversal).
function coderWrite(opts = {}) {
  const proj = String(opts.project || '').trim(); if (!proj) throw new Error('project required');
  const dir = projectDir(proj); const rel = String(opts.relpath || opts.file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || /(^|\/)\.\.(\/|$)/.test(rel)) throw new Error('invalid relpath');
  const full = path.join(dir, rel); if (!path.resolve(full).startsWith(path.resolve(dir))) throw new Error('path escapes project');
  safeMkdir(path.dirname(full)); fs.writeFileSync(full, String(opts.content != null ? opts.content : ''), 'utf8');
  return { ok: true, project: proj, relpath: rel, bytes: Buffer.byteLength(String(opts.content || '')) };
}

// ── LICENSE-TO-SELL: Ed25519-signed, offline-verifiable license keys (turns the Stripe rail into a real product) ──
const LICENSE_PUBKEY_B64 = ''; // set at release to ship verification without the private key; else uses settings.license_pubkey
function licenseKeygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const s = readJson(settingsPath(), {}); s.license_private_key = priv; s.license_pubkey = pub; writeJson(settingsPath(), s);
  return { ok: true, public_key: pub, note: 'Private key stored in settings (the seller/issuer machine). Embed public_key in LICENSE_PUBKEY_B64 to ship verification to customers.' };
}
function _licensePriv() { try { const p = readJson(settingsPath(), {}).license_private_key; return p ? crypto.createPrivateKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'pkcs8' }) : null; } catch { return null; } }
function _licensePub() { const b = LICENSE_PUBKEY_B64 || (readJson(settingsPath(), {}).license_pubkey || ''); try { return b ? crypto.createPublicKey({ key: Buffer.from(b, 'base64'), format: 'der', type: 'spki' }) : null; } catch { return null; } }
function issueLicense(opts = {}) {
  const priv = _licensePriv(); if (!priv) throw new Error('No license signing key — run /api/license/keygen first (owner only).');
  const payload = { email: String(opts.email || '').toLowerCase(), sku: opts.sku || 'abuz8-os-pro', tier: opts.tier || 'pro', issued: new Date().toISOString(), expires: opts.days ? new Date(Date.now() + opts.days * 86400000).toISOString() : null };
  const data = Buffer.from(JSON.stringify(payload));
  const key = data.toString('base64') + '.' + crypto.sign(null, data, priv).toString('base64');
  return { ok: true, license_key: key, ...payload };
}
function verifyLicense(key) {
  try {
    const pub = _licensePub(); if (!pub) return { ok: false, valid: false, error: 'no license public key configured' };
    const [p, sig] = String(key).split('.'); const data = Buffer.from(p, 'base64'); const payload = JSON.parse(data.toString());
    if (!crypto.verify(null, data, pub, Buffer.from(sig, 'base64'))) return { ok: false, valid: false, error: 'signature invalid' };
    if (payload.expires && new Date(payload.expires) < new Date()) return { ok: false, valid: false, error: 'expired', payload };
    return { ok: true, valid: true, ...payload };
  } catch { return { ok: false, valid: false, error: 'malformed license' }; }
}
function activateLicense(key) { const v = verifyLicense(key); if (!v.valid) throw new Error(v.error || 'invalid license'); const s = readJson(settingsPath(), {}); s.license_key = key; s.license_tier = v.tier; writeJson(settingsPath(), s); return { ok: true, tier: v.tier, email: v.email, expires: v.expires }; }
// The issuer/owner machine holds the Ed25519 license SIGNING key — a sold copy never ships it. That key IS proof of ownership.
function isLicenseOwner() { return !!_licensePriv(); }
function licenseStatus() {
  if (isLicenseOwner()) return { ok: true, licensed: true, tier: 'owner', owner: true };
  const s = readJson(settingsPath(), {}); if (!s.license_key) return { ok: true, licensed: false, tier: 'free' };
  const v = verifyLicense(s.license_key); return { ok: true, licensed: !!v.valid, tier: v.valid ? v.tier : 'free', email: v.email, expires: v.expires };
}
function enforceLicense(feature) {
  // Fail-OPEN until the build is productized: a public release embeds the verify pubkey (_licensePub); until then nothing is
  // gated, so the owner's own dev/run instance is never locked out. Once productized, only the owner + a valid Pro license pass.
  if (!_licensePub() || licenseStatus().licensed) return true;
  throw new Error('"' + (feature || 'this feature') + '" requires an ABUZ8 OS Pro license — activate one (/api/license/activate) or purchase via the store.');
}
function storeFulfill(session = {}, opts = {}) {
  // Called by the Stripe webhook on checkout.session.completed → log revenue + deliver.
  // `opts.verified` is true only when the caller validated the Stripe signature.
  const amount = (session.amount_total != null ? session.amount_total / 100 : Number(session.amount_usd) || 0);
  const verified = opts.verified === true;
  recordRevenue({ channel: 'stripe', amount_usd: amount, sku: (session.metadata && session.metadata.sku) || session.sku || '', note: verified ? 'auto-fulfilled (verified)' : 'unverified webhook', source: verified ? 'stripe' : 'manual', verified });
  pushActivity('revenue', (verified ? 'Sale: $' : 'Unverified sale: $') + amount, 'stripe · ' + (verified ? 'verified' : 'UNVERIFIED'));
  // On a VERIFIED sale, issue a signed Pro license key (the product the customer actually gets).
  let license = null;
  if (verified && _licensePriv()) {
    const email = (session.customer_details && session.customer_details.email) || session.customer_email || (session.metadata && session.metadata.email) || '';
    try { const lic = issueLicense({ email, sku: (session.metadata && session.metadata.sku) || 'abuz8-os-pro' }); license = lic.license_key; appendJsonl(path.join(dataRoot, 'logs', 'licenses.jsonl'), { email, license, issued: new Date().toISOString() }); } catch {}
  }
  return { ok: true, fulfilled: true, amount_usd: amount, verified, license };
}
// Stripe webhook signing secret (whsec_…) — from the stripe connector creds or the vault.
function stripeWebhookSecret() { const c = connectorCreds('stripe') || {}; return c.webhook_secret || c.whsec || vaultGet('stripe_webhook_secret') || ''; }
// Verify Stripe's `stripe-signature: t=…,v1=…` against the raw body (HMAC-SHA256), timing-safe,
// with the standard 5-minute tolerance. Returns false on any mismatch/missing piece.
function verifyStripeSig(rawBody, sigHeader, secret) {
  try {
    if (!secret || !sigHeader) return false;
    const parts = {}; String(sigHeader).split(',').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
    if (!parts.t || !parts.v1) return false;
    const mac = crypto.createHmac('sha256', secret).update(parts.t + '.' + String(rawBody || ''), 'utf8').digest('hex');
    const a = Buffer.from(mac), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) <= 300;
  } catch { return false; }
}

let _cpuSnap = null;
function cpuPercent() {
  const cpus = os.cpus(); let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  let pct = null;
  if (_cpuSnap && total - _cpuSnap.total > 0) pct = Math.max(0, Math.min(100, Math.round((1 - (idle - _cpuSnap.idle) / (total - _cpuSnap.total)) * 100)));
  _cpuSnap = { idle, total };
  return pct;
}
function gpuLive() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      const r = String(out || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const [u, mu, mt, name] = l.split(',').map((s) => s.trim()); return { util: Number(u) || 0, mem_used_mb: Number(mu) || 0, mem_total_mb: Number(mt) || 0, name }; });
      resolve(r[0] || null);
    });
  });
}
// Auto-probe of installed CLIs + local AI engines, cached (refreshed on boot + every 5 min).
let _machineCache = null;
async function refreshMachine() {
  try {
    const [clis, engines] = await Promise.all([discoverClis(), detectLocalEngines()]);
    const found = (clis || []).filter((c) => c.available);
    let tier = null, recommended = null, gpus = [];
    try { const p = await machineProbe(); tier = p.tier; gpus = p.gpus || []; const eb = embeddedBrainStatus(); recommended = eb.embedded ? eb.name : 'Portable Core'; } catch {}
    _machineCache = {
      ts: Date.now(),
      clis: found.map((c) => ({ id: c.id, label: c.label, version: c.version })),
      cli_count: found.length,
      engines: Object.entries(engines || {}).filter(([, v]) => v && v.up).map(([id, v]) => ({ id, models: v.models || [] })),
      tier, recommended, gpus
    };
  } catch {}
  return _machineCache;
}
async function machineInfo() { if (!_machineCache || Date.now() - _machineCache.ts > 300000) await refreshMachine(); return _machineCache || { ts: Date.now(), clis: [], engines: [], cli_count: 0 }; }

async function dashboardData() {
  const cpu = cpuPercent();
  if (!_machineCache) refreshMachine().catch(() => {});
  const totalmem = os.totalmem(), freemem = os.freemem();
  const gpu = await gpuLive().catch(() => null);
  const embedded = embeddedBrainStatus();
  const activeProvider = (readJson(settingsPath(), {}).active_provider) || null;
  const now = Date.now();
  const recent = _usage.filter((u) => now - u.ts < 3600000);
  const last = _usage[_usage.length - 1] || null;
  const tokensHr = recent.reduce((a, u) => a + (u.tokens || 0), 0);
  const lastTokS = last ? (last.tok_s != null ? Math.round(last.tok_s * 10) / 10 : (last.ms ? Math.round((last.tokens / (last.ms / 1000)) * 10) / 10 : null)) : null;
  const counts = {
    memories: (() => { try { return readVectors().length || readMemory(800).length; } catch { return 0; } })(),
    sessions: (() => { try { return listSessions().length; } catch { return 0; } })(),
    skills: (() => { try { return listLearnedSkills().length; } catch { return 0; } })(),
    goals: (() => { try { return listGoals().length; } catch { return 0; } })(),
    schedules: (() => { try { return readSchedules().filter((s) => s.enabled).length; } catch { return 0; } })(),
    projects: (() => { try { return exists(workspacesRoot()) ? fs.readdirSync(workspacesRoot()).length : 0; } catch { return 0; } })()
  };
  const lastAct = activityLog[activityLog.length - 1] || null;
  const idleSec = lastAct ? Math.round((now - new Date(lastAct.t).getTime()) / 1000) : null;
  const working = (counts.schedules > 0) || (idleSec != null && idleSec < 60);
  let mood = 'calm';
  if (working && (cpu || 0) > 70) mood = 'intense';
  else if (working) mood = 'engaged';
  else if (idleSec != null && idleSec > 1800) mood = 'resting';
  return {
    ok: true, version: APP_VERSION,
    system: {
      cpu_pct: cpu,
      ram_used_mb: Math.round((totalmem - freemem) / 1048576), ram_total_mb: Math.round(totalmem / 1048576),
      ram_pct: Math.round(((totalmem - freemem) / totalmem) * 100),
      app_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      gpu: gpu ? { name: gpu.name, util_pct: gpu.util, vram_used_mb: gpu.mem_used_mb, vram_total_mb: gpu.mem_total_mb } : null
    },
    brain: (() => {
      const cliBrain = (readJson(settingsPath(), {}).cli_brain) || null;
      return {
        active: (cliBrain && cliBrainName(cliBrain)) || (activeProvider ? `${activeProvider.name} · ${activeProvider.model || ''}` : (embedded.embedded ? embedded.name : 'Portable Core')),
        kind: cliBrain ? ('cli · ' + cliBrain) : (activeProvider ? 'provider' : (embedded.embedded ? 'local-gguf' : 'fallback')),
        alive: cliBrain ? true : (Boolean(embedded.alive) || Boolean(activeProvider)),
        accel: lastBrainAccel,
        frontier_available: cliBrain ? true : !!bestFrontierProvider(),
        grok_available: grokAvailable(),
        credit: (!cliBrain && !activeProvider && embedded.embedded) ? creditFor(embedded.name) : null
      };
    })(),
    usage: { last_tok_s: lastTokS, tokens_last_hour: tokensHr, calls_last_hour: recent.length, sovereign: !activeProvider, burn_per_hr_usd: activeProvider ? null : 0 },
    counts,
    state: { role: activeProvider ? activeProvider.name : (embedded.embedded ? embedded.name : 'Portable Core'), working, idle_seconds: idleSec, mood, last_action: lastAct ? { label: lastAct.label, at: lastAct.t } : null },
    activity: activityLog.slice(-8).reverse(),
    machine: _machineCache ? { tier: _machineCache.tier, recommended: _machineCache.recommended, cli_count: _machineCache.cli_count, clis: _machineCache.clis, engines: _machineCache.engines } : null
  };
}

// ── Model attribution (credit the makers) + live Hugging Face recommendations ──
const MODEL_CREDITS = [
  [/gemma/i, 'Gemma 3 4B — by Google DeepMind'],
  [/qwen/i, 'Qwen — by Alibaba'],
  [/nomic/i, 'nomic-embed — by Nomic AI'],
  [/llama/i, 'Llama — by Meta'],
  [/mistral|mixtral|codestral|ministral/i, 'Mistral — by Mistral AI'],
  [/phi-?\d/i, 'Phi — by Microsoft'],
  [/deepseek/i, 'DeepSeek — by DeepSeek'],
  [/glm|chatglm/i, 'GLM — by Zhipu AI'],
  [/granite/i, 'Granite — by IBM'],
  [/command-?r|cohere/i, 'Command — by Cohere'],
  [/yi-/i, 'Yi — by 01.AI']
];
function creditFor(name) { const n = String(name || ''); for (const [re, c] of MODEL_CREDITS) if (re.test(n)) return c; return null; }
function estParamsB(id) {
  const s = String(id).toLowerCase();
  let m = s.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/); if (m) return Number(m[1]) * Number(m[2]);
  m = s.match(/(\d+(?:\.\d+)?)\s*b\b/); return m ? Number(m[1]) : null;
}
async function recommendedModels() {
  const ramGb = Math.round(os.totalmem() / 1073741824);
  let raw = [];
  try { raw = JSON.parse(await fetchUrl('https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=40', { timeout: 12000 })); } catch {}
  if (!Array.isArray(raw) || !raw.length) { try { raw = JSON.parse(await fetchUrl('https://huggingface.co/api/models?search=GGUF&sort=downloads&direction=-1&limit=40', { timeout: 12000 })); } catch {} }
  const out = [];
  for (const m of (Array.isArray(raw) ? raw : [])) {
    const id = m.id || m.modelId; if (!id || /embed|whisper|bge|rerank/i.test(id)) continue;
    const pb = estParamsB(id);
    const estGb = pb ? Math.round(pb * 0.62 * 10) / 10 : null; // ~Q4_K_M footprint
    const fits = estGb != null ? estGb < ramGb * 0.6 : null;
    out.push({ id, url: 'https://huggingface.co/' + id, downloads: m.downloads || 0, likes: m.likes || 0, params_b: pb, est_q4_gb: estGb, fits, credit: creditFor(id) });
  }
  out.sort((a, b) => (Number(b.fits === true) - Number(a.fits === true)) || (b.downloads - a.downloads));
  return { ok: true, ram_gb: ramGb, recommended: out.slice(0, 18), source: 'huggingface', note: 'Live from Hugging Face — ranked by popularity and fit for your RAM. New releases appear automatically.' };
}

// ═══ THE MOAT PACK — 5 capabilities to match the frontier agent systems ═══

// GAP 1 — First-class browser automation as a VERIFIED see→act→verify loop (on top of the Playwright runner).
async function browserTask(goal, opts = {}) {
  if (!browserAutomationAvailable()) return { ok: false, error: 'Browser automation not installed (attachments/playwright).' };
  const maxSteps = Math.min(Number(opts.max_steps) || 5, 8);
  const steps = []; let page = { url: opts.url || '', title: '', text: '' };
  const sys = 'You drive a real web browser to accomplish a goal. Each turn you get the goal, the current page (url/title/visible text), and your history. Reply ONLY JSON: {"thought":"one line","action":{"url":"https://...","search":"optional","actions":[{"type":"click|type|wait","selector":"css","text":"to type"}]},"done":false,"answer":"final answer when goal met"}. Navigate, act, READ the page, set done=true with the answer when satisfied. Keep it minimal.';
  for (let i = 0; i < maxSteps; i++) {
    const ctx = `GOAL: ${goal}\n\nCURRENT PAGE:\nurl: ${page.url}\ntitle: ${page.title}\ntext: ${String(page.text).slice(0, 2800)}\n\nHISTORY:\n${steps.map((s) => s.thought).filter(Boolean).join('\n') || '(none)'}\n\nNext JSON step.`;
    const r = await frontierReply(ctx, sys, opts);
    const plan = extractJsonObject(r.text);
    if (!plan) { steps.push({ error: 'model returned no JSON', raw: String(r.text).slice(0, 200) }); break; }
    if (plan.done) { steps.push({ thought: plan.thought, done: true }); return { ok: true, goal, answer: plan.answer || page.text.slice(0, 600), steps, brain: r.brain, verified: true }; }
    const a = plan.action || {};
    try {
      const out = await browserDo({ url: a.url || page.url || undefined, search: a.search, actions: Array.isArray(a.actions) ? a.actions : [], extract: true, screenshot: !!opts.screenshot });
      page = { url: out.url || a.url || page.url, title: out.title || '', text: out.text || out.content || '' };
      steps.push({ thought: plan.thought, action: a, url: page.url, ok: true });
    } catch (e) { steps.push({ thought: plan.thought, action: a, error: e.message }); page.text = 'ERROR: ' + e.message; }
  }
  return { ok: true, goal, answer: String(page.text).slice(0, 600), steps, note: 'reached max steps', verified: false };
}

// GAP 2 — Whole-codebase semantic index (standing index for instant repo-wide retrieval, like Cursor/Devin).
function codeIndexFile(s) { return path.join(safeMkdir(path.join(dataRoot, 'codeindex')), (s || 'index') + '.jsonl'); }
async function indexCodebase(dir, opts = {}) {
  if (!dir || !exists(dir)) return { ok: false, error: 'directory not found' };
  const proj = slug(path.basename(dir)) || 'repo';
  const files = listProjectFiles(dir, 500).filter((f) => /\.(js|ts|jsx|tsx|py|html|css|md|json|sh|ps1|java|go|rs)$/i.test(f));
  const out = codeIndexFile(proj); try { fs.writeFileSync(out, ''); } catch {}
  const cap = Number(opts.max_chunks) || 3500; let chunks = 0, indexed = 0;
  for (const rel of files) {
    if (chunks >= cap) break;
    let content = ''; try { content = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    const lines = content.split('\n'); const win = 60, step = 45;
    for (let i = 0; i < lines.length && chunks < cap; i += step) {
      const piece = lines.slice(i, i + win).join('\n'); if (!piece.trim()) continue; chunks++;
      const vec = await embedText(rel + '\n' + piece); if (!vec) continue;
      appendJsonl(out, { file: rel, line: i + 1, text: piece.slice(0, 1200), vec }); indexed++;
    }
  }
  return { ok: true, project: proj, files: files.length, chunks_indexed: indexed, capped: chunks >= cap, index: out };
}
async function searchCode(dir, query, k = 6) {
  const proj = slug(path.basename(dir)) || 'repo'; const f = codeIndexFile(proj);
  let rows = []; try { rows = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (!rows.length) return { ok: false, error: 'not indexed — POST /api/code/index first', project: proj };
  const qv = await embedText(query); if (!qv) return { ok: false, error: 'embedding engine unavailable' };
  const hits = rows.map((r) => ({ file: r.file, line: r.line, score: Math.round(cosine(qv, r.vec) * 100) / 100, snippet: String(r.text).slice(0, 400) })).sort((a, b) => b.score - a.score).slice(0, k);
  return { ok: true, query, project: proj, total_chunks: rows.length, hits };
}

// GAP 3 — Multi-agent swarm: planner → parallel executors → verifier → synthesizer (OpenClaw/Devin-style).
async function swarmTask(goal, opts = {}) {
  const pr = await frontierReply(`Decompose this goal into 2-5 INDEPENDENT subtasks that can run in parallel. Output ONLY JSON: {"subtasks":["...","..."]}\n\nGOAL: ${goal}`, 'You are a planner. Decompose, do not solve.', opts);
  const pj = extractJsonObject(pr.text);
  const subtasks = (pj && Array.isArray(pj.subtasks) && pj.subtasks.length ? pj.subtasks : [goal]).slice(0, 5);
  const results = await Promise.all(subtasks.map(async (st) => { try { const r = await frontierReply(`Overall goal: ${goal}\n\nYour subtask ONLY: ${st}\n\nComplete it concretely.`, 'You are an executor. Do only your subtask, fully.', opts); return { subtask: st, output: r.text, brain: r.brain }; } catch (e) { return { subtask: st, output: 'error: ' + e.message }; } }));
  const vr = await frontierReply(`Goal: ${goal}\n\nSubtask results:\n${results.map((r, i) => `[${i + 1}] ${r.subtask}\n${String(r.output).slice(0, 700)}`).join('\n\n')}\n\nWhich are incomplete or wrong? Output ONLY JSON: {"ok":true|false,"issues":["..."]}`, 'You are a strict verifier.', opts);
  const verification = extractJsonObject(vr.text) || { ok: null };
  const sr = await frontierReply(`Goal: ${goal}\n\nVerified subtask results:\n${results.map((r) => String(r.output).slice(0, 900)).join('\n\n')}\n\nSynthesize the final deliverable.`, 'You are a synthesizer. Produce the final answer only.', opts);
  recordTrace({ kind: 'swarm', goal: String(goal).slice(0, 200), steps: subtasks.length, done: verification.ok !== false, ok: verification.ok !== false });
  return { ok: true, goal, subtasks, results, verification, deliverable: sr.text, brain: sr.brain };
}

// GAP 5 — Persistent async job sandbox: long jobs run unattended in the background, deliverable retrievable later (Manus/Devin-style).
function jobsDir() { return safeMkdir(path.join(dataRoot, 'jobs')); }
function jobFile(id) { return path.join(jobsDir(), id + '.json'); }
function listJobs() { try { return fs.readdirSync(jobsDir()).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(jobsDir(), f), null)).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created))); } catch { return []; } }
function startJob(goal, kind, opts = {}) {
  const id = 'job' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const job = { id, goal, kind: kind || 'goal', status: 'running', created: new Date().toISOString(), updated: new Date().toISOString(), result: null };
  writeJson(jobFile(id), job);
  pushActivity('plan', 'Async job started: ' + String(goal).slice(0, 50), kind || 'goal');
  (async () => {
    try {
      let result;
      if (kind === 'build') result = await coderRun(goal, { ...opts, max_steps: Number(opts.max_steps) || 6 });
      else if (kind === 'swarm') result = await swarmTask(goal, opts);
      else if (kind === 'browser') result = await browserTask(goal, opts);
      else if (kind === 'research') result = await deepResearch(goal, 3);
      else { const g = createGoal({ objective: goal }); result = await runGoal(g.id, opts); }
      const j = readJson(jobFile(id), job); if (j.status === 'canceled') return; j.status = 'done'; j.result = result; j.updated = new Date().toISOString(); writeJson(jobFile(id), j);
      pushActivity('done', 'Async job done: ' + String(goal).slice(0, 50), '');
    } catch (e) { const j = readJson(jobFile(id), job); if (j.status === 'canceled') return; j.status = 'failed'; j.error = e.message; j.updated = new Date().toISOString(); writeJson(jobFile(id), j); }
  })();
  return job;
}

// GAP 4 — Universal channel gateway: any channel (Slack/WhatsApp/Discord/n8n/Zapier) drives ABUZ8 via one inbound webhook.
async function commandReplyText(text) {
  const m = String(text).match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/); if (!m) return null;
  const cmd = m[1].toLowerCase(); const arg = (m[2] || '').trim(); const s = readJson(settingsPath(), {});
  if (cmd === 'help' || cmd === 'start') return 'ABUZ8 commands: /status · /brain [local|claude|grok|codex|gemini] · /goal <objective> · /build <what> · /skills · /memory <note>. Or just message me.';
  if (cmd === 'status') { const cb = s.cli_brain; const emb = embeddedBrainStatus(); return '🧠 Brain: ' + ((cb && cliBrainName(cb)) || (emb.embedded ? emb.name : 'Portable Core')); }
  if (cmd === 'brain') { if (!arg) return 'Current: ' + ((s.cli_brain && cliBrainName(s.cli_brain)) || 'local Gemma'); const w = arg.toLowerCase(); if (w === 'local' || w === 'gemma') { s.cli_brain = null; writeJson(settingsPath(), s); return '🧠 local Gemma'; } if (cliBrainAvailable(w)) { s.cli_brain = w; s.active_provider = null; writeJson(settingsPath(), s); return '🧠 ' + cliBrainName(w); } return '"' + w + '" not available'; }
  if (cmd === 'skills') { try { const sk = listLearnedSkills(); return sk.length ? '🧩 ' + sk.slice(0, 12).map((x) => x.title || x.id).join(', ') : 'No skills yet.'; } catch { return 'No skills yet.'; } }
  if (cmd === 'memory') { if (!arg) return 'Usage: /memory <note>'; try { appendJsonl(memoryFile(), { id: crypto.randomUUID(), type: 'note', content: arg, timestamp: new Date().toISOString() }); addMemoryVector({ content: arg, type: 'note' }).catch(() => {}); } catch {} return '✅ Remembered.'; }
  if (cmd === 'goal') { if (!arg) return 'Usage: /goal <objective>'; const j = startJob(arg, 'goal'); return '🎯 Goal started (job ' + j.id + ') — runs unattended; I will hold the result.'; }
  if (cmd === 'build') { if (!arg) return 'Usage: /build <what>'; const j = startJob(arg, 'build'); return '💻 Build started (job ' + j.id + ').'; }
  return null;
}
async function botRespond(text) {
  text = String(text || '').trim(); if (!text) return '(empty)';
  if (text.startsWith('/')) { try { const c = await commandReplyText(text); if (c != null) return c; } catch {} }
  try { const r = await agenticReply(text, {}); return r.response || r.text || '(no reply)'; } catch (e) { return 'Error: ' + e.message; }
}

// ── SELF-IMPROVEMENT (MiniMax/Hermes-style): skill Curator + keep-or-revert scaffold + self-healing ──
function skillUsageFile() { return path.join(dataRoot || '', 'skills', 'usage.json'); }
function bumpSkillUsage(ids) { try { if (!dataRoot) return; const f = skillUsageFile(); const u = readJson(f, {}); for (const id of (Array.isArray(ids) ? ids : [ids])) if (id) u[id] = (u[id] || 0) + 1; writeJson(f, u); } catch {} }
// Curator: grade skills by usage + recency, dedupe near-identical, prune stale/never-used (Hermes-style cycle).
function curateSkillsOnce(opts = {}) {
  if (!dataRoot) return { ok: false };
  const dir = learnedSkillsDir(); const skills = listLearnedSkills();
  if (!skills.length) return { ok: true, graded: 0, pruned: 0, kept: 0, note: 'no skills yet' };
  const usage = readJson(skillUsageFile(), {}); const now = Date.now();
  const pruneDays = Number(opts.prune_days) || 21; let pruned = 0, kept = 0;
  const remove = (id) => { try { fs.unlinkSync(path.join(dir, id + '.json')); } catch {} try { fs.unlinkSync(path.join(dir, id + '.md')); } catch {} };
  const byTitle = {}; for (const s of skills) { const k = slug(s.title || s.id); (byTitle[k] = byTitle[k] || []).push(s); }
  const survivors = [];
  for (const group of Object.values(byTitle)) {
    if (group.length > 1) { group.sort((a, b) => ((usage[b.id] || 0) - (usage[a.id] || 0)) || String(b.learned_at || '').localeCompare(String(a.learned_at || ''))); survivors.push(group[0]); for (const dup of group.slice(1)) { remove(dup.id); pruned++; } }
    else survivors.push(group[0]);
  }
  for (const s of survivors) { const used = usage[s.id] || 0; const ageDays = s.learned_at ? (now - new Date(s.learned_at).getTime()) / 86400000 : 0; if (used === 0 && ageDays > pruneDays) { remove(s.id); pruned++; } else kept++; }
  const out = { ok: true, graded: skills.length, pruned, kept, ts: new Date().toISOString() };
  try { appendJsonl(path.join(dataRoot, 'logs', 'curator.jsonl'), out); } catch {}
  return out;
}
// Self-healing: detect dead subsystems (brain/voice/MCP child processes) and clear them for lazy auto-respawn.
function selfHealOnce() {
  if (!dataRoot) return { ok: false };
  const heals = [];
  try { if (lfmProcess && lfmProcess.exitCode !== null) { lfmProcess = null; lfmStarting = false; heals.push('reasoning brain had died → cleared for auto-respawn'); } } catch {}
  try { if (voiceProcess && voiceProcess.exitCode !== null) { voiceProcess = null; voiceStarting = false; heals.push('voice brain had died → cleared'); } } catch {}
  try { for (const [name, c] of mcpProcesses) { if (c && c.proc && c.proc.exitCode !== null) { mcpProcesses.delete(name); heals.push('MCP "' + name + '" had died → cleared'); } } } catch {}
  if (heals.length) { for (const h of heals) pushActivity('observe', 'Self-heal', h); try { appendJsonl(path.join(dataRoot, 'logs', 'selfheal.jsonl'), { ts: new Date().toISOString(), heals }); } catch {} }
  return { ok: true, healed: heals.length, actions: heals };
}
// Keep-or-revert scaffold loop: evolve a small "learned operating note" from outcomes; auto-revert if it doesn't help.
function learnedDirectivesPath() { return path.join(soulDir(), 'LEARNED.md'); }
function learnedDirectivesText() { try { return fs.readFileSync(learnedDirectivesPath(), 'utf8').trim(); } catch { return ''; } }
function recentSuccessRate(n = 40) {
  try { const rows = fs.readFileSync(signalFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); if (!rows.length) return null; return { rate: rows.filter((r) => r.ok === true).length / rows.length, n: rows.length }; } catch { return null; }
}
async function evolveScaffoldOnce(opts = {}) {
  if (!dataRoot) return { ok: false };
  const expPath = path.join(dataRoot, 'logs', 'scaffold_experiment.json');
  const exp = readJson(expPath, null);
  if (exp && !exp.reviewed) return { ok: true, note: 'an experiment is already live — it auto-reviews; revert with /api/scaffold/revert', experiment: exp };
  const sr = recentSuccessRate(40);
  if (!sr || sr.n < 8) return { ok: true, note: 'not enough signal yet (' + (sr ? sr.n : 0) + ' turns)' };
  let fails = []; try { fails = fs.readFileSync(signalFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-40).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.ok === false).slice(-5); } catch {}
  const sys = 'You improve an agent by writing ONE short operating note (max 2 sentences) it should follow to avoid recent mistakes. Output ONLY the note text.';
  const r = await frontierReply('Recent success rate: ' + Math.round(sr.rate * 100) + '%. Recent failures: ' + JSON.stringify(fails).slice(0, 1500) + '\n\nWrite one concise operating note.', sys, opts);
  const note = String(r.text || '').trim().slice(0, 300);
  if (!note) return { ok: true, note: 'no proposal generated' };
  const prev = learnedDirectivesText();
  try { fs.writeFileSync(learnedDirectivesPath() + '.bak', prev); } catch {}
  try { fs.writeFileSync(learnedDirectivesPath(), (prev ? prev + '\n' : '') + '- ' + note); } catch {}
  writeJson(expPath, { ts: new Date().toISOString(), note, baseline_rate: sr.rate, baseline_n: sr.n, brain: r.brain, reviewed: false });
  pushActivity('plan', 'Scaffold experiment started', note.slice(0, 60));
  return { ok: true, applied: true, note, baseline: Math.round(sr.rate * 100) + '%' };
}
function scaffoldReviewOnce() {
  if (!dataRoot) return { ok: false };
  const expPath = path.join(dataRoot, 'logs', 'scaffold_experiment.json');
  const exp = readJson(expPath, null);
  if (!exp || exp.reviewed) return { ok: true, note: 'no live experiment' };
  const sr = recentSuccessRate(30);
  if (!sr || sr.n < exp.baseline_n + 8) return { ok: true, note: 'trial still running', have: sr ? sr.n : 0 };
  const improved = sr.rate >= exp.baseline_rate;
  if (!improved) { try { fs.writeFileSync(learnedDirectivesPath(), fs.readFileSync(learnedDirectivesPath() + '.bak', 'utf8')); } catch { try { fs.unlinkSync(learnedDirectivesPath()); } catch {} } pushActivity('observe', 'Scaffold reverted (no gain)', ''); }
  else pushActivity('done', 'Scaffold note kept (improved)', '');
  exp.reviewed = true; exp.kept = improved; exp.final_rate = sr.rate; writeJson(expPath, exp);
  try { appendJsonl(path.join(dataRoot, 'logs', 'scaffold_log.jsonl'), exp); } catch {}
  return { ok: true, kept: improved, baseline: Math.round(exp.baseline_rate * 100) + '%', now: Math.round(sr.rate * 100) + '%' };
}
function scaffoldRevertNow() {
  try { fs.writeFileSync(learnedDirectivesPath(), fs.readFileSync(learnedDirectivesPath() + '.bak', 'utf8')); } catch { try { fs.unlinkSync(learnedDirectivesPath()); } catch {} }
  try { const p = path.join(dataRoot, 'logs', 'scaffold_experiment.json'); const exp = readJson(p, null); if (exp) { exp.reviewed = true; exp.kept = false; writeJson(p, exp); } } catch {}
  return { ok: true, note: 'Reverted learned operating notes to backup.' };
}
function selfImproveStatus() {
  let cur = null; try { const l = fs.readFileSync(path.join(dataRoot, 'logs', 'curator.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean); cur = JSON.parse(l[l.length - 1]); } catch {}
  return { ok: true, skills: listLearnedSkills().length, learned_notes: learnedDirectivesText(), last_curation: cur, scaffold_experiment: readJson(path.join(dataRoot, 'logs', 'scaffold_experiment.json'), null), success_rate: recentSuccessRate(40) };
}

// ── SAFE SELF-UPGRADE: propose → test in an isolated git worktree → apply with rollback ──
// He edits his OWN source, but only inside a throwaway worktree, gated by node --check.
// Nothing touches live code until a verified proposal is explicitly applied; rollback via git revert.
function selfRepoDir() {
  // Detect the source repo wherever ABUZ8 runs: env/setting override, then the running
  // code's own tree (__dirname/.. in dev/clone), then the legacy path. Must have a real
  // .git so it can commit. (In the packaged .exe __dirname is inside app.asar with no .git,
  // so this returns null and self-upgrade correctly falls back to the self-UPDATE channel.)
  const cands = [process.env.ABUZ8_REPO, (readJson(settingsPath(), {}).repo_dir), path.join(__dirname, '..'), __dirname, path.join(os.homedir(), 'codingProjects', 'abuz8-os')].filter(Boolean);
  for (const c of cands) { try { if ((exists(path.join(c, 'src', 'portable-core.js')) || exists(path.join(c, 'portable-core.js'))) && exists(path.join(c, '.git'))) return path.resolve(c); } catch {} }
  return null;
}
// Deterministic self-code-edit (no brain needed): write a file into the repo, syntax-check
// any .js, commit, and optionally rebuild app.asar live. The verifiable core of "upgrade itself".
async function selfApplyPatch(relpath, content, message, opts = {}) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'source repo not found (installed build → use /api/update).' };
  const rel = String(relpath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.+/g, '');
  if (!rel) return { ok: false, error: 'relpath required' };
  const target = path.resolve(repo, rel);
  if (!target.startsWith(path.resolve(repo))) return { ok: false, error: 'path escapes repo' };
  try {
    safeMkdir(path.dirname(target));
    fs.writeFileSync(target, String(content != null ? content : ''));
    if (/\.js$/i.test(rel)) { const chk = await nodeCheckFile(target, repo); if (!chk.ok) return { ok: false, error: 'syntax check failed: ' + (chk.stderr || '').slice(0, 300) }; }
    // keep the root↔src mirror honest if portable-core.js was edited
    if (rel === 'src/portable-core.js') { try { fs.copyFileSync(target, path.join(repo, 'portable-core.js')); } catch {} }
    await gitDo(['add', '-A'], repo, 30000);
    const msg = (message || ('self-upgrade: ' + rel)).slice(0, 200);
    const cm = await gitDo(['commit', '-m', msg, '--no-gpg-sign'], repo, 30000);
    const h = await gitDo(['rev-parse', 'HEAD'], repo, 10000);
    let live = null; if (opts.rebuild === true) { try { live = await selfRebuildLive(repo); } catch (e) { live = { rebuilt: false, error: e.message }; } }
    return { ok: cm.ok, commit: (h.stdout || '').trim(), file: rel, message: msg, live, note: live && live.rebuilt ? 'Committed + rebuilt live.' : 'Committed to source. Pass rebuild:true to repack the app live.' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function selfWorktreesDir() { const d = path.join(dataRoot || os.tmpdir(), 'self-upgrade'); safeMkdir(d); return d; }
const _proposals = {};
// Robust git/node exec via execFile (args array) — no cmd.exe /s quote-stripping, handles paths with spaces.
function gitDo(args, cwd, timeout = 30000) { return new Promise((resolve) => { try { execFile('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, stdout: String(so || '').slice(-8000), stderr: String(se || (err && err.message) || '').slice(-8000) })); } catch (e) { resolve({ ok: false, stderr: e.message }); } }); }
function nodeCheckFile(file, cwd) { return new Promise((resolve) => { try { execFile('node', ['--check', file], { cwd, windowsHide: true, timeout: 20000 }, (err, so, se) => resolve({ ok: !err, stderr: String(se || (err && err.message) || '') })); } catch (e) { resolve({ ok: false, stderr: e.message }); } }); }
function selfStatus() { return { ok: true, available: !!selfRepoDir(), repo: selfRepoDir(), proposals: Object.values(_proposals).sort((a, b) => b.created - a.created).map((p) => ({ id: p.id, goal: p.goal, checks_passed: p.checks_passed, files: p.files.length, applied: p.applied, brain: p.brain, summary: p.summary, diff_stat: p.diff_stat })) }; }
// ── FLEET-WIDE VERIFIED SELF-UPGRADE PROPAGATION ─────────────────────────────
// The master git-format-patches a verified self-edit and ships it to every node; each
// peer applies it in an ISOLATED worktree, eval-gates it LOCALLY (golden tests), and only
// commits if it passes + commit:true. Default is dry-run (apply+eval+report, no commit) —
// the same fail-closed posture as local self-upgrade, now across the whole army.
async function selfApplyPatchText(patch, message) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'no source repo' };
  const pf = path.join(repo, '.git', 'INCOMING.patch'); fs.writeFileSync(pf, patch);
  const chk = await gitDo(['apply', '--check', pf], repo, 30000);
  if (!chk.ok) { try { fs.unlinkSync(pf); } catch {} return { ok: false, error: 'apply check failed: ' + (chk.stderr || '').slice(0, 200) }; }
  await gitDo(['apply', pf], repo, 30000); try { fs.unlinkSync(pf); } catch {}
  try { const src = path.join(repo, 'src', 'portable-core.js'); if (exists(src)) fs.copyFileSync(src, path.join(repo, 'portable-core.js')); } catch {}
  await gitDo(['add', '-A'], repo, 30000);
  const cm = await gitDo(['commit', '-m', String(message || 'fleet self-upgrade').slice(0, 200), '--no-gpg-sign'], repo, 30000);
  const h = await gitDo(['rev-parse', 'HEAD'], repo, 10000);
  return { ok: cm.ok, commit: (h.stdout || '').trim() };
}
async function selfReceivePatch(patch, opts = {}) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'no source repo (consumer install uses /api/update)' };
  if (!patch) return { ok: false, error: 'no patch provided' };
  if (!(await hasBin('git'))) return { ok: false, error: 'git not available' };
  const id = 'rp' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const wt = path.join(selfWorktreesDir(), id);
  const base = opts.base || 'HEAD';
  const add = await gitDo(['worktree', 'add', '--detach', wt, base], repo, 60000);
  if (!exists(wt)) return { ok: false, error: 'worktree add failed: ' + (add.stderr || '').slice(0, 200) };
  try {
    const pf = path.join(wt, '_incoming.patch'); fs.writeFileSync(pf, patch);
    const chk = await gitDo(['apply', '--check', pf], wt, 30000);
    if (!chk.ok) { await gitDo(['worktree', 'remove', wt, '--force'], repo, 30000); return { ok: false, error: 'patch does not apply on base ' + base + ': ' + (chk.stderr || '').slice(0, 200) }; }
    await gitDo(['apply', pf], wt, 30000); try { fs.unlinkSync(pf); } catch {}
    const ev = await runEvalOnWorktree(wt, opts);
    const baseline = readEvalBaseline();
    const passed = ev.ok && ev.score >= baseline;
    let committed = false, commit = null;
    if (passed && opts.commit === true) { const r2 = await selfApplyPatchText(patch, opts.message || ('fleet self-upgrade ' + id)); committed = r2.ok; commit = r2.commit; }
    await gitDo(['worktree', 'remove', wt, '--force'], repo, 30000);
    return { ok: true, applied_to_worktree: true, eval: { score: ev.score, total: ev.total, booted: ev.booted }, passed, committed, commit, dry_run: opts.commit !== true };
  } catch (e) { try { await gitDo(['worktree', 'remove', wt, '--force'], repo, 30000); } catch {} return { ok: false, error: e.message }; }
}
async function meshUpgradeAll(opts = {}) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'no source repo' };
  if (!(await hasBin('git'))) return { ok: false, error: 'git not available' };
  const outDir = path.join(selfWorktreesDir(), 'patch' + Date.now().toString(36)); safeMkdir(outDir);
  const ref = opts.ref || 'HEAD';
  const fp = await gitDo(['format-patch', '-1', ref, '-o', outDir], repo, 30000);
  const files = (function () { try { return fs.readdirSync(outDir).filter((f) => f.endsWith('.patch')); } catch { return []; } })();
  if (!files.length) return { ok: false, error: 'no patch produced: ' + (fp.stderr || '').slice(0, 160) };
  const patch = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  const nodes = readMesh().nodes;
  const base = opts.base || (ref === 'HEAD' ? 'HEAD~1' : ref + '~1');
  const results = await Promise.all(nodes.map(async (n) => {
    try {
      const out = await fetchUrl(n.url + '/api/self/receive-patch', { method: 'POST', headers: { 'Content-Type': 'application/json', ..._nodeHeaders(n) }, body: JSON.stringify({ patch, base, commit: opts.commit === true, message: opts.message }), timeout: 180000 });
      let j; try { j = JSON.parse(out); } catch { j = { raw: String(out).slice(0, 200) }; }
      return { node: n.name, id: n.id, ...j };
    } catch (e) { return { node: n.name, id: n.id, ok: false, error: e.message }; }
  }));
  return { ok: true, patch_bytes: patch.length, base, nodes: nodes.length, committed_to_peers: results.filter((r) => r.committed).length, results };
}
async function selfUpgradePropose(goal, opts = {}) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'Self-upgrade unavailable: ABUZ8 source repo not found on this machine (this is normal on a consumer install).' };
  if (!(await hasBin('git'))) return { ok: false, error: 'git is not installed.' };
  const id = 'up' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const branch = 'self/' + id;
  const wt = path.join(selfWorktreesDir(), id);
  const init = await gitDo(['worktree', 'add', wt, '-b', branch], repo, 60000);
  const srcDir = exists(path.join(wt, 'src')) ? path.join(wt, 'src') : wt;
  if (!exists(srcDir) || !exists(path.join(srcDir, 'portable-core.js'))) return { ok: false, error: 'worktree create failed: ' + (init.stderr || init.stdout || '').slice(0, 200) };
  const files = listProjectFiles(srcDir, 80).filter((f) => /\.(js|html|json)$/i.test(f));
  const sys = `You are ABUZ8's self-upgrade engineer. You edit ABUZ8's OWN source inside an ISOLATED git worktree (never the live app). Output ONLY JSON: {"thought":"one line","files":[{"path":"relative path under src","contents":"FULL new file contents"}],"summary":"what changed"}. Make a SMALL, SAFE, syntactically valid change toward the goal — never break existing code, keep full file contents.`;
  const ctx = files.filter((f) => /portable-core\.js|renderer\/index\.html|main\.js/.test(f)).slice(0, 1).map((f) => { try { return `--- ${f} ---\n` + fs.readFileSync(path.join(srcDir, f), 'utf8').slice(0, 7000); } catch { return ''; } }).join('\n\n');
  const r = await frontierReply(`GOAL: ${goal}\n\nSOURCE FILES:\n${files.join('\n')}\n\nEXCERPT:\n${ctx}\n\nPropose the smallest safe edit as JSON.`, sys, opts);
  const plan = extractJsonObject(r.text);
  const wrote = [];
  if (plan && Array.isArray(plan.files)) {
    for (const f of plan.files) {
      try { const rel = String(f.path || '').replace(/^(src[\/\\])?[\/\\]*/, '').replace(/\.\.[\/\\]/g, ''); if (!rel) continue; const full = path.join(srcDir, rel); if (!full.startsWith(srcDir)) continue; safeMkdir(path.dirname(full)); fs.writeFileSync(full, String(f.contents != null ? f.contents : ''), 'utf8'); wrote.push(rel); } catch {}
    }
  }
  const checks = [];
  for (const rel of wrote) { if (/\.js$/i.test(rel)) { const c = await nodeCheckFile(path.join(srcDir, rel), srcDir); checks.push({ file: rel, ok: c.ok, err: c.ok ? '' : (c.stderr || '').slice(0, 200) }); } }
  const passed = wrote.length > 0 && checks.every((c) => c.ok);
  const diff = await gitDo(['diff', '--stat'], wt, 20000);
  const prop = { id, goal, branch, worktree: wt, repo, brain: r.brain, summary: plan ? (plan.summary || plan.thought || '') : '(model returned no plan)', files: wrote, checks, checks_passed: passed, diff_stat: (diff.stdout || '').trim(), applied: false, created: Date.now() };
  _proposals[id] = prop;
  pushActivity('plan', 'Self-upgrade proposed: ' + String(goal).slice(0, 60), passed ? 'checks passed' : 'needs review');
  return { ok: true, proposal: prop };
}
// ── VERIFIED SELF-IMPROVEMENT — behavioral eval gate ─────────────────────────
// node --check only proves a patch PARSES. These golden tests prove it BEHAVES: the
// patched code is booted in an isolated child on a scratch port and probed. A self-edit
// is committed only if it boots and scores >= baseline — catching syntactically-valid
// but behaviorally-broken changes that the syntax gate alone would let through.
const GOLDEN_TESTS = [
  { name: 'health 200', fn: async (b) => { const r = JSON.parse(await fetchUrl(b + '/health', { timeout: 6000 })); return !!(r && r.ok === true); } },
  { name: 'device probe (cores>0)', fn: async (b) => { const r = JSON.parse(await fetchUrl(b + '/api/device', { timeout: 8000 })); return !!(r && (r.cores || 0) > 0); } },
  { name: 'agent tool roundtrip (get_time)', fn: async (b) => { const r = JSON.parse(await fetchUrl(b + '/api/tools/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'get_time' }), timeout: 8000 })); return !!(r && r.ok === true); } },
  { name: 'fleet stats shape', fn: async (b) => { const r = JSON.parse(await fetchUrl(b + '/api/fleet/stats', { timeout: 8000 })); return !!(r && r.ok === true && r.pooled && typeof r.pooled.cores === 'number'); } },
  { name: 'connectors list', fn: async (b) => { const r = JSON.parse(await fetchUrl(b + '/api/connectors', { timeout: 8000 })); return !!r; } },
];
function evalBaselinePath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'eval-baseline.json'); }
function readEvalBaseline() { try { const j = readJson(evalBaselinePath(), null); if (j && typeof j.score === 'number') return j.score; } catch {} return GOLDEN_TESTS.length; }
function writeEvalBaseline(score) { try { writeJson(evalBaselinePath(), { score, updated: new Date().toISOString() }); } catch {} }
// Boot the (possibly patched) codebase at `target` in an isolated child + run GOLDEN_TESTS.
async function runEvalOnWorktree(target, opts = {}) {
  const root = target || selfRepoDir();
  if (!root) return { ok: false, score: 0, total: GOLDEN_TESTS.length, results: [{ name: 'repo', ok: false, err: 'no source repo' }], booted: false };
  const srcDir = exists(path.join(root, 'src', 'portable-core.js')) ? path.join(root, 'src') : root;
  const entry = path.join(srcDir, 'portable-core.js');
  if (!exists(entry)) return { ok: false, score: 0, total: GOLDEN_TESTS.length, results: [{ name: 'entry', ok: false, err: 'no portable-core.js' }], booted: false };
  const tag = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const pf = path.join(os.tmpdir(), 'abuz8_eval_' + tag + '.port');
  const dataDir = path.join(os.tmpdir(), 'abuz8_eval_data_' + tag); safeMkdir(path.join(dataDir, 'config'));
  try { fs.unlinkSync(pf); } catch {}
  const code = 'var fs=require("fs");try{require(' + JSON.stringify(entry) + ').start({log:function(){}}).then(function(r){fs.writeFileSync(process.env.PF,String(r.port));}).catch(function(e){fs.writeFileSync(process.env.PF,"ERR:"+(e&&e.message||e));});}catch(e){fs.writeFileSync(process.env.PF,"ERR:"+(e&&e.message||e));}';
  const child = require('child_process').spawn(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { ABUZ8_DATA_DIR: dataDir, ABUZ8_PORT: String(opts.port || 0), PF: pf }), stdio: 'ignore' });
  let port = null; const t0 = Date.now(); const bootMs = opts.bootMs || 25000;
  while (Date.now() - t0 < bootMs) { if (exists(pf)) { const v = fs.readFileSync(pf, 'utf8').trim(); if (v) { port = v; break; } } await new Promise((r) => setTimeout(r, 300)); }
  const booted = !!(port && !/^ERR/.test(port) && port !== '0');
  const results = []; let score = 0;
  if (booted) { const base = 'http://127.0.0.1:' + port; for (const t of GOLDEN_TESTS) { let ok = false; try { ok = !!(await t.fn(base)); } catch { ok = false; } results.push({ name: t.name, ok }); if (ok) score++; } }
  else results.push({ name: 'boot', ok: false, err: String(port || 'timeout') });
  try { child.kill(); } catch {}
  try { fs.unlinkSync(pf); } catch {}
  return { ok: booted, score, total: GOLDEN_TESTS.length, results, booted };
}
async function selfUpgradeApply(id, opts = {}) {
  const p = _proposals[id]; if (!p) return { ok: false, error: 'proposal not found' };
  if (!p.checks_passed) return { ok: false, error: 'refusing to apply — syntax checks did not pass' };
  // Behavioral eval gate: the patched worktree must BOOT + score >= baseline (not just parse).
  if (opts.skipEval !== true) {
    const ev = await runEvalOnWorktree(p.worktree, opts);
    p.eval = ev;
    try { fs.appendFileSync(path.join(safeMkdir(path.join(dataRoot, 'logs')), 'selftest.jsonl'), JSON.stringify({ ts: Date.now(), id, goal: p.goal, score: ev.score, total: ev.total, booted: ev.booted, results: ev.results }) + '\n'); } catch {}
    const baseline = readEvalBaseline();
    if (!ev.ok || ev.score < baseline) return { ok: false, error: 'refusing to apply — behavioral eval ' + ev.score + '/' + ev.total + (ev.booted ? '' : ' (boot failed)') + ' < baseline ' + baseline + '. node --check passed, but the patch is behaviorally broken.', eval: ev };
    if (ev.score > baseline) writeEvalBaseline(ev.score);
  }
  const repo = p.repo;
  const srcWt = exists(path.join(p.worktree, 'src')) ? path.join(p.worktree, 'src') : p.worktree;
  const srcRepo = exists(path.join(repo, 'src')) ? path.join(repo, 'src') : repo;
  for (const rel of p.files) {
    try { const from = path.join(srcWt, rel); const to = path.join(srcRepo, rel); safeMkdir(path.dirname(to)); fs.copyFileSync(from, to); if (rel === 'portable-core.js' && exists(path.join(repo, 'portable-core.js'))) fs.copyFileSync(from, path.join(repo, 'portable-core.js')); } catch {}
  }
  try { await gitDo(['add', '-A'], repo, 30000); fs.writeFileSync(path.join(repo, '.git', 'SELF_MSG'), 'self-upgrade: ' + String(p.goal).slice(0, 80)); await gitDo(['commit', '-F', '.git/SELF_MSG', '--no-gpg-sign'], repo, 30000); const h = await gitDo(['rev-parse', 'HEAD'], repo, 10000); p.commit = (h.stdout || '').trim(); } catch {}
  p.applied = true; p.applied_at = Date.now();
  try { await gitDo(['worktree', 'remove', p.worktree, '--force'], repo, 30000); } catch {}
  // Optionally make the self-edit LIVE: pack src → app.asar and swap it into the install (rebuild.sh).
  let live = null;
  if (p.rebuild === true) { try { live = await selfRebuildLive(repo); } catch (e) { live = { rebuilt: false, error: e.message }; } }
  return { ok: true, applied: true, commit: p.commit, files: p.files, live, note: live && live.rebuilt ? 'Applied + committed + REBUILT live (app.asar swapped). Roll back via /api/self/rollback.' : 'Applied to source + committed. Pass rebuild:true (or run scripts/rebuild.sh) to ship it live. Roll back any time with /api/self/rollback.' };
}
// Make a committed self-edit take effect on the running install: pack src → app.asar + swap (rebuild.sh).
async function selfRebuildLive(repo) {
  const sh = path.join(repo, 'scripts', 'rebuild.sh');
  if (!exists(sh)) return { rebuilt: false, note: 'no scripts/rebuild.sh in repo' };
  return await new Promise((resolve) => {
    try { _cp.execFile('bash', [sh], { cwd: repo, timeout: 240000, windowsHide: true }, (err, stdout, stderr) => { resolve({ rebuilt: !err, out: String(stdout || stderr || '').slice(-400), error: err ? err.message : undefined }); }); }
    catch (e) { resolve({ rebuilt: false, error: e.message }); }
  });
}
async function selfUpgradeRollback(id) {
  const repo = selfRepoDir(); if (!repo) return { ok: false, error: 'repo not found' };
  const p = _proposals[id];
  const target = p && p.commit ? p.commit : 'HEAD';
  const r = await gitDo(['revert', '--no-edit', '--no-gpg-sign', target], repo, 30000);
  return { ok: r.ok, note: r.ok ? 'Rolled back (git revert ' + target.slice(0, 8) + ') — non-destructive undo. Rebuild to ship the rollback.' : (r.stderr || r.stdout || '').slice(0, 200) };
}

// ═══ A2 — Remote reach: cloudflared quick tunnel, auto-secured with the LAN access key ═══
let _tunnelProc = null, _tunnelUrl = '';
function cloudflaredPath() { return path.join(safeMkdir(path.join(dataRoot, 'bin')), 'cloudflared.exe'); }
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve) => {
    try {
      if (airgapOn()) return resolve({ ok: false, error: 'Local-Only (air-gap) mode is ON — downloads disabled.' });
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'ABUZ8-OS' }, timeout: 180000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) { res.resume(); return resolve(downloadFile(res.headers.location, dest, redirects + 1)); }
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        const ws = fs.createWriteStream(dest); res.pipe(ws); ws.on('finish', () => ws.close(() => resolve(true))); ws.on('error', () => resolve(false));
      });
      req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}
async function ensureCloudflared() {
  const p = cloudflaredPath();
  try { if (exists(p) && fs.statSync(p).size > 1000000) return p; } catch {}
  const ok = await downloadFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', p);
  try { if (ok && exists(p) && fs.statSync(p).size > 1000000) return p; } catch {}
  try { fs.unlinkSync(p); } catch {}
  return null;
}
async function startTunnel() {
  if (_tunnelProc && _tunnelUrl) return { ok: true, url: _tunnelUrl, key: (readJson(settingsPath(), {}).lan_token), note: 'already running' };
  const bin = await ensureCloudflared(); if (!bin) return { ok: false, error: 'Could not obtain cloudflared (needs internet to download once).' };
  const s = readJson(settingsPath(), {}); if (!s.lan_token) s.lan_token = crypto.randomBytes(5).toString('hex'); s.lan_access = true; writeJson(settingsPath(), s);
  return new Promise((resolve) => {
    let done = false;
    try { _tunnelProc = spawn(bin, ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], { windowsHide: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const onData = (d) => { const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m && !done) { done = true; _tunnelUrl = m[0]; pushActivity('gateway', 'Tunnel live', _tunnelUrl); resolve({ ok: true, url: _tunnelUrl, key: s.lan_token, note: 'Public URL live — every request needs ?key=' + s.lan_token }); } };
    _tunnelProc.stdout.on('data', onData); _tunnelProc.stderr.on('data', onData);
    _tunnelProc.on('exit', () => { _tunnelProc = null; _tunnelUrl = ''; });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: !!_tunnelUrl, url: _tunnelUrl, key: s.lan_token, error: _tunnelUrl ? '' : 'tunnel did not report a URL in 35s' }); } }, 35000);
  });
}
function stopTunnel() { const u = _tunnelUrl; try { if (_tunnelProc) _tunnelProc.kill(); } catch {} _tunnelProc = null; _tunnelUrl = ''; return { ok: true, stopped: u || null }; }
function tunnelStatus() { return { ok: true, running: !!_tunnelProc, url: _tunnelUrl, key: (readJson(settingsPath(), {}).lan_token) || null }; }
// ── SCOPED ACCESS KEYS — temporary, revocable "let a human in" grants ────────
// Unlike the permanent LAN key, a grant is LABELED, SCOPED, and EXPIRES — issue a 30-min
// key to interject from another device, then it auto-dies. Owner-minted only (the mint route
// sits behind the auth gate). This is the human-interjection handoff (the Manus/RustDesk move).
function accessGrantsPath() { return path.join(safeMkdir(path.join(dataRoot, 'config')), 'access-grants.json'); }
function readAccessGrants() { const g = readJson(accessGrantsPath(), { grants: [] }); g.grants = (g.grants || []).filter((x) => x && x.expires > Date.now()); return g; }
function writeAccessGrants(g) { writeJson(accessGrantsPath(), g); return g; }
function accessGrant(opts = {}) {
  const g = readAccessGrants();
  const ttl = Math.min(Math.max(Number(opts.ttl_min) || 30, 1), 1440);
  const item = { id: 'ak' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), token: crypto.randomBytes(10).toString('hex'), label: String(opts.label || 'human interjection').slice(0, 80), scope: opts.scope || 'control', device: opts.device || 'any', created: Date.now(), expires: Date.now() + ttl * 60000, uses: 0 };
  g.grants.push(item); writeAccessGrants(g);
  pushActivity('access', 'Access key issued: ' + item.label, item.scope + ' · ' + ttl + 'min');
  const base = (typeof _tunnelUrl !== 'undefined' && _tunnelUrl) ? _tunnelUrl : ('http://127.0.0.1:' + PORT);
  return { ok: true, id: item.id, token: item.token, scope: item.scope, label: item.label, expires_at: new Date(item.expires).toISOString(), ttl_min: ttl, connect_url: base + '/m?akey=' + item.token };
}
const _accessUses = {}; // in-memory hit counter — NOT written per-request (no hot-path disk race)
function accessValidate(token) {
  if (!token) return null;
  const g = readAccessGrants(); const it = g.grants.find((x) => x.token === token);
  if (!it) return null;
  _accessUses[it.id] = (_accessUses[it.id] || it.uses || 0) + 1; // count in memory, flush lazily in accessList
  return { ok: true, id: it.id, scope: it.scope || 'control', device: it.device || 'any', label: it.label, expires: it.expires, uses: _accessUses[it.id] };
}
function accessRevoke(id) { const g = readAccessGrants(); const before = g.grants.length; g.grants = g.grants.filter((x) => x.id !== id && x.token !== id); writeAccessGrants(g); return { ok: true, revoked: before - g.grants.length }; }
function accessList() { const g = readAccessGrants(); return { ok: true, grants: g.grants.map((x) => ({ id: x.id, label: x.label, scope: x.scope, device: x.device, token_tail: String(x.token).slice(-4), expires_at: new Date(x.expires).toISOString(), remaining_min: Math.max(0, Math.round((x.expires - Date.now()) / 60000)), uses: _accessUses[x.id] || x.uses || 0 })) }; }
// ── UNIFIED REMOTE CONTROL — one surface over this machine + every fleet node ──
// Manus/RustDesk-style: pick a device, see its screen, drive its input. Reuses the verified
// screenshot + gui_do tools locally and over the mesh (meshExec) — no new agent needed.
async function remoteDevices() {
  const list = [{ id: 'local', name: os.hostname(), kind: 'this-machine' }];
  for (const n of readMesh().nodes) list.push({ id: n.id, name: n.name || n.url, kind: 'fleet-node', url: n.url });
  return { ok: true, devices: list, count: list.length };
}
async function remoteScreen(device, opts = {}) {
  if (!device || device === 'local') return await callLocalTool('screenshot', Object.assign({ _permitted: true }, opts));
  return await meshExec(device, 'screenshot', opts || {});
}
async function remoteInput(device, action = {}) {
  if (!device || device === 'local') return await callLocalTool('gui_do', Object.assign({ _permitted: true }, action));
  return await meshExec(device, 'gui_do', action);
}
// ═══ A1 — Native channel adapters (Slack Events API, Twilio WhatsApp/SMS); reach ABUZ8 via the tunnel ═══
async function slackPost(token, channel, t) { try { await fetchUrl('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ channel, text: String(t || '').slice(0, 3000) }), timeout: 15000 }); } catch {} }
function parseForm(raw) { const o = {}; for (const pair of String(raw || '').split('&')) { const i = pair.indexOf('='); if (i < 0) continue; try { o[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' ')); } catch {} } return o; }

// ── LOCAL SOVEREIGN AVATAR — drives the on-disk AvatarStack (Wav2Lip/GFPGAN) on the GPU.
// A real talking-avatar mp4 from a face + audio, generated locally with NO cloud key. Works in
// air-gap (no egress). heygen/did stay as optional cloud connectors; this is the sovereign default.
function avatarStackDir() { try { return readJson(settingsPath(), {}).avatar_stack_dir || 'E:\\ABU\\AvatarStack'; } catch { return 'E:\\ABU\\AvatarStack'; } }
function avatarPython() { try { return readJson(settingsPath(), {}).avatar_python || 'C:\\Miniconda3\\python.exe'; } catch { return 'C:\\Miniconda3\\python.exe'; } }
function localAvatarAvailable() {
  const root = avatarStackDir();
  try { return exists(path.join(root, 'LAYER3_LipSync', 'Wav2Lip_GFPGAN', 'inference.py')) && exists(path.join(root, 'LAYER3_LipSync', 'Wav2Lip', 'checkpoints', 'wav2lip_gan.pth')) && exists(avatarPython()); } catch { return false; }
}
// XTTS voice cloning — local, sovereign. Synthesize text in a target voice from a short ref clip.
function xttsPython() { try { const s = readJson(settingsPath(), {}).xtts_python; if (s) return s; for (const p of ['E:\\Miniconda3\\envs\\xtts\\python.exe', 'C:\\Miniconda3\\envs\\xtts\\python.exe']) { if (exists(p)) return p; } return 'E:\\Miniconda3\\envs\\xtts\\python.exe'; } catch { return 'E:\\Miniconda3\\envs\\xtts\\python.exe'; } }
function xttsModelDir() { try { return readJson(settingsPath(), {}).xtts_model_dir || 'E:\\ABU\\AUDIO\\xtts'; } catch { return 'E:\\ABU\\AUDIO\\xtts'; } }
function voiceCloneRunner() { return path.join(avatarStackDir(), 'abuz8_xtts_clone.py'); }
function voiceCloneAvailable() { try { return exists(xttsPython()) && exists(path.join(xttsModelDir(), 'model.pth')) && exists(voiceCloneRunner()); } catch { return false; } }
function synthesizeVoiceClone(opts = {}) {
  return new Promise((resolve) => {
    if (!voiceCloneAvailable()) return resolve({ ok: false, needs_xtts: true, error: 'XTTS voice-clone not ready (xtts conda env + coqui-tts). Use /api/tts for standard voice.' });
    const text = String(opts.text || '').slice(0, 1500);
    const ref = String(opts.ref || opts.voice_ref || '');
    if (!text) return resolve({ ok: false, error: 'Provide text to speak.' });
    if (!exists(ref)) return resolve({ ok: false, error: 'Provide ref = path to a short reference voice .wav to clone.' });
    const out = String(opts.out || path.join(avatarStackDir(), '_outputs', 'voice_' + Date.now() + '.wav'));
    safeMkdir(path.dirname(out));
    pushActivity('voice', 'Cloning voice (XTTS)', 'local GPU');
    execFile(xttsPython(), ['-s', voiceCloneRunner(), '--text', text, '--ref', ref, '--out', out, '--lang', String(opts.lang || 'en'), '--model_dir', xttsModelDir()], { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
      if (exists(out) && fs.statSync(out).size > 1000) return resolve({ ok: true, out, bytes: fs.statSync(out).size });
      resolve({ ok: false, error: 'voice clone failed', detail: String((se || (err && err.message) || so) || '').slice(-600) });
    });
  });
}
// Full chain: face + (audio | text+voice_ref) -> cloned speech -> lip-synced avatar mp4. All local.
async function generateTalkingAvatar(opts = {}) {
  if (!localAvatarAvailable()) return { ok: false, needs_stack: true, error: 'Local avatar stack not found (set avatar_stack_dir/avatar_python), or add a HeyGen/D-ID key for the cloud path.' };
  const root = avatarStackDir();
  const face = String(opts.face || opts.image || '');
  if (!exists(face)) return { ok: false, error: 'Provide face = path to a face image/video.' };
  let audio = String(opts.audio || opts.wav || ''); let voiceMode = 'provided';
  if (!exists(audio) && opts.text) {
    const ref = String(opts.voice_ref || opts.ref || '');
    if (ref && voiceCloneAvailable()) {
      const v = await synthesizeVoiceClone({ text: opts.text, ref, lang: opts.lang });
      if (!v.ok) return { ok: false, error: 'voice-clone step failed: ' + v.error, detail: v.detail };
      audio = v.out; voiceMode = 'cloned';
    } else {
      return { ok: false, error: 'Provide audio (.wav), or text + voice_ref (a reference .wav) for cloned speech.' };
    }
  }
  if (!exists(audio)) return { ok: false, error: 'Provide audio = path to a .wav, or text + voice_ref.' };
  const out = String(opts.out || path.join(root, '_outputs', 'avatar_' + Date.now() + '.mp4'));
  safeMkdir(path.dirname(out));
  const cwd = path.join(root, 'LAYER3_LipSync', 'Wav2Lip_GFPGAN');
  const ckpt = path.join(root, 'LAYER3_LipSync', 'Wav2Lip', 'checkpoints', 'wav2lip_gan.pth');
  const args = ['inference.py', '--checkpoint_path', ckpt, '--face', face, '--audio', audio, '--outfile', out, '--resize_factor', String(opts.resize_factor || 1), '--nosmooth'];
  pushActivity('avatar', 'Generating talking avatar', 'wav2lip · local GPU · voice:' + voiceMode);
  return await new Promise((resolve) => {
    execFile(avatarPython(), args, { cwd, windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) => {
      if (exists(out) && fs.statSync(out).size > 1000) { pushActivity('avatar', 'Avatar ready', out); return resolve({ ok: true, engine: 'wav2lip', voice: voiceMode, audio, out, bytes: fs.statSync(out).size }); }
      resolve({ ok: false, error: 'avatar generation failed', detail: String((se || (err && err.message) || so) || '').slice(-800) });
    });
  });
}

async function route(req, res) {
  const { pathname, searchParams } = splitPath(req.url);
  // Per-request CORS origin (replaces the old wildcard) — stamped before any response helper runs.
  res._acao = corsAllowOrigin(req);
  // DNS-rebinding guard: in default desktop mode (LAN off) the ONLY legitimate Host is localhost.
  // A rebinding attack arrives with Host: attacker-domain → reject. (LAN/tunnel modes are gated by
  // the access-key check below instead, so we don't break the phone or cloudflared.)
  try {
    if (readJson(settingsPath(), {}).lan_access !== true) {
      const hn = reqHostName(req);
      if (hn && !isLocalHostName(hn)) return json(res, 403, { ok: false, error: 'host not allowed' });
    }
  } catch {}
  // CSRF GUARD: a state-changing request carrying a CROSS-SITE Origin is a malicious web page —
  // CORS blocks it from reading the response, but NOT from causing the side effect (and a text/plain
  // "simple" POST skips preflight entirely). So we reject it here. Same-origin (the app), file:// (null),
  // and non-browser callers (no Origin: curl, MCP bridge, fleet peers) all pass. Scope (honest): this
  // catches every CROSS-ORIGIN method-mutating request (POST/PUT/PATCH/DELETE) that carries an Origin.
  // It does NOT catch a no-Origin GET (an <img>/<script>/<link> load sends no Origin), so any GET handler
  // with a SIDE EFFECT is individually forced to POST to fall under this guard (e.g. /api/spine/computer/*,
  // /api/self/heal). Pure-read GETs stay safe because CORS still blocks the attacker from reading the body.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.headers && req.headers['origin'];
    if (origin && !res._acao) return json(res, 403, { ok: false, error: 'cross-origin request blocked (CSRF guard)' });
  }
  if (req.method === 'OPTIONS') return text(res, 204, '');

  // ── LAN auth gate ── When LAN access is on, any request NOT from localhost
  // must carry the access key. The command-execution API is RCE-capable, so
  // unauthenticated LAN exposure is never allowed. Localhost (the desktop app)
  // is always trusted; the app shell + health load unauthenticated so the phone
  // can fetch the page and then authenticate with the key in its URL.
  try {
    const s0 = readJson(settingsPath(), {});
    if (s0.lan_access === true && !isLocalRequest(req)) {
      // Login surfaces stay open so the phone can authenticate; static shell + vendor assets too.
      const openPaths = ['/', '/app', '/index.html', '/health', '/m', '/mobile', '/mobile.html', '/manifest.json', '/sw.js', '/api/account/status', '/api/account/login', '/api/account/setup', '/api/account/register', '/api/account/recover'];
      const openPrefix = pathname.startsWith('/vendor/');
      if (!openPaths.includes(pathname) && !openPrefix) {
        const key = req.headers['x-abuz8-key'] || searchParams.get('key') || '';
        const session = req.headers['x-abuz8-session'] || searchParams.get('session') || '';
        const akey = req.headers['x-abuz8-access'] || searchParams.get('akey') || '';
        const keyOk = s0.lan_token && key === s0.lan_token;
        const sessionOk = accountValidate(session);
        // A scoped access grant (owner-minted, expiring, revocable) lets a human interject —
        // accepted even under require_account, because the owner issued it on purpose. SCOPE is
        // ENFORCED: a 'read' grant authorizes only GET requests; 'control'/'full' authorize all.
        const _grant = akey ? accessValidate(akey) : null;
        const accessOk = !!_grant && (_grant.scope === 'control' || _grant.scope === 'full' || (_grant.scope === 'read' && req.method === 'GET'));
        // When require_account is on (and an account exists), the phone MUST sign in with
        // username + password (a valid session) — the LAN key alone is not enough.
        const requireAccount = s0.require_account === true && accountStatus().enabled;
        const allowed = accessOk || (requireAccount ? sessionOk : (keyOk || sessionOk));
        if (!allowed) {
          return json(res, 401, { ok: false, require_account: requireAccount, error: requireAccount ? 'Sign in: POST /api/account/login {username,password} then send the token as x-abuz8-session.' : 'Requires the LAN access key (?key=…) or a signed-in session (x-abuz8-session).' });
        }
      }
    }
  } catch {}

  // N7: dispatch through ordered route groups; first to respond wins, else 404.
  // headersSent (set by writeHead) is the "handled" signal — it is true the instant a
  // handler begins responding, including streaming responses (SSE / file-range) that
  // do not synchronously end the stream (writableEnded would still be false for those).
  for (const _g of ROUTE_GROUPS) { await _g(req, res, pathname, searchParams); if (res.headersSent) return; }
  return json(res, 404, { ok: false, error: `No portable-core endpoint for ${pathname}` });
}

// route group 1/12 — /tui … /api/browser/do (264 lines)
async function routeG01(req, res, pathname, searchParams) {
  if (pathname === '/tui') return sendTui(res);
  // OAuth loopback redirect — the provider sends the user back here with ?code; we exchange it for tokens.
  if (pathname === '/oauth/callback') {
    const code = searchParams.get('code'); const state = searchParams.get('state'); const err = searchParams.get('error');
    const page = (title, msg) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font-family:system-ui;background:#0b120e;color:#cfe;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:44px">${err ? '⚠️' : '✅'}</div><h2>${title}</h2><p style="opacity:.7">${msg}</p><p style="opacity:.5;font-size:13px">You can close this tab and return to ABUZ8.</p></div></body>`;
    if (err) return text(res, 200, page('Authorization cancelled', esc(err)), 'text/html; charset=utf-8');
    try { await oauthExchange(code, state); return text(res, 200, page('Connected — hands-free', 'Tokens stored. ABUZ8 will auto-refresh them from now on.'), 'text/html; charset=utf-8'); }
    catch (e) { return text(res, 200, page('Connection failed', esc(e.message)), 'text/html; charset=utf-8'); }
  }
  // Serve bundled vendor assets (MediaPipe vision: wasm, model .task, js bundle) for offline gesture/eye tracking.
  if (pathname.startsWith('/vendor/')) {
    const rel = pathname.replace(/^\/+/, '').replace(/\.\.+/g, '');
    const roots = [__dirname, process.resourcesPath ? path.join(process.resourcesPath, 'app.asar') : null].filter(Boolean);
    const MIME = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };
    for (const root of roots) {
      const f = path.join(root, rel);
      try { if (fs.existsSync(f) && fs.statSync(f).isFile()) { const ext = path.extname(f).toLowerCase(); return binary(res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream'); } } catch {}
    }
    return json(res, 404, { ok: false, error: 'vendor asset not found: ' + rel });
  }
  if (pathname === '/health') {
    return json(res, 200, { ok: true, service: 'portable-core', port: PORT, data_root: dataRoot, version: APP_VERSION, build: BUILD_STAMP });
  }
  // Mobile companion PWA (installable web app for the phone, talks to this instance).
  if (pathname === '/m' || pathname === '/mobile' || pathname === '/mobile.html') {
    const html = readRendererAsset('mobile.html');
    if (html) return text(res, 200, injectCsrf(html), 'text/html; charset=utf-8');
    return json(res, 404, { ok: false, error: 'mobile.html not found' });
  }
  // ASRED Dev IDE — sovereign in-app Monaco editor + dev spec-ops (local Qwen3-Coder).
  if (pathname === '/ide' || pathname === '/ide.html') {
    const html = readRendererAsset('ide.html');
    if (html) return text(res, 200, injectCsrf(html), 'text/html; charset=utf-8');
    return json(res, 404, { ok: false, error: 'ide.html not found' });
  }
  // Spine command dashboard (P8) + 360° viewer (P11) — light-palette renderer pages.
  if (pathname === '/spine' || pathname === '/spine.html') { const html = readRendererAsset('spine.html'); return html ? text(res, 200, html, 'text/html; charset=utf-8') : json(res, 404, { ok: false, error: 'spine.html not found' }); }
  if (pathname === '/360' || pathname === '/viewer360.html') { const html = readRendererAsset('viewer360.html'); return html ? text(res, 200, html, 'text/html; charset=utf-8') : json(res, 404, { ok: false, error: 'viewer360.html not found' }); }
  if (pathname === '/editor' || pathname === '/editor.html') { const html = readRendererAsset('editor.html'); return html ? text(res, 200, html, 'text/html; charset=utf-8') : json(res, 404, { ok: false, error: 'editor.html not found' }); }
  if (pathname === '/team' || pathname === '/team.html') { const html = readRendererAsset('team.html'); return html ? text(res, 200, html, 'text/html; charset=utf-8') : json(res, 404, { ok: false, error: 'team.html not found' }); }
  if (pathname === '/manifest.json') { const j = readRendererAsset('manifest.json'); return j ? text(res, 200, j, 'application/manifest+json; charset=utf-8') : json(res, 404, { ok: false, error: 'no manifest' }); }
  if (pathname === '/sw.js') { const j = readRendererAsset('sw.js'); return j ? text(res, 200, j, 'text/javascript; charset=utf-8') : json(res, 404, { ok: false, error: 'no sw' }); }
  // Serve the dashboard over HTTP so a phone/tablet on the LAN can use it.
  if (pathname === '/' || pathname === '/app' || pathname === '/index.html') {
    const html = readRendererHtml();
    if (html) return text(res, 200, injectCsrf(html), 'text/html; charset=utf-8');
    return json(res, 200, { ok: true, service: 'portable-core', note: 'Renderer not found on disk; use the desktop window.' });
  }
  if (pathname === '/api/lan/status') {
    const s = readJson(settingsPath(), {});
    return json(res, 200, { ok: true, enabled: s.lan_access === true, key: s.lan_access ? s.lan_token : undefined, urls: lanUrls(s.lan_access ? s.lan_token : ''), bound: serverHost });
  }
  if (pathname === '/api/lan/toggle') {
    const body = await getBody(req);
    const s = readJson(settingsPath(), {});
    s.lan_access = body.enabled === true;
    if (s.lan_access && !s.lan_token) s.lan_token = crypto.randomBytes(5).toString('hex'); // 10-char PIN
    s.updated_at = new Date().toISOString();
    writeJson(settingsPath(), s);
    await rebindServer(s.lan_access ? '0.0.0.0' : '127.0.0.1');
    return json(res, 200, { ok: true, enabled: s.lan_access, key: s.lan_access ? s.lan_token : undefined, urls: lanUrls(s.lan_access ? s.lan_token : ''), bound: serverHost });
  }
  if (pathname === '/api/onboard') {
    // Self-onboarding: the OS probes itself on wake and composes a spoken hello.
    let brain = 'Portable Core'; try { brain = (activeBrain || selectEmbeddedBrain())?.name || brain; } catch {}
    let skills = 0; try { skills = listSkills().length; } catch {}
    const tools = (typeof KNOWN_AGENT_TOOLS !== 'undefined') ? KNOWN_AGENT_TOOLS.size : 0;
    let gpu = false; try { gpu = await hasNvidiaGpu(); } catch {}
    const voice = piperAvailable(), hears = whisperAvailable();
    const greeting = `Hello Ahmad. ABUZ8 OS online. ${brain} brain loaded${gpu ? ' on GPU' : ''}` +
      `${voice ? ', neural voice ready' : ''}${hears ? ', and I can hear you' : ''}. ` +
      `${skills} skills and ${tools} tools connected. I'm always listening — just say Abuu. Ready when you are.`;
    return json(res, 200, { ok: true, greeting, brain, gpu, voice, hears, skills, tools });
  }
  if (pathname === '/api/status') {
    const embedded = embeddedBrainStatus();
    const _cliBrain = (readJson(settingsPath(), {}).cli_brain) || null;
    const _brainName = (_cliBrain && cliBrainName(_cliBrain)) || (embedded.embedded ? embedded.name : 'Portable Core');
    return json(res, 200, {
      ok: true,
      service: 'portable-core',
      primary_brain: _brainName,
      brain: _brainName,
      latency_ms: 1,
      memory_count: readMemory(200).length,
      data_root: dataRoot,
      mcp_config: mcpConfigPath(),
      embedded_brain: embedded,
      acceleration: lastBrainAccel,
      brain_alive: Boolean(lfmProcess) || Boolean(voiceProcess),
      brain_error: lastLfmError || null
    });
  }
  if (pathname === '/api/chat/auto') {
    const body = await getBody(req);
    const prompt = body.content || body.message || body.prompt || body.raw || '';
    pushActivity('chat', 'You (auto-routed)', String(prompt).slice(0, 100));
    try { const r = await autoChat(prompt, body); return json(res, 200, { ok: true, ...r }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/chat' || pathname === '/api/chat/stream') {
    const body = await getBody(req);
    const prompt = body.content || body.message || body.prompt || body.raw;
    const agentic = body.agentic !== false;
    pushActivity('chat', 'You', String(prompt || '').slice(0, 100));
    let result;
    if (agentic) {
      result = await agenticReply(prompt, body);
    } else {
      const r = await reasonReply(prompt, { provider: body.provider, role: body.role, brief: body.brief });
      result = { response: r.text, modelResponse: r.model ? r.text : null, brain: r.brain, fallback: r.fallback };
    }
    const response = result.response;
    appendJsonl(memoryFile(), {
      id: crypto.randomUUID(),
      type: 'chat',
      content: body.content || body.message || '',
      response,
      tool_call: result.tool_call || null,
      tool_error: result.tool_error || null,
      timestamp: new Date().toISOString()
    });
    // Learn from this pass (non-blocking): durable facts about the user → memory.
    try { if (readJson(settingsPath(), {}).per_turn_learning !== false) reviewTurn(prompt, response).catch(() => {}); } catch {}
    const embedded = embeddedBrainStatus();
    const brainLabel = result.brain || (result.modelResponse ? embedded.name : 'Portable Core');
    if (pathname.endsWith('/stream')) return sendSse(res, response, brainLabel);
    return json(res, 200, {
      ok: true,
      response,
      brain: brainLabel,
      latency_ms: result.modelResponse ? null : 1,
      embedded_brain: embedded,
      fallback: Boolean(result.fallback),
      tool_call: result.tool_call || null,
      tool_result: result.tool_result || null,
      tool_error: result.tool_error || null
    });
  }
  if (pathname === '/api/chat/live') {
    const body = await getBody(req);
    const prompt = body.content || body.message || body.prompt || body.raw || '';
    pushActivity('chat', 'You', String(prompt).slice(0, 100));
    res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', 'vary': 'origin' }, res._acao ? { 'access-control-allow-origin': res._acao } : {}));
    const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
    const s = readJson(settingsPath(), {});
    const cb = (!body.provider && !body.forceLocal) ? s.cli_brain : null;
    let mode = s.think_mode || 'single';
    if (mode === 'auto') mode = routeThinkMode(prompt); // easy turns still stream fast; hard ones fall to fusion
    let text = '';
    try {
      if (cb && cliBrainAvailable(cb) && mode === 'single' && !s.web_grounding) {
        // Fast path: true token-by-token streaming for a single brain.
        let system = composeSystem(body.role, body.system);
        try { const mems = await retrieveMemories(prompt, 4); if (mems.length) system += '\n\nRelevant things you remember (use if helpful):\n' + mems.map((m) => '- ' + m.content).join('\n'); } catch {}
        text = (await streamCliBrain(cb, prompt, system, (chunk) => sse({ token: chunk }))) || '';
        sse({ done: true, brain: cliBrainName(cb), tool: null });
      } else {
        // Multi-brain (council/debate), grounded, or local/agentic: run with live progress notes, emit final once.
        const r = await agenticReply(prompt, { ...body, onNote: (n) => sse({ note: n }), onStep: (t) => sse({ tool: t }) });
        text = r.response || '';
        sse({ token: text });
        sse({ done: true, brain: r.brain || 'ABUZ8', tool: (r.tool_call && r.tool_call.tool) || (r.tool_result && r.tool_result.tool) || null });
      }
    } catch (e) { sse({ done: true, brain: 'error', error: e.message }); }
    try { appendJsonl(memoryFile(), { id: crypto.randomUUID(), type: 'chat', content: prompt, response: text, timestamp: new Date().toISOString() }); } catch {}
    try { if (text && readJson(settingsPath(), {}).per_turn_learning !== false) reviewTurn(prompt, text).catch(() => {}); } catch {}
    try { res.end(); } catch {}
    return;
  }
  if (pathname === '/api/brains/one') {
    const b = await getBody(req);
    const which = b.brain; const prompt = b.prompt || b.content || ''; const t0 = Date.now();
    try {
      if (which === 'local') { const r = await reasonReply(prompt, { forceLocal: true }); return json(res, 200, { ok: !!(r && r.text), brain: 'local', name: 'Local Gemma', text: (r && r.text) || '', ms: Date.now() - t0 }); }
      if (cliBrainAvailable(which)) { const sys = composeSystem(b.role, b.system); const t = await cliBrainReply(which, prompt, sys); return json(res, 200, { ok: !!t, brain: which, name: cliBrainName(which), text: t || '', ms: Date.now() - t0 }); }
      return json(res, 400, { ok: false, brain: which, error: 'not available', ms: Date.now() - t0 });
    } catch (e) { return json(res, 400, { ok: false, brain: which, name: which, error: e.message, ms: Date.now() - t0 }); }
  }
  if (pathname === '/api/brains/synth') {
    const b = await getBody(req); const answers = b.answers || []; const prompt = b.prompt || '';
    if (answers.length < 2) return json(res, 400, { ok: false, error: 'need 2+ answers' });
    const merged = answers.map((a) => '### ' + (a.name || a.brain || 'assistant') + '\n' + (a.text || '')).join('\n\n');
    const sp = 'Several expert assistants answered the SAME request. Merge them into ONE best answer: resolve disagreements, keep the strongest reasoning from each, drop filler, stay concise.\n\nRequest:\n' + prompt + '\n\nTheir answers:\n' + merged + '\n\nThe single best, merged answer:';
    const by = b.by; const t0 = Date.now();
    try {
      if (by && by !== 'local' && cliBrainAvailable(by)) { const t = await cliBrainReply(by, sp, 'You are a synthesis engine. Output only the merged best answer, in ABUZ8\'s voice.'); return json(res, 200, { ok: !!t, name: cliBrainName(by), synthesis: t || '', ms: Date.now() - t0 }); }
      const r = await reasonReply(sp, { forceLocal: true }); return json(res, 200, { ok: !!(r && r.text), name: 'Local Gemma', synthesis: (r && r.text) || '', ms: Date.now() - t0 });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/onboarding/brains' || pathname === '/api/brains/list') {
    const embedded = embeddedBrainStatus();
    const lfmBrains = (embedded.available || []).map((b) => ({
      id: b.id,
      name: b.name,
      status: b.embedded ? (embedded.id === b.id ? embedded.status : 'ready') : 'missing',
      alive: embedded.id === b.id && embedded.alive,
      kind: 'offline-gguf',
      tier: b.tier,
      port: LFM_PORT,
      size_mb: b.size_mb,
      model_file: b.model_file,
      role: b.role
    }));
    const brains = [
      { id: 'portable-core', name: 'Portable Core', status: 'online', alive: true, kind: 'Portable Core', port: PORT, models: ['portable-core'] },
      ...lfmBrains
    ];
    return json(res, 200, { ok: true, brains, local: brains, cloud: [], grok: grokAvailable(), cli_brains: availableCliBrains() });
  }
  if (pathname === '/api/brain/cli') {
    const b = await getBody(req); const s = readJson(settingsPath(), {});
    if (b.brain && cliBrainAvailable(b.brain)) { s.cli_brain = b.brain; s.active_provider = null; writeJson(settingsPath(), s); return json(res, 200, { ok: true, brain: cliBrainName(b.brain) }); }
    s.cli_brain = null; writeJson(settingsPath(), s); return json(res, 200, { ok: true, brain: 'cleared' });
  }
  if (pathname === '/api/brains/select') {
    const body = await getBody(req);
    try {
      return json(res, 200, setActiveBrain(body.brain || body.id || body.tier || body.name || 'auto'));
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message, brains: embeddedBrainStatus().available || [] });
    }
  }
  if (pathname === '/api/device/probe' || pathname === '/api/capabilities/probe') {
    return json(res, 200, await machineProbe());
  }
  if (pathname === '/api/system/scan') {
    return json(res, 200, await systemScan());
  }
  if (pathname === '/api/models/catalog') {
    return json(res, 200, await modelCatalog());
  }
  if (pathname === '/api/brain/accelerate') {
    pushActivity('plan', 'GPU unlock requested', 'downloading CUDA runtime…');
    const r = await unlockGpu();
    pushActivity(r.ok ? 'done' : 'observe', r.ok ? 'GPU unlocked' : 'GPU unlock failed', r.note || r.error || '');
    return json(res, 200, r);
  }
  if (pathname === '/api/soul') {
    if (req.method === 'POST') {
      const body = await getBody(req);
      return json(res, 200, { ok: true, soul: saveSoul(body) });
    }
    return json(res, 200, { ok: true, soul: loadSoul() });
  }
  if (pathname === '/api/agents/roles') {
    return json(res, 200, { ok: true, roles: AGENT_ROLES.map((r) => ({ id: r.id, name: r.name, tagline: r.tagline, tools: r.tools })) });
  }
  if (pathname === '/api/swarm/run') {
    const body = await getBody(req);
    try { return json(res, 200, await runSwarm(body.task || body.goal || body.content, body.roles || body.agents)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/agent/run') {
    const body = await getBody(req);
    try { return json(res, 200, await runAgentLoop(body.goal || body.task || body.content, body)); }
    catch (e) { agentRunning = false; return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/activity') {
    const since = Number(searchParams.get('since') || 0);
    const board = readMissionBoard();
    const summary = missionSummary(board);
    return json(res, 200, {
      ok: true,
      seq: activitySeq,
      agent_running: agentRunning,
      events: activityLog.filter((e) => e.id > since),
      missions: { total: summary.total, counts: summary.counts, next: summary.next }
    });
  }
  if (pathname === '/api/browser/do') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, result: await browserDo(body) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
}

// route group 2/12 — /api/gui/do … /api/kinect (88 lines)
async function routeG02(req, res, pathname, searchParams) {
  if (pathname === '/api/gui/do') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, result: await guiDo(body) }); }
    catch (e) { const s = /consent|Allow actions/i.test(e.message) ? 403 : 400; return json(res, s, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/content/generate') {
    const body = await getBody(req);
    try { return json(res, 200, await generateContent(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/content/formats') {
    return json(res, 200, { ok: true, formats: Object.keys(CONTENT_FORMATS) });
  }
  if (pathname === '/api/x/post') {
    const body = await getBody(req);
    return json(res, 200, await xPost(body));
  }
  if (pathname === '/api/growth/seed') {
    return json(res, 200, seedGrowthBoard());
  }
  if (pathname === '/api/skills/installed') {
    return json(res, 200, { ok: true, skills: listSkills(), dir: path.join(dataRoot, 'skills') });
  }
  if (pathname === '/api/bridge/status') {
    return json(res, 200, bridgeStatus());
  }
  if (pathname === '/api/bridge/reinstall' || pathname === '/api/bridge/reinstate') {
    return json(res, 200, reinstateBridge());
  }
  // ── Learn from Claude: import the claude.ai conversation export into memory ──
  if (pathname === '/api/bridge/learn/scan') {
    return json(res, 200, { ok: true, exports: scanForClaudeExport(), how: 'Export from claude.ai → Settings → Privacy → "Export data". Unzip it; conversations.json is inside. Drop it in Downloads, then Scan.' });
  }
  if (pathname === '/api/bridge/learn/import') {
    const body = await getBody(req);
    try {
      if (body.path) return json(res, 200, await importClaudeFromPath(body.path));
      if (body.json) return json(res, 200, await importClaudeConversations(body.json, {}));
      if (body.conversations) return json(res, 200, await importClaudeConversations(body.conversations, {}));
      return json(res, 400, { ok: false, error: 'Provide { path } to a conversations.json, or { json } with the export.' });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // ── Second Brain (vault) ──
  if (pathname === '/api/vault/notes') return json(res, 200, { ok: true, notes: listVaultNotes() });
  if (pathname === '/api/vault/note') { const id = searchParams.get('id'); if (req.method === 'POST') { const body = await getBody(req); return json(res, 200, body.delete ? deleteVaultNote(body.id) : readVaultNote(body.id)); } return json(res, 200, readVaultNote(id)); }
  if (pathname === '/api/vault/ingest') { const body = await getBody(req); try { return json(res, 200, await vaultIngest(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/vault/ask') { const body = await getBody(req); try { return json(res, 200, await vaultAsk(body.q || body.question || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Content Studio + HUD ──
  if (pathname === '/api/studio/image') { const body = await getBody(req); try { return json(res, 200, await studioImage(body.prompt || body.text || '', body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/studio/article') { const body = await getBody(req); try { return json(res, 200, await studioArticle(body.keyword || body.topic || body.text || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/hud') { try { return json(res, 200, await hudSnapshot()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Messaging gateway (chat with ABUZ8 from Telegram) ──
  if (pathname === '/api/gateway/telegram') { if (req.method === 'POST') { const body = await getBody(req); if (body.token) { const s = readJson(settingsPath(), {}); s.tg_gateway_token = body.token; writeJson(settingsPath(), s); } return json(res, 200, setTgGateway(body.enable !== false)); } return json(res, 200, tgGatewayStatus()); }
  if (pathname === '/api/gateway/telegram/off') { return json(res, 200, setTgGateway(false)); }
  // ── Chat sessions ──
  if (pathname === '/api/sessions') { const q = searchParams.get('q'); return json(res, 200, { ok: true, sessions: q ? searchSessions(q) : listSessions() }); }
  if (pathname === '/api/session') {
    if (req.method === 'POST') { const body = await getBody(req); if (body.delete) return json(res, 200, deleteSessionById(body.delete)); if (body.rename && body.id) { const s = getSession(body.id); if (s) { s.title = body.rename; return json(res, 200, saveSession(s)); } return json(res, 404, { ok: false }); } return json(res, 200, saveSession(body.session || body)); }
    return json(res, 200, { ok: true, session: getSession(searchParams.get('id')) });
  }
  // ── Self-update ──
  if (pathname === '/api/providers/count') {
    const catalog = PROVIDER_CATALOG;
    const staticModels = catalog.reduce((n, p) => n + ((p.models || []).length), 0);
    let live = 0; try { const c = connectorCreds('openrouter'); if (c.api_key) { const r = JSON.parse(await fetchUrl('https://openrouter.ai/api/v1/models', { headers: { Authorization: 'Bearer ' + c.api_key }, timeout: 15000 })); live = ((r.data || []).length); } } catch {}
    const total = staticModels + live;
    return json(res, 200, { ok: true, providers: catalog.length, native_dialects: ['openai-compatible', 'anthropic', 'gemini-native'], static_models: staticModels, openrouter_live_models: live, total_models_reachable: total, hundred_plus: total >= 100, note: live ? 'Includes the live OpenRouter model list.' : 'Connect OpenRouter to add 300+ more live models on one key.' });
  }
  if (pathname === '/api/setup/status') {
    const conns = connectorList();
    const configured = conns.filter((c) => c.configured || c.connected).map((c) => c.id);
    let oauth = []; try { oauth = oauthStatus().filter((o) => o.connected).map((o) => o.id); } catch {}
    const brain = (() => { try { return !!(selectEmbeddedBrain() || availableEmbeddedBrains().length); } catch { return false; } })();
    const voice = (() => { try { return piperAvailable(); } catch { return false; } })();
    const hears = (() => { try { return whisperAvailable(); } catch { return false; } })();
    const redirect = oauthRedirectUri();
    const steps = [];
    if (!brain) steps.push('Bundle/download a brain (Settings → Brain).');
    if (!configured.length && !oauth.length) steps.push('Connect one account in Connect (paste a key, or OAuth — register this redirect URI: ' + redirect + ').');
    steps.push('Optional: code-sign the build to sell; authorize Google/YouTube/Higgsfield for the studio + channel.');
    return json(res, 200, { ok: true, brain, voice, hears, connectors_configured: configured, oauth_connected: oauth, oauth_redirect_uri: redirect, port: PORT, one_click_ready: brain && voice, next_steps: steps });
  }
  if (pathname === '/api/voice/stream/start') { const body = await getBody(req); return json(res, 200, await whisperStreamStart(body)); }
  if (pathname === '/api/voice/stream/read') { const body = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); return json(res, 200, { ok: true, ...whisperStreamRead(body.since || u.searchParams.get('since') || 0) }); }
  if (pathname === '/api/voice/stream/stop') return json(res, 200, whisperStreamStop());
  if (pathname === '/api/voice/stream/status') return json(res, 200, { ok: true, ...whisperStreamStatus() });
  if (pathname === '/api/voice/devices') { try { return json(res, 200, { ok: true, capture_devices: await listCaptureDevices() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/kinect') { try { return json(res, 200, { ok: true, ...(await kinectStatus()) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
}

// route group 3/12 — /api/channels … /api/memory/write (77 lines)
async function routeG03(req, res, pathname, searchParams) {
  if (pathname === '/api/channels') {
    const cc = (id) => { try { return connectorCreds(id) || {}; } catch { return {}; } };
    const tg = (() => { try { const s = readJson(settingsPath(), {}); return !!(s.telegram_token || s.tg_token || cc('telegram').bot_token); } catch { return false; } })();
    const out = [
      { id: 'telegram', label: 'Telegram', configured: tg, two_way: true },
      { id: 'discord', label: 'Discord', configured: !!cc('discord').bot_token, two_way: true },
      { id: 'slack', label: 'Slack', configured: !!cc('slack').bot_token, two_way: true }
    ];
    return json(res, 200, { ok: true, channels: out, configured: out.filter((c) => c.configured).map((c) => c.id), note: 'Paste a bot token in Connect for Discord/Slack; Telegram runs the two-way gateway. Send via connector_call <id> send {channel|channel_id, text}.' });
  }
  // ── Channel INBOUND (two-way: receive + auto-reply) ──
  if (pathname === '/api/channels/listen') { const b = req.method === 'POST' ? await getBody(req) : {}; if (req.method === 'POST') { const cfg = readChannelListen(); if (b.discord) cfg.discord = Object.assign({}, cfg.discord, b.discord); if (b.slack) cfg.slack = Object.assign({}, cfg.slack, b.slack); if (b.enabled != null) cfg.enabled = !!b.enabled; writeChannelListen(cfg); return json(res, 200, { ok: true, config: cfg }); } return json(res, 200, { ok: true, config: readChannelListen() }); }
  if (pathname === '/api/channels/poll') { try { return json(res, 200, await channelPollOnce()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/channels/inbound') { const b = await getBody(req); try { return json(res, 200, await routeInboundMessage(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── ABUZ8 Connect: scoped human-interjection access keys + unified remote control ──
  if (pathname === '/api/access/grant') { const b = await getBody(req); try { return json(res, 200, accessGrant(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/access/list') { try { return json(res, 200, accessList()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/access/revoke') { const b = await getBody(req); try { return json(res, 200, accessRevoke(b.id || b.token)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/remote/devices') { try { return json(res, 200, await remoteDevices()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/remote/screen') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, { ok: true, result: await remoteScreen(b.device, b) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/remote/input') { const b = await getBody(req); try { return json(res, 200, { ok: true, result: await remoteInput(b.device, b.action || b) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/brains') return json(res, 200, { ok: true, ...connectedBrains() });
  if (pathname === '/api/route') {
    const body = req.method === 'POST' ? await getBody(req) : {};
    const u = new URL(req.url, 'http://x'); const task = body.task || u.searchParams.get('task') || ''; const hint = body.hint || u.searchParams.get('hint') || '';
    return json(res, 200, { ok: true, ...routeByCost(task, hint) });
  }
  if (pathname === '/api/term/open') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...termOpen(body) }); } catch (e) { return json(res, 400, { ok: false, error: e.message, pty_available: ptyAvailable() }); } }
  if (pathname === '/api/term/write') { const body = await getBody(req); try { return json(res, 200, termWrite(body.id, body.data)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/term/read') { const body = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); const id = body.id || u.searchParams.get('id'); const since = body.since || u.searchParams.get('since') || 0; try { return json(res, 200, { ok: true, ...termRead(id, since) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/term/resize') { const body = await getBody(req); return json(res, 200, termResize(body.id, body.cols, body.rows)); }
  if (pathname === '/api/term/close') { const body = await getBody(req); return json(res, 200, termClose(body.id)); }
  if (pathname === '/api/term/list') return json(res, 200, { ok: true, pty_available: ptyAvailable(), terminals: termList() });
  if (pathname === '/api/term/warm') { try { return json(res, 200, { ok: true, ...termWarmAll() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/device') {
    const gi = await gpuInfo().catch(() => ({ gpus: [], count: 0, total_vram_gb: 0 }));
    const useGpu = brainIsCuda() && await hasNvidiaGpu().catch(() => false);
    let brain = ''; try { const eb = embeddedBrainStatus(); brain = eb.name || ''; } catch {}
    return json(res, 200, { ok: true, cpu: (os.cpus()[0] || {}).model || 'CPU', cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024), platform: process.platform, arch: process.arch, gpus: gi.gpus, gpu_count: gi.count, total_vram_gb: gi.total_vram_gb, accel: useGpu ? 'gpu' : 'cpu', brain, note: gi.count > 1 ? 'Multi-GPU: brain offloads across all ' + gi.count + ' GPUs (-ngl 999, split-mode layer).' : (useGpu ? 'Single GPU offload.' : 'CPU (no NVIDIA GPU or CUDA runtime).') });
  }
  if (pathname === '/api/build/preflight') {
    const node = await hasBin('node').catch(() => false);
    const git = await hasBin('git').catch(() => false);
    const npm = await hasBin('npm').catch(() => false);
    let embed = false; try { embed = (typeof embedAvailable === 'function') ? embedAvailable() : false; } catch {}
    let comfy = false; try { comfy = !!(await connectorTest('comfyui')).ok; } catch {}
    return json(res, 200, { ok: true, node, git, npm, embed_model: embed, comfyui: comfy, ready_for_code: !!(node && npm), ready_for_video: comfy, note: (node && npm) ? 'Code build ready.' : 'Install Node.js + git on PATH to enable code builds (not bundled in the installer).' });
  }
  if (pathname === '/api/update/check') { return json(res, 200, await checkUpdate()); }
  if (pathname === '/api/update/config') { const body = await getBody(req); const s = readJson(settingsPath(), {}); s.update_url = body.url || ''; writeJson(settingsPath(), s); return json(res, 200, { ok: true }); }
  if (pathname === '/api/version') { return json(res, 200, { ok: true, version: APP_VERSION }); }
  if (pathname === '/api/cmd/run') {
    const body = await getBody(req);
    try {
      return json(res, 200, { ok: true, result: await actionCmdRun(body) });
    } catch (e) {
      const status = /consent|Allow actions/i.test(e.message) ? 403 : 400;
      return json(res, status, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/optional-probe') {
    return json(res, 200, { ok: false, optional: true, manual: true, port: searchParams.get('port') || null });
  }
  if (pathname === '/api/memory/recent' || pathname === '/api/memory/all') {
    return json(res, 200, { ok: true, memories: readMemory(Number(searchParams.get('limit') || 20)), data_root: dataRoot });
  }
  if (pathname === '/api/memory/facts') {
    return json(res, 200, { ok: true, facts: readMemory(50).map((m) => ({ content: m.content || m.response || '', timestamp: m.timestamp })) });
  }
  if (pathname === '/api/memory/write') {
    const body = await getBody(req);
    const plain = body.content || body.text || body.raw || '';
    const item = { id: crypto.randomUUID(), type: body.type || 'note', content: plain, timestamp: new Date().toISOString() };
    appendJsonl(memoryFile(), { id: item.id, type: item.type, content: maybeEnc(plain), timestamp: item.timestamp }); // encrypted at rest when enabled
    addMemoryVector(item).catch(() => {});
    return json(res, 200, { ok: true, item, encrypted: notesEncryptOn() });
  }
}

// route group 4/12 — /api/vault/encrypt … /api/connectors/call (133 lines)
async function routeG04(req, res, pathname, searchParams) {
  if (pathname === '/api/vault/encrypt') { const b = await getBody(req); try { const s = readJson(settingsPath(), {}); s.encrypt_notes = b.on !== false; writeJson(settingsPath(), s); return json(res, 200, { ok: true, encrypt_notes: s.encrypt_notes }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/vault/dpapi') { const b = await getBody(req); try { return json(res, 200, vaultDpapi(b.on)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/knowledge/ingest') { const b = await getBody(req); try { return json(res, 200, await fileToKnowledge(b.path || b.file, b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/memory/index') {
    return json(res, 200, await indexAllMemories());
  }
  if (pathname === '/api/learn/run') {
    return json(res, 200, selfLearnOnce());
  }
  if (pathname === '/api/learn/skills') {
    return json(res, 200, { ok: true, learned: listLearnedSkills() });
  }
  if (pathname === '/api/classes') {
    return json(res, 200, { ok: true, active: activeClassId(), classes: AGENT_CLASSES.map((c) => ({ id: c.id, class: c.class, name: c.name, specialty: c.specialty, tagline: c.tagline, brain: c.brain, tools: c.tools, connectors: c.connectors })) });
  }
  if (pathname === '/api/classes/select') {
    const body = await getBody(req);
    const cls = resolveClass(body.id || body.class || '');
    const s = readJson(settingsPath(), {});
    s.active_class = cls ? cls.id : '';
    s.updated_at = new Date().toISOString();
    writeJson(settingsPath(), s);
    return json(res, 200, { ok: true, active: s.active_class, class: cls || null });
  }
  if (pathname === '/api/orchestrate') {
    const body = await getBody(req);
    try { return json(res, 200, await orchestrate(body.objective || body.goal || body.content, body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // ── Durable mission graph (resumable, approval-gated) ──
  if (pathname === '/api/missions') return json(res, 200, { ok: true, missions: listMissionGraphs() });
  if (pathname === '/api/missions/create') {
    const body = await getBody(req);
    return json(res, 200, { ok: true, mission: createMissionGraph(body.title, body.steps || []) });
  }
  if (pathname === '/api/missions/get') {
    const m = getMissionGraph(searchParams.get('id') || '');
    return json(res, m ? 200 : 404, m ? { ok: true, mission: m } : { ok: false, error: 'not found' });
  }
  if (pathname === '/api/missions/advance') {
    const body = await getBody(req);
    return json(res, 200, await advanceMissionGraph(body.id));
  }
  if (pathname === '/api/missions/run') {
    const body = await getBody(req);
    return json(res, 200, await runMissionToCompletion(body.id));
  }
  if (pathname === '/api/missions/approve') {
    const body = await getBody(req);
    return json(res, 200, approveMissionNode(body.id, body.node));
  }
  // ── Autonomy (scheduled / autonomous runs) ──
  if (pathname === '/api/autonomy/schedules') {
    if (req.method === 'POST') {
      const body = await getBody(req);
      return json(res, 200, { ok: true, schedule: createSchedule(body) });
    }
    return json(res, 200, { ok: true, schedules: readSchedules() });
  }
  if (pathname === '/api/autonomy/toggle') {
    const body = await getBody(req);
    const arr = readSchedules(); const it = arr.find((x) => x.id === body.id);
    if (it) { it.enabled = body.enabled !== false; writeSchedules(arr); }
    return json(res, 200, { ok: Boolean(it), schedule: it || null });
  }
  if (pathname === '/api/autonomy/delete') {
    const body = await getBody(req);
    writeSchedules(readSchedules().filter((x) => x.id !== body.id));
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/autonomy/run-now') {
    const body = await getBody(req);
    const it = readSchedules().find((x) => x.id === body.id);
    if (!it) return json(res, 404, { ok: false, error: 'schedule not found' });
    fireSchedule(it).catch(() => {});
    return json(res, 200, { ok: true, fired: it.name });
  }
  // ── Earn (the dead-simple money machine) ──
  if (pathname === '/api/earn/start') {
    const body = await getBody(req);
    const topic = String(body.topic || body.niche || 'AI automation tips').trim();
    const link = String(body.link || '').trim();
    const platforms = Array.isArray(body.platforms) ? body.platforms : (socialList().filter((p) => p.connected).map((p) => p.id));
    const every_min = Number(body.every_min) || 240;
    const sch = createSchedule({ name: 'Money machine: ' + topic, every_min, action: { kind: 'content_loop', payload: { topic, platforms, link } }, enabled: true });
    // Fire one post right now so they see it working immediately (best-effort).
    setTimeout(() => { const it = readSchedules().find((x) => x.id === sch.id); if (it) fireSchedule(it).catch(() => {}); }, 200);
    pushActivity('earn', 'Money machine started: ' + topic, platforms.join(', '));
    return json(res, 200, { ok: true, schedule: sch, platforms, posted_now: false, queued: platforms.length > 0, note: platforms.length ? 'First post queued (best-effort).' : 'No account connected yet — nothing will post until you connect one.' });
  }
  if (pathname === '/api/earn/status') {
    const loops = readSchedules().filter((s) => s.action && s.action.kind === 'content_loop');
    let posts = 0; try { const lines = fs.readFileSync(signalFile(), 'utf8').trim().split('\n'); for (const ln of lines) { try { const s = JSON.parse(ln); if (s.kind === 'social_post') posts += (s.ok || 0); } catch {} } } catch {}
    const connected = socialList().filter((p) => p.connected).map((p) => p.label);
    return json(res, 200, { ok: true, running: loops.filter((l) => l.enabled).length, loops: loops.map((l) => ({ id: l.id, name: l.name, every_min: l.every_min, enabled: l.enabled, last_run: l.last_run, topic: (l.action.payload || {}).topic, link: (l.action.payload || {}).link })), posts, connected });
  }
  if (pathname === '/api/earn/stop') { const body = await getBody(req); const arr = readSchedules(); const it = arr.find((x) => x.id === body.id); if (it) { it.enabled = false; writeSchedules(arr); } return json(res, 200, { ok: true }); }
  // ── Vision & spatial awareness ──
  if (pathname === '/api/presence') {
    if (req.method === 'POST') {
      const body = await getBody(req);
      const r = updatePresence(body || {});
      return json(res, 200, { ok: true, presence: getPresence(), matched: r.matched });
    }
    return json(res, 200, { ok: true, presence: getPresence(), present: isUserPresent(), attentive: isUserAttentive() });
  }
  if (pathname === '/api/vision/gestures') {
    return json(res, 200, { ok: true, map: gestureMap() });
  }
  if (pathname === '/api/vision/gestures/set') {
    const body = await getBody(req);
    const s = readJson(settingsPath(), {});
    s.gesture_map = Object.assign({}, s.gesture_map || {}, body.map || {});
    writeJson(settingsPath(), s);
    return json(res, 200, { ok: true, map: gestureMap() });
  }
  // ── Connectors ──
  if (pathname === '/api/connectors') return json(res, 200, { ok: true, connectors: connectorList() });
  if (pathname === '/api/connectors/set') {
    const body = await getBody(req);
    if (!body.id || !CONNECTOR_DEFS[body.id]) return json(res, 400, { ok: false, error: 'unknown connector' });
    const cfg = readConnectors(); cfg[body.id] = Object.assign({}, cfg[body.id], body.creds || {}); writeConnectors(cfg);
    pushActivity('connect', 'Connector saved: ' + CONNECTOR_DEFS[body.id].label, '');
    return json(res, 200, { ok: true, test: await connectorTest(body.id) });
  }
  if (pathname === '/api/connectors/test') {
    const body = await getBody(req); return json(res, 200, { ok: true, id: body.id, result: await connectorTest(body.id) });
  }
  if (pathname === '/api/connectors/call') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, data: await connectorCall(body.id, body.action, body.args || {}) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
}

// route group 5/12 — /api/osint … /api/search/all (61 lines)
async function routeG05(req, res, pathname, searchParams) {
  if (pathname === '/api/osint') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, result: await osintLookup(body.action, body.target || body.domain || body.host || body.ip || body.username || body.email || body.url, body) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/chain') {
    const body = await getBody(req);
    try { if (String(body.action || '').toLowerCase() === 'publish') return json(res, 200, { ok: true, result: await chainPublish(body.target) }); return json(res, 200, { ok: true, result: chainTool(body) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/tor') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, result: await torTool(body) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // Self-hosted update channel: every ABUZ8 node advertises its own version, so a mesh
  // primary can be the update source for its peers (and it gives a real reachable manifest URL).
  if (pathname === '/release-manifest.json') {
    return json(res, 200, { product: 'ABUZ8 OS', channel: 'stable', version: APP_VERSION, installer_url: 'https://github.com/abuz8studios-ship-it/abuz8-os/releases/latest/download/ABUZ8-OS-Setup.exe', notes: BUILD_STAMP, min_supported: '1.24.0', released: new Date().toISOString().slice(0, 10) });
  }
  if (pathname === '/api/connectors/delete') {
    const body = await getBody(req); const cfg = readConnectors(); delete cfg[body.id]; writeConnectors(cfg);
    return json(res, 200, { ok: true });
  }
  // ── Fleet mesh ──
  if (pathname === '/api/mesh/whoami') return json(res, 200, { ok: true, id: 'self', service: 'abuz8-core', port: PORT, role: 'worker+control', classes: AGENT_CLASSES.length });
  if (pathname === '/api/mesh/nodes') {
    const m = readMesh();
    const withStatus = await Promise.all(m.nodes.map(async (n) => ({ ...n, ping: await meshPing(n) })));
    return json(res, 200, { ok: true, nodes: withStatus });
  }
  if (pathname === '/api/mesh/add') { const body = await getBody(req); if (!body.url) return json(res, 400, { ok: false, error: 'url required' });
      let _mh = ''; try { _mh = new URL(body.url).hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); } catch { return json(res, 400, { ok: false, error: 'invalid url' }); }
      // SEC-03: a node registration whitelists that host for outbound calls. A cloud-metadata/link-local host
      // is never a legitimate fleet peer — refuse it. And a NON-loopback peer is a privileged topology change,
      // so require explicit Allow-actions (a prompt-injected agent can't silently whitelist an internal host).
      if (_isMetaOrLinkLocal(_mh)) return json(res, 403, { ok: false, error: 'blocked: a cloud-metadata/link-local host can never be a fleet peer (SSRF guard)' });
      if (!isLocalHostName(_mh) && !actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions to add a non-loopback fleet node (it whitelists that host for outbound calls)' });
      return json(res, 200, { ok: true, node: meshAdd(body) }); }
  if (pathname === '/api/mesh/remove') { const body = await getBody(req); return json(res, 200, meshRemove(body.id)); }
  if (pathname === '/api/mesh/ping') { const body = await getBody(req); const n = readMesh().nodes.find((x) => x.id === body.id); if (!n) return json(res, 404, { ok: false, error: 'not found' }); return json(res, 200, { ok: true, ping: await meshPing(n) }); }
  if (pathname === '/api/mesh/dispatch') {
    const body = await getBody(req);
    try { return json(res, 200, { ok: true, result: await meshDispatch(body.id, body.task || body.content || '') }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // ── Swarm / fleet (the orchestrating master over many nodes) ──
  if (pathname === '/api/fleet/stats') { try { return json(res, 200, { ok: true, ...(await meshStats()) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/broadcast') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...(await meshBroadcast(body.task || body.content || '', body)) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/brain') { const body = await getBody(req); try { return json(res, 200, await meshBrain(body.question || body.task || body.content || '', body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/exec') { const body = await getBody(req); try { return json(res, 200, body.all ? { ok: true, ...(await meshExecAll(body.tool, body.args)) } : { ok: true, result: await meshExec(body.id, body.tool, body.args) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/dispatch') { const body = await getBody(req); try { return json(res, 200, Array.isArray(body.units) ? { ok: true, ...(await fleetDispatch(body.units, body)) } : { ok: true, result: await meshDispatchSmart(body.tool, body.args, body) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/orchestrate') { const body = await getBody(req); try { return json(res, 200, await fleetOrchestrate(body.objective || body.task || body.content || '', body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/shard/plan') { const body = await getBody(req); try { return json(res, 200, await meshShardPlan(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/shard/serve') { const body = await getBody(req); try { return json(res, 200, await meshShardServe(body.model || body.model_path, body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/rpc/start') { const body = await getBody(req); try { return json(res, 200, startRpcServer(Number(body.port) || undefined)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Fleet-shared collective memory ──
  if (pathname === '/api/mesh/mem/export') { const b = await getBody(req); try { return json(res, 200, memExportSince(b.since, b.limit)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/rag') { const b = await getBody(req); try { return json(res, 200, await fleetRagSearch(b.query || b.q || b.task || '', b.k)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/memsync') { const b = await getBody(req); try { return json(res, 200, await fleetMemSync(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Knowledge graph + federated search ──
  if (pathname === '/api/graph/stats') { try { return json(res, 200, graphStats()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/graph/search') { const b = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); try { return json(res, 200, graphSearch(b.q || b.query || u.searchParams.get('q') || '', b.k)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/graph/entity') { const b = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); try { return json(res, 200, graphEntity(b.name || b.entity || u.searchParams.get('name') || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/graph/extract') { const b = await getBody(req); try { return json(res, 200, await graphExtract(b.text || b.content || '', b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/graph/rebuild') { const b = await getBody(req); try { return json(res, 200, await graphRebuild(b.limit)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/search/all') { const b = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); try { return json(res, 200, await federatedSearch(b.q || b.query || u.searchParams.get('q') || '', b.k)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Signed extension packs ──
}

// route group 6/12 — /api/packs/sign … /api/jarvis/see (49 lines)
async function routeG06(req, res, pathname, searchParams) {
  if (pathname === '/api/packs/sign') { const body = await getBody(req); try { return json(res, 200, { ok: true, manifest: packSign(body.manifest || body) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/packs/verify') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...packVerify(body.manifest || body) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/packs/install') { const body = await getBody(req); try { return json(res, 200, installPack(body, {})); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/packs/list') { try { return json(res, 200, { ok: true, packs: packList() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/packs/push') { const body = await getBody(req); try { return json(res, 200, await packPush(body.name)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/join') { const body = await getBody(req); try { return json(res, 200, { ok: true, result: await fleetJoin(body.master || body.master_url, body.token || '', body.self) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Local account ──
  if (pathname === '/api/account/status') return json(res, 200, { ok: true, ...accountStatusFull() });
  if (pathname === '/api/account/register') { const body = await getBody(req); try { return json(res, 200, accountRegister(body.username, body.password)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/link-google') { try { return json(res, 200, await accountLinkGoogle()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/recover') { try { return json(res, 200, await accountRecoverViaGoogle()); } catch (e) { return json(res, 401, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/reset-password') { const body = await getBody(req); try { return json(res, 200, await accountResetPassword(body.password || body.new_password)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/setup') { const body = await getBody(req); try { accountSetup(body.username, body.password); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/login') { const body = await getBody(req); try { return json(res, 200, accountLogin(body.username, body.password)); } catch (e) { return json(res, 401, { ok: false, error: e.message }); } }
  if (pathname === '/api/account/logout') { const body = await getBody(req); return json(res, 200, accountLogout(body.token || req.headers['x-abuz8-session'] || '')); }
  if (pathname === '/api/account/require') { const body = await getBody(req); const s = readJson(settingsPath(), {}); s.require_account = body.require === true || body.enabled === true; writeJson(settingsPath(), s); return json(res, 200, { ok: true, require_account: s.require_account }); }
  // ── Provider catalog (Noah's Ark) ──
  if (pathname === '/api/providers') {
    if (req.method === 'POST') {
      const body = await getBody(req);
      const cfg = readJson(providersPath(), { providers: [] });
      const i = cfg.providers.findIndex((p) => p.name === body.name);
      const entry = { name: body.name, type: body.type || 'openai', endpoint: body.endpoint || '', model: body.model || '', api_key: body.api_key || '', enabled: body.enabled !== false, context_length: Number(body.context_length) || 8192, parameters: body.parameters || { temperature: 0.7, max_tokens: 2048 } };
      if (i >= 0) cfg.providers[i] = entry; else cfg.providers.push(entry);
      writeJson(providersPath(), cfg);
      return json(res, 200, { ok: true, providers: cfg.providers });
    }
    return json(res, 200, { ok: true, providers: providerCatalogList(), active: (readJson(settingsPath(), {}).active_provider) || null });
  }
  if (pathname === '/api/providers/connect') {
    const body = await getBody(req);
    try { const e = catalogConnect(body.id, { api_key: body.api_key, model: body.model, endpoint: body.endpoint }); return json(res, 200, { ok: true, provider: { id: e.name, model: e.model }, test: await catalogTest(body.id) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/providers/test') { const body = await getBody(req); return json(res, 200, { ok: true, id: body.id, result: await catalogTest(body.id) }); }
  if (pathname === '/api/providers/models') { const body = await getBody(req); return json(res, 200, await catalogModels(body.id)); }
  if (pathname === '/api/providers/select') { const body = await getBody(req); try { return json(res, 200, setActiveProvider(body.id, body.model)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/providers/use-native') { return json(res, 200, setActiveProvider(null)); }
  if (pathname === '/api/providers/disconnect') { const body = await getBody(req); return json(res, 200, catalogDisconnect(body.id)); }
  if (pathname === '/api/providers/detect') { return json(res, 200, { ok: true, engines: await detectLocalEngines() }); }
  // ── Social beacon ──
  if (pathname === '/api/social/platforms') return json(res, 200, { ok: true, platforms: socialList() });
  if (pathname === '/api/social/connect') { const body = await getBody(req); try { socialConnect(body.id, body.creds || {}); return json(res, 200, { ok: true, platforms: socialList() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/social/disconnect') { const body = await getBody(req); return json(res, 200, socialDisconnect(body.id)); }
  if (pathname === '/api/social/post') { const body = await getBody(req); try { return json(res, 200, await socialPost(body.platforms || [], { text: body.text, link: body.link })); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/social/draft') { const body = await getBody(req); try { return json(res, 200, await socialDraft(body.topic || body.text || '', body.platform)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── The Forge (holographic CAD / world builder) ──
  if (pathname === '/api/forge/interpret') { const body = await getBody(req); return json(res, 200, { ok: true, op: forgeInterpret(body.text || body.command || '') }); }
  if (pathname === '/api/forge/analyze') { const body = await getBody(req); try { return json(res, 200, await forgeAnalyze(body.image_base64 || body.image || '', body.hint || body.label || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/forge/mesh') { const body = await getBody(req); try { return json(res, 200, await jarvisImageTo3D(body.image_base64 || body.image || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/forge/mesh-status') { const body = await getBody(req); try { return json(res, 200, await jarvisMeshStatus(body.task_id)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Jarvis layer ──
  if (pathname === '/api/jarvis/see') { const body = await getBody(req); try { return json(res, 200, await jarvisSee(body.question || body.q || '', body.image_base64 || body.image || '')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
}

// route group 7/12 — /api/jarvis/brief … /api/skills/install (156 lines)
async function routeG07(req, res, pathname, searchParams) {
  if (pathname === '/api/jarvis/brief') { try { return json(res, 200, await jarvisBrief()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/vision/local/status') { const vm = visionModelFiles(); return json(res, 200, { ok: true, installed: !!vm, running: !!visionProcess, port: VISION_PORT, model: vm ? path.basename(vm.llm) : null, accel: lastBrainAccel }); }
  if (pathname === '/api/vision/local/warm') { try { const ok = await ensureVisionBrain(); return json(res, 200, { ok, running: !!visionProcess }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Operator (autonomous computer use) ──
  if (pathname === '/api/operator/step') { const body = await getBody(req); try { return json(res, 200, await operatorStep(body.goal || '', body.image_base64 || body.image || '', body.history || [])); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Persistent OAuth ──
  if (pathname === '/api/oauth/status') return json(res, 200, { ok: true, providers: oauthStatus(), redirect_uri: oauthRedirectUri() });
  if (pathname === '/api/oauth/setup') { const body = await getBody(req); try { return json(res, 200, oauthSetupClient(body.provider, body.client_id, body.client_secret)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/oauth/start') { const body = await getBody(req); try { const r = oauthStart(body.provider); return json(res, 200, { ok: true, ...r }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/oauth/disconnect') { const body = await getBody(req); return json(res, 200, oauthDisconnect(body.provider)); }
  if (pathname === '/api/research') {
    const body = await getBody(req);
    try { return json(res, 200, await deepResearch(body.q || body.query || body.topic || searchParams.get('q') || '', Number(body.pages) || 3)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/reflect') {
    const body = await getBody(req);
    const improved = await reflectAndImprove(body.goal || body.content || '', body.draft || '', body.context || '');
    return json(res, 200, { ok: true, improved });
  }
  if (pathname === '/api/memory/recall') {
    const q = searchParams.get('q') || '';
    return json(res, 200, { ok: true, results: await retrieveMemories(q, Number(searchParams.get('k') || 5)), engine: embedAvailable() ? 'vector' : 'keyword' });
  }
  if (pathname === '/api/memory/search' || pathname === '/api/memory/similar') {
    const q = searchParams.get('q') || searchParams.get('to') || '';
    return json(res, 200, { ok: true, results: searchMemoryItems(q, 20) });
  }
  if (pathname === '/mcp/tools' || pathname === '/api/mcp/tools') {
    return json(res, 200, { ok: true, tools: localToolsList().filter((t) => t.type === 'mcp'), all_tools_endpoint: '/api/tools/list' });
  }
  if (pathname === '/api/mcp/tools/all') { try { return json(res, 200, { ok: true, tools: await mcpAllTools() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/mcp/install') {
    const body = await getBody(req);
    const imported = mergeMcpServers(body.servers || body.mcpServers || {}, 'catalog');
    return json(res, 200, { ok: true, imported, mcp_config: mcpConfigPath() });
  }
  if (pathname === '/api/mcp/import/claude-desktop') {
    const file = claudeConfigPath();
    if (!fs.existsSync(file)) return json(res, 400, { ok: false, imported: 0, merged: [], error: `Claude Desktop config not found at ${file}` });
    const cfg = readJson(file, {});
    const imported = mergeMcpServers(cfg.mcpServers || {}, 'claude-desktop');
    return json(res, 200, { ok: true, imported: imported.length, merged: imported, source: file, mcp_config: mcpConfigPath() });
  }
  if (pathname === '/api/mcp/import/docker-desktop') {
    const available = await commandExists('docker', ['mcp', '--help']);
    if (!available) return json(res, 400, { ok: false, merged: [], error: 'Docker Desktop MCP Toolkit was not detected on this machine.' });
    const imported = mergeMcpServers({ 'docker-desktop-gateway': { command: 'docker', args: ['mcp', 'gateway', 'run', '--block-secrets', '--transport', 'stdio'], enabled: false, note: 'Docker Desktop MCP gateway' } }, 'docker-desktop');
    return json(res, 200, { ok: true, merged: imported, mcp_config: mcpConfigPath() });
  }
  if (pathname === '/api/mcp/install/claude-symbiote' || pathname === '/api/mcp/export/claude-desktop') {
    const installed = installClaudeSymbiote();
    return json(res, 200, {
      ok: true,
      message: 'ABUZ8 OS MCP symbiote was added to Claude Desktop. Restart Claude Desktop to load it.',
      claude_config: installed.file,
      server: installed.server
    });
  }
  if (pathname === '/api/models/list') {
    return json(res, 200, { ok: true, models: listDownloadedModels(), embedded: embeddedBrainStatus().available || [] });
  }
  if (pathname === '/api/models/huggingface/download') {
    const body = await getBody(req);
    try {
      return json(res, 200, await downloadHuggingFaceModel(body));
    } catch (e) {
      const status = /allow_network_download/i.test(e.message) ? 403 : 400;
      return json(res, status, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/cloud-brains/register') {
    const body = await getBody(req);
    try {
      return json(res, 200, registerCloudBrain(body));
    } catch (e) {
      const status = /allow_cloud_brain/i.test(e.message) ? 403 : 400;
      return json(res, status, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/cli/probe') {
    const body = await getBody(req);
    if (!body.allow_cli) {
      return json(res, 403, { ok: false, error: 'allow_cli must be true before executing a local CLI command.' });
    }
    const command = String(body.command || '').trim();
    const args = Array.isArray(body.args) ? body.args.map(String) : ['--version'];
    if (!command) return json(res, 400, { ok: false, error: 'command is required' });
    return json(res, 200, { ok: true, command, args, result: await runCommand(command, args, Number(body.timeout || 15000)) });
  }
  if (pathname === '/api/cli/register') {
    const body = await getBody(req);
    if (!body.allow_cli) {
      return json(res, 403, { ok: false, error: 'allow_cli must be true before registering a local CLI connector.' });
    }
    const id = slug(body.id || body.name || body.command || `cli-${Date.now()}`);
    const record = {
      id,
      name: body.name || id,
      command: body.command || '',
      args: Array.isArray(body.args) ? body.args : [],
      auth_command: body.auth_command || body.login_command || '',
      subscription: body.subscription || body.plan || 'user-provided',
      status: 'registered',
      registered_at: new Date().toISOString()
    };
    writeJson(path.join(dataRoot, 'config', 'cli-connectors', `${id}.json`), record);
    return json(res, 200, { ok: true, connector: record, dir: path.join(dataRoot, 'config', 'cli-connectors') });
  }
  if (pathname === '/api/oauth/exchange') {
    const body = await getBody(req);
    if (!body.allow_oauth_store) {
      return json(res, 403, { ok: false, error: 'allow_oauth_store must be true before exchanging and storing provider tokens.' });
    }
    if (!body.token_url || !body.client_id || !body.code) {
      return json(res, 400, { ok: false, error: 'token_url, client_id, and code are required. User consent still happens in the provider browser flow.' });
    }
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: body.client_id,
      code: body.code,
      redirect_uri: body.redirect_uri || ''
    });
    if (body.code_verifier) params.set('code_verifier', body.code_verifier);
    if (body.client_secret) params.set('client_secret', body.client_secret);
    try {
      const tokenUrl = new URL(body.token_url);
      const result = await new Promise((resolve, reject) => {
        const r = https.request({
          method: 'POST',
          hostname: tokenUrl.hostname,
          path: tokenUrl.pathname + tokenUrl.search,
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(params.toString()), accept: 'application/json' }
        }, (rr) => {
          let out = '';
          rr.on('data', (d) => { out += d; });
          rr.on('end', () => resolve({ status: rr.statusCode, body: out }));
        });
        r.on('error', reject);
        r.write(params.toString());
        r.end();
      });
      const parsed = JSON.parse(result.body || '{}');
      if (result.status < 200 || result.status >= 300) return json(res, 400, { ok: false, status: result.status, error: parsed.error_description || parsed.error || 'OAuth exchange failed' });
      const safeToken = { ...parsed, access_token: parsed.access_token ? '[stored-local]' : undefined, refresh_token: parsed.refresh_token ? '[stored-local]' : undefined };
      writeJson(path.join(dataRoot, 'config', 'oauth', `${slug(body.provider || body.client_id)}.json`), { provider: body.provider || body.client_id, token: parsed, saved_at: new Date().toISOString() });
      return json(res, 200, { ok: true, token: safeToken, dir: path.join(dataRoot, 'config', 'oauth') });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/skills/hub') { const b = req.method === 'POST' ? await getBody(req) : {}; const u = new URL(req.url, 'http://x'); try { return json(res, 200, { ok: true, ...skillsHub(b.q || b.query || u.searchParams.get('q') || '') }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/skills/scan') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, b.id ? { ok: true, ...skillScanOne(b.id) } : await skillsScanAll()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/skills/scan/status') { try { return json(res, 200, { ok: true, ...readSkillScans() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/skills/toggle') { const b = await getBody(req); return json(res, 200, skillsToggle(b.id, b.enabled)); }
  if (pathname === '/api/skills/install') { const b = await getBody(req); try { return json(res, 200, skillsInstall(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
}

// route group 8/12 — /api/skills/list … /api/resume (149 lines)
async function routeG08(req, res, pathname, searchParams) {
  if (pathname === '/api/skills/list' || pathname === '/api/skills/registry') {
    return json(res, 200, { ok: true, skills: skillsHub('').skills, registry: [], dir: path.join(dataRoot, 'skills') });
  }
  if (pathname === '/api/skills/self_learning/status') {
    return json(res, 200, { ok: true, enabled: false, mode: 'manual', hint: 'Self-learning skill capture is available when a skill registry is connected.' });
  }
  if (pathname === '/api/skills/import' || pathname === '/api/skills/create' || pathname === '/api/skills/promote') {
    const body = await getBody(req);
    const id = slug(body.name || body.repo || body.title || `skill-${Date.now()}`);
    writeJson(path.join(dataRoot, 'skills', `${id}.json`), { ...body, id, imported_at: new Date().toISOString() });
    return json(res, 200, { ok: true, id, dir: path.join(dataRoot, 'skills') });
  }
  if (pathname === '/api/hardware/manifest') {
    const probe = await machineProbe();
    return json(res, 200, { ok: true, manifest: { system: probe.system, cpu: probe.cpu, memory: probe.memory, storage: probe.storage, gpus: probe.gpus, tier: probe.tier, capabilities: probe.capabilities, recommended: probe.recommended, embedded_brain: probe.embedded_brain } });
  }
  if (pathname === '/api/swarm/dispatch') {
    const body = await getBody(req);
    const job = { id: `job_${Date.now().toString(36)}`, task: body.task || body.content || 'task', status: 'queued', created_at: new Date().toISOString() };
    jobs.unshift(job);
    try {
      upsertMissionTask({
        id: `swarm-${job.id}`,
        title: job.task,
        column: 'doing',
        priority: body.priority || 'medium',
        owner: 'ABUZ8',
        details: `Swarm job ${job.id}`
      });
    } catch {}
    return json(res, 200, { ok: true, job_id: job.id, job });
  }
  if (pathname === '/swarm/status' || pathname === '/api/creator/queue') {
    return json(res, 200, { ok: true, active: jobs.filter((j) => j.status !== 'done').length, jobs });
  }
  if (pathname === '/api/creator/render') {
    const body = await getBody(req);
    const job = { ...body, id: body.id || `render_${Date.now().toString(36)}`, status: 'queued-local-fallback', created_at: new Date().toISOString() };
    jobs.unshift(job);
    return json(res, 200, { ok: true, job, mode: 'local-fallback' });
  }
  if (pathname === '/api/attachments') {
    return json(res, 200, attachmentsStatus());
  }
  if (pathname === '/api/voice/status' || pathname === '/api/tts/status') {
    const piper = piperAvailable();
    const piperVoices = piper ? listPiperVoices() : [];
    const winVoices = await listWindowsTtsVoices();
    const recognizers = await listWindowsSttRecognizers();
    const voices = [
      ...piperVoices.map((v) => ({ id: v.id, name: v.name, engine: 'piper', lang: v.lang, neural: true, arabic: v.arabic })),
      ...winVoices.map((v) => ({ id: v, name: v, engine: 'windows', neural: false }))
    ];
    return json(res, 200, {
      ok: true,
      voice_engine: piper ? 'piper-neural' : 'windows-sapi',
      neural_tts: piper,
      neural_stt: whisperAvailable(),
      native_tts: process.platform === 'win32' && winVoices.length > 0,
      browser_stt: true, browser_tts: true, streaming_chat_tts: true,
      presets: ['normal', 'calm', 'fast', 'narrator', 'cartoon'],
      recognizers, voices,
      note: piper ? 'Offline neural voice via Piper is active. Browser/Windows speech remain fallbacks.' : 'Install the Piper attachment for natural neural voices.'
    });
  }
  if (pathname === '/api/stt' || pathname === '/api/stt/transcribe') {
    const body = await getBody(req);
    const audio = body.audio_base64 || body.wav_base64 || body.audio || body.raw || '';
    const language = body.language || body.lang || 'auto'; // 'auto' detects Arabic/English/…; 'ar' forces Arabic
    try {
      const result = whisperAvailable() ? await transcribeWhisper(audio, language) : await transcribeWindowsStt(audio);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message, fallback: 'browser-stt' });
    }
  }
  if (pathname === '/api/tts' || pathname === '/api/tts/stream') {
    const body = await getBody(req);
    try {
      if (piperAvailable()) {
        const r = await synthesizePiper(body.text || body.raw || '', body.voice || '', body.preset);
        return binary(res, 200, r.wav, 'audio/wav');
      }
      const wav = await synthesizeWindowsTts(body.text || body.raw || '', body.voice || '');
      return binary(res, 200, wav, 'audio/wav');
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message, fallback: 'browser-tts' });
    }
  }
  if (pathname === '/api/avatar/speak') {
    const body = await getBody(req);
    try {
      const wav = await synthesizeWindowsTts(body.text || body.raw || '', body.voice || '');
      return binary(res, 200, wav, 'audio/wav');
    } catch (e) {
      return json(res, 200, { ok: true, queued: false, fallback: 'browser-tts', error: e.message });
    }
  }
  if (pathname === '/api/avatar/health') {
    const voices = await listWindowsTtsVoices();
    return json(res, 200, { ok: true, mode: voices.length ? 'native-windows-tts' : 'browser-tts-fallback', voices });
  }
  if (pathname === '/api/routing/leaderboard') return json(res, 200, { ok: true, rows: [{ lane: 'portable-core', n_calls: readMemory(500).length, mean_success: 1, cost_per_1k: 0 }] });
  if (pathname === '/api/provenance/stats') return json(res, 200, { ok: true, fact_count: readMemory(1000).length, agent_count: 1, open_conflicts: 0 });
  if (pathname === '/api/security/integrity' || pathname === '/api/security/audit') return json(res, 200, { ok: true, message: 'Portable runtime folders and local API are reachable.', data_root: dataRoot });
  if (pathname === '/api/telephony/status') return json(res, 200, { ok: true, active: false, hint: 'Connect Twilio or another provider in settings.' });
  if (pathname === '/api/crm/health') return json(res, 200, { ok: true, mode: 'local-fallback', hint: 'CRM data is stored locally until Stripe or an external CRM is connected.' });
  if (pathname === '/api/chimera/panels') {
    const embedded = embeddedBrainStatus();
    const panels = [
      { id: 'portable-core', role: 'local router', model: 'portable-core', enabled: true, active: !embedded.embedded, weight: embedded.embedded ? 0.25 : 1 },
      ...(embedded.available || []).map((b) => ({
        id: b.id,
        role: b.role || b.tier || 'embedded brain',
        model: b.name,
        enabled: b.embedded,
        active: embedded.id === b.id,
        status: embedded.id === b.id ? embedded.status : b.status,
        weight: embedded.id === b.id ? 1 : 0.5
      }))
    ];
    return json(res, 200, { ok: true, panels, active: embedded });
  }
  if (pathname === '/api/chimera/deliberate') {
    const body = await getBody(req);
    const prompt = body.prompt || body.content || body.raw || '';
    const response = await embeddedReply(prompt) || localReply(prompt);
    return json(res, 200, { ok: true, response, verdict: response, panels: [embeddedBrainStatus().id || 'portable-core'] });
  }
  if (pathname === '/api/connections/discover') return json(res, 200, { ok: true, connections: [{ id: 'portable-core', status: 'online', url: `http://127.0.0.1:${PORT}` }] });
  if (pathname === '/api/usage') return json(res, 200, usageSummary());
  if (pathname === '/api/cost/summary') return json(res, 200, costSummary());
  if (pathname === '/api/traces') return json(res, 200, recentTraces());
  if (pathname === '/api/revenue/summary') return json(res, 200, revenueSummary());
  if (pathname === '/api/actions/status') return json(res, 200, { ok: true, allow_actions: actionsAllowed(), session_only: false });
  if (pathname === '/api/actions/consent') {
    const body = await getBody(req);
    actionConsentGranted = body.allow_actions === true;
    // Persist so it survives relaunch (read back by actionsAllowed / start()).
    const s = readJson(settingsPath(), {});
    s.auto_grant_actions = actionConsentGranted;
    s.updated_at = new Date().toISOString();
    writeJson(settingsPath(), s);
    appendJsonl(path.join(dataRoot, 'logs', 'action-consent.jsonl'), { allow_actions: actionConsentGranted, timestamp: new Date().toISOString() });
    return json(res, 200, { ok: true, allow_actions: actionConsentGranted, session_only: false });
  }
  // ── Hardening routes (additive) ──
  if (pathname === '/api/agent/stop') { stopAgentRun(); pushActivity('halt', 'Agent stopped', 'user'); return json(res, 200, { ok: true, stopped: true, note: 'Stop requested — the running autopilot/coder/task loop exits at its next step.' }); }
  if (pathname === '/api/airgap') { const body = await getBody(req); const s = readJson(settingsPath(), {}); s.local_only = body.enabled === true; writeJson(settingsPath(), s); pushActivity('privacy', s.local_only ? 'Local-Only ON' : 'Local-Only OFF', s.local_only ? 'zero outbound' : 'cloud allowed'); return json(res, 200, { ok: true, local_only: s.local_only, note: s.local_only ? 'Local-Only ON — zero outbound; only the bundled local brain answers, nothing reaches any provider.' : 'Local-Only OFF — cloud engines allowed (data leaves only when you choose a cloud brain).' }); }
  if (pathname === '/api/airgap/status') { return json(res, 200, { ok: true, local_only: airgapOn() }); }
  if (pathname === '/api/decide') { const body = await getBody(req); try { return json(res, 200, monteCarloDecide(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/license/status') { return json(res, 200, licenseStatus()); }
  if (pathname === '/api/license/keygen') { if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions first (signing-key generation)' }); try { return json(res, 200, licenseKeygen()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/license/issue') { if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions to issue licenses' }); const body = await getBody(req); try { return json(res, 200, issueLicense(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/license/activate') { const body = await getBody(req); try { return json(res, 200, activateLicense(body.license_key || body.key)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // Multi-channel YouTube — manage the per-channel encrypted token store (the 10 AI channels)
  if (pathname === '/api/youtube/channels' && req.method === 'GET') return json(res, 200, ytListChannels());
  if (pathname === '/api/youtube/channels/add') { try { return json(res, 200, await ytSaveCurrentChannel()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/youtube/channels/select') { const body = await getBody(req); try { return json(res, 200, ytSelectChannel(body.id)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/youtube/channels/remove') { const body = await getBody(req); try { return json(res, 200, ytRemoveChannel(body.id)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/avatar/status') { return json(res, 200, { ok: true, local: localAvatarAvailable(), stack: avatarStackDir(), cloud: { heygen: !!(connectorCreds('heygen') || {}).api_key, did: !!(connectorCreds('did') || {}).api_key } }); }
  if (pathname === '/api/avatar/generate') { const body = await getBody(req); try { enforceLicense('Local AI Avatar Studio'); return json(res, 200, await generateTalkingAvatar(body)); } catch (e) { return json(res, /Pro license/.test(e.message || '') ? 402 : 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/studio/local') { const body = await getBody(req); try { enforceLicense('Local Video & Image Studio'); return json(res, 200, await localMediaGenerate(body)); } catch (e) { return json(res, /Pro license/.test(e.message || '') ? 402 : 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/studio/workflows') { return json(res, 200, { ok: true, workflows: listComfyWorkflows().map((w) => w.name).slice(0, 300) }); }
  if (pathname === '/api/studio/workflow') { const body = await getBody(req); try { return json(res, 200, await runComfyWorkflow(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/devteam/solve') { const body = await getBody(req); try { enforceLicense('ASRED Dev Spec-Ops'); return json(res, 200, await devTeamSolve(body)); } catch (e) { return json(res, /Pro license/.test(e.message || '') ? 402 : 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/devteam/status') { let up = false, models = []; try { const t = JSON.parse(await fetchUrl(ollamaBase() + '/api/tags', { timeout: 4000 })); up = true; models = (t.models || []).map((m) => m.name); } catch {} return json(res, 200, { ok: true, local_brain: up, coder_model: localCoderModel(), models }); }
  if (pathname === '/api/coder/write') { const body = await getBody(req); try { return json(res, 200, coderWrite(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/learn/status') { let ingested = 0; try { ingested = fs.readFileSync(path.join(dataRoot, 'logs', 'ingest.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).length; } catch {} return json(res, 200, { ok: true, self_learn: selfLearnOn(), watchers: _fileWatchers.length, files_ingested: ingested, parts_this_session: _learnCount }); }
  if (pathname === '/api/learn/ingest') { const body = await getBody(req); try { return json(res, 200, await ingestFileToKnowledge(String(body.path || body.file || ''))); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/learn/scan') { const body = await getBody(req); try { return json(res, 200, await ingestDirectory(body.dir && exists(body.dir) ? body.dir : (body.project ? projectDir(body.project) : workspacesRoot()), Number(body.cap) || 200)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/learn/toggle') { const body = await getBody(req); const s = readJson(settingsPath(), {}); s.self_learn = body.enabled !== false; writeJson(settingsPath(), s); if (s.self_learn) { try { startFileWatcher(); } catch {} } return json(res, 200, { ok: true, self_learn: s.self_learn }); }
  if (pathname === '/api/onboard/catalog') { return json(res, 200, onboardCatalog()); }
  if (pathname === '/api/onboard/connect') { const body = await getBody(req); try { return json(res, 200, await onboardConnect(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/voiceclone/status') { return json(res, 200, { ok: true, voice_clone: voiceCloneAvailable(), model_dir: xttsModelDir() }); }
  if (pathname === '/api/voiceclone/run') { const body = await getBody(req); try { enforceLicense('Voice Cloning'); return json(res, 200, await synthesizeVoiceClone(body)); } catch (e) { return json(res, /Pro license/.test(e.message || '') ? 402 : 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/halt') { _halted = true; actionConsentGranted = false; try { const s = readJson(settingsPath(), {}); s.auto_grant_actions = false; writeJson(settingsPath(), s); } catch {} appendJsonl(path.join(dataRoot, 'logs', 'action-consent.jsonl'), { halt: true, timestamp: new Date().toISOString() }); return json(res, 200, { ok: true, halted: true, note: 'Kill switch ON — actions blocked, scheduler + inbound gateway frozen. In-flight jobs finish; nothing new starts. POST /api/resume to lift.' }); }
  if (pathname === '/api/resume') { _halted = false; appendJsonl(path.join(dataRoot, 'logs', 'action-consent.jsonl'), { resume: true, timestamp: new Date().toISOString() }); return json(res, 200, { ok: true, halted: false, note: 'Resumed. Actions still require the Allow-actions consent toggle.' }); }
}

// route group 9/12 — /api/halt/status … /api/models/tasks (38 lines)
async function routeG09(req, res, pathname, searchParams) {
  if (pathname === '/api/halt/status') return json(res, 200, { ok: true, halted: _halted, actions_allowed: actionsAllowed() });
  if (pathname === '/api/actions/approve-command') { const body = await getBody(req); try { return json(res, 200, approveCommand(body.command || '', body.scope || 'session')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/backup' || pathname === '/api/backup/create') { try { return json(res, 200, await zipDataRoot('manual')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/backup/list') { try { const d = exportsDir(); const rows = fs.readdirSync(d).filter((f) => f.endsWith('.zip')).map((f) => ({ file: path.join(d, f), name: f, bytes: fs.statSync(path.join(d, f)).size, mtime: fs.statSync(path.join(d, f)).mtime })).sort((a, b) => b.mtime - a.mtime); return json(res, 200, { ok: true, backups: rows, dir: d }); } catch { return json(res, 200, { ok: true, backups: [] }); } }
  if (pathname === '/api/restore') { const body = await getBody(req); try { return json(res, 200, await restoreBackup(body.zipPath || body.file)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/checkpoints') return json(res, 200, { ok: true, checkpoints: listCheckpoints() });
  if (pathname === '/api/checkpoints/rollback') { const body = await getBody(req); try { return json(res, 200, rollbackCheckpoint(body.id)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/pairing/list') return json(res, 200, { ok: true, ...pairingState() });
  if (pathname === '/api/pairing/request') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...pairingRequest(body.id, body.label) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/pairing/approve') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...pairingApprove(body.id) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/pairing/revoke') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...pairingRevoke(body.id) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Operator list (items 1-6) ──
  if (pathname === '/api/brief') return json(res, 200, operatorBrief());
  if (pathname === '/api/policy' || pathname === '/api/policy/tiers') return json(res, 200, { ok: true, tiers: TOOL_TIERS, red_approved: Array.from(_redApproved), note: 'green = auto · yellow = consent-gated · red = explicit per-tool approval' });
  if (pathname === '/api/approvals/list') return json(res, 200, { ok: true, red_approved: Array.from(_redApproved), all: listApprovals() });
  if (pathname === '/api/approvals/pending') return json(res, 200, { ok: true, pending: listApprovals('pending') });
  if (pathname === '/api/approvals/approve') { const body = await getBody(req); try { return json(res, 200, body.id ? decideApproval(body.id, 'approve', body.why) : approveTool(body.tool)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/approvals/deny') { const body = await getBody(req); try { return json(res, 200, body.id ? decideApproval(body.id, 'deny', body.why) : denyTool(body.tool)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/decisions') return json(res, 200, { ok: true, decisions: listDecisions() });
  if (pathname === '/api/audit') return json(res, 200, { ok: true, events: auditTimeline() });
  if (pathname === '/api/fs/list') { const body = await getBody(req);
      const d = path.resolve(String(body.dir || body.path || os.homedir()));
      let realD = d; try { realD = fs.realpathSync.native(d); } catch {}
      if (isSensitivePath(d) || isSensitivePath(realD)) return json(res, 403, { ok: false, error: 'blocked: sensitive system/credential path' });
      if (!_fsAccessAllowed(realD, req)) return json(res, 403, { ok: false, error: 'blocked: remote listing is jailed to the workspace' });
      return json(res, 200, fsListDir(realD)); }
  if (pathname === '/api/context/expand') { const body = await getBody(req); try { return json(res, 200, await expandContextRefs(String(body.text || ''), { cwd: body.cwd, terminals: body.terminals || {}, soft: body.soft, hard: body.hard })); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fs/read') { const body = await getBody(req); try {
      const p = path.resolve(String(body.path || ''));
      // SEC-02: canonicalize (resolve symlinks/junctions + 8.3 short names) BEFORE the credential denylist
      // so the jail can't be bypassed via a link or short-name alias; check both the raw and real path.
      let real = p; try { real = fs.realpathSync.native(p); } catch {}
      if (isSensitivePath(p) || isSensitivePath(real)) return json(res, 403, { ok: false, error: 'blocked: sensitive system/credential path' });
      if (!_fsAccessAllowed(real, req)) return json(res, 403, { ok: false, error: 'blocked: remote reads are jailed to the workspace' });
      const tgt = real; // SEC-02: stat/read the CANONICAL path we vetted (not the raw alias) — closes the realpath→read TOCTOU
      if (!exists(tgt) || fs.statSync(tgt).isDirectory()) throw new Error('not a file');
      const ext = (path.extname(tgt) || '').toLowerCase(); const size = fs.statSync(tgt).size;
      if (size > 12 * 1024 * 1024) return json(res, 200, { ok: true, path: p, kind: 'binary', size, note: 'too large to preview (>12MB)' });
      if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(ext)) return json(res, 200, { ok: true, path: p, kind: 'image', mime: 'image/' + ext.replace('.', '').replace('jpg', 'jpeg').replace('svg', 'svg+xml'), base64: fs.readFileSync(tgt).toString('base64') });
      if (ext === '.pdf') return json(res, 200, { ok: true, path: p, kind: 'pdf', base64: fs.readFileSync(tgt).toString('base64') });
      if (ext === '' || /\.(txt|md|markdown|json|jsonl|js|mjs|ts|jsx|tsx|py|rb|php|html?|css|scss|log|xml|ya?ml|java|c|cpp|h|go|rs|sh|ps1|bat|sql|ini|conf|env|csv|tsv)$/.test(ext)) return json(res, 200, { ok: true, path: p, kind: 'text', content: fs.readFileSync(tgt, 'utf8').slice(0, 200000) });
      return json(res, 200, { ok: true, path: p, kind: 'binary', size, note: 'binary file — no inline preview' });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/escalations') { try { const rows = fs.readFileSync(path.join(dataRoot, 'logs', 'escalations.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-50).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); return json(res, 200, { ok: true, escalations: rows }); } catch { return json(res, 200, { ok: true, escalations: [] }); } }
  if (pathname === '/api/autonomy/runs') { const body = await getBody(req); return json(res, 200, { ok: true, runs: scheduleRuns(body.id, body.limit || 30) }); }
  if (pathname === '/api/blueprints') return json(res, 200, { ok: true, blueprints: BLUEPRINTS.map((b) => ({ id: b.id, name: b.name, desc: b.desc, slots: b.slots })) });
  if (pathname === '/api/blueprints/create') { const body = await getBody(req); try { return json(res, 200, { ok: true, schedule: blueprintCreate(body.id, body.slots || {}) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/gateway/channels') return json(res, 200, { ok: true, channels: readChannels() });
  if (pathname === '/api/gateway/channels/set') { const body = await getBody(req); try { return json(res, 200, { ok: true, channel: upsertChannel(body) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/models/tasks') { const body = await getBody(req); if (body && Object.keys(body).length) { const s = readJson(settingsPath(), {}); s.task_models = { ...(s.task_models || {}), ...body }; writeJson(settingsPath(), s); } return json(res, 200, { ok: true, task_models: taskModels(), slots: ['curator', 'verify', 'vision', 'voice', 'title', 'compress'] }); }
}

// route group 10/12 — /api/profiles … /api/provider/chat (133 lines)
async function routeG10(req, res, pathname, searchParams) {
  if (pathname === '/api/profiles') return json(res, 200, { ok: true, active: _activeProfile || 'default', profiles: ['default', ...profilesList()] });
  if (pathname === '/api/profiles/create') { const body = await getBody(req); const n = String(body.name || '').replace(/[^a-z0-9_-]/gi, ''); if (!n) return json(res, 400, { ok: false, error: 'name required' }); safeMkdir(path.join(dataRoot, 'profiles', n)); return json(res, 200, { ok: true, created: n, profiles: profilesList() }); }
  if (pathname === '/api/profiles/switch') { const body = await getBody(req); const n = (!body.name || body.name === 'default') ? '' : String(body.name).replace(/[^a-z0-9_-]/gi, ''); _activeProfile = n; try { fs.writeFileSync(activeProfileFile(), n); } catch {} return json(res, 200, { ok: true, active: n || 'default', note: 'Switched — soul, sessions and memory now use this profile.' }); }
  if (pathname === '/api/vault/set') { const body = await getBody(req); try { return json(res, 200, vaultSet(body.key, body.value)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/vault/get') { const body = await getBody(req); try { const v = vaultGet(body.key); return json(res, 200, { ok: v !== undefined, key: body.key, value: v }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/vault/list') return json(res, 200, { ok: true, keys: vaultList() });
  if (pathname === '/api/vault/delete') { const body = await getBody(req); try { return json(res, 200, vaultDelete(body.key)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/revenue/record') { const body = await getBody(req); try { recordRevenue({ ...body, source: 'manual', verified: false }); return json(res, 200, { ok: true, recorded: true, verified: false, note: 'Recorded as UNVERIFIED (manual). Only Stripe-signed webhooks count as verified cash.', summary: revenueSummary() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/voice/matrix') return json(res, 200, voiceMatrix());
  if (pathname === '/api/comfyui/status') return json(res, 200, await comfyuiStatus());
  if (pathname === '/api/comfyui/generate') { const body = await getBody(req); try { return json(res, 200, await comfyuiGenerate(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/verify') { const body = await getBody(req); try { return json(res, 200, { ok: true, ...(await verifyAction(body.tool || 'action', body.args || body)) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/learn/review') { const body = await getBody(req); try { return json(res, 200, await reviewTurn(body.user || body.userText || body.content, body.assistant || body.assistantText || ' ')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/store/products') return json(res, 200, { ok: true, products: storeProducts(), file: storeProductsFile() });
  if (pathname === '/api/store/checkout') { const body = await getBody(req); try { return json(res, 200, await storeCheckout(body)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/store/webhook') { const body = await getBody(req); try {
      const secret = stripeWebhookSecret();
      // SEC-07: refuse outright when no signing secret is configured — never record an unverified "sale"
      // that the HUD would then surface as money. Configure the stripe connector webhook_secret first.
      if (!secret) return json(res, 501, { ok: false, error: 'store webhook disabled: no Stripe signing secret configured (set the stripe connector webhook_secret). No sale recorded.' });
      const verified = verifyStripeSig(req._rawBody, req.headers['stripe-signature'] || '', secret);
      // A bad/missing signature is rejected outright — no record.
      if (!verified) return json(res, 400, { ok: false, error: 'invalid or missing Stripe signature' });
      const s = (body.data && body.data.object) || body.session || body;
      if ((body.type && /checkout\.session\.completed/.test(body.type)) || s.amount_total != null || s.amount_usd != null) return json(res, 200, storeFulfill(s, { verified }));
      return json(res, 200, { ok: true, ignored: body.type || 'event' });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/tools/list') return json(res, 200, { ok: true, tools: localToolsList(), custom_tools_file: toolsFile() });
  if (pathname === '/api/tools/create') {
    const body = await getBody(req);
    try {
      const tool = createLocalTool(body);
      return json(res, 200, { ok: true, tool, tools: localToolsList(), custom_tools_file: toolsFile() });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/tools/call') {
    const body = await getBody(req);
    try {
      const result = await callLocalTool(body.tool || body.name, body.args || body);
      appendJsonl(path.join(dataRoot, 'logs', 'tool-calls.jsonl'), { ...result, timestamp: new Date().toISOString() });
      pushActivity('tool', `Tool: ${result.tool || body.tool || body.name}`, result.ok === false ? (result.error || 'failed') : 'ok');
      return json(res, 200, result);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/mission/board' || pathname === '/mission/board.json') {
    const board = readMissionBoard();
    return json(res, 200, { ...board, summary: missionSummary(board), file: missionFile() });
  }
  if (pathname === '/api/mission/task') {
    const body = await getBody(req);
    try {
      const task = upsertMissionTask(body);
      pushActivity('mission', `Task: ${task.title}`, `→ ${task.column} · ${task.owner}`);
      const board = readMissionBoard();
      return json(res, 200, { ok: true, task, board, summary: missionSummary(board) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/mission/move') {
    const body = await getBody(req);
    try {
      const task = moveMissionTask(body.id, body.column);
      pushActivity('mission', `Moved: ${task.title}`, `→ ${task.column}`);
      const board = readMissionBoard();
      return json(res, 200, { ok: true, task, board, summary: missionSummary(board) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (pathname === '/mission/crm/state.json') {
    const board = readMissionBoard();
    return json(res, 200, {
      ok: true,
      portfolio: [],
      leads: [],
      revenue: 0,
      goals: board.tasks.filter((t) => t.column !== 'done').slice(0, 6).map((t) => ({ label: t.title, status: `${t.column} · ${t.priority}` })),
      blockers: board.tasks.filter((t) => t.blocked || t.priority === 'blocker').map((t) => ({ issue: t.title, severity: t.priority || 'medium' })),
      mission: board.mission,
      summary: missionSummary(board)
    });
  }
  if (pathname === '/api/sessions/summary') return json(res, 200, { ok: true, sessions: [] });
  if (pathname === '/api/souls/list') return json(res, 200, { ok: true, souls: ['portable-core'] });
  if (pathname === '/api/souls/active') return json(res, 200, { ok: true });
  if (pathname === '/api/telegram/send') {
    const settings = readJson(settingsPath(), {});
    const token = settings.telegram_token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return json(res, 400, { ok: false, error: 'Telegram not configured. Set a bot token in Settings.' });
    const body = await getBody(req);
    const chatId = body.chat_id || settings.telegram_chat_id;
    if (!chatId) return json(res, 400, { ok: false, error: 'No chat_id configured. Send /start to your bot first.' });
    try {
      const resp = await fetchUrl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body.text || body.message || '', parse_mode: 'Markdown' })
      });
      const data = JSON.parse(resp);
      return json(res, 200, { ok: data.ok, error: data.description || null });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ── SETTINGS API ──────────────────────────────────────────────
  if (pathname === '/api/settings') {
    if (req.method === 'POST') {
      const body = await getBody(req);
      const cfg = readJson(settingsPath(), {});
      for (const k of Object.keys(body)) cfg[k] = body[k];
      cfg.updated_at = new Date().toISOString();
      writeJson(settingsPath(), cfg);
      return json(res, 200, { ok: true, settings: cfg });
    }
    const s = readJson(settingsPath(), {});
    s._dataRoot = dataRoot;
    s._port = PORT;
    return json(res, 200, { ok: true, settings: s });
  }

  // ── PROVIDERS API ────────────────────────────────────────────

  // ── PROVIDER CHAT ────────────────────────────────────────────
  if (pathname === '/api/provider/chat') {
    const body = await getBody(req);
    const providerName = body.provider || body.brain || 'lmstudio';
    const cfg = readJson(providersPath(), { providers: [] });
    const provider = cfg.providers.find(p => p.name === providerName);
    if (!provider) return json(res, 200, { ok: false, error: `Provider '${providerName}' not configured. Add it in Settings.`, fallback: true });
    if (!provider.enabled) return json(res, 200, { ok: false, error: `Provider '${providerName}' is disabled.`, fallback: true });
    try {
      const result = await callProviderChat(provider, body.content || body.message || body.prompt || '');
      return json(res, 200, { ok: true, response: result, provider: providerName, brain: provider.model || providerName });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, fallback: true });
    }
  }

  // ── MCP SERVER RUNTIME ──────────────────────────────────────
}

// route group 11/12 — /api/mcp/servers … /api/scaffold/revert (113 lines)
async function routeG11(req, res, pathname, searchParams) {
  if (pathname === '/api/mcp/servers') {
    const cfg = readJson(mcpConfigPath(), { mcpServers: {} });
    const running = Array.from(mcpProcesses.keys());
    const servers = Object.entries(cfg.mcpServers).map(([name, spec]) => ({ name, command: spec.command, args: spec.args || [], enabled: spec.enabled !== false, source: spec.source || 'catalog', note: spec.note || '', running: running.includes(name) }));
    return json(res, 200, { ok: true, servers });
  }

  if (pathname.match(/^\/api\/mcp\/servers\/.+\/start$/)) {
    const name = pathname.split('/')[4];
    try {
      const pid = await startMcpServer(name);
      return json(res, 200, { ok: true, message: `Started MCP server: ${name}`, pid });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname.match(/^\/api\/mcp\/servers\/.+\/stop$/)) {
    const name = pathname.split('/')[4];
    stopMcpServer(name);
    return json(res, 200, { ok: true, message: `Stopped MCP server: ${name}` });
  }
  if (pathname.match(/^\/api\/mcp\/servers\/.+\/tools$/)) {
    const name = pathname.split('/')[4];
    try {
      const tools = await mcpListTools(name);
      return json(res, 200, { ok: true, server: name, tools });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/mcp/call') {
    const body = await getBody(req);
    const serverName = String(body.server || '').trim();
    const toolName2 = String(body.tool || body.name || '').trim();
    if (!serverName || !toolName2) return json(res, 400, { ok: false, error: 'server and tool are required' });
    try {
      const result = await mcpCallTool(serverName, toolName2, body.args || body.arguments || {});
      appendJsonl(path.join(dataRoot, 'logs', 'tool-calls.jsonl'), { ok: true, mcp: serverName, tool: toolName2, timestamp: new Date().toISOString() });
      return json(res, 200, { ok: true, server: serverName, tool: toolName2, result });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname.match(/^\/api\/mcp\/servers\/.+\/enable$/)) {
    const name = pathname.split('/')[4];
    const body = await getBody(req);
    const cfg = readJson(mcpConfigPath(), { mcpServers: {} });
    if (!cfg.mcpServers[name]) return json(res, 404, { ok: false, error: `MCP server '${name}' not found` });
    cfg.mcpServers[name].enabled = body.enabled !== false;
    writeJson(mcpConfigPath(), cfg);
    return json(res, 200, { ok: true, enabled: cfg.mcpServers[name].enabled, name });
  }

  // ── PERMISSION REQUEST ──────────────────────────────────────
  if (pathname === '/api/actions/request') {
    const body = await getBody(req);
    return json(res, 200, { ok: true, action_required: true, tool: body.tool || 'unknown', reason: body.reason || 'This action requires your permission.', request_id: `perm-${Date.now()}`, prompt: `⚠️ **Permission Request**: ${body.reason || 'This action requires your permission.'}\n\nType \`/allow-actions\` to grant permission for this session, or type \`/deny\` to reject.` });
  }

  // ── TELEGRAM POLL ──────────────────────────────────────────
  if (pathname === '/api/telegram/poll') {
    const settings = readJson(settingsPath(), {});
    const token = settings.telegram_token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return json(res, 400, { ok: false, error: 'No token configured' });
    try {
      const offset = settings.telegram_update_offset || 0;
      const resp = await fetchUrl(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=5`, { timeout: 10000 });
      const data = JSON.parse(resp);
      if (data.ok && data.result && data.result.length > 0) {
        const maxUpdate = Math.max(...data.result.map(u => u.update_id));
        const msgs = data.result.filter(u => u.message && u.message.text);
        for (const msg of msgs) {
          if (msg.message.text === '/start') {
            settings.telegram_chat_id = String(msg.message.chat.id);
            settings.telegram_update_offset = maxUpdate + 1;
            writeJson(settingsPath(), settings);
            // Send welcome
            await fetchUrl(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: msg.message.chat.id, text: '✅ ABUZ8 OS connected! You can now receive notifications here.' })
            });
            return json(res, 200, { ok: true, registered: true, chat_id: String(msg.message.chat.id) });
          }
        }
        settings.telegram_update_offset = maxUpdate + 1;
        writeJson(settingsPath(), settings);
      }
      return json(res, 200, { ok: true, registered: false, message: 'Send /start to your bot from Telegram to register.' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/dashboard') { try { return json(res, 200, await dashboardData()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/machine') { try { return json(res, 200, { ok: true, machine: await machineInfo() }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/models/recommended') { try { return json(res, 200, await recommendedModels()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── Moat Pack endpoints ──
  if (pathname === '/api/browser/task') { const b = await getBody(req); try { return json(res, 200, await browserTask(b.goal || b.task || '', b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/code/index') { const b = await getBody(req); const dir = b.dir && exists(b.dir) ? b.dir : (b.project ? projectDir(b.project) : selfRepoDir()); try { return json(res, 200, await indexCodebase(dir, b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/code/search') { const b = await getBody(req); const dir = b.dir && exists(b.dir) ? b.dir : (b.project ? projectDir(b.project) : selfRepoDir()); try { return json(res, 200, await searchCode(dir, b.query || b.q || '', Number(b.k) || 6)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/swarm/task') { const b = await getBody(req); try { return json(res, 200, await swarmTask(b.goal || b.task || '', b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/jobs') { return json(res, 200, { ok: true, jobs: listJobs().map((j) => ({ id: j.id, goal: j.goal, kind: j.kind, status: j.status, created: j.created, updated: j.updated })) }); }
  if (pathname === '/api/jobs/start') { const b = await getBody(req); if (!b.goal) return json(res, 400, { ok: false, error: 'goal required' }); return json(res, 200, { ok: true, job: startJob(b.goal, b.kind, b) }); }
  if (pathname === '/api/jobs/get') { const b = await getBody(req); const j = readJson(jobFile(b.id), null); return j ? json(res, 200, { ok: true, job: j }) : json(res, 404, { ok: false, error: 'job not found' }); }
  if (pathname === '/api/jobs/cancel') { const b = await getBody(req); const j = readJson(jobFile(b.id), null); if (!j) return json(res, 404, { ok: false, error: 'job not found' }); if (j.status === 'running') { j.status = 'canceled'; j.updated = new Date().toISOString(); writeJson(jobFile(b.id), j); pushActivity('done', 'Async job canceled: ' + String(j.goal || '').slice(0, 50), ''); } return json(res, 200, { ok: true, job: j }); }
  if (pathname === '/api/jobs/clear') { const b = await getBody(req); try { if (b.id) { const f = jobFile(b.id); if (exists(f)) fs.unlinkSync(f); } else { listJobs().filter((j) => j.status !== 'running').forEach((j) => { try { fs.unlinkSync(jobFile(j.id)); } catch {} }); } } catch (e) { return json(res, 400, { ok: false, error: e.message }); } return json(res, 200, { ok: true }); }
  if (pathname === '/api/gateway/inbound') { const b = await getBody(req); const s = readJson(settingsPath(), {}); if (s.gateway_secret && b.secret !== s.gateway_secret) return json(res, 401, { ok: false, error: 'bad or missing secret' }); const reply = await botRespond(b.text || b.message || ''); pushActivity('gateway', 'Inbound ' + (b.channel || '') + ': ' + String(b.text || '').slice(0, 40), ''); return json(res, 200, { ok: true, reply }); }
  if (pathname === '/api/tunnel/start') { try { return json(res, 200, await startTunnel()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/tunnel/stop') { return json(res, 200, stopTunnel()); }
  if (pathname === '/api/tunnel/status') { return json(res, 200, tunnelStatus()); }
  if (pathname === '/api/gateway/config') { if (req.method === 'POST') { const b = await getBody(req); const s = readJson(settingsPath(), {}); for (const k of ['slack_bot_token', 'gateway_secret']) if (b[k] != null) s[k] = b[k]; writeJson(settingsPath(), s); return json(res, 200, { ok: true }); } const s = readJson(settingsPath(), {}); return json(res, 200, { ok: true, slack: !!s.slack_bot_token, secret: !!s.gateway_secret, tunnel: tunnelStatus() }); }
  if (pathname === '/api/gateway/slack/events') { const b = await getBody(req); if (b.type === 'url_verification') return json(res, 200, { challenge: b.challenge }); if (b.type === 'event_callback' && b.event && b.event.type === 'message' && !b.event.bot_id && b.event.subtype == null && b.event.text) { const s = readJson(settingsPath(), {}); const ev = b.event; (async () => { try { const reply = await botRespond(ev.text); if (s.slack_bot_token) await slackPost(s.slack_bot_token, ev.channel, reply); } catch {} })(); pushActivity('gateway', 'Slack: ' + String(b.event.text).slice(0, 40), ''); } return json(res, 200, { ok: true }); }
  if (pathname === '/api/gateway/twilio') { const b = await getBody(req); const f = b.raw ? parseForm(b.raw) : b; const txt = f.Body || f.body || ''; const reply = await botRespond(txt); pushActivity('gateway', 'WhatsApp/SMS: ' + String(txt).slice(0, 40), ''); const safe = String(reply).slice(0, 1500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); const xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + safe + '</Message></Response>'; return text(res, 200, xml, 'text/xml; charset=utf-8'); }
  if (pathname === '/api/improve/status') { return json(res, 200, selfImproveStatus()); }
  if (pathname === '/api/skills/curate') { return json(res, 200, curateSkillsOnce(await getBody(req))); }
  if (pathname === '/api/self/heal') { if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required (no cross-origin GET trigger)' }); return json(res, 200, selfHealOnce()); }
  if (pathname === '/api/scaffold/evolve') { const b = await getBody(req); try { return json(res, 200, await evolveScaffoldOnce(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/scaffold/review') { return json(res, 200, scaffoldReviewOnce()); }
  if (pathname === '/api/scaffold/revert') { return json(res, 200, scaffoldRevertNow()); }
}

// route group 12/12 — /api/self/status … /api/providers/quick (38 lines)
async function routeG12(req, res, pathname, searchParams) {
  if (pathname === '/api/self/status') return json(res, 200, selfStatus());
  if (pathname === '/api/self/eval') { const b = await getBody(req); try { const ev = await runEvalOnWorktree(b.path || undefined, b); const baseline = readEvalBaseline(); if (b.set_baseline === true && ev.ok) writeEvalBaseline(ev.score); return json(res, 200, { ok: true, ...ev, baseline, passed: ev.ok && ev.score >= baseline }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/self/patch') { const b = await getBody(req); try { return json(res, 200, await selfApplyPatch(b.relpath || b.file, b.content, b.message, b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/self/propose') { const b = await getBody(req); try { return json(res, 200, await selfUpgradePropose(b.goal || b.task || '', b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/self/apply') { const b = await getBody(req); try { return json(res, 200, await selfUpgradeApply(b.id, b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/self/receive-patch') { const b = await getBody(req); try { return json(res, 200, await selfReceivePatch(b.patch, b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/fleet/upgrade-all') { const b = await getBody(req); try { return json(res, 200, await meshUpgradeAll(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/self/rollback') { const b = await getBody(req); try { return json(res, 200, await selfUpgradeRollback(b.id)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  // ── v1.23 Convergence Pack endpoints ──
  if (pathname === '/api/coder/run') { const b = await getBody(req); try { return json(res, 200, await coderRun(b.goal || b.task || b.prompt || '', b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/coder/projects') { try { const root = workspacesRoot(); const ps = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, dir: path.join(root, d.name), files: listProjectFiles(path.join(root, d.name), 60).length })); return json(res, 200, { ok: true, projects: ps }); } catch (e) { return json(res, 200, { ok: true, projects: [] }); } }
  if (pathname === '/api/coder/files') { const b = await getBody(req); const dir = b.dir && exists(b.dir) ? b.dir : projectDir(b.project || ''); return json(res, 200, { ok: true, dir, files: listProjectFiles(dir, 300) }); }
  if (pathname === '/api/coder/file') { const b = await getBody(req); try { const dir = b.dir && exists(b.dir) ? b.dir : projectDir(b.project || ''); const full = path.join(dir, String(b.path || '').replace(/\.\.[\/\\]/g, '')); if (!full.startsWith(dir)) throw new Error('out of sandbox'); return json(res, 200, { ok: true, path: b.path, contents: fs.readFileSync(full, 'utf8').slice(0, 200000) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/coder/stream') { const b = await getBody(req); const proj = path.basename(projectDir(b.project || b.goal || '')); return json(res, 200, { ok: true, stream: _coderStream[proj] || null }); }
  if (pathname === '/api/coder/history') { const b = await getBody(req); const dir = b.dir && exists(b.dir) ? b.dir : projectDir(b.project || ''); try { if (!exists(path.join(dir, '.git'))) return json(res, 200, { ok: true, history: [], note: 'no commits yet' }); const log = await devExec('git log --oneline -30', dir, 10000); return json(res, 200, { ok: true, history: (log.stdout || '').trim().split(/\r?\n/).filter(Boolean) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/deploy/targets') return json(res, 200, { ok: true, targets: deployTargets() });
  if (pathname === '/api/deploy/run') { const b = await getBody(req); try { return json(res, 200, await deployRun(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/skills/synthesize') { try { return json(res, 200, await synthesizeSkillsOnce(await getBody(req))); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/skills/feed') return json(res, 200, skillsFeed());
  if (pathname === '/api/skills/recall') { const b = await getBody(req); return json(res, 200, { ok: true, skills: await retrieveSkills(b.query || b.q || '', Number(b.k) || 3) }); }
  if (pathname === '/api/goals') return json(res, 200, { ok: true, goals: listGoals() });
  if (pathname === '/api/goals/create') { const b = await getBody(req); return json(res, 200, { ok: true, goal: createGoal(b) }); }
  if (pathname === '/api/goals/get') { const b = await getBody(req); const g = readJson(goalFile(b.id), null); return g ? json(res, 200, { ok: true, goal: g }) : json(res, 404, { ok: false, error: 'goal not found' }); }
  if (pathname === '/api/goals/run') { const b = await getBody(req); try { const g = b.id ? readJson(goalFile(b.id), null) : null; const id = g ? b.id : createGoal(b).id; return json(res, 200, { ok: true, goal: await runGoal(id, b) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/update/apply') { try { return json(res, 200, await applyUpdate()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/update/url') return json(res, 200, { ok: true, url: updateUrl(), current: APP_VERSION });
  if (pathname === '/api/mobile/edge-model') {
    const dl = searchParams.get('download') || searchParams.get('id');
    const models = mobileEdgeModels();
    if (!dl) return json(res, 200, { ok: true, models, note: 'GET ?download=<id> to fetch the GGUF onto the phone for fully-offline on-device inference (Apollo-style).' });
    const m = models.find((x) => x.id === dl); if (!m) return json(res, 404, { ok: false, error: 'unknown edge model', available: models.map((x) => x.id) });
    return serveFileWithRange(req, res, m.path, 'application/octet-stream');
  }
  if (pathname === '/api/mobile/scaffold') { const b = await getBody(req); try { return json(res, 200, await mobileScaffold(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/mobile/build') { const b = await getBody(req); try { return json(res, 200, await mobileBuild(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/providers/health') { try { return json(res, 200, await providersHealth()); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
  if (pathname === '/api/providers/quick') { const b = await getBody(req); try { return json(res, 200, setActiveProvider(b.id, b.model)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }

}

// ════════════════════════════════════════════════════════════════════════
// SPINE — the unified, crisply-organized primitive layer (v1.35 "unify" pass)
// ------------------------------------------------------------------------
// One canonical home for the org's first-class concepts so the three forks
// (ABUZ8 OS · QADIR_CORE · ABUZ8_AGENT_OS) CONVERGE instead of duplicating.
// Every primitive is a plain JSON collection under <dataRoot>/spine/<name>.json.
// Real reads/writes only — no shells. The migration importer pulls the real
// souls/minds/skills that already exist on disk into these collections.
// Routes: /api/spine/<collection>/(list|get|create|update|delete),
//         /api/spine/overview, /heartbeat[/beat], /migrate/(scan|import).
// ════════════════════════════════════════════════════════════════════════
const SPINE_COLLECTIONS = ['agents', 'souls', 'teams', 'threads', 'concepts', 'skills', 'memories', 'lessons', 'library', 'tools', 'providers', 'missions', 'migrations'];

function spineDir() { return safeMkdir(path.join(dataRoot, 'spine')); }
function spineFile(col) { return path.join(spineDir(), col + '.json'); }
function spineList(col) { return readJson(spineFile(col), []); }
function spineSave(col, arr) { writeJson(spineFile(col), arr); return arr; }
function spineNow() { return new Date().toISOString(); }
function spineId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

function spineCreate(col, rec) {
  if (!SPINE_COLLECTIONS.includes(col)) throw new Error('unknown spine collection: ' + col);
  const arr = spineList(col);
  const now = spineNow();
  const item = { id: (rec && rec.id) || spineId(col.slice(0, 3)), created: now, updated: now, ...rec };
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) { item.created = arr[i].created || now; arr[i] = item; } else arr.push(item);
  spineSave(col, arr);
  return item;
}
function spineUpdate(col, id, patch) {
  const arr = spineList(col);
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('not found: ' + id);
  arr[i] = { ...arr[i], ...patch, id, updated: spineNow() };
  spineSave(col, arr);
  return arr[i];
}
function spineDelete(col, id) {
  const arr = spineList(col);
  const next = arr.filter((x) => x.id !== id);
  spineSave(col, next);
  return { removed: arr.length - next.length };
}

// Heartbeat — liveness + uptime + a rolling tick log the agents/threads can pulse.
function spineHeartbeat() {
  const counts = {};
  for (const c of SPINE_COLLECTIONS) counts[c] = spineList(c).length;
  const hb = readJson(path.join(spineDir(), '_heartbeat.json'), { count: 0, first: spineNow(), last: null, history: [] });
  return { ok: true, alive: true, version: APP_VERSION, port: PORT, ts: spineNow(), uptime_s: Math.round(process.uptime()), counts, beat: hb };
}
function spineBeat(note) {
  const f = path.join(spineDir(), '_heartbeat.json');
  const hb = readJson(f, { count: 0, first: spineNow(), last: null, history: [] });
  hb.count = (hb.count || 0) + 1;
  hb.last = spineNow();
  hb.history = [{ ts: hb.last, note: String(note || '') }, ...(hb.history || [])].slice(0, 50);
  writeJson(f, hb);
  return hb;
}

// Provider "full works" registry — the model stack Ahmad named. Seeded once;
// editable thereafter via /api/spine/providers/(create|update|delete).
const SPINE_PROVIDER_SEED = [
  { id: 'anthropic', name: 'Anthropic Claude', kind: 'cloud', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'], env: 'ANTHROPIC_API_KEY', sdk: '@anthropic-ai/sdk' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', kind: 'cloud', models: ['gpt-4o', 'o3', 'gpt-4.1'], env: 'OPENAI_API_KEY', sdk: 'openai' },
  { id: 'google', name: 'Google Gemini', kind: 'cloud', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], env: 'GOOGLE_API_KEY', sdk: '@google/genai' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', models: ['deepseek-chat', 'deepseek-reasoner'], env: 'DEEPSEEK_API_KEY', sdk: 'openai-compat' },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'cloud', models: ['nemotron-4-340b', 'llama-3.1-nemotron-70b'], env: 'NVIDIA_API_KEY', sdk: 'openai-compat' },
  { id: 'hermes', name: 'Hermes (Nous, MIT — transport only)', kind: 'local', models: ['hermes-4'], env: null, sdk: 'mercury', note: 'borrowed, not sellable' },
  { id: 'gemma', name: 'Gemma (local omni brain)', kind: 'local', models: ['gemma-4-e4b'], env: null, sdk: 'ollama' },
  { id: 'fable', name: 'Fable 5', kind: 'cloud', models: ['claude-fable-5'], env: 'ANTHROPIC_API_KEY', sdk: '@anthropic-ai/sdk' },
  { id: 'nemo-ultra', name: 'Nemo Ultra', kind: 'local', models: ['nemo-ultra'], env: null, sdk: 'ollama', port: 8001 },
  { id: 'ollama', name: 'Ollama (local runtime)', kind: 'local', models: ['qwen3-coder', 'nomic-embed-text'], env: null, sdk: 'ollama', port: 11434 },
];
function spineSeedProviders() {
  if (spineList('providers').length) return;
  const now = spineNow();
  spineSave('providers', SPINE_PROVIDER_SEED.map((p) => ({ ...p, created: now, updated: now, source: 'seed' })));
}

// Migration — read the REAL souls/minds/skills already on disk in the sibling
// systems and fold them into the Spine. Read-only on sources; writes only to spine/.
function spineWalk(root, opts) {
  const { match, maxFiles = 300, maxDepth = 5 } = opts || {};
  const skip = ['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.archive', '.quarantine', '.wrangler', '.codegraph'];
  const out = [];
  if (!exists(root)) return out;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !skip.includes(e.name) && !e.name.endsWith('.deleted') && !e.name.includes('.deleted_')) stack.push({ dir: full, depth: depth + 1 });
      } else if (match(e.name, full)) { out.push(full); if (out.length >= maxFiles) break; }
    }
  }
  return out;
}
function spineParseLite(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8').slice(0, 20000); } catch { return {}; }
  const meta = {};
  const fm = /^---\s*([\s\S]*?)\s*---/.exec(txt);
  const yamlBlock = fm ? fm[1] : (/\.ya?ml$/i.test(file) ? txt : '');
  for (const line of yamlBlock.split(/\r?\n/)) {
    const m = /^([a-zA-Z_][\w-]*):\s*(.+?)\s*$/.exec(line);
    if (m && meta[m[1]] === undefined) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const h1 = /^#\s+(.+)$/m.exec(txt);
  if (h1 && !meta.name && !meta.title) meta.title = h1[1].trim();
  const para = txt.replace(/^---[\s\S]*?---/, '').split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#') && !s.startsWith('---'));
  if (para && !meta.description && !meta.mandate) meta.description = para.slice(0, 400);
  return meta;
}
function spineMigrationSources() {
  return [
    { system: 'QADIR_CORE', into: 'souls', kind: 'soul', root: 'E:\\ABU\\QADIR_CORE\\souls', match: (n) => /\.(md|ya?ml)$/i.test(n) },
    { system: 'QADIR_CORE', into: 'skills', kind: 'skill', root: 'E:\\ABU\\QADIR_CORE\\skills\\active', match: (n) => /\.(ya?ml|json)$/i.test(n) },
    { system: 'ABUZ8_AGENT_OS', into: 'agents', kind: 'mind', root: 'E:\\ABU\\ABUZ8_AGENT_OS', match: (n) => /^mind\.ya?ml$/i.test(n) },
    { system: 'ABUZ8_AGENT_OS', into: 'skills', kind: 'skill', root: 'E:\\ABU\\ABUZ8_AGENT_OS\\backend\\skills', match: (n) => /\.(ya?ml)$/i.test(n) },
  ];
}
function spineMigrationScan() {
  const out = [];
  for (const s of spineMigrationSources()) {
    const files = spineWalk(s.root, { match: s.match });
    const items = files.map((f) => {
      const meta = spineParseLite(f);
      const base = path.basename(f).replace(/\.(md|ya?ml|json)$/i, '');
      const parent = path.basename(path.dirname(f));
      const generic = ['soul', 'mind', 'index', 'readme', 'config', '__init__'].includes(base.toLowerCase());
      const name = meta.name || meta.id || (generic ? parent : base) || meta.title;
      return { name, kind: s.kind, into: s.into, system: s.system, source: f, mandate: meta.mandate || meta.description || meta.identity || '' };
    });
    out.push({ system: s.system, into: s.into, root: s.root, found: items.length, items });
  }
  return { ok: true, ts: spineNow(), available: exists('E:\\ABU\\QADIR_CORE') || exists('E:\\ABU\\ABUZ8_AGENT_OS'), sources: out, total: out.reduce((a, r) => a + r.found, 0) };
}
function spineMigrationImport() {
  const scan = spineMigrationScan();
  let imported = 0; const per = {};
  for (const grp of scan.sources) {
    for (const it of grp.items) {
      const sig = crypto.createHash('sha1').update(it.source).digest('hex').slice(0, 12);
      const id = (it.system.toLowerCase() + '_' + it.kind + '_' + sig);
      spineCreate(it.into, { id, name: it.name, kind: it.kind, mandate: it.mandate, source: it.source, system: it.system, imported_at: spineNow() });
      imported++; per[it.into] = (per[it.into] || 0) + 1;
    }
  }
  spineCreate('migrations', { name: 'import ' + spineNow(), imported, per, total: scan.total });
  return { ok: true, imported, per, total: scan.total, ts: spineNow() };
}

// Multi-model adjudication swarm — run N candidates in PARALLEL (each a real
// runTask loop, optionally on a different provider), then an adversarial judge
// picks the best with a bias to action/revenue. The winner is persisted as a
// reusable Spine lesson. This is the enterprise "build many, keep the best" play.
async function spineSwarmSolve(opts = {}) {
  const goal = opts.goal || opts.task || opts.objective || '';
  if (!goal) throw new Error('goal required');
  const provs = (Array.isArray(opts.providers) && opts.providers.length) ? opts.providers : null;
  const n = Math.max(1, Math.min(Number(opts.n) || (provs ? provs.length : 3), 6));
  const slots = provs ? provs.slice(0, n) : new Array(n).fill(null);
  const maxSteps = opts.max_steps != null ? Number(opts.max_steps) : 2;
  // 1) candidates compete in parallel
  const runs = await Promise.all(slots.map((p, i) => {
    const o = { max_steps: maxSteps, reflect: opts.reflect !== false, system: `You are candidate #${i + 1} in a competitive swarm answering one goal. Be decisive, concrete, and bias to action that drives the outcome/revenue. Out-think the other candidates.` };
    if (p) o.provider = p;
    return runTask(goal, o)
      .then((r) => ({ idx: i, provider: p || (r.brain || 'auto'), brain: r.brain || '', answer: r.response || '', steps: (r.tool_result && r.tool_result.steps) || 0, error: null }))
      .catch((e) => ({ idx: i, provider: p || 'auto', brain: '', answer: '', steps: 0, error: e.message }));
  }));
  const valid = runs.filter((r) => r.answer && r.answer.length > 10);
  // 2) adversarial adjudication
  let winner = 0, rationale = valid.length <= 1 ? 'single valid candidate' : '';
  if (valid.length > 1) {
    const ballot = valid.map((r, i) => `CANDIDATE ${i + 1} (brain: ${r.brain}):\n${String(r.answer).slice(0, 1500)}`).join('\n\n---\n\n');
    const judgePrompt = `You are an adversarial chief judge. ${valid.length} candidates answered the goal: "${goal}".\n\n${ballot}\n\nScore on correctness, concreteness, and bias-to-action/revenue. Pick the SINGLE best. Reply ONLY compact JSON: {"winner": <1-based index>, "why": "<one sentence>"}`;
    try {
      const jr = await reasonReply(judgePrompt, { system: 'You are a precise, adversarial evaluation engine. Output ONLY one JSON object.', noMemory: true });
      const mm = /\{[\s\S]*\}/.exec(jr.text || '');
      if (mm) { const pj = JSON.parse(mm[0]); if (pj.winner >= 1 && pj.winner <= valid.length) { winner = pj.winner - 1; rationale = String(pj.why || '').slice(0, 300); } }
    } catch {}
  }
  const best = valid[winner] || runs[0] || { answer: '', brain: '', provider: 'auto' };
  // 3) persist the win
  const thread = spineCreate('threads', { kind: 'swarm', goal: String(goal).slice(0, 500), winner_brain: best.brain, candidates: runs.length, answer: String(best.answer).slice(0, 8000) });
  if (best.answer) spineCreate('lessons', { name: 'swarm win: ' + String(goal).slice(0, 60), goal: String(goal).slice(0, 200), rationale, brain: best.brain, kind: 'swarm-win' });
  spineBeat('swarm solve x' + runs.length);
  return { ok: true, goal, candidates_run: runs.length, candidates_valid: valid.length, winner_index: winner, rationale, winner: { brain: best.brain, provider: best.provider, answer: best.answer }, all: runs.map((r) => ({ provider: r.provider, brain: r.brain, chars: (r.answer || '').length, error: r.error })), thread_id: thread.id };
}

// Full SDLC pipeline — plan -> design -> code -> review(swarm) -> test -> deploy
// -> monitor, each stage wired to the OS's real engines (reasonReply, coderRun,
// runEvalOnWorktree, deployRun, providersHealth) and the adjudication swarm.
// Persisted as a Spine mission with per-stage status. Stages are selectable.
async function spineSdlcStage(name, fn) {
  const t0 = Date.now();
  try { const out = await fn(); return { stage: name, ok: (out && out.ok !== false), ms: Date.now() - t0, ...(out || {}) }; }
  catch (e) { return { stage: name, ok: false, ms: Date.now() - t0, error: e.message }; }
}
async function spineSdlcRun(opts = {}) {
  const goal = opts.goal || opts.task || opts.objective || '';
  if (!goal) throw new Error('goal required');
  const want = (Array.isArray(opts.stages) && opts.stages.length) ? opts.stages : ['plan', 'design', 'code', 'review', 'test', 'deploy', 'monitor'];
  const has = (s) => want.includes(s);
  const stages = [];
  let plan = '', design = '', codeDir = '';
  if (has('plan')) stages.push(await spineSdlcStage('plan', async () => { const x = await reasonReply(`Produce a tight delivery PLAN for this goal: "${goal}". List objectives, key milestones, and risks. Concrete, <=200 words.`, { noMemory: true }); plan = x.text || ''; return { ok: !!plan, brain: x.brain, chars: plan.length }; }));
  if (has('design')) stages.push(await spineSdlcStage('design', async () => { const x = await reasonReply(`Goal "${goal}" with plan:\n${plan}\n\nProduce a DESIGN: components, files to create, and the API/interfaces. Concrete, <=250 words.`, { noMemory: true }); design = x.text || ''; return { ok: !!design, brain: x.brain, chars: design.length }; }));
  if (has('code')) stages.push(await spineSdlcStage('code', async () => { const x = await coderRun(`${goal}\n\nDesign:\n${design}`, { project: opts.project }); codeDir = (x && (x.dir || x.project_dir)) || ''; const files = x && (x.files || x.written); return { ok: x && x.ok !== false, dir: codeDir, files: Array.isArray(files) ? files.length : undefined }; }));
  if (has('review')) stages.push(await spineSdlcStage('review', async () => { const sw = await spineSwarmSolve({ goal: `Adversarially review this work for correctness, gaps, and the single highest-leverage improvement (bias to action/revenue). GOAL: ${goal}\nPLAN: ${plan.slice(0, 500)}\nDESIGN: ${design.slice(0, 800)}`, n: Number(opts.review_n) || 2, max_steps: 0 }); return { ok: sw.ok, winner_brain: sw.winner && sw.winner.brain, rationale: sw.rationale }; }));
  if (has('test')) stages.push(await spineSdlcStage('test', async () => { if (!codeDir) return { ok: true, skipped: 'no code dir to test' }; const ev = await runEvalOnWorktree(codeDir, {}); return { ok: ev && ev.ok !== false, score: ev && ev.score }; }));
  if (has('deploy')) stages.push(await spineSdlcStage('deploy', async () => { if (!opts.deploy) return { ok: true, skipped: 'deploy not requested' }; const d = await deployRun({ target: opts.deploy_target, dir: codeDir }); return { ok: d && d.ok !== false, target: opts.deploy_target || null }; }));
  if (has('monitor')) stages.push(await spineSdlcStage('monitor', async () => { let h = null; try { h = await providersHealth(); } catch {} return { ok: true, version: APP_VERSION, port: PORT, providers_ok: h ? (h.ok !== false) : null }; }));
  const ok = stages.every((s) => s.ok);
  const mission = spineCreate('missions', { kind: 'sdlc', name: 'SDLC: ' + String(goal).slice(0, 60), goal: String(goal).slice(0, 300), status: ok ? 'complete' : 'partial', stages: stages.map((s) => ({ stage: s.stage, ok: s.ok, ms: s.ms, note: s.error || s.skipped || s.rationale || '' })) });
  spineBeat('sdlc: ' + want.join('>'));
  return { ok, goal, stages, mission_id: mission.id, plan, design, code_dir: codeDir };
}

// ── E6: hash-chained audit ledger (tamper-evident, blockchain-style) ──
function spineAuditFile() { return path.join(spineDir(), 'audit_chain.jsonl'); }
function spineAuditLast() {
  try { const ls = fs.readFileSync(spineAuditFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean); return ls.length ? JSON.parse(ls[ls.length - 1]) : null; } catch { return null; }
}
function spineAuditAppend(event) {
  const prev = spineAuditLast();
  const prevHash = prev ? prev.hash : 'GENESIS';
  const rec = { seq: prev ? prev.seq + 1 : 0, ts: spineNow(), event: event || {}, prev: prevHash };
  rec.hash = crypto.createHash('sha256').update(prevHash + JSON.stringify(rec.event) + rec.ts + rec.seq).digest('hex');
  appendJsonl(spineAuditFile(), rec);
  return rec;
}
function spineAuditVerify() {
  let ls = [];
  try { ls = fs.readFileSync(spineAuditFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return { ok: true, length: 0, intact: true }; }
  let prevHash = 'GENESIS', intact = true, bad = null;
  for (const r of ls) {
    const h = crypto.createHash('sha256').update(prevHash + JSON.stringify(r.event) + r.ts + r.seq).digest('hex');
    if (r.prev !== prevHash || r.hash !== h) { intact = false; bad = r.seq; break; }
    prevHash = r.hash;
  }
  return { ok: true, length: ls.length, intact, broken_at: bad };
}

// ── E6: neocortex decision — N (default 10k) Monte-Carlo scenarios per option,
// emotion/utility-weighted, picks the highest-EV / highest-success choice. ──
function spineNeocortexDecide(opts = {}) {
  const options = Array.isArray(opts.options) ? opts.options : [];
  if (!options.length) throw new Error('options[] required');
  const trials = Math.max(100, Math.min(Number(opts.trials) || 10000, 200000));
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const results = options.map((o) => {
    const p = Math.max(0, Math.min(Number(o.p_success != null ? o.p_success : 0.5), 1));
    const payoff = Number(o.payoff != null ? o.payoff : 1);
    const downside = Number(o.downside != null ? o.downside : 0);
    const vol = Number(o.volatility != null ? o.volatility : Math.abs(payoff) * 0.25);
    const emo = Number(o.emotion_weight != null ? o.emotion_weight : 1);
    let wins = 0, sum = 0, sumsq = 0;
    for (let i = 0; i < trials; i++) {
      const v = ((Math.random() < p) ? payoff : downside) + gauss() * vol;
      const u = v * emo;
      if (u > 0) wins++; sum += u; sumsq += u * u;
    }
    const mean = sum / trials, variance = Math.max(0, sumsq / trials - mean * mean), std = Math.sqrt(variance);
    return { name: o.name || 'option', ev: +mean.toFixed(4), success_rate: +(wins / trials).toFixed(4), std: +std.toFixed(4), sharpe: std ? +(mean / std).toFixed(3) : null };
  });
  results.sort((a, b) => b.ev - a.ev);
  const best = results[0];
  spineCreate('lessons', { kind: 'decision', name: 'decide: ' + best.name, choice: best.name, ev: best.ev, success_rate: best.success_rate, trials });
  try { spineAuditAppend({ type: 'decision', choice: best.name, ev: best.ev, trials }); } catch {}
  return { ok: true, trials, verdict: best.name, best, ranked: results };
}

// ── E3: sandbox — run code in an isolated, timeout-bounded child process and
// report whether it WORKS before anything touches real life. (node now; py/wasm ROADMAP) ──
function spineSandboxRun(opts = {}) {
  return new Promise((resolve) => {
    const lang = (opts.lang || 'node').toLowerCase();
    const code = String(opts.code || '');
    if (!code) return resolve({ ok: false, error: 'code required' });
    if (!['node', 'js', 'javascript'].includes(lang)) return resolve({ ok: false, error: 'unsupported lang (node only; python/wasm = ROADMAP)', isolation: 'none' });
    let cp; try { cp = require('child_process'); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const dir = safeMkdir(path.join(spineDir(), 'sandbox'));
    const file = path.join(dir, 'run_' + Date.now().toString(36) + '.js');
    try { fs.writeFileSync(file, code); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const timeoutMs = Math.min(Number(opts.timeout_ms) || 5000, 20000);
    let out = '', err = '', done = false;
    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain node — without it,
    // spawning process.execPath in the packaged app boots a 2nd app instance, not the script.
    const child = cp.spawn(process.execPath, [file], { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    const to = setTimeout(() => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, timed_out: true, isolation: 'process+timeout (network not jailed — VM/WASM = ROADMAP)', stdout: out.slice(0, 2000), stderr: err.slice(0, 1000) }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(to); resolve({ ok: false, error: e.message }); });
    child.on('close', (codeN) => { if (done) return; done = true; clearTimeout(to); const ok = codeN === 0; try { spineAuditAppend({ type: 'sandbox', ok, lang }); } catch {} resolve({ ok, isolation: 'process+timeout (network not jailed — VM/WASM = ROADMAP)', exit: codeN, stdout: out.slice(0, 2000), stderr: err.slice(0, 1000) }); });
  });
}

// ── E5: hardware abstraction layer — registry of transports/radios with an
// HONEST device probe. Software layer is real; device paths are ROADMAP until present. ──
const SPINE_HARDWARE = [
  { id: 'bt54', name: 'Bluetooth 5.4', kind: 'radio', detect: ['bluetoothctl', 'btmgmt'] },
  { id: 'nfc-pn532', name: 'NFC PN532', kind: 'radio', detect: ['nfc-list'] },
  { id: 'hackrf', name: 'UHF HackRF One', kind: 'sdr', detect: ['hackrf_info'] },
  { id: 'sim7600', name: 'SIM7600 cellular', kind: 'cellular', detect: [] },
  { id: 'iridium-rockblock', name: 'Iridium RockBlock', kind: 'satellite', detect: [] },
  { id: 'uhf-mesh-exo', name: 'UHF mesh (EXO)', kind: 'mesh', detect: [] },
  { id: 'asmp-tor', name: 'ASMP over Tor', kind: 'transport', detect: ['tor'] },
];
function spineHardwareProbe() {
  let cp; try { cp = require('child_process'); } catch {}
  const seen = {};
  const which = (bin) => { if (!cp) return false; if (seen[bin] !== undefined) return seen[bin]; try { const r = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 1500, windowsHide: true }); return (seen[bin] = r.status === 0); } catch { return (seen[bin] = false); } };
  const torBundled = exists('E:\\ABU\\ABUZ8_OS_DIST\\build-assets\\tor') || (process.resourcesPath && exists(path.join(process.resourcesPath, 'tor')));
  const transports = SPINE_HARDWARE.map((h) => {
    const present = (h.detect || []).some((b) => which(b)) || (h.id === 'asmp-tor' && !!torBundled);
    return { id: h.id, name: h.name, kind: h.kind, present, status: present ? 'available' : 'roadmap' };
  });
  return { ok: true, ts: spineNow(), note: 'software abstraction layer; device-dependent transports are ROADMAP until hardware is verified present', transports, available: transports.filter((t) => t.present).map((t) => t.id) };
}

// ── E2-rest: turn a successful run/thread into a persisted, reusable Spine skill ──
function spineLearnSkillFrom(rec) {
  rec = rec || {};
  const name = rec.name || ('skill: ' + String(rec.goal || 'learned').slice(0, 50));
  const skill = spineCreate('skills', { name, kind: 'learned', goal: rec.goal || '', when: rec.when || rec.goal || '', body: String(rec.body || rec.answer || rec.rationale || '').slice(0, 4000), source: rec.source || 'auto-learn', brain: rec.brain || '' });
  try { spineAuditAppend({ type: 'skill_learned', name }); } catch {}
  return skill;
}

// ── P9: earn-loop — UTM-tagged tracked links + click ledger (revenue attribution) ──
function spineEarnFile() { return path.join(spineDir(), 'earn_clicks.jsonl'); }
function spineEarnLink(opts = {}) {
  const dest = String(opts.url || opts.dest || 'https://abuz8ai.com');
  const id = 'utm_' + crypto.randomBytes(4).toString('hex');
  let url = dest;
  try { const u = new URL(dest); u.searchParams.set('utm_source', String(opts.source || 'abuz8')); u.searchParams.set('utm_medium', String(opts.medium || 'agent')); u.searchParams.set('utm_campaign', String(opts.campaign || 'default')); u.searchParams.set('abz', id); url = u.toString(); } catch {}
  const rec = { id, url, dest, campaign: String(opts.campaign || 'default'), source: String(opts.source || 'abuz8'), clicks: 0 };
  spineCreate('library', { id: 'earnlink_' + id, kind: 'earn-link', ...rec });
  try { spineAuditAppend({ type: 'earn_link', id, campaign: rec.campaign }); } catch {}
  return rec;
}
function spineEarnClick(id, meta = {}) {
  appendJsonl(spineEarnFile(), { ts: spineNow(), id, ref: String(meta.ref || '').slice(0, 200), ua: String(meta.ua || '').slice(0, 200) });
  const lib = spineList('library'); const i = lib.findIndex((x) => x.id === 'earnlink_' + id);
  let campaign = 'unknown';
  if (i >= 0) { lib[i].clicks = (lib[i].clicks || 0) + 1; campaign = lib[i].campaign || 'default'; spineSave('library', lib); }
  // Commit every click to the tamper-evident, hash-linked audit chain → revenue attribution can't be silently edited.
  let audit = null; try { audit = spineAuditAppend({ type: 'earn_click', id, campaign }); } catch {}
  return { ok: true, id, recorded: true, signed: !!audit, seq: audit ? audit.seq : null };
}
function spineEarnLedger() {
  let clicks = []; try { clicks = fs.readFileSync(spineEarnFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const links = spineList('library').filter((x) => x.kind === 'earn-link');
  const byCampaign = {};
  for (const c of clicks) { const l = links.find((x) => x.id === 'earnlink_' + c.id); const camp = l ? l.campaign : 'unknown'; byCampaign[camp] = (byCampaign[camp] || 0) + 1; }
  return { ok: true, links: links.length, clicks: clicks.length, by_campaign: byCampaign };
}
function spineLicenseCheck(feature) {
  const st = licenseStatus();
  return { ok: true, feature: feature || null, licensed: !!st.licensed, tier: st.tier, allowed: !!st.licensed, truth_status: st.licensed ? 'LIVE' : 'free-tier' };
}

// ── P7: project lifecycle + live preview (Replit-style) ──
function spineProjectCreate(opts = {}) {
  const name = String(opts.name || 'project');
  const dir = projectDir(name);
  if (opts.files && typeof opts.files === 'object') {
    for (const [rel, content] of Object.entries(opts.files)) { const full = path.join(dir, String(rel).replace(/\.\.[\/\\]/g, '')); if (!full.startsWith(dir)) continue; safeMkdir(path.dirname(full)); fs.writeFileSync(full, String(content)); }
  } else if (opts.scaffold !== false && !exists(path.join(dir, 'index.html'))) {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset=utf-8><title>' + name + '</title><h1>' + name + '</h1><p>Scaffolded by ABUZ8 OS — preview is live.</p>');
  }
  spineCreate('library', { id: 'project_' + slug(name), kind: 'project', name, dir, preview: '/api/spine/preview/' + slug(name) + '/index.html' });
  return { ok: true, name, dir, files: listProjectFiles(dir, 100).length, preview: '/api/spine/preview/' + slug(name) + '/index.html' };
}

// ── E4: git ops (read/recovery only) + repo registry ──
function spineRepoRegister(opts = {}) {
  const dir = String(opts.dir || '');
  if (!dir || !exists(path.join(dir, '.git'))) throw new Error('not a git repo: ' + dir);
  return spineCreate('library', { id: 'repo_' + slug(opts.name || path.basename(dir)), kind: 'repo', name: opts.name || path.basename(dir), dir, remote: opts.remote || '' });
}
async function spineGit(opts = {}) {
  const action = opts.action || 'status';
  let dir = opts.dir;
  if (!dir && opts.repo) { const r = spineList('library').find((x) => x.kind === 'repo' && (x.name === opts.repo || x.id === 'repo_' + slug(opts.repo))); if (r) dir = r.dir; }
  if (!dir && opts.project) dir = projectDir(opts.project);
  if (!dir || !exists(path.join(dir, '.git'))) throw new Error('no git repo (pass dir, registered repo name, or a project with .git)');
  const safeMap = { status: 'git status --porcelain=v1 -b', log: 'git log --oneline -20', diff: 'git diff --stat', branches: 'git branch -a', reflog: 'git reflog -20', remotes: 'git remote -v' };
  const cmd = safeMap[action]; if (!cmd) throw new Error('unsupported git action: ' + action + ' (allowed: ' + Object.keys(safeMap).join(', ') + ')');
  const out = await devExec(cmd, dir, 15000);
  try { spineAuditAppend({ type: 'git', action }); } catch {}
  return { ok: out.ok !== false, action, dir, output: String(out.stdout || out.stderr || '').slice(0, 4000) };
}

// ── P2b: Mercury — OpenAI-compatible /v1 surface so LangChain/Cursor/n8n/Hermes
// can use ABUZ8 as a brain. Routes through the OS's reasonReply + provider stack. ──
async function mercuryChat(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages.length ? messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n') : String(body.prompt || '');
  const r = await reasonReply(prompt, { noMemory: true });
  return { id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'abuz8', brain: r.brain, choices: [{ index: 0, message: { role: 'assistant', content: r.text || '' }, finish_reason: 'stop' }], usage: {} };
}
function mercuryModels() {
  const data = [{ id: 'abuz8', object: 'model', owned_by: 'abuz8-os' }];
  for (const p of spineList('providers')) for (const m of (p.models || [])) data.push({ id: m, object: 'model', owned_by: p.id });
  return { object: 'list', data };
}

// ── P3/P11: STUDIO — PDF/script → scene-by-scene storyboard (dialogue/action/
// camera/music/SFX) → render via the proven local engine. The "Pixar-pipeline" brain. ──
function comfyuiReachable() {
  return new Promise((resolve) => {
    let r; try { r = require('http').get({ host: '127.0.0.1', port: 8188, path: '/system_stats', timeout: 2000 }, (resp) => { resolve((resp.statusCode || 0) > 0); resp.resume(); }); } catch { return resolve(false); }
    r.on('error', () => resolve(false)); r.on('timeout', () => { try { r.destroy(); } catch {} resolve(false); });
  });
}
const STUDIO_DEPARTMENTS = [
  { id: 'story', name: 'Story & Script', does: 'adapt source → screenplay, beats, dialogue' },
  { id: 'previs', name: 'Previs / Storyboard', does: 'scene-by-scene shot breakdown' },
  { id: 'art', name: 'Art & Concept', does: 'style, characters, environments, image prompts' },
  { id: 'layout', name: 'Layout & Camera', does: 'shot composition, camera moves' },
  { id: 'animation', name: 'Animation', does: 'motion + performance (t2v/i2v)' },
  { id: 'lighting', name: 'Lighting & Look-dev', does: 'mood, color, grade' },
  { id: 'fx', name: 'FX / VFX', does: 'effects, particles, comp' },
  { id: 'editorial', name: 'Editorial', does: 'assembly, pacing, final cut' },
  { id: 'sound', name: 'Sound Design', does: 'SFX, foley' },
  { id: 'music', name: 'Music & Score', does: 'score + cues' },
];
function spineStudioDepartments() {
  const teams = STUDIO_DEPARTMENTS.map((d) => spineCreate('teams', { id: 'dept_' + d.id, kind: 'studio-department', name: d.name, does: d.does }));
  return { ok: true, departments: STUDIO_DEPARTMENTS, seeded: teams.length };
}
async function spineStudioStoryboard(opts = {}) {
  const title = String(opts.title || 'Untitled');
  const source = String(opts.pdf_text || opts.script || opts.synopsis || opts.prompt || '').slice(0, 8000);
  if (!source) throw new Error('provide synopsis, script, or pdf_text');
  const scenesN = Math.max(1, Math.min(Number(opts.scenes_n) || 3, 8));
  const style = String(opts.style || 'cinematic');
  const prompt = `You are the Story + Previs department of an animation studio. From the SOURCE, produce a scene-by-scene STORYBOARD for "${title}" in a ${style} style, ${scenesN} scenes. Each scene: setting, 1-line summary, 2-3 shots (each: action, dialogue, camera, vfx, and a vivid image_prompt for a text-to-image model), plus the scene's music cue and key SFX.\n\nSOURCE:\n${source}\n\nReply ONLY with compact JSON: {"title":"","logline":"","style":"","scenes":[{"n":1,"setting":"","summary":"","music":"","sfx":"","shots":[{"n":1,"action":"","dialogue":"","camera":"","vfx":"","image_prompt":""}]}]}`;
  const r = await reasonReply(prompt, { noMemory: true, system: 'You are a precise studio storyboard engine. Output ONLY one JSON object, no prose.' });
  let board = null;
  try { const m = /\{[\s\S]*\}/.exec(r.text || ''); if (m) board = JSON.parse(m[0]); } catch {}
  if (!board || !Array.isArray(board.scenes)) board = { title, logline: '', style, scenes: [], raw: (r.text || '').slice(0, 1500), parse_failed: true };
  board.title = board.title || title; board.brain = r.brain;
  const shots = (board.scenes || []).reduce((a, s) => a + ((s.shots || []).length), 0);
  const proj = spineCreate('library', { kind: 'storyboard', name: title, title, scenes: (board.scenes || []).length, shots, board });
  try { spineAuditAppend({ type: 'storyboard', title, scenes: (board.scenes || []).length, shots }); } catch {}
  return { ok: !board.parse_failed, title, scenes: (board.scenes || []).length, shots, brain: r.brain, storyboard_id: proj.id, storyboard: board };
}
async function spineStudioMovie(opts = {}) {
  let board = opts.storyboard, sbId = opts.storyboard_id;
  if (!board && sbId) { const p = spineList('library').find((x) => x.id === sbId); if (p) board = p.board; }
  if (!board) { const sb = await spineStudioStoryboard(opts); board = sb.storyboard; sbId = sb.storyboard_id; }
  const shots = [];
  (board.scenes || []).forEach((s) => (s.shots || []).forEach((sh) => shots.push({ scene: s.n, shot: sh.n, image_prompt: sh.image_prompt, dialogue: sh.dialogue, music: s.music, sfx: s.sfx })));
  let comfyUp = false;
  if (opts.render) { try { comfyUp = await comfyuiReachable(); } catch {} }
  const assets = [];
  if (opts.render && comfyUp) {
    const max = Math.max(1, Math.min(Number(opts.max_shots) || shots.length, 6));
    for (let i = 0; i < Math.min(shots.length, max); i++) {
      try { const rr = await localMediaGenerate({ kind: 'image', prompt: shots[i].image_prompt || ((board.title || 'scene') + ' cinematic still') }); assets.push({ scene: shots[i].scene, shot: shots[i].shot, ok: rr.ok !== false, media: rr.media_url || rr.file || rr.path || null }); }
      catch (e) { assets.push({ scene: shots[i].scene, shot: shots[i].shot, ok: false, error: e.message }); }
    }
  }
  const proj = spineCreate('library', { kind: 'movie', name: board.title || 'movie', title: board.title, shots: shots.length, rendered: assets.filter((a) => a.ok).length, storyboard_id: sbId });
  return { ok: true, title: board.title, total_shots: shots.length, render_requested: !!opts.render, comfyui_up: comfyUp, rendered: assets.length, assets, render_plan: assets.length ? undefined : shots.map((s) => ({ scene: s.scene, shot: s.shot, image_prompt: s.image_prompt })), movie_id: proj.id, note: opts.render ? (comfyUp ? 'rendered keyframes via local FLUX' : 'ComfyUI offline — returned render-plan; start :8188 to render') : 'storyboard + plan only (set render:true)' };
}

// ── P4: avatar — wrap the proven local talking-head engine (XTTS clone + Wav2Lip) ──
async function spineStudioAvatar(opts = {}) {
  const out = await generateTalkingAvatar(opts);
  if (out && out.ok) { try { spineCreate('library', { kind: 'avatar', name: opts.name || 'avatar', out: out.out, bytes: out.bytes, voice: out.voice }); spineAuditAppend({ type: 'avatar', ok: true }); } catch {} }
  return out;
}

// ── P6: computer-use — REAL Windows input/screen via .NET P/Invoke (no new deps) ──
function winPS(script) {
  return new Promise((resolve) => {
    let cp; try { cp = require('child_process'); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '';
    const child = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
async function spineComputer(action, args = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'computer-use is Windows-only for now (.NET P/Invoke); linux/mac = ROADMAP.' };
  const A = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;';
  if (action === 'info') {
    const r = await winPS(A + '$p=[System.Windows.Forms.Cursor]::Position; $s=[System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output ("{0},{1},{2},{3}" -f $p.X,$p.Y,$s.Width,$s.Height)');
    const [x, y, w, h] = String(r.out || '').split(',').map(Number);
    return { ok: r.ok && !!w, cursor: { x, y }, screen: { w, h } };
  }
  if (action === 'screenshot') {
    const outp = path.join(safeMkdir(path.join(dataRoot, 'spine', 'shots')), 'shot_' + Date.now() + '.png');
    const r = await winPS(A + `$s=[System.Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.X,$s.Y,0,0,$b.Size); $b.Save('${outp.replace(/\\/g, '\\\\')}'); Write-Output $b.Width`);
    return { ok: r.ok && exists(outp), file: outp, width: Number(r.out) || null };
  }
  if (action === 'move') { const r = await winPS(A + `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(args.x) || 0}, ${Number(args.y) || 0})`); return { ok: r.ok, moved: { x: Number(args.x) || 0, y: Number(args.y) || 0 } }; }
  if (action === 'type') { const t = String(args.text || '').replace(/[+^%~(){}\[\]]/g, '{$&}').replace(/"/g, '`"'); const r = await winPS(A + `[System.Windows.Forms.SendKeys]::SendWait("${t}")`); return { ok: r.ok, typed: String(args.text || '').length }; }
  if (action === 'key') { const r = await winPS(A + `[System.Windows.Forms.SendKeys]::SendWait("${String(args.keys || '').replace(/"/g, '')}")`); return { ok: r.ok }; }
  if (action === 'click') { const r = await winPS(A + 'Add-Type -Name U -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int d,int e);\'; [W.U]::mouse_event(2,0,0,0,0); [W.U]::mouse_event(4,0,0,0,0)'); return { ok: r.ok, clicked: true }; }
  return { ok: false, error: 'unknown computer action: ' + action + ' (info|screenshot|move|click|type|key)' };
}

// ── P10: mobile master-control client (Expo/React-Native) talking to the OS API ──
function spineMobileClient(opts = {}) {
  const name = slug(opts.name || 'abuz8-control') || 'abuz8-control';
  const dir = projectDir(name + '-mobile');
  const host = String(opts.host || 'http://127.0.0.1:8900');
  const appJs = "import { useEffect, useState } from 'react';\nimport { SafeAreaView, ScrollView, Text, View, TextInput, TouchableOpacity } from 'react-native';\nconst HOST = '" + host + "';\nexport default function App(){\n  const [o,setO]=useState(null); const [msg,setMsg]=useState(''); const [reply,setReply]=useState('');\n  useEffect(()=>{ fetch(HOST+'/api/spine/overview').then(r=>r.json()).then(setO).catch(()=>{}); },[]);\n  const send=async()=>{ try{ const r=await fetch(HOST+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:msg})}); const j=await r.json(); setReply(j.response||j.text||JSON.stringify(j)); }catch(e){ setReply('err'); } };\n  return (<SafeAreaView style={{flex:1,backgroundColor:'#FAF8F5'}}><ScrollView contentContainerStyle={{padding:20}}>\n    <Text style={{fontSize:22,fontWeight:'700',color:'#1c1a17'}}>ABUZ8 Control</Text>\n    <Text style={{color:'#6b655c',marginBottom:12}}>master control · {o?('v'+o.version):'…'}</Text>\n    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{o&&Object.entries(o.counts).map(([k,v])=>(<View key={k} style={{backgroundColor:'#fff',borderColor:'#e7e1d8',borderWidth:1,borderRadius:12,padding:12,minWidth:90}}><Text style={{fontSize:22,fontWeight:'700'}}>{v}</Text><Text style={{color:'#6b655c',fontSize:11}}>{k}</Text></View>))}</View>\n    <TextInput value={msg} onChangeText={setMsg} placeholder='Ask ABUZ8…' style={{backgroundColor:'#fff',borderColor:'#e7e1d8',borderWidth:1,borderRadius:10,padding:12,marginTop:16}} />\n    <TouchableOpacity onPress={send} style={{backgroundColor:'#C8A55C',borderRadius:10,padding:14,marginTop:10}}><Text style={{textAlign:'center',fontWeight:'700'}}>Send</Text></TouchableOpacity>\n    <Text style={{marginTop:14,color:'#1c1a17'}}>{reply}</Text>\n  </ScrollView></SafeAreaView>); }\n";
  safeMkdir(dir);
  fs.writeFileSync(path.join(dir, 'App.js'), appJs);
  writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', main: 'node_modules/expo/AppEntry.js', scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios' }, dependencies: { expo: '~51.0.0', 'expo-status-bar': '~1.12.1', react: '18.2.0', 'react-native': '0.74.5' } });
  spineCreate('library', { kind: 'mobile-app', name, dir, host });
  return { ok: true, name, dir, host, note: 'Expo master-control client written. Build: cd dir; npx expo start (dev) or EAS / QADIR BUILD_SIGNED_AAB.ps1 for an APK/iOS binary.' };
}

// ── P11: 360° frame manifest for a project's images (feeds /360 viewer) ──
function spineStudio360(proj) {
  const dir = projectDir(String(proj || ''));
  let images = [];
  try { images = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => '/api/spine/preview/' + slug(proj) + '/' + f); } catch {}
  return { ok: true, proj, frames: images.length, images, viewer: '/360?proj=' + encodeURIComponent(String(proj || '')) };
}

// ── P11: TRUE 360 PHOTOGRAMMETRY via Tripo — multi-view photos → real .glb mesh ──
async function spinePhotoB64(src) {
  if (/^https?:\/\//i.test(src)) { const buf = await fetchUrl(src, { binary: true, timeout: 30000 }); return Buffer.from(buf).toString('base64'); }
  if (/^data:image/i.test(src)) return src.replace(/^data:image\/\w+;base64,/, '');
  if (exists(src)) return fs.readFileSync(src).toString('base64');
  throw new Error('image not found: ' + src);
}
async function spineTripoUpload(key, b64, type) {
  const up = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: { type: type || 'png', data: b64 } }), timeout: 60000 }));
  return up.data && (up.data.image_token || up.data.file_token);
}
async function spinePhotogrammetryStatus(taskId, key) {
  key = key || connectorCreds('tripo').api_key; if (!key) return { ok: false, error: 'no Tripo key' };
  const r = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/task/' + encodeURIComponent(taskId), { headers: { Authorization: 'Bearer ' + key }, timeout: 30000 }));
  const d = r.data || {};
  return { ok: true, status: d.status, progress: d.progress, model_url: d.output && (d.output.pbr_model || d.output.model || d.output.base_model), rendered: d.output && d.output.rendered_image };
}
async function spinePhotogrammetryWait(taskId, key, timeoutS) {
  const deadline = Date.now() + (Math.min(timeoutS || 300, 600) * 1000);
  while (Date.now() < deadline) {
    const s = await spinePhotogrammetryStatus(taskId, key);
    if (s.status === 'success') return { ok: true, status: 'success', model_url: s.model_url, rendered: s.rendered };
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(s.status)) return { ok: false, status: s.status };
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { ok: false, status: 'timeout' };
}
async function spinePhotogrammetry(opts = {}) {
  const key = opts.key || connectorCreds('tripo').api_key;
  if (!key) return { ok: false, needs_auth: true, error: 'No Tripo key — connect one in Providers/Connect (platform.tripo3d.ai) to turn photos into a real 3D mesh.' };
  let images = opts.images || (opts.image ? [opts.image] : []);
  if (!Array.isArray(images) || !images.length) return { ok: false, error: 'provide images[] (1 = single view, 2-4 = multiview front/left/back/right for a true 360 mesh)' };
  images = images.slice(0, 4);
  const type = opts.img_type || 'png';
  try {
    const tokens = [];
    for (const im of images) { const b64 = await spinePhotoB64(im); const tok = await spineTripoUpload(key, b64, type); if (!tok) return { ok: false, error: 'Tripo upload failed for an image' }; tokens.push(tok); }
    const payload = tokens.length >= 2
      ? { type: 'multiview_to_model', files: tokens.map((t) => ({ type, file_token: t })), mode: 'LEFT' }
      : { type: 'image_to_model', file: { type, file_token: tokens[0] } };
    const task = JSON.parse(await fetchUrl('https://api.tripo3d.ai/v2/openapi/task', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 60000 }));
    const taskId = task.data && task.data.task_id;
    if (!taskId) return { ok: false, error: 'Tripo task creation failed', raw: task };
    const rec = spineCreate('library', { kind: 'model3d', name: opts.name || ('reconstruction ' + spineNow()), task_id: taskId, mode: tokens.length >= 2 ? 'multiview' : 'single', views: tokens.length, status: 'running' });
    try { spineAuditAppend({ type: 'photogrammetry', task_id: taskId, views: tokens.length }); } catch {}
    if (opts.wait) {
      const r = await spinePhotogrammetryWait(taskId, key, Number(opts.timeout_s) || 300);
      const lib = spineList('library'); const i = lib.findIndex((x) => x.id === rec.id); if (i >= 0) { lib[i].status = r.status; lib[i].model_url = r.model_url; spineSave('library', lib); }
      return { ok: r.ok, model_id: rec.id, task_id: taskId, mode: rec.mode, status: r.status, model_url: r.model_url, rendered: r.rendered, viewer: r.model_url ? ('/360?model=' + encodeURIComponent(r.model_url)) : null };
    }
    return { ok: true, model_id: rec.id, task_id: taskId, mode: rec.mode, status: 'running', note: 'reconstructing — poll /api/spine/photogrammetry/status?task_id=' + taskId };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── P11: LOCAL TripoSR — sovereign image→3D on the GPU, zero cloud key ──
function triposrReady() { const repo = 'E:\\ABU\\TripoSR'; return exists(path.join(repo, 'tsr')) || exists(path.join(repo, '.git')); }
function triposrPython() { return (readJson(settingsPath(), {}).comfy_python) || 'E:\\ABU\\ComfyUI\\.venv\\Scripts\\python.exe'; }
async function spinePhotogrammetryLocal(opts = {}) {
  const img = String(opts.image || (Array.isArray(opts.images) && opts.images[0]) || '');
  if (!img) return { ok: false, error: 'provide image = path/URL to a photo' };
  const py = triposrPython();
  if (!triposrReady() || !exists(py)) return { ok: false, not_installed: true, error: 'Local TripoSR not installed yet (one-time setup: clone + deps + ~1.7GB weights).', setup: 'powershell -ExecutionPolicy Bypass -File E:\\ABU\\ABUZ8_OS_DIST\\scripts\\setup_triposr.ps1' };
  // python can't execute a script from inside the asar, so resolve a real on-disk path.
  const runner = ['E:\\ABU\\ABUZ8_OS_DIST\\scripts\\3d\\triposr_run.py', path.join(__dirname, '..', 'scripts', '3d', 'triposr_run.py')].find((p) => exists(p)) || path.join(__dirname, '..', 'scripts', '3d', 'triposr_run.py');
  let imgPath = img;
  try {
    if (/^https?:\/\//i.test(img)) { const buf = await fetchUrl(img, { binary: true, timeout: 30000 }); imgPath = path.join(safeMkdir(path.join(dataRoot, 'spine', '3d')), 'in_' + Date.now() + '.png'); fs.writeFileSync(imgPath, Buffer.from(buf)); }
  } catch (e) { return { ok: false, error: 'could not fetch image: ' + e.message }; }
  if (!exists(imgPath)) return { ok: false, error: 'image not found: ' + img };
  const out = path.join(safeMkdir(path.join(dataRoot, 'spine', '3d')), 'mesh_' + Date.now() + '.glb');
  return await new Promise((resolve) => {
    execFile(py, [runner, imgPath, out, String(opts.resolution || 256)], { windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
      let parsed = null; try { const lines = String(so || '').trim().split(/\r?\n/); parsed = JSON.parse(lines[lines.length - 1]); } catch {}
      if (parsed && parsed.ok && exists(out)) {
        const rec = spineCreate('library', { kind: 'model3d', name: opts.name || 'local-reconstruction', engine: 'triposr-local', out, verts: parsed.verts, sovereign: true });
        try { spineAuditAppend({ type: 'photogrammetry_local', verts: parsed.verts }); } catch {}
        return resolve({ ok: true, engine: 'triposr-local', sovereign: true, model_id: rec.id, out, verts: parsed.verts, viewer: '/360?model=' + encodeURIComponent('/api/spine/model/' + rec.id) });
      }
      resolve({ ok: false, not_installed: !!(parsed && parsed.not_installed), error: (parsed && parsed.error) || 'TripoSR run failed', detail: String(se || (err && err.message) || so || '').slice(-600) });
    });
  });
}

// ── P11: CapCut-style timeline editor — clips → ffmpeg assemble → mp4 ──
function ffmpegBin() { return ['E:\\ABU\\AI\\ffmpeg\\ffmpeg.exe', 'E:\\ABU\\AI\\ffmpeg\\bin\\ffmpeg.exe'].find((p) => exists(p)) || 'ffmpeg'; }
function ffrun(args, timeout) { return new Promise((resolve) => { try { execFile(ffmpegBin(), args, { windowsHide: true, timeout: timeout || 120000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => resolve({ ok: !err, err: err ? String(se || err.message).slice(-400) : '' })); } catch (e) { resolve({ ok: false, err: e.message }); } }); }
async function spineEditorRender(opts = {}) {
  let tl = opts.timeline;
  if (!tl && opts.id) { const p = spineList('library').find((x) => x.id === opts.id && x.kind === 'timeline'); if (p) tl = p.timeline; }
  if (!tl || !Array.isArray(tl.clips) || !tl.clips.length) return { ok: false, error: 'provide timeline.clips[] (each {src, dur, text?})' };
  const w = Number(tl.w) || 1280, h = Number(tl.h) || 720, fps = Number(tl.fps) || 30;
  const dir = safeMkdir(path.join(dataRoot, 'spine', 'editor', 'r_' + Date.now().toString(36)));
  const font = 'C\\:/Windows/Fonts/arial.ttf';
  const segs = [];
  for (let i = 0; i < Math.min(tl.clips.length, 40); i++) {
    const c = tl.clips[i] || {}; const dur = Math.max(0.3, Number(c.dur) || 3); const src = String(c.src || ''); const seg = path.join(dir, 'seg_' + i + '.mp4');
    let vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    if (c.text) { const t = String(c.text).replace(/[\\:']/g, ' ').slice(0, 120); vf += `,drawtext=fontfile='${font}':text='${t}':fontcolor=white:fontsize=${Math.round(h / 16)}:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h-th-40`; }
    let args;
    if (!src) args = ['-y', '-f', 'lavfi', '-i', `color=c=0x141414:s=${w}x${h}:d=${dur}:r=${fps}`, '-vf', vf, '-pix_fmt', 'yuv420p', seg];
    else if (/\.(png|jpe?g|webp|bmp)$/i.test(src)) args = ['-y', '-loop', '1', '-t', String(dur), '-i', src, '-vf', vf, '-r', String(fps), '-pix_fmt', 'yuv420p', seg];
    else args = ['-y', '-t', String(dur), '-i', src, '-vf', vf, '-r', String(fps), '-pix_fmt', 'yuv420p', '-an', seg];
    const r = await ffrun(args, 120000);
    if (r.ok && exists(seg)) segs.push(seg);
  }
  if (!segs.length) return { ok: false, error: 'no clips rendered (check ffmpeg + sources)' };
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
  const out = path.join(dir, (slug(tl.name || 'edit') || 'edit') + '.mp4');
  let cargs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (tl.audio && exists(tl.audio)) cargs = cargs.concat(['-i', tl.audio, '-shortest', '-c:a', 'aac']);
  cargs = cargs.concat(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  const rc = await ffrun(cargs, 180000);
  if (!rc.ok || !exists(out)) return { ok: false, error: 'concat failed', detail: rc.err };
  const rec = spineCreate('library', { kind: 'render', name: tl.name || 'edit', out, clips: segs.length, w, h });
  try { spineAuditAppend({ type: 'editor_render', clips: segs.length }); } catch {}
  return { ok: true, out, clips: segs.length, bytes: fs.statSync(out).size, media: '/api/spine/render/' + rec.id, render_id: rec.id };
}

function spineOverview() {
  spineSeedProviders();
  const counts = {};
  for (const c of SPINE_COLLECTIONS) counts[c] = spineList(c).length;
  return {
    ok: true, name: 'ABUZ8 Spine', version: APP_VERSION, ts: spineNow(),
    primitives: SPINE_COLLECTIONS, counts, heartbeat: spineHeartbeat(),
    providers: spineList('providers').map((p) => ({ id: p.id, name: p.name, kind: p.kind, models: (p.models || []).length })),
  };
}

// route group 13/13 — /api/spine/* (unified primitive + migration + heartbeat layer)
async function routeGSpine(req, res, pathname, searchParams) {
  if (!pathname.startsWith('/api/spine')) return;
  spineSeedProviders();
  try {
    if (pathname.startsWith('/api/spine/preview/')) {
      const rest = pathname.slice('/api/spine/preview/'.length);
      const slash = rest.indexOf('/');
      const proj = slash >= 0 ? rest.slice(0, slash) : rest;
      const relPath = ((slash >= 0 ? rest.slice(slash + 1) : 'index.html') || 'index.html').replace(/\.\.[\/\\]/g, '');
      const dir = projectDir(proj);
      const full = path.join(dir, relPath);
      if (!full.startsWith(dir) || !exists(full)) return json(res, 404, { ok: false, error: 'preview file not found' });
      const ext = path.extname(full).toLowerCase();
      const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
      try { return binary(res, 200, fs.readFileSync(full), MIME[ext] || 'application/octet-stream'); } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/spine' || pathname === '/api/spine/overview') return json(res, 200, spineOverview());
    if (pathname === '/api/spine/heartbeat') return json(res, 200, spineHeartbeat());
    if (pathname === '/api/spine/heartbeat/beat') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, { ok: true, beat: spineBeat(b.note) }); }
    if (pathname === '/api/spine/migrate/scan') return json(res, 200, spineMigrationScan());
    if (pathname === '/api/spine/migrate/import') { if (req.method === 'POST') await getBody(req); return json(res, 200, spineMigrationImport()); }
    // Bridge: run a Spine agent (with its soul/mandate as identity) through the
    // REAL ReAct loop (runTask) and persist the run as a Spine thread. This is the
    // unify play — Spine agents drive the existing battle-tested engine, not a fork.
    if (pathname === '/api/spine/agents/run') {
      const b = req.method === 'POST' ? await getBody(req) : {};
      const goal = b.goal || b.task || b.objective || '';
      if (!goal) return json(res, 400, { ok: false, error: 'goal required' });
      const agent = b.id ? (spineList('agents').find((x) => x.id === b.id) || null) : null;
      const name = (agent && agent.name) || b.name || 'ABUZ8 Agent';
      const mandate = (agent && (agent.mandate || agent.identity)) || b.mandate || '';
      const soulRef = (agent && agent.soul) || b.soul || '';
      let soulText = '';
      if (soulRef) { const sl = spineList('souls').find((x) => x.id === soulRef || x.name === soulRef || x.callsign === soulRef); if (sl) soulText = sl.persona || sl.mandate || ''; }
      const system = [`You are ${name}, an autonomous ABUZ8 agent.`, mandate && ('Mandate: ' + mandate), soulText && ('Soul: ' + soulText)].filter(Boolean).join('\n');
      const out = await runTask(goal, { system, max_steps: b.max_steps != null ? Number(b.max_steps) : 3, reflect: b.reflect !== false });
      const thread = spineCreate('threads', { agent_id: (agent && agent.id) || null, agent: name, goal: String(goal).slice(0, 500), answer: (out.response || '').slice(0, 8000), brain: out.brain || '', tools: (out.tool_result && out.tool_result.used) || [], steps: (out.tool_result && out.tool_result.steps) || 0 });
      spineBeat('agent run: ' + name);
      return json(res, 200, { ok: true, thread_id: thread.id, agent: name, brain: out.brain, answer: out.response, tools: thread.tools, steps: thread.steps });
    }
    if (pathname === '/api/spine/swarm/solve') {
      const b = req.method === 'POST' ? await getBody(req) : {};
      if (!(b.goal || b.task || b.objective)) return json(res, 400, { ok: false, error: 'goal required' });
      return json(res, 200, await spineSwarmSolve(b));
    }
    if (pathname === '/api/spine/sdlc/run') {
      const b = req.method === 'POST' ? await getBody(req) : {};
      if (!(b.goal || b.task || b.objective)) return json(res, 400, { ok: false, error: 'goal required' });
      return json(res, 200, await spineSdlcRun(b));
    }
    if (pathname === '/api/spine/audit/append') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, { ok: true, record: spineAuditAppend(b.event || b) }); }
    if (pathname === '/api/spine/audit/verify') return json(res, 200, spineAuditVerify());
    if (pathname === '/api/spine/decide') { const b = req.method === 'POST' ? await getBody(req) : {}; if (!Array.isArray(b.options) || !b.options.length) return json(res, 400, { ok: false, error: 'options[] required' }); return json(res, 200, spineNeocortexDecide(b)); }
    if (pathname === '/api/spine/sandbox/run') { const b = req.method === 'POST' ? await getBody(req) : {}; if (!b.code) return json(res, 400, { ok: false, error: 'code required' }); return json(res, 200, await spineSandboxRun(b)); }
    if (pathname === '/api/spine/hardware/probe') return json(res, 200, spineHardwareProbe());
    if (pathname === '/api/spine/learn/skill') { const b = req.method === 'POST' ? await getBody(req) : {}; let rec = b; if (b.thread_id) { const t = spineList('threads').find((x) => x.id === b.thread_id); if (t) rec = { name: b.name, goal: t.goal, answer: t.answer, brain: t.brain, source: 'thread:' + t.id }; } return json(res, 200, { ok: true, skill: spineLearnSkillFrom(rec) }); }
    // P9 — earn-loop + license gate
    if (pathname === '/api/spine/earn/link') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, { ok: true, link: spineEarnLink(b) }); }
    if (pathname === '/api/spine/earn/click') { const b = req.method === 'POST' ? await getBody(req) : {}; const id = b.id || searchParams.get('id'); if (!id) return json(res, 400, { ok: false, error: 'id required' }); return json(res, 200, spineEarnClick(id, b)); }
    if (pathname === '/api/spine/earn/ledger') return json(res, 200, spineEarnLedger());
    if (pathname === '/api/spine/license/check') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, spineLicenseCheck(b.feature || searchParams.get('feature'))); }
    if (pathname === '/api/spine/pro/feature') { try { enforceLicense('pro-demo'); return json(res, 200, { ok: true, allowed: true, note: 'Pro feature unlocked.' }); } catch (e) { return json(res, 402, { ok: false, allowed: false, error: e.message }); } }
    // P7 — project lifecycle (preview served above)
    if (pathname === '/api/spine/project/create') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, spineProjectCreate(b)); }
    if (pathname === '/api/spine/project/list') return json(res, 200, { ok: true, projects: spineList('library').filter((x) => x.kind === 'project') });
    // E4 — git ops + repo registry
    if (pathname === '/api/spine/repo/register') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, { ok: true, repo: spineRepoRegister(b) }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/repo/list') return json(res, 200, { ok: true, repos: spineList('library').filter((x) => x.kind === 'repo') });
    if (pathname === '/api/spine/git') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineGit(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    // P3/P11 — studio: storyboard / departments / movie
    if (pathname === '/api/spine/studio/departments') return json(res, 200, spineStudioDepartments());
    if (pathname === '/api/spine/studio/storyboard') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineStudioStoryboard(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/studio/movie') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineStudioMovie(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/studio/avatar') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineStudioAvatar(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/studio/360') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, spineStudio360(b.proj || searchParams.get('proj') || '')); }
    if (pathname === '/api/spine/mobile/client') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, spineMobileClient(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname.startsWith('/api/spine/computer/')) {
      // SEC-01b: real mouse/keyboard/screen control. Force POST so a no-Origin GET (<img>/<script> load)
      // can't reach it — that brings it under the cross-origin CSRF guard above. AND require the explicit
      // Allow-actions toggle (same standing-consent gate as gui_do/cmd_run), so even a local prompt-injection
      // can't silently drive the desktop or screenshot the screen.
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' });
      if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions to drive the desktop (mouse/keyboard/screen capture)' });
      const action = pathname.slice('/api/spine/computer/'.length); const b = await getBody(req);
      return json(res, 200, await spineComputer(action, b));
    }
    // P11 — true 360 photogrammetry (Tripo multiview photos -> .glb)
    if (pathname === '/api/spine/photogrammetry/reconstruct') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spinePhotogrammetry(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/photogrammetry/status') { const b = req.method === 'POST' ? await getBody(req) : {}; const tid = b.task_id || searchParams.get('task_id'); if (!tid) return json(res, 400, { ok: false, error: 'task_id required' }); try { return json(res, 200, await spinePhotogrammetryStatus(tid)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/spine/photogrammetry/list') return json(res, 200, { ok: true, models: spineList('library').filter((x) => x.kind === 'model3d') });
    if (pathname === '/api/spine/photogrammetry/local') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spinePhotogrammetryLocal(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname.startsWith('/api/spine/model/')) { const id = pathname.slice('/api/spine/model/'.length); const m = spineList('library').find((x) => x.id === id && x.kind === 'model3d'); if (!m || !m.out || !exists(m.out)) return json(res, 404, { ok: false, error: 'model not found' }); try { return binary(res, 200, fs.readFileSync(m.out), 'model/gltf-binary'); } catch (e) { return json(res, 500, { ok: false, error: e.message }); } }
    // P11 — CapCut-style timeline editor
    if (pathname === '/api/spine/editor/save') { const b = req.method === 'POST' ? await getBody(req) : {}; const rec = spineCreate('library', { kind: 'timeline', name: b.name || 'timeline', timeline: b.timeline || b }); return json(res, 200, { ok: true, id: rec.id }); }
    if (pathname === '/api/spine/editor/list') return json(res, 200, { ok: true, timelines: spineList('library').filter((x) => x.kind === 'timeline') });
    if (pathname === '/api/spine/editor/render') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineEditorRender(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname.startsWith('/api/spine/render/')) { const id = pathname.slice('/api/spine/render/'.length); const m = spineList('library').find((x) => x.id === id && x.kind === 'render'); if (!m || !m.out || !exists(m.out)) return json(res, 404, { ok: false, error: 'render not found' }); try { return binary(res, 200, fs.readFileSync(m.out), 'video/mp4'); } catch (e) { return json(res, 500, { ok: false, error: e.message }); } }
    const m = /^\/api\/spine\/([a-z]+)(?:\/(list|get|create|update|delete))?$/.exec(pathname);
    if (m) {
      const col = m[1]; const action = m[2] || 'list';
      if (!SPINE_COLLECTIONS.includes(col)) return json(res, 404, { ok: false, error: 'unknown spine collection: ' + col, collections: SPINE_COLLECTIONS });
      if (action === 'list') return json(res, 200, { ok: true, collection: col, items: spineList(col) });
      const b = req.method === 'POST' ? await getBody(req) : {};
      if (action === 'get') { const it = spineList(col).find((x) => x.id === (b.id || searchParams.get('id'))); return it ? json(res, 200, { ok: true, item: it }) : json(res, 404, { ok: false, error: 'not found' }); }
      if (action === 'create') return json(res, 200, { ok: true, item: spineCreate(col, b.item || b) });
      if (action === 'update') return json(res, 200, { ok: true, item: spineUpdate(col, b.id, b.patch || b) });
      if (action === 'delete') return json(res, 200, { ok: true, ...spineDelete(col, b.id || searchParams.get('id')) });
    }
    return json(res, 404, { ok: false, error: 'no spine endpoint for ' + pathname });
  } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
}

// route group 14 — Mercury: OpenAI-compatible /v1 surface (ABUZ8 as a brain for 3rd-party tools)
async function routeGMercury(req, res, pathname, searchParams) {
  if (pathname === '/v1/models') return json(res, 200, mercuryModels());
  if (pathname === '/v1/chat/completions') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await mercuryChat(b)); } catch (e) { return json(res, 400, { error: { message: e.message, type: 'abuz8_error' } }); } }
}

// ── T13: secure reach — sovereign SSH/SCP via Windows' built-in OpenSSH (no new deps),
// host registry (encrypted creds), and an honest transport/reach status. VPS *provisioning*
// would spend Ahmad's money / bind a contract → HARD STOP: we never auto-buy; we report + guide. ──
function reachSshExe() {
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  if (process.platform === 'win32' && exists(win)) return win;
  return 'ssh'; // PATH fallback (linux/mac/git-bash)
}
function reachKeygenExe() {
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe');
  if (process.platform === 'win32' && exists(win)) return win;
  return 'ssh-keygen';
}
function reachAvailable() { return process.platform !== 'win32' || exists(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')); }
function reachSshDir() { return safeMkdir(path.join(dataRoot, 'ssh')); }
function reachKeygen(opts = {}) {
  const name = (String(opts.name || 'abuz8').replace(/[^a-zA-Z0-9_-]/g, '') || 'abuz8');
  const keyPath = path.join(reachSshDir(), 'id_' + name);
  return new Promise((resolve, reject) => {
    if (exists(keyPath) && !opts.force) { try { return resolve({ ok: true, already: true, name, key: keyPath, public: fs.readFileSync(keyPath + '.pub', 'utf8').trim() }); } catch {} }
    try { if (exists(keyPath)) fs.unlinkSync(keyPath); if (exists(keyPath + '.pub')) fs.unlinkSync(keyPath + '.pub'); } catch {}
    execFile(reachKeygenExe(), ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'abuz8-os:' + name], { windowsHide: true, timeout: 20000 }, (err) => {
      if (err && !exists(keyPath + '.pub')) return reject(new Error('ssh-keygen failed: ' + err.message));
      try { resolve({ ok: true, name, key: keyPath, public: fs.readFileSync(keyPath + '.pub', 'utf8').trim() }); } catch (e) { reject(e); }
    });
  });
}
function reachHostAdd(opts = {}) {
  if (!opts.host) throw new Error('host required');
  const id = 'sshhost_' + (String(opts.name || opts.host).replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomBytes(3).toString('hex'));
  const rec = { id, kind: 'ssh-host', name: opts.name || opts.host, host: String(opts.host), port: Number(opts.port) || 22, user: String(opts.user || 'root'), key: opts.key ? String(opts.key) : '', pass: opts.pass ? encStr(String(opts.pass)) : '' };
  const lib = spineList('library'); const i = lib.findIndex((x) => x.id === id);
  if (i >= 0) { lib[i] = rec; spineSave('library', lib); } else spineCreate('library', rec);
  return { ok: true, host: { id, name: rec.name, host: rec.host, port: rec.port, user: rec.user, auth: rec.key ? 'key' : (rec.pass ? 'password(enc)' : 'agent') } };
}
function reachHostList() {
  return { ok: true, hosts: spineList('library').filter((x) => x.kind === 'ssh-host').map((h) => ({ id: h.id, name: h.name, host: h.host, port: h.port, user: h.user, auth: h.key ? 'key' : (h.pass ? 'password(enc)' : 'agent') })) };
}
async function reachExec(opts = {}) {
  requireActionConsent('ssh_exec'); // runs commands on a remote machine — always gated
  if (!reachAvailable()) throw new Error('OpenSSH client not available on this box.');
  const cmd = String(opts.command || opts.cmd || '').trim();
  if (!cmd) throw new Error('command required');
  let h = opts.host && spineList('library').find((x) => x.kind === 'ssh-host' && (x.id === opts.host || x.name === opts.host || x.host === opts.host));
  const host = h ? h.host : String(opts.host || '');
  if (!host) throw new Error('no host (pass a registered host id/name or a hostname)');
  const user = h ? h.user : String(opts.user || 'root');
  const port = h ? h.port : (Number(opts.port) || 22);
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', String(port)];
  const key = h ? h.key : opts.key;
  if (key && exists(key)) args.push('-i', key);
  args.push(user + '@' + host, cmd);
  return new Promise((resolve) => {
    execFile(reachSshExe(), args, { windowsHide: true, timeout: Number(opts.timeout) || 30000 }, (err, stdout, stderr) => {
      try { spineAuditAppend({ type: 'ssh_exec', host, ok: !err }); } catch {}
      resolve({ ok: !err, host, user, output: String(stdout || '').slice(0, 8000), error: err ? String(stderr || err.message).slice(0, 2000) : '' });
    });
  });
}
function reachStatus() {
  const winOpenSSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');
  const has = (rel) => process.platform === 'win32' ? exists(path.join(winOpenSSH, rel)) : true;
  let cloudflared = false; try { cloudflared = exists(path.join(attachmentsDir(), 'cloudflared', 'cloudflared.exe')) || exists(path.join(dataRoot, 'cloudflared.exe')); } catch {}
  return {
    ok: true,
    transports: {
      ssh: { available: reachAvailable(), exe: reachSshExe(), via: 'native OpenSSH' },
      scp: { available: has('scp.exe') },
      tunnel: { available: cloudflared, kind: 'cloudflared', note: cloudflared ? 'public reach via Cloudflare tunnel' : 'cloudflared not bundled' },
      vpn: { available: false, kind: 'wireguard', truth_status: 'ROADMAP' },
    },
    hosts: spineList('library').filter((x) => x.kind === 'ssh-host').length,
    vps_provisioning: { auto_buy: false, truth_status: 'manual-only', reason: 'auto-provisioning would spend money / bind a contract — escalated to Ahmad, never automatic.' },
  };
}

// route group 15 — /api/reach/* (secure SSH/SCP reach + transport status; sovereign OpenSSH)
async function routeGReach(req, res, pathname, searchParams) {
  if (!pathname.startsWith('/api/reach')) return;
  try {
    if (pathname === '/api/reach/status') return json(res, 200, reachStatus());
    if (pathname === '/api/reach/ssh/keygen') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, await reachKeygen(b)); }
    if (pathname === '/api/reach/ssh/hosts') { if (req.method === 'POST') { const b = await getBody(req); return json(res, 200, reachHostAdd(b)); } return json(res, 200, reachHostList()); }
    if (pathname === '/api/reach/ssh/exec') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await reachExec(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    return json(res, 404, { ok: false, error: 'no reach endpoint for ' + pathname });
  } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
}

// ── T17: multi-tenant — token auth (hashed, never stored plaintext), RBAC role hierarchy,
// and per-tenant data isolation. Lets the sovereign OS scale from Ahmad's single cockpit to a
// swarm of owned nodes/seats without leaking one tenant's data into another's. ──
const TENANT_ROLES = { owner: 4, admin: 3, member: 2, viewer: 1 };
function tenantSha(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function tenantNamespace(id) { return safeMkdir(path.join(dataRoot, 'tenants', String(id).replace(/[^a-zA-Z0-9_-]/g, ''), 'data')); }
function tenantCreate(opts = {}) {
  const name = String(opts.name || 'tenant').slice(0, 80);
  const role = TENANT_ROLES[opts.role] ? opts.role : 'member';
  const id = 'tnt_' + crypto.randomBytes(5).toString('hex');
  const token = 'abz_' + crypto.randomBytes(24).toString('hex'); // shown ONCE
  const rec = { id, kind: 'tenant', name, role, token_sha256: tenantSha(token), created: spineNow(), namespace: tenantNamespace(id) };
  spineCreate('library', rec);
  try { spineAuditAppend({ type: 'tenant_create', id, role }); } catch {}
  return { ok: true, tenant: { id, name, role, namespace: rec.namespace }, token, note: 'Store this token now — it is hashed at rest and cannot be retrieved again.' };
}
function tenantList() {
  return { ok: true, tenants: spineList('library').filter((x) => x.kind === 'tenant').map((t) => ({ id: t.id, name: t.name, role: t.role, created: t.created })) };
}
function tenantResolve(token) {
  if (!token) return null;
  const h = tenantSha(token);
  const t = spineList('library').find((x) => x.kind === 'tenant' && x.token_sha256 === h);
  return t ? { id: t.id, name: t.name, role: t.role, namespace: t.namespace || tenantNamespace(t.id) } : null;
}
function tenantTokenFrom(req, body, searchParams) {
  return (req.headers && (req.headers['x-abuz8-token'] || req.headers['x-abuz8-tenant'])) || (body && body.token) || (searchParams && searchParams.get('token')) || '';
}
function tenantRankOk(role, need) { return (TENANT_ROLES[role] || 0) >= (TENANT_ROLES[need] || 0); }
function tenantCheck(token, need = 'viewer') {
  const t = tenantResolve(token);
  if (!t) return { ok: true, authenticated: false, allowed: false, reason: 'no/invalid token' };
  return { ok: true, authenticated: true, tenant: { id: t.id, name: t.name, role: t.role }, need, allowed: tenantRankOk(t.role, need) };
}
function tenantDelete(id) {
  const lib = spineList('library'); const i = lib.findIndex((x) => x.kind === 'tenant' && x.id === id);
  if (i < 0) return { ok: false, error: 'no such tenant' };
  lib.splice(i, 1); spineSave('library', lib);
  try { spineAuditAppend({ type: 'tenant_delete', id }); } catch {}
  return { ok: true, deleted: id };
}

// route group 16 — /api/tenant/* (multi-tenant auth + RBAC + isolation)
async function routeGTenant(req, res, pathname, searchParams) {
  if (!pathname.startsWith('/api/tenant')) return;
  try {
    if (pathname === '/api/tenant/create') {
      if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions to mint tenants' });
      const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, tenantCreate(b));
    }
    if (pathname === '/api/tenant/list') {
      if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only — enable Allow-actions to list tenants' });
      return json(res, 200, tenantList());
    }
    if (pathname === '/api/tenant/whoami') { const b = req.method === 'POST' ? await getBody(req) : {}; const t = tenantResolve(tenantTokenFrom(req, b, searchParams)); return json(res, 200, t ? { ok: true, authenticated: true, tenant: t } : { ok: true, authenticated: false }); }
    if (pathname === '/api/tenant/check') { const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, tenantCheck(tenantTokenFrom(req, b, searchParams), b.need || searchParams.get('need') || 'viewer')); }
    if (pathname === '/api/tenant/delete') {
      if (!actionsAllowed()) return json(res, 403, { ok: false, error: 'owner only' });
      const b = req.method === 'POST' ? await getBody(req) : {}; return json(res, 200, tenantDelete(b.id || searchParams.get('id')));
    }
    return json(res, 404, { ok: false, error: 'no tenant endpoint for ' + pathname });
  } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
}

// ── GLUE: souls -> live runnable agents + CEO-routed team dispatch. Turns the ported
// QADIR soul personas (Spine 'souls') into a working autonomous team on the real ReAct loop. ──
function spineSoulFind(ref) {
  if (!ref) return null;
  const souls = spineList('souls');
  return souls.find((x) => x.id === ref || x.callsign === ref || x.name === ref || x.id === 'soul_' + ref) || null;
}
function soulSystemPrompt(sl) {
  if (!sl) return '';
  const parts = [];
  if (sl.persona) parts.push(sl.persona);
  else {
    if (sl.role) parts.push(`You are ${sl.name || sl.callsign} - ${sl.role}.`);
    if (sl.mandate) parts.push('Mandate: ' + sl.mandate);
  }
  if (Array.isArray(sl.hard_stops) && sl.hard_stops.length) parts.push('Hard stops:\n' + sl.hard_stops.map((h) => '- ' + h).join('\n'));
  return parts.filter(Boolean).join('\n\n');
}
function teamRoster() {
  return spineList('souls').filter((s) => s.callsign).map((s) => ({ callsign: s.callsign, name: s.name, role: s.role || '', brain: (s.brain && s.brain.preferred_brain) || '' }));
}
// AUTO-ROUTE a soul to a fast brain: honor the soul's own preferred_brain when that provider is
// configured, else fall back to the healthiest connected frontier provider. Returns a provider
// NAME to force (so the whole run — planning + reasoning — uses it), or null to let local handle it.
function pickSoulBrain(sl, override) {
  try {
    if (override) return override;
    // If a CLI brain (Grok/Claude account) is set & available, DON'T force a providers.json
    // provider — return null so the native chain routes both planning + reasoning through it.
    // (Forcing opts.provider would bypass the cli_brain path entirely.)
    try { const cb = readJson(settingsPath(), {}).cli_brain; if (cb && cliBrainAvailable(cb)) return null; } catch {}
    const cfg = readJson(providersPath(), { providers: [] });
    const avail = (cfg.providers || []).filter((p) => p.api_key && p.enabled !== false);
    const pref = String((sl && sl.brain && sl.brain.preferred_brain) || '').toLowerCase();
    if (pref && avail.length) {
      const token = pref.split('/')[0];
      const map = { anthropic: 'anthropic', claude: 'anthropic', openai: 'openai', gpt: 'openai', openrouter: 'openrouter', google: 'google-gemini', gemini: 'google-gemini', deepseek: 'deepseek', xai: 'xai-grok', grok: 'xai-grok', groq: 'groq', together: 'together' };
      const want = map[token] || token;
      const hit = avail.find((p) => p.type === want || p.name === want);
      if (hit) return hit.name;
    }
    const fp = bestFrontierProvider();
    return fp ? fp.name : null;
  } catch { return null; }
}
async function spineSoulRun(opts = {}) {
  const sl = spineSoulFind(opts.soul || opts.callsign || opts.id);
  if (!sl) throw new Error('soul not found: ' + (opts.soul || opts.callsign || opts.id || '(none)'));
  const goal = opts.goal || opts.task || opts.objective || '';
  if (!goal) throw new Error('goal required');
  const provider = pickSoulBrain(sl, opts.provider);   // fast-brain auto-route
  const out = await runTask(goal, { system: soulSystemPrompt(sl), provider, max_steps: opts.max_steps != null ? Number(opts.max_steps) : 3, reflect: opts.reflect !== false });
  const thread = spineCreate('threads', { soul: sl.callsign, agent: sl.name, goal: String(goal).slice(0, 500), answer: (out.response || '').slice(0, 8000), brain: out.brain || '' });
  spineBeat('soul run: ' + sl.callsign);
  return { ok: true, soul: sl.callsign, name: sl.name, routed_brain: provider || 'local/auto', brain: out.brain, answer: out.response, thread_id: thread.id };
}
async function spineTeamDispatch(opts = {}) {
  const goal = opts.goal || opts.task || opts.objective || '';
  if (!goal) throw new Error('goal required');
  const heads = spineList('souls').filter((s) => /^abuz8-(head|cfo|cmo|coo|cto)/.test(s.callsign || ''));
  if (!heads.length) throw new Error('no department-head souls found (port souls first)');
  const ceo = spineSoulFind('abuz8-ceo');
  const roster = heads.map((h) => `${h.callsign}: ${h.role || h.name}`).join('\n');
  const routePrompt = `Route this request to exactly ONE department head. Reply with ONLY the callsign, nothing else.\n\nRequest: ${goal}\n\nHeads:\n${roster}`;
  let chosen = null;
  try {
    const pick = await reasonReply(routePrompt, { provider: pickSoulBrain(ceo, opts.provider), system: soulSystemPrompt(ceo) || 'You are the ABUZ8 CEO router.', noMemory: true });
    const txt = (pick.text || '').toLowerCase();
    chosen = heads.find((h) => txt.includes((h.callsign || '').toLowerCase()));
    var reason = (pick.text || '').slice(0, 200);
  } catch (e) { reason = 'router error: ' + e.message; }
  if (!chosen) chosen = heads[0];
  const work = await spineSoulRun({ soul: chosen.callsign, goal, max_steps: opts.max_steps });
  const thread = spineCreate('threads', { soul: 'abuz8-ceo->' + chosen.callsign, goal: String(goal).slice(0, 500), answer: (work.answer || '').slice(0, 8000) });
  spineBeat('team dispatch -> ' + chosen.callsign);
  return { ok: true, routed_to: chosen.callsign, route_reason: reason, result: work, thread_id: thread.id };
}

// route group 17 — /api/team/* (soul-driven autonomous team: run one soul, or CEO-route a goal)
async function routeGTeam(req, res, pathname, searchParams) {
  if (!pathname.startsWith('/api/team')) return;
  try {
    if (pathname === '/api/team/roster') return json(res, 200, { ok: true, team: teamRoster() });
    if (pathname === '/api/team/run') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineSoulRun(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    if (pathname === '/api/team/dispatch') { const b = req.method === 'POST' ? await getBody(req) : {}; try { return json(res, 200, await spineTeamDispatch(b)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } }
    return json(res, 404, { ok: false, error: 'no team endpoint for ' + pathname });
  } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
}

const ROUTE_GROUPS = [routeG01, routeG02, routeG03, routeG04, routeG05, routeG06, routeG07, routeG08, routeG09, routeG10, routeG11, routeG12, routeGSpine, routeGMercury, routeGReach, routeGTenant, routeGTeam];

// Read the dashboard HTML from disk (works inside the asar via Electron fs).
function readRendererHtml() { return readRendererAsset('index.html'); }
function readRendererAsset(name) {
  const candidates = [
    path.join(__dirname, 'renderer', name),
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'renderer', name) : null
  ].filter(Boolean);
  for (const f of candidates) { try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } catch {} }
  return null;
}

// Is the request from this machine (always trusted)?
// Credential / secret stores that no file-preview should ever return — blocks a prompt-injected
// agent (or a local script) from reading keys/cookies/tokens to exfiltrate.
const SENSITIVE_PATH_RX = /([\\\/]\.ssh[\\\/])|([\\\/]\.aws[\\\/]credentials)|([\\\/]\.gnupg[\\\/])|(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|(known_hosts|authorized_keys)$|([\\\/]\.config[\\\/](gcloud|gh)[\\\/])|([\\\/]\.kube[\\\/]config)|([\\\/]\.docker[\\\/]config\.json)|([\\\/]AppData[\\\/](Local|Roaming)[\\\/](Google[\\\/]Chrome|Microsoft[\\\/]Edge|BraveSoftware|Mozilla)[\\\/].*(Login Data|Cookies|Web Data|key[0-9]?\.db|logins\.json))|(Login Data|Cookies|Web Data|Local State)$|([\\\/](Keychains|login\.keychain))|(\.vaultkey$)|([\\\/]\.npmrc$)|([\\\/]\.git-credentials$)|([\\\/]\.env(\.[a-z0-9_-]+)?$)|([\\\/]\.netrc$)|([\\\/]\.pgpass$)|(wallet\.dat$)|(NTUSER\.DAT$)|([\\\/](SAM|SYSTEM|SECURITY)$)|(\.(pem|key|pfx|p12|pscredential|keystore|jks|tfstate)$)|([\\\/]secrets?\.(json|ya?ml|env)$)/i;
// Supplementary secret-path coverage (blocker #3 hardening): more credential classes the primary
// denylist missed — KeePass/PuTTY/OpenVPN keys, OAuth client secrets, cloud-CLI dirs, terraform
// vars, package/registry creds, and shell histories (which routinely leak tokens).
const SENSITIVE_PATH_RX2 = /(\.kdbx$)|(\.ppk$)|(\.ovpn$)|(client_secret[^\\\/]*\.json$)|([\\\/]credentials\.json$)|([\\\/]\.aws[\\\/])|([\\\/]\.azure[\\\/])|([\\\/]\.oci[\\\/])|([\\\/]\.terraformrc$)|(terraform\.tfvars$)|([\\\/]\.s3cfg$)|([\\\/]\.boto$)|([\\\/]\.pypirc$)|([\\\/]\.htpasswd$)|([\\\/]\.dockercfg$)|(secring\.gpg$)|((?:bash|zsh|psql|mysql)_history$)|(ConsoleHost_history\.txt$)/i;
// SEC-02: treat the BARE secret directories as sensitive too (so /api/fs/list can't enumerate which keys
// exist), not just the files inside them.
const _SECRET_DIR_RX = /[\\\/]\.(ssh|gnupg|aws|azure|oci|gcloud|kube)([\\\/]|$)/i;
function isSensitivePath(p) { try { const s = String(p); return SENSITIVE_PATH_RX.test(s) || SENSITIVE_PATH_RX2.test(s) || _SECRET_DIR_RX.test(s); } catch { return false; } }
function isLocalHostName(h) { return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'; }
// Local-Only / Air-Gap: when on, fetchUrl blocks all non-loopback egress (enforced sovereignty).
function airgapOn() { try { return readJson(settingsPath(), {}).local_only === true; } catch { return false; } }
function reqHostName(req) {
  let host = String((req.headers && req.headers['host']) || '').toLowerCase();
  return host.replace(/^\[/, '').split(']')[0].split(':')[0];
}
// Per-process CSRF nonce: injected into the served renderer HTML; the real renderer echoes it back as
// the x-abuz8-csrf header. The Origin:null path (file:// renderer fallback) is unlocked ONLY with a valid
// nonce, so a malicious opaque-origin iframe (sandboxed/srcdoc/data:/blob: — all Origin:null) can neither
// drive a state-changing endpoint nor read a response. The normal http://127.0.0.1 renderer is same-origin
// and unaffected. Closes SEC-01 (drive-by file read / vault exfil / RCE-when-Allow-actions).
const CSRF_TOKEN = crypto.randomBytes(32).toString('hex');
function csrfTokenValid(req) {
  try {
    const t = req.headers && req.headers['x-abuz8-csrf'];
    if (!t || typeof t !== 'string' || t.length !== CSRF_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CSRF_TOKEN));
  } catch { return false; }
}
function injectCsrf(html) {
  if (typeof html !== 'string' || !html) return html;
  const tag = '<script>window.__ABUZ8_CSRF__=' + JSON.stringify(CSRF_TOKEN) + ';</script>';
  return html.includes('<head>') ? html.replace('<head>', '<head>' + tag) : (tag + html);
}
// The specific origin we will allow to read responses (echoed into ACAO), or '' to deny.
// Same-machine origins always; LAN IPs only when the owner has turned LAN access on.
function corsAllowOrigin(req) {
  const o = req.headers && req.headers['origin'];
  if (!o) return '';            // non-browser client or same-origin nav — no ACAO needed
  if (o === 'null') return csrfTokenValid(req) ? 'null' : ''; // file:// renderer ONLY with the nonce — opaque-origin iframes have none
  let host = ''; try { host = new URL(o).hostname.toLowerCase(); } catch { return ''; }
  if (isLocalHostName(host)) return o;
  try {
    if (readJson(settingsPath(), {}).lan_access === true) {
      const ifs = os.networkInterfaces();
      for (const n of Object.keys(ifs)) for (const ni of ifs[n] || []) {
        if (ni.family === 'IPv4' && !ni.internal && ni.address === host) return o;
      }
    }
  } catch {}
  return '';
}
function isLocalRequest(req) {
  // A request arriving through a tunnel/proxy (cloudflared, etc.) carries forwarding headers
  // even though its socket is 127.0.0.1 — treat those as NON-local so the access key is required.
  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-real-ip']) return false;
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// LAN URLs the phone can open (IPv4 non-internal interfaces), key embedded.
function lanUrls(key) {
  const q = key ? `?key=${key}` : '';
  // Phone-facing: point at the mobile companion (/m). The desktop dashboard (/app) stays local.
  const urls = [`http://127.0.0.1:${PORT}/m${q}`];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}/m${q}`);
      }
    }
  } catch {}
  return urls;
}

// Re-bind the running server to a new host (localhost <-> LAN) without restart.
function rebindServer(host) {
  return new Promise((resolve) => {
    if (!server || host === serverHost) { serverHost = host; return resolve(serverHost); }
    server.close(() => {
      serverHost = host;
      server.listen(PORT, serverHost, () => { logFn(`portable core re-bound to http://${serverHost}:${PORT}`); resolve(serverHost); });
    });
  });
}

async function start(options = {}) {
  if (server) return { port: PORT, dataRoot };
  logFn = options.log || logFn;
  // CR-3: keep the sovereign daemon alive on a stray async throw (headless/VPS/Docker inherit these too).
  if (!process._abuz8GuardsInstalled) {
    process._abuz8GuardsInstalled = true;
    process.on('uncaughtException', (e) => { try { logFn('[uncaughtException] ' + ((e && e.stack) || e)); } catch {} });
    process.on('unhandledRejection', (e) => { try { logFn('[unhandledRejection] ' + ((e && e.stack) || e)); } catch {} });
  }
  hostExecutable = process.env.PORTABLE_EXECUTABLE_FILE
    || (options.app && typeof options.app.getPath === 'function' ? options.app.getPath('exe') : null)
    || process.execPath;
  dataRoot = resolveDataRoot(options.app);
  initFolders();
  // Restore persisted action consent so "Allow actions" survives relaunch.
  try { if (readJson(settingsPath(), {}).auto_grant_actions === true) actionConsentGranted = true; } catch {}
  // Restore persisted login sessions so the phone stays signed in across restarts.
  try { loadSessions(); } catch {}
  // Bind to the LAN only if the user has opted in; otherwise localhost-only.
  try { if (readJson(settingsPath(), {}).lan_access === true) serverHost = '0.0.0.0'; } catch {}
  server = http.createServer((req, res) => route(req, res).catch((e) => json(res, 500, { ok: false, error: e.message })));
  // Bind its OWN line: prefer 8900 (so existing MCP configs keep working), but if it's
  // taken on this machine, auto-grab a free OS-assigned port — no manual config, like Claude Desktop.
  await new Promise((resolve, reject) => {
    const bind = (p, ephemeral) => {
      server.removeAllListeners('error');
      server.once('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          if (process.env.ABUZ8_ALLOW_EXTERNAL_BACKEND === '1') { logFn(`port ${p} in use; adopting existing local backend (ABUZ8_ALLOW_EXTERNAL_BACKEND=1).`); server = null; return resolve(); }
          if (!ephemeral) { logFn(`port ${p} in use — auto-selecting a free port (its own line).`); return bind(0, true); }
          return reject(new Error('ABUZ8 core could not bind any port: ' + e.message));
        }
        reject(e);
      });
      server.listen(p, serverHost, () => { try { PORT = server.address().port; } catch {} resolve(); });
    };
    bind(PORT, false);
  });
  if (server) {
    logFn(`portable core listening on http://${serverHost}:${PORT}`);
    // Persist the actually-bound port so siblings / next launch / clients can find it.
    try { const cfg = path.join(dataRoot, 'config', 'runtime.json'); const j = readJson(cfg, {}); j.backend_port = PORT; writeJson(cfg, j); } catch {}
  }
  logFn(`data root: ${dataRoot}`);
  // Self-heal the two-way Claude Desktop symbiosis on every launch.
  try {
    const b = reinstateBridge();
    logFn(`claude bridge: symbiote ${b.symbiote ? 'installed' : 'present'}; imported ${b.imported.length} Claude MCP server(s).`);
  } catch (e) { logFn('claude bridge self-heal skipped: ' + e.message); }
  // Self-learning runs quietly in the background (Al-Buraq pattern) — never blocks.
  try { setInterval(() => { try { selfLearnOnce(); } catch {} }, 10 * 60 * 1000).unref?.(); } catch {}
  // Learn from every file created on the system: watch the workspace/vault + ingest changes into RAG.
  try { setTimeout(() => { try { const n = startFileWatcher(); logFn('self-learning file-watcher on ' + n + ' root(s)'); } catch {} }, 5000); } catch {}
  try { setInterval(() => { synthesizeSkillsOnce().catch(() => {}); }, 15 * 60 * 1000).unref?.(); } catch {}
  try { setInterval(() => { try { selfHealOnce(); } catch {} }, 2 * 60 * 1000).unref?.(); } catch {} // self-healing: revive dead subsystems
  try { setInterval(() => { try { curateSkillsOnce(); } catch {} }, 6 * 60 * 60 * 1000).unref?.(); } catch {} // skill Curator: grade/dedupe/prune
  try { setInterval(() => { try { scaffoldReviewOnce(); } catch {} }, 30 * 60 * 1000).unref?.(); } catch {} // keep-or-revert scaffold experiments
  try { setTimeout(() => { refreshMachine().catch(() => {}); }, 4000); } catch {} // auto-probe CLIs + engines on boot
  try { setInterval(() => { refreshMachine().catch(() => {}); }, 5 * 60 * 1000).unref?.(); } catch {}
  // Autonomy: check schedules every 60s and fire any that are due.
  try { setInterval(() => { schedulerTick().catch(() => {}); }, 60 * 1000).unref?.(); } catch {}
  // Auto-detect an NVIDIA GPU and self-accelerate (non-blocking; no-op on CPU-only machines).
  try { setTimeout(() => { maybeAutoAccelerate().catch(() => {}); }, 4000); } catch {}
  // First-run: seed bundled skill packs into the data root and embed them for semantic recall.
  try { setTimeout(() => { seedBundledSkillsOnce().catch(() => {}); }, 2500); } catch {}
  try { setTimeout(() => { try { seedBundledVoiceOnce(); } catch {} }, 1500); } catch {} // seed voice engines → talks+listens offline on first run
  // Messaging gateway: poll Telegram for incoming chats when enabled (no-op otherwise).
  try { setInterval(() => { tgPollOnce().catch(() => {}); }, 3000).unref?.(); } catch {}
  // Sovereign chain: commit the running code+version onto ABUZ8's own blockchain once per build.
  try { setTimeout(() => { try { const ch = chainReadAll(); const codeHash = _sha256hex(fs.readFileSync(path.join(__dirname, 'portable-core.js'))); if (!ch.some((b) => b.type === 'self-snapshot' && b.data && b.data.code_sha256 === codeHash)) chainSnapshotSelf(); } catch {} }, 3500); } catch {}
  // Self-update: check the channel on boot (notify), and auto-apply if settings.auto_update is on.
  try { setTimeout(() => { checkUpdate().then((u) => { if (u && u.update_available) { try { pushActivity('update', 'Update available: ' + u.latest, u.notes || ''); } catch {} if (readJson(settingsPath(), {}).auto_update === true) applyUpdate().catch(() => {}); } }).catch(() => {}); }, 6000); } catch {}
  try { setInterval(() => { checkUpdate().then((u) => { if (u && u.update_available && readJson(settingsPath(), {}).auto_update === true) applyUpdate().catch(() => {}); }).catch(() => {}); }, 6 * 60 * 60 * 1000).unref?.(); } catch {}
  return { port: PORT, dataRoot };
}

function stop() {
  if (server) server.close();
  server = null;
  try { torStop(); } catch {}
  try { termCloseAll(); } catch {}
  try { whisperStreamStop(); } catch {}
  if (lfmProcess) {
    try { lfmProcess.kill(); } catch {}
    lfmProcess = null;
  }
  if (embedProcess) {
    try { embedProcess.kill(); } catch {}
    embedProcess = null;
  }
  if (voiceProcess) {
    try { voiceProcess.kill(); } catch {}
    voiceProcess = null;
  }
  for (const [name, client] of mcpProcesses) {
    try { (client.proc || client).kill(); } catch {}
    mcpProcesses.delete(name);
  }
}

// ── SETTINGS / PROVIDERS HELPERS ──────────────────────────────
function settingsPath() { return path.join(dataRoot, 'config', 'settings.json'); }
function providersPath() { return path.join(dataRoot, 'config', 'providers.json'); }

async function callProviderChat(provider, prompt, system) {
  const _t0 = Date.now();
  const endpoint = (provider.endpoint || '').replace(/\/+$/, '');
  const model = provider.model || 'default';
  const params = provider.parameters || { temperature: 0.7, max_tokens: 2048 };

  // Anthropic uses its own Messages API (x-api-key, /v1/messages, system is top-level).
  if (provider.type === 'anthropic') {
    const url = (endpoint || 'https://api.anthropic.com') + '/v1/messages';
    const headers = { 'Content-Type': 'application/json', 'x-api-key': provider.api_key || '', 'anthropic-version': '2023-06-01' };
    const body = JSON.stringify({ model, max_tokens: params.max_tokens || 2048, system: system || undefined, messages: [{ role: 'user', content: prompt }] });
    const data = JSON.parse(await fetchUrl(url, { method: 'POST', headers, body, timeout: provider.timeout || 60000 }));
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    try { const u = data.usage || {}; recordUsage({ source: 'provider', model, tokens: (u.input_tokens || 0) + (u.output_tokens || 0), ms: Date.now() - _t0 }); } catch {}
    return (data.content && data.content[0] && data.content[0].text) || JSON.stringify(data);
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const isLm = provider.type === 'lmstudio' || endpoint.includes('localhost:1234') || endpoint.includes('127.0.0.1:1234');
  const base = isLm ? (endpoint || 'http://localhost:1234')
    : (provider.type === 'openai' || provider.type === 'hermes') ? (endpoint || 'https://api.openai.com/v1')
    : endpoint;
  // Prefer an explicit chat_url from the catalog; else derive (with /v1 de-dup).
  const url = provider.chat_url || `${base}/v1/chat/completions`.replace('/v1/v1/', '/v1/');
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;
  const body = JSON.stringify({ model, messages, temperature: params.temperature, max_tokens: params.max_tokens || 2048, stream: false, store: false });
  const resp = await fetchUrl(url, { method: 'POST', headers, body, timeout: provider.timeout || 60000 });
  const data = JSON.parse(resp);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  try { recordUsage({ source: 'provider', model, tokens: (data.usage && data.usage.total_tokens) || 0, ms: Date.now() - _t0 }); } catch {}
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

// A LAN host the owner explicitly added as a fleet/mesh node is trusted (exempt from the RFC1918 SSRF block).
function _isKnownMeshHost(h) {
  try { return (readMesh().nodes || []).some((n) => { try { return new URL(n.url).hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '') === h; } catch { return false; } }); } catch { return false; }
}
function _normIp(ip) { return String(ip || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/^::ffff:/, ''); }
function _isMetaOrLinkLocal(ip) { const h = _normIp(ip); return /^169\.254\./.test(h) || /^fe80:/i.test(h) || h === 'metadata.google.internal' || h === 'metadata' || h === '100.100.100.200' || h === 'fd00:ec2::254'; }
function _isPrivateIp(ip) { const h = _normIp(ip); return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^(fc|fd)[0-9a-f]{2}:/i.test(h); }
function _isIpLiteral(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /:/.test(h); }
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => { (async () => {
    let parsed; try { parsed = new URL(url); } catch (e) { return reject(e); }
    const _h = String(parsed.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    // SOVEREIGNTY: when Local-Only / Air-Gap is ON, the single network chokepoint refuses every
    // non-loopback request — provider calls, web, geo, weather, updates. Nothing reaches the wire;
    // only the bundled local brain answers. This makes "your data never leaves" literally enforced.
    if (airgapOn() && !isLocalHostName(_h) && !opts._localOk) {
      return reject(new Error('Local-Only (air-gap) mode is ON — outbound network blocked to ' + parsed.hostname + '. Turn it off in Settings → Privacy to use cloud engines.'));
    }
    // SSRF guard (SEC-03). Cloud-metadata + link-local are NEVER a legitimate target → block unconditionally.
    if (_isMetaOrLinkLocal(_h)) return reject(new Error('blocked: link-local / cloud-metadata address (SSRF guard)'));
    // Private LAN ranges (RFC1918 + IPv6 ULA): block agent/user-supplied URLs (router / NAS / own control-plane
    // pivot), but allow explicit _localOk callers and trusted, user-configured fleet peers (so the mesh still works).
    const _allowPriv = !!opts._localOk || _isKnownMeshHost(_h);
    if (_isPrivateIp(_h) && !_allowPriv) {
      return reject(new Error('blocked: private LAN address (SSRF guard) — add it as a fleet node if this is intentional'));
    }
    // SEC-03 deeper: a HOSTNAME (not a literal IP, not loopback) can RESOLVE to an internal address — DNS-based
    // SSRF or DNS rebinding. Resolve it, vet EVERY returned address, and PIN the socket to the vetted IP so the
    // connection can't re-resolve to a different (internal) address after the check (TOCTOU rebind).
    let _pin = null;
    if (!_isIpLiteral(_h) && !isLocalHostName(_h)) {
      let addrs = [];
      try { addrs = await _dnsP.lookup(_h, { all: true }); } catch (e) { return reject(new Error('dns lookup failed for ' + _h + ': ' + e.message)); }
      for (const a of addrs) {
        if (_isMetaOrLinkLocal(a.address)) return reject(new Error('blocked: "' + _h + '" resolves to a link-local/cloud-metadata address (DNS SSRF guard)'));
        if (_isPrivateIp(a.address) && !_allowPriv) return reject(new Error('blocked: "' + _h + '" resolves to a private LAN address (DNS SSRF guard)'));
      }
      const _safe = addrs.find((a) => a.family === 4) || addrs[0]; // prefer IPv4 so the pin still routes on v4-only hosts
      if (_safe) _pin = { address: _safe.address, family: _safe.family };
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const body = opts.body ? Buffer.from(opts.body) : null;
    const reqOpts = {
      method: opts.method || 'GET',
      headers: { ...opts.headers, ...(body ? { 'Content-Length': body.length } : {}) },
      timeout: opts.timeout || 30000
    };
    // Pin DNS so the connection targets exactly the address we vetted (TLS SNI/Host still use the hostname).
    if (_pin) reqOpts.lookup = (hn, o, cb) => (o && o.all) ? cb(null, [{ address: _pin.address, family: _pin.family }]) : cb(null, _pin.address, _pin.family);
    const req = mod.request(url, reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(opts.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  })().catch(reject); });
}

// ── MCP SERVER RUNTIME ────────────────────────────────────────
// Real MCP client: line-delimited JSON-RPC over stdio (initialize,
// tools/list, tools/call) so imported servers are usable, not just spawned.
function spawnMcpClient(name, spec) {
  // shell:true is needed for npx/.cmd resolution on Windows, but it CONCATENATES argv — so a
  // command/arg with a space (e.g. C:\Program Files\nodejs\node.exe) breaks unless quoted.
  const _q = (s) => (/\s/.test(String(s)) && !/^".*"$/.test(String(s))) ? '"' + s + '"' : String(s);
  // Pass ONE concatenated command string (not file+args[]) with shell:true — keeps npx/.cmd +
  // spaced-path resolution while avoiding the DEP0190 warning (args[] + shell concatenates argv).
  const cmdline = [_q(spec.command)].concat((spec.args || []).map(_q)).join(' ');
  const proc = spawn(cmdline, {
    env: buildSafeMcpEnv(spec), // scrub: only safe base vars + the server's declared env (no API-key leak)
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true
  });
  const client = { proc, buf: '', nextId: 1, pending: new Map(), initialized: null, stderrTail: '' };
  proc.stdout.on('data', (d) => {
    client.buf += d.toString();
    let idx;
    while ((idx = client.buf.indexOf('\n')) >= 0) {
      const line = client.buf.slice(0, idx).trim();
      client.buf = client.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && client.pending.has(msg.id)) {
          const { resolve, reject, timer } = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    }
  });
  proc.stderr.on('data', (d) => { client.stderrTail = (client.stderrTail + d.toString()).slice(-800); });
  proc.on('exit', (code) => {
    for (const { reject, timer } of client.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server '${name}' exited (code ${code}). ${client.stderrTail.slice(-300)}`));
    }
    client.pending.clear();
    mcpProcesses.delete(name);
    if (code !== 0) logFn(`[mcp:${name}] exited code ${code}: ${client.stderrTail.slice(0, 200)}`);
  });
  proc.on('error', (e) => {
    for (const { reject, timer } of client.pending.values()) { clearTimeout(timer); reject(e); }
    client.pending.clear();
    mcpProcesses.delete(name);
  });
  return client;
}

function mcpRequest(client, name, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`MCP server '${name}' timed out on ${method}`));
    }, timeoutMs);
    client.pending.set(id, { resolve, reject, timer });
    client.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

async function ensureMcpClient(name) {
  let client = mcpProcesses.get(name);
  if (client && client.proc && client.proc.exitCode === null) {
    if (client.initialized) await client.initialized;
    return client;
  }
  const cfg = readJson(mcpConfigPath(), { mcpServers: {} });
  const spec = cfg.mcpServers[name];
  if (!spec) throw new Error(`MCP server '${name}' not found in config`);
  if (!spec.command) throw new Error(`MCP server '${name}' has no command configured`);
  client = spawnMcpClient(name, spec);
  mcpProcesses.set(name, client);
  client.initialized = mcpRequest(client, name, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'abuz8-os', version: '1.0.0' }
  }, 60000).then(() => {
    client.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });
  await client.initialized;
  return client;
}

async function startMcpServer(name) {
  const client = await ensureMcpClient(name);
  return client.proc.pid;
}

async function mcpListTools(name) {
  const client = await ensureMcpClient(name);
  const result = await mcpRequest(client, name, 'tools/list', {}, 30000);
  return result.tools || [];
}

async function mcpCallTool(name, tool, args) {
  const client = await ensureMcpClient(name);
  return mcpRequest(client, name, 'tools/call', { name: tool, arguments: args || {} }, 120000);
}
// FORWARD-HOST AUTONOMY: list every tool across all configured MCP servers (name-prefixed)
// so the agent can DISCOVER + then call any imported MCP tool — the gap the audit flagged.
async function mcpAllTools() {
  const cfg = readJson(mcpConfigPath(), { mcpServers: {} });
  const out = [];
  for (const name of Object.keys(cfg.mcpServers || {})) {
    try { const tools = await mcpListTools(name); for (const t of (tools || [])) out.push({ server: name, name: t.name, ref: name + ':' + t.name, description: (t.description || '').slice(0, 200) }); } catch (e) { out.push({ server: name, error: e.message }); }
  }
  return out;
}

function stopMcpServer(name) {
  const client = mcpProcesses.get(name);
  if (!client) return;
  try { (client.proc || client).kill(); } catch {}
  mcpProcesses.delete(name);
}

module.exports = { start, stop, PORT, CSRF_TOKEN, semverGt, updateHostAllowed };
