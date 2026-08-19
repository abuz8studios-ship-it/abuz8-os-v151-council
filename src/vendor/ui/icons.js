/* ABUZ8 icon system — replaces the old unicode/emoji nav glyphs with one consistent
   Lucide-grade inline-SVG set (1.6px stroke, 24-grid, currentColor). Every view gets a
   distinct, meaningful icon. Vendored = keeps the renderer's single bare <script> CI rule.
   Plus a light surgical polish pass (spacing/hierarchy) — additive, breaks nothing. */
(function () {
  'use strict';
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17" aria-hidden="true">' + inner + '</svg>';
  }
  // data-view -> icon paths (meaningful + unique)
  var I = {
    atrium: '<path d="M3 22h18"/><path d="M12 2 3 8h18z"/><path d="M5 22V11"/><path d="M9.5 22V11"/><path d="M14.5 22V11"/><path d="M19 22V11"/>', // temple/columns
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    coder: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    spine: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>', // cpu
    mind: '<path d="M12 3a4 4 0 0 0-4 4 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 6 0 3 3 0 0 0 2-4 3 3 0 0 0-1-5 4 4 0 0 0-4-4Z"/><path d="M12 7v10"/>', // brain
    kanban: '<rect x="4" y="4" width="4" height="14" rx="1"/><rect x="10" y="4" width="4" height="9" rx="1"/><rect x="16" y="4" width="4" height="11" rx="1"/>',
    operations: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>', // list-checks
    agent: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13h0M15 13h0"/><path d="M2 14h2M20 14h2"/>', // bot
    swarm: '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M12 7.4 6.5 15.8M12 7.4l5.5 8.4M7.4 18h9.2"/>', // network triangle
    fleet: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h0M7 17h0"/>', // stacked servers
    council: '<path d="M17 11a3 3 0 1 0-2.5-1.3"/><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15.5 14A6 6 0 0 1 21 20"/>', // users
    agents: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2"/><path d="M15 20a5 5 0 0 1 6-3"/>',
    studio: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-5-5L5 21"/>', // image
    forge: '<path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9"/><path d="M17.6 6.4 14 10l-2-2 3.6-3.6a2.8 2.8 0 0 1 4 4Z"/>', // hammer/forge
    social: '<path d="m3 11 16-5v12L3 14z"/><path d="M11.6 16.9a3 3 0 1 1-5.8-1.5"/>', // megaphone
    earn: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v6M18 9v6"/>', // banknote
    growth: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>', // trending-up
    voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>', // mic
    vision: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>', // eye
    operator: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>', // monitor
    knowledge: '<path d="M3 5a2 2 0 0 1 2-2h14v18H5a2 2 0 0 1-2-2z"/><path d="M3 5v14a2 2 0 0 0 2 2"/><path d="M8 7h7M8 11h7"/>', // book/brain
    docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
    gallery: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 21h12a2 2 0 0 0 2-2V9"/><circle cx="8" cy="8" r="1.5"/><path d="m3 14 4-3 4 3"/>',
    memory: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>', // database
    skills: '<path d="M15 3a2 2 0 0 1 2 2v2h2a2 2 0 1 1 0 4h-2v2a2 2 0 0 1-2 2v2a2 2 0 1 1-4 0H9a2 2 0 0 1-2-2v-2H5a2 2 0 1 1 0-4h2V5a2 2 0 0 1 2-2h2a2 2 0 1 1 4 0Z"/>', // puzzle
    providers: '<path d="M9 2v6M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v6"/>', // plug
    connect: '<path d="M9 12a3 3 0 0 0 0 4l2 2a3 3 0 0 0 4-4"/><path d="M15 12a3 3 0 0 0 0-4l-2-2a3 3 0 0 0-4 4"/>', // link
    mcp: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>', // blocks
    models: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>', // layers
    bridge: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>', // arrow-left-right
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2z"/>', // wrench
    system: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11 6 17M12 11l6 6"/>', // git-fork
    hud: '<path d="M12 14 16 9"/><path d="M5 18a8 8 0 1 1 14 0z"/>', // gauge
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6 1.6 1.6 0 0 0 8 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 14.6 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'
  };
  function polish() {
    if (document.getElementById('ui-polish')) return;
    var s = document.createElement('style'); s.id = 'ui-polish';
    s.textContent = [
      '.nav-item .ico{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;opacity:.78;transition:opacity .12s}',
      '.nav-item:hover .ico,.nav-item.active .ico{opacity:1}',
      '.nav-item.active .ico svg{stroke:var(--accent)}',
      '.nav-item{border-radius:9px;font-weight:500}',
      '.nav-label{letter-spacing:.12em;text-transform:uppercase;font-size:10.5px;opacity:.62;font-weight:700}',
      '.card{border-radius:13px}',
      '::-webkit-scrollbar{width:9px;height:9px}'
    ].join('');
    document.head.appendChild(s);
  }
  function apply() {
    try {
      polish();
      document.querySelectorAll('.nav-item').forEach(function (n) {
        var v = n.getAttribute('data-view'); var ico = n.querySelector('.ico');
        if (ico && I[v]) ico.innerHTML = svg(I[v]);
      });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  setTimeout(apply, 600); // re-apply after the renderer finishes booting
  window.abuz8ApplyIcons = apply;
})();
