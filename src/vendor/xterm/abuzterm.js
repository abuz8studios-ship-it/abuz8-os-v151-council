/* ABUZ8 in-app terminal controller — drives /api/term/* against a real node-pty,
   renders with xterm.js, warm-launches a CLI brain per tab. Loaded as an external
   script (keeps the renderer's single inline <script> contract for CI). */
(function () {
  var term = null, fit = null, curId = null, off = 0, poll = null;
  function api(p, b) { return fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
  function ensureTerm() {
    if (term) return true;
    if (typeof Terminal === 'undefined') { console.warn('xterm not loaded'); return false; }
    term = new Terminal({ fontFamily: 'IBM Plex Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#000000', foreground: '#cfe' } });
    try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) {}
    term.open(document.getElementById('abuzTermBody'));
    try { fit && fit.fit(); } catch (e) {}
    term.onData(function (d) { if (curId) api('/api/term/write', { id: curId, data: d }); });
    window.addEventListener('resize', function () { try { fit && fit.fit(); if (curId && term) api('/api/term/resize', { id: curId, cols: term.cols, rows: term.rows }); } catch (e) {} });
    return true;
  }
  function markWarm(brain) { try { document.querySelectorAll('#abuzTermTabs button[data-brain]').forEach(function (b) { b.classList.toggle('warm', b.getAttribute('data-brain') === brain); }); } catch (e) {} }
  var warmed = false;
  function warmBrains() { if (warmed) return; warmed = true; try { fetch('/api/term/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) { return r.json(); }).then(function (d) { try { (d && d.warmed || []).forEach(function (b) { var btn = document.querySelector('#abuzTermTabs button[data-brain="' + b + '"]'); if (btn) btn.classList.add('warm'); }); } catch (e) {} }).catch(function () {}); } catch (e) {} }
  var T = {
    toggle: function () { var w = document.getElementById('abuzTermWrap'); var openNow = !w.classList.contains('open'); w.classList.toggle('open'); if (openNow) { warmBrains(); } if (openNow && !curId) T.open('shell'); else if (openNow) { try { ensureTerm(); fit && fit.fit(); term && term.focus(); } catch (e) {} } },
    open: function (brain) {
      if (!ensureTerm()) { alert('Terminal needs node-pty (rebuild for this runtime).'); return; }
      document.getElementById('abuzTermWrap').classList.add('open');
      if (poll) { clearInterval(poll); poll = null; }
      term.reset(); off = 0; markWarm(brain);
      term.write('\x1b[90m… opening ' + (brain === 'shell' ? 'shell' : brain + ' (warm)') + '\x1b[0m\r\n');
      var cols = term.cols || 100, rows = term.rows || 28;
      api('/api/term/open', brain === 'shell' ? { cols: cols, rows: rows } : { brain: brain, cols: cols, rows: rows }).then(function (r) {
        if (!r || !r.ok) { term.write('\r\n\x1b[31m' + ((r && r.error) || 'failed to open terminal') + '\x1b[0m\r\n'); return; }
        curId = r.id; off = 0;
        poll = setInterval(function () { api('/api/term/read', { id: curId, since: off }).then(function (d) { if (d && d.ok) { if (d.data) { term.write(d.data); off = d.len; } if (d.exited) { clearInterval(poll); poll = null; } } }).catch(function () {}); }, 220);
        try { fit && fit.fit(); term.focus(); } catch (e) {}
      });
    }
  };
  window.abuzTerm = T;
})();
