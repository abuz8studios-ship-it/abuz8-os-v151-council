#!/usr/bin/env node
/*
 * ABUZ8 OS — headless / CLI / daemon entrypoint (NO Electron, NO Chromium).
 *
 * This is the GUI-free way to run ABUZ8 OS: pure Node.js requiring the engine
 * (src/portable-core.js, which has zero Electron deps). It is what runs on a
 * Linux VPS, in Docker, or under Termux on Android — anywhere there is a node
 * binary and (optionally) a llama-server for the local brain.
 *
 *   node scripts/headless.js [--port 8900] [--data-dir <path>] [--lan] [--no-brain]
 *
 * Env equivalents: ABUZ8_PORT, ABUZ8_DATA_DIR, ABUZ8_LAN=1, ABUZ8_NO_BRAIN=1
 */
'use strict';

const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) {
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) return true; // boolean flag
    return next;
  }
  return fallback;
}

const port = arg('port', process.env.ABUZ8_PORT);
if (port && port !== true) process.env.ABUZ8_PORT = String(port);

const dataDir = arg('data-dir', process.env.ABUZ8_DATA_DIR);
if (dataDir && dataDir !== true) process.env.ABUZ8_DATA_DIR = String(dataDir);

if (arg('lan', false)) process.env.ABUZ8_LAN = '1';
if (arg('no-brain', false)) process.env.ABUZ8_NO_BRAIN = '1';

const core = require(path.join(__dirname, '..', 'src', 'portable-core.js'));

(async () => {
  const log = (m) => process.stdout.write(`[abuz8] ${m}\n`);
  log('starting headless (pure node, no Electron) …');
  try {
    const { port: boundPort, dataRoot } = await core.start({ log });
    log(`READY · http://127.0.0.1:${boundPort}/health · data: ${dataRoot}`);
    log('headless daemon live — API + scheduler + brain running, no GUI. Ctrl-C to stop.');
  } catch (e) {
    log('FAILED to start: ' + (e && e.stack || e));
    process.exit(1);
  }
  const shutdown = (sig) => { log(`${sig} — stopping …`); try { core.stop(); } catch {} process.exit(0); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Keep the event loop alive even though all internal timers are unref'd.
  setInterval(() => {}, 1 << 30);
})();
