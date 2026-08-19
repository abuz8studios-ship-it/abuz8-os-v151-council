/* ABUZ8 live voice — whisper.cpp streaming STT (real-time native hearing).
   Prefers the Kinect v2 "Xbox NUI Sensor" mic array when present. Loaded as an
   external script to keep the renderer's single-inline-script contract for CI. */
(function () {
  var on = false, off = 0, poll = null, buf = '';
  function api(p, b) { return fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
  function setBtn(label) { var b = document.getElementById('abuzLiveBtn'); if (b) { b.textContent = label; b.classList.toggle('on', on); } }
  function showTx(t) { var box = document.getElementById('abuzLiveTx'); if (box) { box.style.display = on ? 'block' : 'none'; box.textContent = (t || '').replace(/\s+/g, ' ').slice(-300); } }
  var L = {
    toggle: function () {
      if (on) { on = false; if (poll) { clearInterval(poll); poll = null; } api('/api/voice/stream/stop'); setBtn('🎙 Live'); showTx(''); return; }
      fetch('/api/kinect').then(function (r) { return r.json(); }).then(function (k) {
        var opts = { language: 'en' };
        if (k && k.kinect_mic_capture_index != null) opts.kinect = true;
        api('/api/voice/stream/start', opts).then(function (s) {
          if (!s || !s.ok) { alert('Live voice unavailable: ' + ((s && s.error) || 'whisper-stream not ready')); return; }
          on = true; off = 0; buf = ''; setBtn('🛑 Listening' + (opts.kinect ? ' (Kinect)' : ''));
          poll = setInterval(function () {
            api('/api/voice/stream/read', { since: off }).then(function (d) { if (d && d.ok) { off = d.len; if (d.transcript) { buf += d.transcript; showTx(buf); } } }).catch(function () {});
          }, 600);
        });
      }).catch(function () { api('/api/voice/stream/start', { language: 'en' }).then(function () { on = true; setBtn('🛑 Listening'); }); });
    }
  };
  window.abuzLive = L;
})();
