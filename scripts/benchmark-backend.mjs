import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runWorkload, scenarios } from './benchmark-workload.mjs';
const args = process.argv.slice(2);
if (args[0] === '--child') {
  try { console.log(JSON.stringify(await runWorkload(Number(args[1]), args[2]))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
} else {
  const output = args[0];
  const repeats = Number(args[1] ?? 1);
  if (!output || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Usage: node scripts/benchmark-backend.mjs NEW-OUTPUT.json [1..10 repeats]');
  const report = { status: 'failed', repeats, results: [], sourceHashes: Object.fromEntries(['src/backend/duplicates.js', 'src/backend/diskusage.js', 'src/backend/sys.js', 'src/backend/paths.js', 'scripts/benchmark-workload.mjs', 'scripts/benchmark-backend.mjs'].map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])) };
  const hashes = new Map();
  try {
    for (const count of [1000, 10000, 100000]) for (const scenario of scenarios) for (let repeat = 0; repeat < repeats; repeat++) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', String(count), scenario], { encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 20, windowsHide: true });
      if (child.error || child.status !== 0) {
        report.results.push({ count, scenario, repeat, exitCode: child.status, stderr: child.stderr, stdout: child.stdout, error: child.error?.message });
        throw new Error(`Benchmark child failed: ${count}/${scenario}: ${child.stderr || child.error}`);
      }
      const row = JSON.parse(child.stdout);
      const key = `${count}/${scenario}`;
      if (hashes.has(key) && hashes.get(key) !== row.outputHash) throw new Error(`Nondeterministic output: ${key}`);
      hashes.set(key, row.outputHash);
      report.results.push({ ...row, repeat, exitCode: child.status });
    }
    report.status = 'passed';
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally { writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(`Backend benchmark evidence: ${output} (${report.status}, ${report.results.length} children)`); }
}
