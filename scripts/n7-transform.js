#!/usr/bin/env node
// N7 — mechanically split route()'s exact-match if-chain into contiguous numbered
// sub-routers, preserving EXACT order + handler bodies. route() becomes a dispatcher:
// runs each group in order, stops at the first that writes res (res.writableEnded),
// else falls to the original 404. Boundaries are only at `  if (pathname === ` lines
// (guaranteed top-level), so no brace-counting through templates/regexes is needed.
const fs = require('fs');
const F = 'src/portable-core.js';
const lines = fs.readFileSync(F, 'utf8').split(/\n/);
const NG = 12;

const headerIdx = lines.findIndex(l => l === 'async function route(req, res) {');
if (headerIdx < 0) throw new Error('route() header not found');
const chainStart = lines.findIndex((l, i) => i > headerIdx && /^  if \(pathname === '\/tui'\)/.test(l));
if (chainStart < 0) throw new Error('chain start (/tui) not found');
const def404 = lines.findIndex((l, i) => i > chainStart && /return json\(res, 404, \{ ok: false, error: `No portable-core endpoint/.test(l));
if (def404 < 0) throw new Error('default 404 not found');
const closeIdx = def404 + 1;
if (lines[closeIdx] !== '}') throw new Error('expected route() closing brace at ' + (closeIdx + 1) + ', got: ' + JSON.stringify(lines[closeIdx]));

const preamble = lines.slice(headerIdx + 1, chainStart);   // auth gate etc (verbatim)
const chain = lines.slice(chainStart, def404);             // the full if-chain (verbatim)
const line404 = lines[def404];                             // exact 404 return line

// boundary candidates = indices within `chain` that start a top-level exact-match handler
const cands = [];
chain.forEach((l, i) => { if (/^  if \(pathname === /.test(l)) cands.push(i); });
if (cands[0] !== 0) throw new Error('chain does not start at an exact-match boundary');

// pick NG group start-candidates, evenly spread
const starts = [];
for (let g = 0; g < NG; g++) starts.push(cands[Math.floor(g * cands.length / NG)]);
const uniqStarts = [...new Set(starts)];

// build group functions
const groupFns = [];
const groupNames = [];
for (let g = 0; g < uniqStarts.length; g++) {
  const s = uniqStarts[g];
  const e = (g + 1 < uniqStarts.length) ? uniqStarts[g + 1] : chain.length;
  const slice = chain.slice(s, e);
  const name = 'routeG' + String(g + 1).padStart(2, '0');
  groupNames.push(name);
  const firstRoute = (slice[0].match(/pathname === '([^']+)'/) || [])[1] || '?';
  const lastExact = [...slice].reverse().find(l => /pathname === '/.test(l));
  const lastRoute = (lastExact && lastExact.match(/pathname === '([^']+)'/) || [])[1] || '?';
  groupFns.push(
    '// route group ' + (g + 1) + '/' + uniqStarts.length + ' — ' + firstRoute + ' … ' + lastRoute +
    ' (' + slice.length + ' lines)\n' +
    'async function ' + name + '(req, res, pathname, searchParams) {\n' +
    slice.join('\n') + '\n}'
  );
}

const newRoute = [
  lines[headerIdx],
  ...preamble,
  '  // N7: dispatch through ordered route groups; first to respond wins, else 404.',
  '  // headersSent (set by writeHead) is the "handled" signal — it is true the instant a',
  '  // handler begins responding, including streaming responses (SSE / file-range) that',
  '  // do not synchronously end the stream (writableEnded would still be false for those).',
  '  for (const _g of ROUTE_GROUPS) { await _g(req, res, pathname, searchParams); if (res.headersSent) return; }',
  line404,
  '}',
  '',
  groupFns.join('\n\n'),
  '',
  'const ROUTE_GROUPS = [' + groupNames.join(', ') + '];'
].join('\n');

const out = [...lines.slice(0, headerIdx), newRoute, ...lines.slice(closeIdx + 1)].join('\n');
fs.writeFileSync(F, out);
console.log('N7 transform: ' + uniqStarts.length + ' groups from ' + cands.length + ' exact routes; chain ' + chain.length + ' lines preserved.');
console.log('groups: ' + groupNames.join(', '));
