/* ABUZ8 Fleet panel — see + drive the army. External vendored controller so the
   renderer keeps its single bare <script> (CI rule). Surfaces /api/fleet/* + /api/mesh/*. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }
  function bar(label, value, max, unit) {
    var pct = max > 0 ? Math.min(100, Math.round(value / max * 100)) : 0;
    return '<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2)"><span>' + esc(label) + '</span><span><b style="color:var(--text)">' + esc(value) + '</b> ' + esc(unit || '') + '</span></div>'
      + '<div style="height:8px;border-radius:6px;background:var(--card2);overflow:hidden;margin-top:3px"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent),var(--accent-soft,var(--accent)))"></div></div></div>';
  }
  function nodeCard(n) {
    var online = n.online !== false && !n.error;
    var dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (online ? '#3ec97a' : '#d05a5a') + ';margin-right:6px"></span>';
    return '<div class="card" style="padding:11px;min-width:200px">'
      + '<div style="font-weight:600;font-size:13px">' + dot + esc(n.name || n.url || n.id) + '</div>'
      + '<div class="muted" style="font-size:11px;margin:2px 0 8px;word-break:break-all">' + esc(n.url || '') + '</div>'
      + (online
        ? '<div style="font-size:12px;line-height:1.7">CPU <b>' + (n.cores || 0) + '</b> cores · GPU <b>' + (n.gpus || 0) + '</b> · VRAM <b>' + (n.vram_gb || 0) + '</b>GB<br>RAM <b>' + (n.ram_gb || 0) + '</b>GB' + (n.brain ? ' · <span class="muted">' + esc(n.brain) + '</span>' : '') + '</div>'
        : '<div class="muted" style="font-size:12px">offline · ' + esc(n.error || 'unreachable') + '</div>')
      + '<div style="margin-top:8px"><button class="btn sm ghost" data-fleet-remove="' + esc(n.id) + '">Remove</button></div></div>';
  }
  function render(stats, nodes) {
    var p = (stats && stats.pooled) || { cores: 0, gpus: 0, vram_gb: 0, ram_gb: 0 };
    var body = document.getElementById('fleet-body'); if (!body) return;
    var perNode = (stats && stats.per_node) || [];
    var roster = (nodes && nodes.nodes) || perNode;
    var cardMax = { cores: Math.max(64, p.cores), vram: Math.max(64, p.vram_gb), ram: Math.max(128, p.ram_gb) };
    body.innerHTML =
      '<div class="grid g2" style="align-items:start;gap:14px">'
      + '<div class="card" style="padding:14px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center"><div class="nav-label" style="padding:0">&#10070; Pooled compute</div>'
      + '<span class="muted" style="font-size:12px">' + (stats ? (stats.online || 0) : 0) + '/' + (stats ? (stats.nodes || 0) : 0) + ' online</span></div>'
      + bar('CPU cores (fleet)', p.cores || 0, cardMax.cores, 'cores')
      + bar('GPUs (fleet)', p.gpus || 0, Math.max(4, p.gpus), '')
      + bar('VRAM (fleet)', p.vram_gb || 0, cardMax.vram, 'GB')
      + bar('RAM (fleet)', p.ram_gb || 0, cardMax.ram, 'GB')
      + '<div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">'
      + '<button class="btn sm" id="fleet-refresh">&#8635; Refresh</button>'
      + '<button class="btn sm" id="fleet-shard">&#9889; Shard a big model</button>'
      + '<button class="btn sm ghost" id="fleet-execall">Run tool on all</button>'
      + '</div><div id="fleet-shard-out" class="muted" style="font-size:11.5px;margin-top:8px"></div>'
      + '</div>'
      + '<div class="card" style="padding:14px">'
      + '<div class="nav-label" style="padding:0">&#129504; Ask the whole fleet</div>'
      + '<div class="muted" style="font-size:11.5px;margin-bottom:6px">Every node answers on its own brain; the master fuses one stronger answer.</div>'
      + '<textarea id="fleet-q" rows="2" placeholder="Ask the collective brain..." style="width:100%;box-sizing:border-box;background:var(--card2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:8px;font-size:13px"></textarea>'
      + '<div style="margin-top:7px"><button class="btn sm" id="fleet-ask">Ask the fleet</button></div>'
      + '<div id="fleet-answer" style="font-size:12.5px;margin-top:9px;white-space:pre-wrap"></div>'
      + '</div></div>'
      + '<div class="nav-label" style="padding-left:0;margin-top:14px">&#9783; Nodes (' + roster.length + ')</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap">' + (roster.length ? roster.map(nodeCard).join('') : '<div class="empty-note">No nodes joined yet. Add one below — each is its own ABUZ8 on its own hardware.</div>') + '</div>'
      + '<div class="card" style="padding:12px;margin-top:12px;max-width:520px"><div class="nav-label" style="padding:0">+ Enroll a node (opt-in)</div>'
      + '<div style="display:flex;gap:7px;margin-top:7px;flex-wrap:wrap">'
      + '<input id="fleet-url" placeholder="http://node-ip:8900" style="flex:1;min-width:170px;background:var(--card2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:8px;font-size:13px">'
      + '<input id="fleet-name" placeholder="name (optional)" style="width:130px;background:var(--card2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:8px;font-size:13px">'
      + '<button class="btn sm" id="fleet-add">Add</button></div>'
      + '<div class="muted" style="font-size:11px;margin-top:6px">The node must allow LAN access + share the key. It joins by choice — ABUZ8 never self-spreads.</div></div>';
    wire();
  }
  function wire() {
    var byId = function (id) { return document.getElementById(id); };
    if (byId('fleet-refresh')) byId('fleet-refresh').onclick = load;
    if (byId('fleet-add')) byId('fleet-add').onclick = function () {
      var url = byId('fleet-url').value.trim(); if (!url) return;
      api('/api/mesh/add', 'POST', { url: url, name: byId('fleet-name').value.trim() || undefined }).then(load);
    };
    if (byId('fleet-ask')) byId('fleet-ask').onclick = function () {
      var q = byId('fleet-q').value.trim(); if (!q) return;
      byId('fleet-answer').textContent = 'Asking the fleet…';
      api('/api/fleet/brain', 'POST', { question: q }).then(function (r) {
        byId('fleet-answer').textContent = (r && r.synthesis) ? r.synthesis : ('No answer (' + ((r && r.error) || (r && r.nodes_answered === 0 ? 'no node answered' : 'error')) + ')');
      });
    };
    if (byId('fleet-shard')) byId('fleet-shard').onclick = function () {
      byId('fleet-shard-out').textContent = 'Planning split…';
      api('/api/fleet/shard/plan', 'POST', {}).then(function (r) {
        if (!r || !r.ok) { byId('fleet-shard-out').textContent = 'Plan failed: ' + ((r && r.error) || '?'); return; }
        byId('fleet-shard-out').innerHTML = 'Pooled <b>' + r.total_vram_gb + 'GB</b> across <b>' + r.nodes + '</b> GPU node(s) · split [' + (r.tensor_split || []).join(', ') + ']'
          + (r.rpc_binary_present ? '' : '<br><span class="muted">rpc-server binary not bundled yet — plan ready, serve gated.</span>');
      });
    };
    if (byId('fleet-execall')) byId('fleet-execall').onclick = function () {
      api('/api/fleet/exec', 'POST', { all: true, tool: 'get_time' }).then(function (r) {
        var n = (r && r.responded) || 0; byId('fleet-shard-out').textContent = 'Ran get_time on ' + n + ' node(s).';
      });
    };
    document.querySelectorAll('[data-fleet-remove]').forEach(function (b) {
      b.onclick = function () { api('/api/mesh/remove', 'POST', { id: b.getAttribute('data-fleet-remove') }).then(load); };
    });
  }
  function load() {
    var body = document.getElementById('fleet-body'); if (body && !body.innerHTML) body.innerHTML = '<div class="empty-note">Loading the fleet…</div>';
    Promise.all([api('/api/fleet/stats'), api('/api/mesh/nodes')]).then(function (res) { render(res[0], res[1]); });
  }
  window.loadFleet = load;
})();
