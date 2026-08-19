/* ABUZ8 theme toggle — quick light/dark switch driving the app's real THEMES system
   (applyTheme persists to localStorage 'abuz8_theme' + sets vars inline). The doctrine
   light palette is the 'abuz8-light' THEMES entry. External vendored file = keeps the
   renderer's single bare <script> CI rule. */
(function () {
  'use strict';
  function cur() { try { return localStorage.getItem('abuz8_theme') || 'abuz8-light'; } catch (e) { return 'abuz8-light'; } }
  function isLight(k) { return /light/.test(k || ''); }
  function sync() { var b = document.getElementById('abuzThemeBtn'); if (b) b.textContent = isLight(cur()) ? '☾' : '☀'; } // moon when light, sun when dark
  function toggle() {
    var next = isLight(cur()) ? 'claude-dark' : 'abuz8-light';
    if (typeof window.applyTheme === 'function') window.applyTheme(next);
    var sel = document.getElementById('theme-sel'); if (sel) { sel.value = next; }
    sync();
  }
  function mount() {
    if (document.getElementById('abuzThemeBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'abuzThemeBtn'; btn.title = 'Toggle light / dark theme'; btn.setAttribute('aria-label', 'Toggle theme');
    btn.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:9998;width:40px;height:40px;border-radius:50%;border:1px solid var(--border2);background:var(--card2);color:var(--accent);font-size:17px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    btn.onclick = toggle;
    document.body.appendChild(btn);
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.abuz8ToggleTheme = toggle;
})();
