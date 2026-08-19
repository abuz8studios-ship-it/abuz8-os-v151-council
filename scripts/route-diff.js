#!/usr/bin/env node
// N7 SAFETY NET — differential route-behavior snapshot.
// Boots the engine headless on a scratch port and probes EVERY route (from
// scripts/route-inventory.json) + the order-sensitive special routes, recording
// {status, content-type, JSON top-level key-shape}. Run BEFORE the refactor to make
// a baseline, then AFTER — a zero diff proves dispatch + response-contract is unchanged.
// Matching in route() is by pathname only (not method), so a GET probe exercises the
// SAME handler a POST would. We snapshot KEY SHAPE (not values) so timestamps/latency
// don't create false diffs. Fresh data-dir + sorted order => reproducible across runs.
const os = require('os'); const path = require('path'); const fs = require('fs'); const http = require('http');
const OUT = process.argv[2] || path.join(__dirname, '.route-snapshot.json');
process.env.ABUZ8_DATA_DIR = path.join(os.tmpdir(), 'abuz8_rdiff_' + process.pid);
fs.mkdirSync(path.join(process.env.ABUZ8_DATA_DIR, 'config'), { recursive: true });
process.env.ABUZ8_PORT = '0';
// Routes that rebind/halt/spawn/exit the server or stream huge files — would break the run
// or are non-deterministic. We still record that they EXIST, just don't execute them.
const DENY = new Set(['/api/lan/toggle', '/api/halt', '/api/self/rollback', '/api/update/apply',
  '/api/self/upgrade/apply', '/api/restart', '/api/quit', '/api/shutdown']);
const SPECIAL = [ // order-sensitive non-exact handlers — verify they still dispatch
  '/vendor/__nope__.js', '/api/mcp/servers/__x__/start', '/api/mcp/servers/__x__/stop',
  '/api/mcp/servers/__x__/tools', '/api/mcp/servers/__x__/enable', '/__definitely_not_a_route__'];
const pc = require(path.join(__dirname, '..', 'src', 'portable-core.js'));
function probe(port, p) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 15000 }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let keys = null; try { const j = JSON.parse(b); keys = j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j).sort().join(',') : (Array.isArray(j) ? '[array]' : typeof j); } catch { keys = '<non-json:' + (b.trim()[0] || '') + '>'; }
        resolve({ status: res.statusCode, ct: (res.headers['content-type'] || '').split(';')[0], keys });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, ct: '', keys: 'TIMEOUT' }); });
    r.on('error', () => resolve({ status: 0, ct: '', keys: 'ERROR' }));
    r.end();
  });
}
(async () => {
  const { port } = await pc.start({ log: () => {} });
  await new Promise(r => setTimeout(r, 2000));
  const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'route-inventory.json'), 'utf8'));
  const all = [...routes, ...SPECIAL].sort();
  const snap = {};
  for (const p of all) {
    if (DENY.has(p)) { snap[p] = { status: 'DENY', ct: 'skipped', keys: 'lifecycle' }; continue; }
    snap[p] = await probe(port, p);
  }
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
  console.log('route snapshot: ' + all.length + ' routes -> ' + OUT);
  process.exit(0);
})().catch(e => { console.error('RDIFF ERR ' + (e.stack || e)); process.exit(2); });
