#!/usr/bin/env node
// Security smoke — proves the Track-1 CORS/rebinding/fs-read fixes actually behave.
const os = require('os'); const path = require('path'); const fs = require('fs'); const http = require('http');
process.env.ABUZ8_DATA_DIR = path.join(os.tmpdir(), 'abuz8_secsmoke_' + process.pid);
fs.mkdirSync(path.join(process.env.ABUZ8_DATA_DIR, 'config'), { recursive: true });
process.env.ABUZ8_PORT = '0';
const pc = require(path.join(__dirname, '..', 'src', 'portable-core.js'));
function req(port, p, m, headers, body) {
  return new Promise((resolve) => {
    const d = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {}); if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: h }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    }); r.on('error', () => resolve({ status: 0, headers: {}, json: null })); if (d) r.write(d); r.end();
  });
}
(async () => {
  const { port } = await pc.start({ log: () => {} });
  let pass = 0, fail = 0; const ck = (n, ok, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (d ? ' :: ' + String(d).slice(0, 100) : '')); ok ? pass++ : fail++; };

  // 1. legitimate same-origin still works (no Origin header → normal app/curl path)
  const ok1 = await req(port, '/health', 'GET', {});
  ck('same-origin health 200', ok1.status === 200 && ok1.json && ok1.json.version, 'v=' + (ok1.json && ok1.json.version));

  // 2. cross-site page must NOT receive an ACAO it can read with
  const evil = await req(port, '/health', 'GET', { Origin: 'https://evil.example.com' });
  ck('cross-origin gets NO wildcard/echo ACAO', !evil.headers['access-control-allow-origin'], 'acao=' + evil.headers['access-control-allow-origin']);

  // 3. our own renderer origin IS reflected
  const mine = await req(port, '/health', 'GET', { Origin: 'http://127.0.0.1:' + port });
  ck('same-machine origin reflected', mine.headers['access-control-allow-origin'] === 'http://127.0.0.1:' + port, 'acao=' + mine.headers['access-control-allow-origin']);

  // 3b. SEC-01: Origin:null (opaque iframe / data:/srcdoc) WITHOUT the per-process CSRF nonce must be
  //     blocked on a state-changing POST AND must get no readable ACAO:null on any response.
  const nullPost = await req(port, '/api/fs/read', 'POST', { Origin: 'null' }, { path: __filename });
  ck('SEC-01: Origin:null POST blocked w/o nonce', nullPost.status === 403, 'status=' + nullPost.status);
  const nullGet = await req(port, '/health', 'GET', { Origin: 'null' });
  ck('SEC-01: Origin:null gets no readable ACAO', !nullGet.headers['access-control-allow-origin'], 'acao=' + nullGet.headers['access-control-allow-origin']);

  // 4. DNS-rebinding Host (lan off) rejected
  const rebind = await req(port, '/health', 'GET', { Host: 'evil.example.com' });
  ck('DNS-rebind Host 403', rebind.status === 403, 'status=' + rebind.status);

  // 5. fs/read blocks a sensitive credential path
  const ssh = await req(port, '/api/fs/read', 'POST', {}, { path: path.join(os.homedir(), '.ssh', 'id_rsa') });
  ck('fs/read blocks ~/.ssh/id_rsa', ssh.status === 403 || (ssh.json && /sensitive|blocked/i.test(ssh.json.error || '')), 'status=' + ssh.status + ' err=' + (ssh.json && ssh.json.error));

  // 6. fs/read still works for a normal file (not over-blocked)
  const tf = path.join(process.env.ABUZ8_DATA_DIR, 'note.txt'); fs.writeFileSync(tf, 'hello-abuz8');
  const good = await req(port, '/api/fs/read', 'POST', {}, { path: tf });
  ck('fs/read normal file works', good.json && good.json.ok && good.json.content === 'hello-abuz8', 'ok=' + (good.json && good.json.ok));

  // 7. semver: a lower manifest version must NOT be offered (no downgrade-brick)
  ck('semverGt rejects downgrade', pc.semverGt('1.31.0', '1.26.0') === true && pc.semverGt('1.26.0', '1.31.0') === false && pc.semverGt('1.31.0', '1.31.0') === false, 'lib');

  // 8. manual revenue record is forced UNVERIFIED (can't fabricate cash)
  const recd = await req(port, '/api/revenue/record', 'POST', {}, { channel: 'fake', amount_usd: 50000, verified: true, source: 'stripe' });
  ck('revenue/record forced unverified', recd.json && recd.json.ok && recd.json.verified === false, 'verified=' + (recd.json && recd.json.verified));
  const sum = await req(port, '/api/revenue/summary', 'GET');
  ck('summary keeps fabricated $ out of verified_total', sum.json && sum.json.verified_total === 0 && sum.json.unverified_total >= 50000, 'vt=' + (sum.json && sum.json.verified_total) + ' ut=' + (sum.json && sum.json.unverified_total));

  // 9. SEC-07: with NO Stripe signing secret configured, the webhook is REFUSED (501) and records NOTHING —
  //    a stronger guarantee than the old "record as unverified" (which polluted the ledger/HUD).
  const sumBefore = await req(port, '/api/revenue/summary', 'GET');
  const wh = await req(port, '/api/store/webhook', 'POST', {}, { type: 'checkout.session.completed', data: { object: { amount_total: 99900 } } });
  const sumAfter = await req(port, '/api/revenue/summary', 'GET');
  const noNewRow = sumBefore.json && sumAfter.json && (sumAfter.json.unverified_total === sumBefore.json.unverified_total);
  ck('unsigned webhook refused, nothing recorded (SEC-07)', wh.status === 501 && wh.json && wh.json.ok === false && noNewRow, 'status=' + wh.status + ' newRow=' + (!noNewRow));

  // 10. self-update host-pin: only https on trusted hosts; reject http + arbitrary hosts
  ck('update host-pin accepts github https', pc.updateHostAllowed('https://github.com/abuz8studios-ship-it/abuz8-os/releases/latest/download/ABUZ8-OS-Setup.exe') === true);
  ck('update host-pin rejects http', pc.updateHostAllowed('http://github.com/x/ABUZ8-OS-Setup.exe') === false);
  ck('update host-pin rejects evil host', pc.updateHostAllowed('https://evil.example.com/ABUZ8-OS-Setup.exe') === false);

  // 11. prompt-injection guard: cmd_run must NOT run even with the agent's _permitted bypass,
  // unless the explicit Allow-actions toggle is on. (Default settings: actions not allowed.)
  const inj = await req(port, '/api/tools/call', 'POST', {}, { tool: 'cmd_run', args: { command: 'echo pwned', _permitted: true } });
  ck('cmd_run blocked despite _permitted bypass', inj.json && inj.json.ok === false && /allow.?action|shell\/OS|permission|blocked/i.test(JSON.stringify(inj.json)), JSON.stringify(inj.json).slice(0, 90));

  // 12. agent stop endpoint exists and acknowledges (mid-loop cancel)
  const stop = await req(port, '/api/agent/stop', 'POST', {}, {});
  ck('agent stop endpoint works', stop.json && stop.json.ok === true && stop.json.stopped === true, JSON.stringify(stop.json).slice(0, 60));

  // 13. SOVEREIGNTY: Local-Only/air-gap toggles and actually blocks outbound egress
  const ag0 = await req(port, '/api/airgap/status', 'GET');
  ck('air-gap default off', ag0.json && ag0.json.local_only === false, 'lo=' + (ag0.json && ag0.json.local_only));
  await req(port, '/api/airgap', 'POST', {}, { enabled: true });
  const ag1 = await req(port, '/api/airgap/status', 'GET');
  ck('air-gap toggles on', ag1.json && ag1.json.local_only === true);
  const upd = await req(port, '/api/update/check', 'GET'); // forces an external github fetch
  ck('air-gap BLOCKS outbound egress', upd.json && upd.json.ok === false && /local-only|air-gap|blocked|outbound/i.test(JSON.stringify(upd.json)), JSON.stringify(upd.json).slice(0, 90));
  const wsAir = await req(port, '/api/tools/call', 'POST', {}, { tool: 'web_search', args: { q: 'secret query' } });
  ck('air-gap BLOCKS web search (query never leaves)', wsAir.json && wsAir.json.result && wsAir.json.result.airgap === true, JSON.stringify(wsAir.json).slice(0, 80));
  await req(port, '/api/airgap', 'POST', {}, { enabled: false }); // restore

  // 16. fs/read now blocks .env and browser master key (re-audit gap fix)
  const envf = path.join(process.env.ABUZ8_DATA_DIR, '.env'); fs.writeFileSync(envf, 'API_KEY=supersecret');
  const envRead = await req(port, '/api/fs/read', 'POST', {}, { path: envf });
  ck('fs/read blocks .env secrets', envRead.status === 403, 'status=' + envRead.status);

  // 14. SOVEREIGNTY: API keys encrypted at rest (no plaintext secret on disk)
  await req(port, '/api/connectors/set', 'POST', {}, { id: 'stripe', creds: { api_key: 'sk_test_SECRET_ABC123' } });
  const connFile = path.join(process.env.ABUZ8_DATA_DIR, 'config', 'connectors.json');
  let raw = ''; try { raw = fs.readFileSync(connFile, 'utf8'); } catch {}
  ck('connector secret encrypted at rest', /"__enc"\s*:\s*"v1"/.test(raw) && !/sk_test_SECRET_ABC123/.test(raw), 'enc=' + /__enc/.test(raw) + ' leak=' + /sk_test_SECRET_ABC123/.test(raw));
  const clist = await req(port, '/api/connectors', 'GET'); // reads back through decryption — must not error
  ck('connectors still readable after encryption', clist.status === 200 && clist.json, 'status=' + clist.status);

  // 15. NZT decision engine: runs Monte Carlo + verdict before answering
  const goMove = await req(port, '/api/decide', 'POST', {}, { name: 'good bet', p_success: 0.6, upside_usd: 1000, downside_usd: 300, bankroll_usd: 10000 });
  ck('decide: +EV move → GO', goMove.json && goMove.json.ok && /^GO/.test(goMove.json.verdict) && goMove.json.expected_value_usd > 0, 'v=' + (goMove.json && goMove.json.verdict) + ' ev=' + (goMove.json && goMove.json.expected_value_usd));
  const noMove = await req(port, '/api/decide', 'POST', {}, { name: 'bad bet', p_success: 0.3, upside_usd: 200, downside_usd: 500 });
  ck('decide: -EV move → NO-GO + anomaly', noMove.json && noMove.json.verdict === 'NO-GO' && noMove.json.anomalies.length > 0, 'v=' + (noMove.json && noMove.json.verdict) + ' ev=' + (noMove.json && noMove.json.expected_value_usd));

  // 17. CSRF guard: a cross-site Origin on a state-changing POST is blocked (kills the ungated-endpoint class)
  const csrf = await req(port, '/api/onboard/connect', 'POST', { Origin: 'https://evil.example.com' }, { id: 'notion', creds: { token: 'x' } });
  ck('CSRF: cross-origin POST blocked 403', csrf.status === 403, 'status=' + csrf.status);
  const sameorigin = await req(port, '/api/onboard/connect', 'POST', {}, { id: 'notion', creds: { token: 'x' } });
  ck('same-origin/no-origin POST still works', sameorigin.status === 200, 'status=' + sameorigin.status);

  // 18. learn/ingest refuses credential/secret files
  const sf = path.join(process.env.ABUZ8_DATA_DIR, '.env'); fs.writeFileSync(sf, 'SECRET=abc');
  const li = await req(port, '/api/learn/ingest', 'POST', {}, { path: sf });
  ck('learn/ingest blocks .env secret', li.json && li.json.ok === false && /sensitive/.test(JSON.stringify(li.json)), JSON.stringify(li.json).slice(0, 70));

  // 19. license keygen/issue owner-gated (no Allow-actions = 403)
  const kg = await req(port, '/api/license/keygen', 'POST', {}, {});
  ck('license keygen owner-gated', kg.status === 403, 'status=' + kg.status);

  const tc = await req(port, '/api/tenant/create', 'POST', {}, { name: 'x', role: 'admin' });
  ck('tenant create owner-gated', tc.status === 403, 'status=' + tc.status);
  const tw = await req(port, '/api/tenant/whoami', 'POST', {}, {});
  ck('tenant whoami default-unauthenticated', tw.json && tw.json.authenticated === false);
  const tk = await req(port, '/api/tenant/check', 'POST', {}, { need: 'owner' });
  ck('tenant RBAC default-deny (no token)', tk.json && tk.json.allowed === false);

  // 20. SEC-01b: desktop control (real mouse/keyboard/screen) must NOT be drivable cross-origin.
  // A no-Origin GET (<img>/<script> drive-by) is rejected with 405 (POST required), and even a POST
  // is refused 403 until Allow-actions is on — so a malicious browser tab can neither click nor screenshot.
  const cuGet = await req(port, '/api/spine/computer/screenshot', 'GET', {});
  ck('desktop-control: no-Origin GET blocked (405)', cuGet.status === 405, 'status=' + cuGet.status);
  const cuPost = await req(port, '/api/spine/computer/click', 'POST', {}, {});
  ck('desktop-control: POST needs Allow-actions (403)', cuPost.status === 403, 'status=' + cuPost.status);
  const heal = await req(port, '/api/self/heal', 'GET', {});
  ck('self/heal: no cross-origin GET trigger (405)', heal.status === 405, 'status=' + heal.status);

  // 21. SEC-02 deeper: fs/list is credential-jailed (sensitive dirs blocked) like fs/read; bare secret dir too.
  const lss = await req(port, '/api/fs/list', 'POST', {}, { dir: path.join(os.homedir(), '.ssh') });
  ck('fs/list blocks bare .ssh dir (403)', lss.status === 403, 'status=' + lss.status);
  const lss2 = await req(port, '/api/fs/list', 'POST', {}, { dir: path.join(os.homedir(), '.ssh', 'sub') });
  ck('fs/list blocks inside .ssh (403)', lss2.status === 403, 'status=' + lss2.status);

  // 22. SEC-03 deeper: mesh/add can't register a cloud-metadata host (SSRF whitelist), and a non-loopback
  // peer needs Allow-actions — so a prompt-injected agent can't silently whitelist an internal host.
  const mMeta = await req(port, '/api/mesh/add', 'POST', {}, { url: 'http://169.254.169.254/latest/meta-data/' });
  ck('mesh/add blocks cloud-metadata host (403)', mMeta.status === 403, 'status=' + mMeta.status);
  const mLan = await req(port, '/api/mesh/add', 'POST', {}, { url: 'http://192.168.1.50:9000' });
  ck('mesh/add non-loopback peer needs Allow-actions (403)', mLan.status === 403, 'status=' + mLan.status);

  console.log('\nSEC-SMOKE: ' + pass + ' ok / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SEC ERR ' + (e.stack || e)); process.exit(2); });
