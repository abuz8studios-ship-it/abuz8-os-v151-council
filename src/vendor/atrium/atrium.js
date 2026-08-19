/* ABUZ8 Atrium — the sovereign entrance. Marble + gold, geometric (8-fold) precision.
   Every tile routes to a REAL, shipped capability; the dream-input routes any wish into the
   agentic loop. External vendored controller = keeps the renderer's single bare <script> rule.
   Aesthetic: secular classical/geometric (golden-ratio proportions, tessellation) — no
   religious iconography. Honors the doctrine light palette (#FAF8F5 + #C8A55C + DM Sans). */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function go(view) { try { if (window.setView) window.setView(view); } catch (e) {} }
  function dream(text) {
    try {
      var ta = document.getElementById('chat-text');
      go('chat');
      if (ta) { ta.value = text || ''; try { ta.dispatchEvent(new Event('input')); } catch (e) {} ta.focus(); }
      if (text && typeof window.send === 'function') setTimeout(function () { try { window.send(); } catch (e) {} }, 140);
    } catch (e) {}
  }

  // Each capability is REAL + shipped. action: {view} navigates; {seed} prefills the agent.
  var CAPS = [
    { g: '◧', t: 'Build anything', s: 'Apps, websites, tools, game scaffolds — planned, coded, tested, committed.', view: 'coder' },
    { g: '✦', t: 'Create media', s: 'Images, wallpapers, video, designs — your own studio pipeline.', view: 'studio' },
    { g: '◈', t: 'ComfyUI workflows', s: 'Drive your local ComfyUI graphs — generate at full power.', view: 'connect' },
    { g: '❖', t: 'Content & publish', s: 'Write it, then post to your own X / Discord / Slack / Telegram.', view: 'growth' },
    { g: '⬡', t: 'OSINT & recon', s: 'whois · DNS · subdomains · headers · username · breach lookups.', seed: 'Run an OSINT recon on: ' },
    { g: '◉', t: 'Private browser', s: 'Bundled Tor + SOCKS5 — browse sovereign, reach .onion.', seed: 'Open this over Tor privately: ' },
    { g: '◆', t: 'Second brain', s: 'Memory + semantic RAG — it remembers, recalls, compounds.', view: 'knowledge' },
    { g: '⬢', t: 'Run your life', s: 'Missions, goals, schedules, durable plans with approval gates.', view: 'operations' },
    { g: '⌘', t: 'The Fleet', s: 'Your army of nodes — pooled compute, one collective brain.', view: 'fleet' },
    { g: '◐', t: 'Voice & vision', s: 'Talk, listen, see — streaming speech + camera, fully local.', view: 'voice' },
    { g: '⎈', t: 'Connect & control', s: 'Sign into your own tools; control any device with scoped keys.', view: 'connect' },
    { g: '✧', t: 'Self-upgrade', s: 'It edits, eval-gates, and improves its own code — verified.', view: 'settings' },
  ];

  function injectStyle() {
    if (document.getElementById('atrium-style')) return;
    var st = document.createElement('style');
    st.id = 'atrium-style';
    st.textContent = [
      '#view-atrium .atrium-wrap{position:relative;max-width:1180px;margin:0 auto;padding:30px 22px 60px}',
      // marble + faint geometric tessellation watermark, gold vignette
      '#view-atrium .atrium-hero{position:relative;text-align:center;padding:46px 18px 30px;border:1px solid var(--border2);border-radius:20px;overflow:hidden;background:radial-gradient(1200px 380px at 50% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%), linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, var(--card)) 0%, var(--card) 60%)}',
      '#view-atrium .atrium-hero::before{content:"";position:absolute;inset:0;opacity:.06;pointer-events:none;background-image:repeating-conic-gradient(from 0deg at 50% 50%, var(--accent) 0deg 1deg, transparent 1deg 45deg);background-size:54px 54px}',
      '#view-atrium .emblem{width:96px;height:96px;margin:0 auto 16px;display:block;filter:drop-shadow(0 6px 18px color-mix(in srgb, var(--accent) 40%, transparent))}',
      '#view-atrium .eyebrow{letter-spacing:.34em;text-transform:uppercase;font-size:11.5px;color:var(--accent);font-weight:700;margin-bottom:12px}',
      '#view-atrium h1.atrium-title{font-size:clamp(30px,4.4vw,52px);line-height:1.06;margin:0 0 12px;font-weight:700;letter-spacing:-.01em;color:var(--text)}',
      '#view-atrium h1.atrium-title .gold{color:var(--accent)}',
      '#view-atrium .atrium-sub{max-width:660px;margin:0 auto 26px;color:var(--text2);font-size:15.5px;line-height:1.6}',
      '#view-atrium .dreambar{display:flex;gap:10px;max-width:680px;margin:0 auto;align-items:stretch}',
      '#view-atrium .dreambar input{flex:1;background:var(--input-bg);border:1.5px solid var(--border2);border-radius:14px;padding:15px 18px;font-size:15px;color:var(--text);outline:none;font-family:var(--sans)}',
      '#view-atrium .dreambar input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)}',
      '#view-atrium .dreambar button{background:var(--accent);color:#1a1205;border:none;border-radius:14px;padding:0 24px;font-weight:700;font-size:14.5px;cursor:pointer;white-space:nowrap;font-family:var(--sans)}',
      '#view-atrium .dreambar button:hover{filter:brightness(1.06)}',
      '#view-atrium .dream-hint{margin:12px auto 0;color:var(--text3);font-size:12.5px}',
      '#view-atrium .const-label{text-align:center;letter-spacing:.28em;text-transform:uppercase;font-size:11px;color:var(--text3);font-weight:600;margin:40px 0 18px}',
      '#view-atrium .caps{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:14px}',
      '#view-atrium .cap{position:relative;text-align:left;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 16px 15px;cursor:pointer;transition:.14s;overflow:hidden}',
      '#view-atrium .cap:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 10px 26px color-mix(in srgb, var(--accent) 16%, transparent)}',
      '#view-atrium .cap .cg{font-size:22px;color:var(--accent);line-height:1;margin-bottom:9px;display:block}',
      '#view-atrium .cap .ct{font-weight:650;font-size:14.5px;color:var(--text);margin-bottom:4px}',
      '#view-atrium .cap .cs{font-size:12.5px;color:var(--text2);line-height:1.5}',
      '#view-atrium .atrium-foot{text-align:center;margin-top:34px;color:var(--text3);font-size:12.5px;line-height:1.7}',
      '#view-atrium .atrium-foot b{color:var(--text2);font-weight:600}'
    ].join('');
    document.head.appendChild(st);
  }

  function emblemSVG() {
    // 8-fold geometric star (pure geometry — the "8" of ABUZ8, mathematically symmetric)
    var pts = [];
    var cx = 48, cy = 48, R = 44, r = 18;
    for (var i = 0; i < 16; i++) { var ang = (Math.PI / 8) * i - Math.PI / 2; var rad = (i % 2 === 0) ? R : r; pts.push((cx + rad * Math.cos(ang)).toFixed(1) + ',' + (cy + rad * Math.sin(ang)).toFixed(1)); }
    return '<svg class="emblem" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
      + '<polygon points="' + pts.join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.85"/>'
      + '<circle cx="48" cy="48" r="26" fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.5"/>'
      + '<text x="48" y="56" text-anchor="middle" font-family="var(--sans)" font-size="26" font-weight="800" fill="var(--accent)">A8</text>'
      + '</svg>';
  }

  function render() {
    var v = document.getElementById('view-atrium'); if (!v) return;
    if (v.getAttribute('data-built') === '1') return;
    injectStyle();
    var caps = CAPS.map(function (c, i) { return '<div class="cap" data-i="' + i + '"><span class="cg">' + c.g + '</span><div class="ct">' + esc(c.t) + '</div><div class="cs">' + esc(c.s) + '</div></div>'; }).join('');
    v.innerHTML =
      '<div class="atrium-wrap">'
      + '<div class="atrium-hero">' + emblemSVG()
      + '<div class="eyebrow">ABUZ8 OS · Sovereign Operator</div>'
      + '<h1 class="atrium-title">I am your sovereign operator.<br>If you can dream it, <span class="gold">we can build it.</span></h1>'
      + '<div class="atrium-sub">I run your life and build what you imagine — on your machine, your data, never cut off. Tell me what you want and I will plan it, make it, and ship it.</div>'
      + '<div class="dreambar"><input id="atrium-dream" type="text" placeholder="What is your dream today?  (e.g. build me a wallpaper, scaffold a video game, run recon on a domain…)" aria-label="What is your dream today?"><button id="atrium-go">Begin →</button></div>'
      + '<div class="dream-hint">Press Enter to hand it to the agent. Everything below is shipped and real today.</div>'
      + '</div>'
      + '<div class="const-label">— What I can do for you, right now —</div>'
      + '<div class="caps">' + caps + '</div>'
      + '<div class="atrium-foot">A sovereign fusion — <b>Claude Desktop</b> precision · <b>Manus</b> control · <b>Hermes</b> agentic loop · <b>OpenClaw</b> reach — built as one, <b>100% yours</b>.<br>Every capability above is shipped and verifiable. No cloud lock-in, no rented mind.</div>'
      + '</div>';
    var inp = document.getElementById('atrium-dream'), btn = document.getElementById('atrium-go');
    function fire() { var t = (inp && inp.value || '').trim(); if (t) dream(t); }
    if (btn) btn.onclick = fire;
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
    v.querySelectorAll('.cap').forEach(function (el) {
      el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
      var c = CAPS[+el.getAttribute('data-i')];
      var act = function () { if (c.view) go(c.view); else if (c.seed) dream(c.seed); };
      el.onclick = act;
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    });
    v.setAttribute('data-built', '1');
  }
  window.loadAtrium = function () { try { render(); var i = document.getElementById('atrium-dream'); if (i) i.focus(); } catch (e) {} };
})();
