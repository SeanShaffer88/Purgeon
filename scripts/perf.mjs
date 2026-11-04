// Performance baseline: the few numbers worth watching, measured the same way
// every time so a regression is visible instead of felt. Run: npm run perf
//   - production build size (total + largest chunks) — what ships to the user
//   - test-suite wall time and pass/fail counts — the feedback loop's cost
// This records a baseline; it does not enforce budgets. A change that moves a
// number by more than ~10% should say why in its change notes.
import { spawnSync } from 'node:child_process';
import { parseCounts, requireSuccess } from './perf-result.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..';
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log('Building (production)…');
const t0 = Date.now();
requireSuccess(spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const buildMs = Date.now() - t0;

const assetsDir = path.join(root, 'dist', 'assets');
const assets = fs
  .readdirSync(assetsDir)
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetsDir, name)).size }))
  .sort((a, b) => b.bytes - a.bytes);
const total = assets.reduce((s, a) => s + a.bytes, 0);
console.log(`\nBuild: ${buildMs.toLocaleString()} ms`);
console.log(`Bundle: ${kb(total)} total across ${assets.length} files`);
for (const a of assets.slice(0, 5)) console.log(`  ${a.name}: ${kb(a.bytes)}`);

console.log('\nRunning the test suite…');
const t1 = Date.now();
const run = spawnSync(process.execPath, ['--test', 'test/*.test.js'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const suiteMs = Date.now() - t1;
const out = requireSuccess(run);
const { pass, fail } = parseCounts(out);
console.log(`Tests: ${suiteMs.toLocaleString()} ms wall, ${pass} passed, ${fail} failed`);
console.log('\nBaseline recorded above. Compare like with like: same machine, same command.');
