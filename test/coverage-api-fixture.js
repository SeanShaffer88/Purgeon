import assert from 'node:assert/strict';
import { registerRuntime, initializeRuntime } from '../packages/purgeon-core/src/public-runtime.js';
import * as log from '../src/backend/log.js';
import { recoveryLeaseFixture } from './recovery-lease-fixture.js';

// One registered host per module graph. Every test gets new virtual storage;
// nothing here opens a file, process, registry key, or network connection.
export async function createCoverageApiFixture() {
  const root = 'C:\\CoverageApiFixture';
  const files = new Map(), present = new Set(), recycled = new Set(), calls = [], approvals = [];
  const control = {};
  const lease = recoveryLeaseFixture();
  let held = false;
  const host = {
    info: { dataDir: root, env: { TEMP: 'C:\\CoverageApiTemp' } },
    makeDir: async () => {}, readDir: async () => [], stat: async path => control.stat?.(path) ?? null,
    readOptionalText: async path => files.get(path) ?? null,
    readText: async path => { assert.ok(files.has(path), `Missing virtual file ${path}`); return files.get(path); },
    writeTextAtomic: async (path, text) => {
      calls.push(['write', path]);
      await control.write?.(path, text);
      files.set(path, text);
    },
    appendText: async (path, text) => files.set(path, (files.get(path) || '') + text),
    exists: async path => files.has(path) || present.has(path),
    removePath: async path => {
      calls.push(['remove', path]);
      for (const key of files.keys()) if (key === path || key.startsWith(path + '\\')) files.delete(key);
    },
    secretGet: async () => '', secretKeys: async () => [],
    sha256Files: async paths => { assert.deepEqual(paths, [], 'File-export hashing must be explicitly implemented before use'); return []; },
    acquireRecoveryLease: async () => { const token = await lease.acquireRecoveryLease(); held = true; return token; },
    releaseRecoveryLease: async token => { await lease.releaseRecoveryLease(token); held = false; },
    trash: async path => {
      calls.push(['trash', path]);
      assert.ok(present.has(path), 'Only explicitly seeded virtual paths may be removed');
      await control.trash?.(path);
      present.delete(path); recycled.add(path);
    },
    runPS: async (script, input, _timeout, token) => {
      if (script.includes('$programs = foreach') && script.includes('$shared = foreach')) {
        calls.push(['inventory']);
        return JSON.stringify(control.inventory || { programs: [], shared: [] });
      }
      if (script.includes('$wanted =') && script.includes('$result | ConvertTo-Json')) {
        lease.assertRecoveryToken(token);
        const paths = JSON.parse(input);
        calls.push(['restore', ...paths]);
        if (control.restore) return control.restore(paths);
        return JSON.stringify(Object.fromEntries(paths.map(path => {
          const status = present.has(path) ? 'EXISTS' : recycled.has(path) ? 'OK' : 'NOTFOUND';
          if (status === 'OK') { recycled.delete(path); present.add(path); }
          return [path, status];
        })));
      }
      // Verification reads the virtual bin; it never restores anything.
      if (script.includes('$Recycle.Bin') && script.includes('@($found) | ConvertTo-Json -Compress') && input) {
        calls.push(['binPresence']);
        return JSON.stringify(JSON.parse(input).filter(path => recycled.has(path)));
      }
      throw new Error('Unexpected PowerShell request in inert API fixture');
    },
    exec: async () => { throw new Error('Unexpected native executable request'); },
  };
  const reset = async () => {
    await log.flushNow();
    assert.equal(held, false, 'Previous operation released the recovery lease');
    files.clear(); present.clear(); recycled.clear(); calls.length = 0; approvals.length = 0;
    for (const key of Object.keys(control)) delete control[key];
    files.set(root + '\\settings.json', JSON.stringify({ createRestorePoints: false }));
  };
  await reset();
  registerRuntime({ host, confirm: async request => {
    approvals.push(request);
    return control.approve ? control.approve(request) : true;
  } });
  await initializeRuntime();
  await log.flushNow();
  return {
    root, files, present, recycled, calls, approvals, control, reset,
    pendingPath: root + '\\backups\\pending.json',
    manifestPath: id => root + '\\backups\\' + id + '\\manifest.json',
    manifest: id => JSON.parse(files.get(root + '\\backups\\' + id + '\\manifest.json')),
    held: () => held,
    flush: () => log.flushNow(),
  };
}
