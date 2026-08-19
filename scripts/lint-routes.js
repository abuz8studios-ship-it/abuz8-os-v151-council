#!/usr/bin/env node
// Route-dup lint: fail on duplicate `pathname === '...'` literals so a shadowed/dead route
// (like the old duplicate /api/providers) can never silently land again. Runs in CI.
const fs = require('fs');
const file = process.argv[2] || 'src/portable-core.js';
const src = fs.readFileSync(file, 'utf8');
const re = /pathname === (?:'([^']+)'|"([^"]+)")/g;
const counts = {}; let m;
while ((m = re.exec(src))) { const lit = m[1] || m[2]; counts[lit] = (counts[lit] || 0) + 1; }
const dups = Object.entries(counts).filter(([, v]) => v > 1);
if (dups.length) {
  console.error('ROUTE-LINT FAIL — duplicate pathname literals (shadowed/dead routes):');
  for (const [k, v] of dups) console.error('  ' + k + '  x' + v);
  process.exit(1);
}
console.log('route-lint OK — ' + Object.keys(counts).length + ' unique pathname routes, 0 duplicates (' + file + ')');
