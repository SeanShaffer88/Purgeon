import assert from 'node:assert/strict';
import fs from 'node:fs';
const mode = process.argv[2];
const manifest = JSON.parse(fs.readFileSync('node_modules/purgeon-core/package.json', 'utf8'));
for (const file of fs.readdirSync('node_modules/purgeon-core/src/internal')) {
  if (!file.endsWith('.js')) continue;
  const source = fs.readFileSync('node_modules/purgeon-core/src/internal/' + file, 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"](?:@tauri|react|node:|\.\.\/)/, file);
  assert.doesNotMatch(source, /\bdocument\s*\.|\bwindow\s*\./, file);
}
const timers = [globalThis.setTimeout, globalThis.setInterval];
globalThis.setTimeout = globalThis.setInterval = () => { throw new Error('Import started background work'); };
const modules = {};
try {
  for (const subpath of Object.keys(manifest.exports)) modules[subpath] = await import('purgeon-core/' + subpath.slice(2));
} finally { [globalThis.setTimeout, globalThis.setInterval] = timers; }
assert.equal(manifest.dependencies, undefined);
for (const forbidden of ['sys', 'api', '__handlers', 'setSys', 'invoke', 'dispatchFeature']) {
  for (const exports of Object.values(modules)) assert.equal(exports[forbidden], undefined);
}
const pure = new Set(['runtime', 'winpath', 'contracts', 'confirmation-policy', 'portable-classification', 'lazy-module', 'cli-args']);
let operations = 0;
for (const [subpath, exports] of Object.entries(modules)) {
  if (pure.has(subpath.slice(2))) continue;
  assert.ok(Object.keys(exports).length, subpath);
  for (const [name, operation] of Object.entries(exports)) {
    if (subpath === './measure' && name === 'onMeasured') {
      assert.throws(() => operation(() => {}), /not ready/);
      continue;
    }
    await assert.rejects(operation(), /not ready/);
    operations++;
  }
}
assert.equal(operations, 269);
assert.equal(modules['./winpath'].join('C:\\demo', 'child'), 'C:\\demo\\child');
assert.equal(modules['./cli-args'].parseCliArgs instanceof Function, true);
const runtime = modules['./runtime'];
assert.throws(() => runtime.registerRuntime({ host: {} }), /Invalid runtime/);
assert.equal(runtime.runtimeState(), 'unregistered');
const files = new Map();
let writes = 0, calls = 0, failWrite = false, release, entered;
const hit = () => { calls++; };
const host = {
  info: { dataDir: 'C:\\fixture', env: {}, home: 'C:\\fixture', exe: '', version: 'test' },
  makeDir: async () => { hit(); if (mode === 'failed') throw new Error('init failed'); },
  readDir: async () => { hit(); return []; },
  readText: async p => { hit(); if (!files.has(p)) throw new Error('missing'); return files.get(p); },
  readOptionalText: async p => { hit(); return files.get(p) ?? null; },
  writeTextAtomic: async (p, text) => { hit(); writes++; if (failWrite) throw new Error('file busy after commit'); files.set(p, text); },
  appendText: async () => {},
  stat: async () => null,
  exists: async () => false,
  folderSize: async () => { hit(); return { bytes: 2048, entries: 1, truncated: false }; },
  runPS: async () => { hit(); return '[]'; },
  openDialog: async () => { hit(); return 'C:\\fixture\\installer.exe'; },
};
let decision = mode !== 'denied';
let block = false;
const confirm = async request => {
  if (mode === 'throws') throw new Error('approval failed');
  if (mode === 'nonliteral') return { ok: true };
  if (block && request.kind === 'operation') { entered(); await new Promise(resolve => { release = resolve; }); }
  if (request.argument && typeof request.argument === 'object') request.argument.textScale = 99;
  return decision;
};
if (mode === 'example') {
  const { inspectPrograms } = await import('./node_modules/purgeon-core/examples/inspect.mjs');
  const result = await inspectPrograms(host, confirm);
  assert.deepEqual(result.programs, []);
  assert.equal(result.dataRoot, 'C:\\fixture\\programs');
} else if (mode === 'app-owned') {
  const privateSys = await import('./node_modules/purgeon-core/src/internal/sys.js');
  privateSys.setSys(host); privateSys.setSys(host);
  const { initBackend } = await import('./node_modules/purgeon-core/src/internal/api.js');
  await initBackend();
  assert.throws(() => runtime.registerRuntime({ host, confirm }), /already owned/);
} else {
  runtime.registerRuntime({ host, ...(mode === 'missing' ? {} : { confirm }) });
  assert.equal(calls, 0, 'registration has no host effects');
  host.info.dataDir = 'C:\\changed-after-registration';
  await assert.rejects(modules['./settings'].get(), /not ready/);
  assert.throws(() => runtime.registerRuntime({ host, confirm }), /already registered/);
  const privateSys = await import('./node_modules/purgeon-core/src/internal/sys.js');
  assert.throws(() => privateSys.setSys(host), /already owned/);
  const init = runtime.initializeRuntime();
  assert.equal(init, runtime.initializeRuntime());
  if (mode === 'failed') {
    await assert.rejects(init, /init failed/);
    const count = calls;
    await assert.rejects(runtime.initializeRuntime(), /init failed/);
    assert.equal(calls, count);
    assert.equal(runtime.runtimeState(), 'failed');
  } else {
    await init;
    assert.equal(await modules['./i18n'].current(), 'en');
    const count = writes;
    const hostCalls = calls;
    if (['missing', 'denied', 'throws', 'nonliteral'].includes(mode)) {
      await assert.rejects(modules['./settings'].set({ textScale: 2 }), /Explicit approval|approval failed/);
      await assert.rejects(modules['./monitor'].pickInstaller(), /Explicit approval|approval failed/);
      assert.equal(writes, count);
      assert.equal(calls, hostCalls, 'failed approval reaches no host method');
    } else {
      const measurement = modules['./measure'];
      assert.throws(() => measurement.onMeasured(null), /listener must be a function/);
      const results = [];
      const stopMutating = measurement.onMeasured(result => { result.sizeKB = 99; });
      const unsubscribe = measurement.onMeasured(result => results.push(result));
      await measurement.measureStore([{ key: 'fixture', location: 'C:\\fixture\\app' }]);
      assert.deepEqual(results, [{ key: 'fixture', folder: 'C:\\fixture\\app', sizeKB: 2, sizeMeasured: true, sizeTruncated: false }]);
      unsubscribe(); stopMutating();
      await measurement.measureStore([{ key: 'later', location: 'C:\\fixture\\app' }]);
      assert.equal(results.length, 1, 'unsubscribe stops measurement delivery');
      const before = new Promise(resolve => { entered = resolve; });
      block = true;
      const argument = { textScale: 2 };
      const first = modules['./settings'].set(argument);
      argument.textScale = 3;
      await before;
      await assert.rejects(modules['./groups'].set({ keys: [], group: 'x' }), /Another operation/);
      release(); block = false;
      assert.equal((await first).textScale, 2, 'caller and confirmation cannot tamper with admitted arguments');
      assert.ok(files.has('C:\\fixture\\settings.json'), 'registered data identity is copied');
      assert.equal((await modules['./settings'].get()).textScale, 2);
      assert.equal(await modules['./monitor'].pickInstaller(), 'C:\\fixture\\installer.exe');
      await modules['./groups'].set({ keys: ['fixture'], group: 'test' });
      assert.equal((await modules['./groups'].get()).fixture, 'test');
      failWrite = true;
      const attempts = writes;
      await assert.rejects(modules['./settings'].set({ textScale: 4 }), /file busy/);
      assert.equal(writes, attempts + 1, 'mutation never retries');
      failWrite = false;
      await assert.rejects(modules['./settings'].set({ bad: () => {} }), /plain data/);
      decision = false;
      await assert.rejects(modules['./settings'].set({ textScale: 4 }), /Explicit approval/);
    }
  }
}
console.log(`${mode}: ${operations} guarded named operations, pure imports and runtime checks passed`);
