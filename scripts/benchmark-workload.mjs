// Deterministic backend-only workload. Never touches native files, registry, or shell.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setSys } from '../packages/purgeon-core/src/internal/sys.js';
import * as duplicates from '../packages/purgeon-core/src/internal/duplicates.js';
import * as diskusage from '../packages/purgeon-core/src/internal/diskusage.js';
export const adapterIdentity = 'purgeon-in-memory-backend-v1';
export const scenarios = ['duplicates-scan', 'duplicates-group', 'duplicates-cancel-enumeration', 'duplicates-cancel-hashing', 'disk-scan', 'disk-cancel', 'disk-measure'];
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function workload(count) {
  if (!Number.isSafeInteger(count) || count < 10 || count % 10) throw new Error('Count must be a positive multiple of ten.');
  const root = 'C:\\Benchmark';
  const rows = Array.from({ length: count }, (_, i) => {
    const slot = i % 10;
    return { name: `f${String(i).padStart(6, '0')}`, path: `${root}\\f${String(i).padStart(6, '0')}`, size: 1024 + Math.floor(i / 10) % 31,
      hash: digest(['fixed-seed-6384485', Math.floor(i / 10), slot < 2 ? 0 : slot]), denied: slot === 2, hashDenied: slot === 3, dir: slot === 8, link: slot === 9, partial: i % 20 === 8 };
  });
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const entries = rows.flatMap((r, i) => i % 10 === 0 ? [`F${r.path}`, `F${r.path.toUpperCase()}`] : [`F${r.path}`]);
  const calls = { stat: 0, hash: 0, folder: 0 };
  const adapter = {
    info: { env: {}, home: 'C:\\Users\\Benchmark', dataDir: `${root}\\app` },
    beginScans: async () => {}, walk: async () => entries,
    stat: async (p) => { calls.stat++; const r = byPath.get(p); if (!r || r.denied) throw new Error('Access denied fixture'); return { size: r.size, dir: r.dir, link: r.link }; },
    sha256Files: async (paths) => { calls.hash++; return paths.map((p) => { const r = byPath.get(p); return r.hashDenied ? '' : r.hash; }); },
    readDir: async () => rows.map(({ name, dir, link }) => ({ name, dir, link })),
    folderSize: async (p) => { calls.folder++; const r = byPath.get(p); return { bytes: r.size * 2, truncated: r.partial }; },
  };
  return { root, rows, entries, calls, adapter, workloadHash: digest(rows) };
}
// Independent oracle: known pairs are slots 0/1; same-size unequal content and denied
// entries must never introduce another group. No production grouping helper used here.
function expectedGroups(rows, accepted = () => true) {
  const groups = [];
  for (let i = 0; i < rows.length; i += 10) {
    const pair = rows.slice(i, i + 2);
    if (pair.length === 2 && pair.every(accepted)) groups.push({ sha256: pair[0].hash, size: pair[0].size, files: pair.map((r) => r.path), wasted: pair[0].size });
  }
  return groups.sort((a, b) => b.wasted - a.wasted);
}
function diskExpected(rows, root) {
  const entries = rows.map((r) => ({ name: r.name, path: r.path, dir: r.dir, bytes: r.link ? 0 : r.denied ? 0 : r.size * (r.dir ? 2 : 1), partial: r.dir && r.partial, ...(r.link ? { link: true } : {}) }));
  entries.sort((a, b) => b.bytes - a.bytes || Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { path: root, entries, total: entries.reduce((sum, r) => sum + r.bytes, 0), complete: true };
}
export async function runWorkload(count, scenario) {
  if (!scenarios.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  const w = workload(count);
  setSys(w.adapter);
  let result;
  let checks = 0;
  let startMemory;
  let memory;
  let elapsedMs;
  const measure = async (operation) => {
    startMemory = process.memoryUsage();
    const started = performance.now();
    const value = await operation();
    elapsedMs = performance.now() - started;
    memory = process.memoryUsage();
    return value;
  };
  if (scenario === 'duplicates-group') {
    const sized = w.rows.filter((r) => !r.denied && !r.dir).map((r) => ({ path: r.path, size: r.size }));
    const hashes = new Map(w.rows.filter((r) => !r.hashDenied).map((r) => [r.path, r.hash]));
    result = await measure(() => duplicates.buildGroups(duplicates.groupBySize(sized), hashes));
    assert.deepEqual(result, expectedGroups(w.rows));
  } else if (scenario.startsWith('duplicates-')) {
    const stop = scenario === 'duplicates-cancel-enumeration' ? () => ++checks > 11
      : scenario === 'duplicates-cancel-hashing' ? () => w.calls.hash >= 1 : undefined;
    result = await measure(() => duplicates.scan([w.root, w.root], stop));
    if (scenario === 'duplicates-scan') {
      assert.deepEqual(result, { groups: expectedGroups(w.rows), scanned: count * 0.8, truncated: false });
    } else if (scenario === 'duplicates-cancel-enumeration') {
      // First eleven walk entries represent ten distinct paths, eight readable files.
      assert.deepEqual(result, { groups: [], scanned: 8, truncated: true });
      assert.equal(w.calls.hash, 0);
    } else {
      // Production candidates are grouped by size before hash chunks, not input order.
      const readable = w.rows.filter((r) => !r.denied && !r.dir);
      const sizeOrder = [...new Set(readable.map((r) => r.size))];
      const hashed = new Set(sizeOrder.flatMap((size) => readable.filter((r) => r.size === size).map((r) => r.path)).slice(0, 200));
      assert.deepEqual(result, { groups: expectedGroups(w.rows, (r) => hashed.has(r.path)), scanned: count * 0.8, truncated: true });
      assert.equal(w.calls.hash, 1);
    }
  } else if (scenario === 'disk-measure') {
    const folders = w.rows.filter((r) => r.dir);
    result = await measure(() => diskusage.measureFolders(folders.map((r) => r.path)));
    assert.deepEqual(result, { measured: folders.map((r) => ({ path: r.path, bytes: r.size * 2, partial: r.partial })), complete: true });
  } else {
    result = await measure(() => diskusage.scan(w.root, scenario === 'disk-cancel' ? () => ++checks > 3 : undefined));
    if (scenario === 'disk-scan') assert.deepEqual(result, diskExpected(w.rows, w.root));
    else {
      const expected = diskExpected(w.rows.filter((r, i) => i < 3 || r.link), w.root);
      expected.complete = false;
      assert.deepEqual(result, expected);
      assert.equal(w.calls.stat, 3);
      assert.equal(w.calls.folder, 0);
    }
  }
  return { count, scenario, adapter: adapterIdentity, workloadHash: w.workloadHash, outputHash: digest(result), elapsedMs,
    memory: { before: startMemory, after: memory, peakRssBytes: process.resourceUsage().maxRSS * 1024 }, calls: w.calls,
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch }, correctness: 'passed',
    scope: 'Actual JS backend with deterministic in-memory adapter; excludes native scanning and WebView. Elapsed and before/after memory exclude correctness oracle; peak RSS includes fixture/oracle. Baseline only, no performance budget.' };
}
