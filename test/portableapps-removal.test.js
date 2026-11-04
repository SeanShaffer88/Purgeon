import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api, initBackend } from '../src/backend/api.js';
import { setSys } from '../src/backend/sys.js';
import * as log from '../src/backend/log.js';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('removed generator API channels reject before any system access', async () => {
  setSys({ info: { env: {} }, makeDir: async () => assert.fail('unexpected state creation') });
  for (const channel of ['portableapps:list', 'portableapps:generate']) {
    await assert.rejects(api.invoke(channel, { outputDir: 'C:\\LegacyPackages' }), /Unknown request/);
  }
});

test('backend initialization leaves legacy packages and archive references untouched and creates no generator directory', async () => {
  const legacy = new Map([
    ['C:\\FixtureState\\portableapps\\legacy.json', '{"packageDir":"D:\\LegacyPackages"}'],
    ['C:\\FixtureState\\archive\\entries.json', '[{"package":"D:\\LegacyPackages\\App.paf.exe"}]'],
    ['D:\\LegacyPackages\\App.paf.exe', 'inert package fixture'],
  ]);
  const original = [...legacy], dirs = [], reads = [];
  setSys({ info: { env: {}, dataDir: 'C:\\FixtureState', exe: 'C:\\Fixture\\Purgeon.exe' },
    makeDir: async p => dirs.push(p), readDir: async () => [],
    readOptionalText: async p => { reads.push(p); return legacy.get(p) ?? null; },
    readText: async p => { reads.push(p); if (!legacy.has(p)) throw Error('not found'); return legacy.get(p); },
    stat: async () => null, appendText: async () => {},
    writeTextAtomic: async p => assert.fail(`unexpected write ${p}`),
    removePath: async p => assert.fail(`unexpected deletion ${p}`),
  });
  // Suppress only the installer-exit polling timer in this inert initialization test.
  const interval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  try { await initBackend(); await log.flushNow(); }
  finally { globalThis.setInterval = interval; }
  assert.ok(dirs.includes('C:\\FixtureState\\monitor\\programs'));
  assert.ok(dirs.every(p => !/portableapps/i.test(p)));
  assert.ok(reads.every(p => !/portableapps|LegacyPackages|archive/i.test(p)));
  assert.deepEqual([...legacy], original);
});

test('UI/help have no generator entry points and generic portable API remains wired', () => {
  for (const p of ['src/App.jsx', 'src/more.jsx', 'src/tips.js', 'src/cli.js', 'src/cli-help.json', 'src/backend/api.js']) {
    assert.doesNotMatch(read(p), /portableapps:|\/portableapps\.js|'portableapps'|PortableAppsDialog|MakePortable|makePortable|paf\.exe|makensis/i, p);
  }
  assert.equal(fs.existsSync(new URL('../src/backend/portableapps.js', import.meta.url)), false);
  const source = read('src/backend/api.js');
  for (const op of ['find', 'addFolder', 'removeFolder', 'checkUpdates', 'register', 'unregister']) assert.ok(source.includes(`'portable:${op}'`));
  const classifier = read('src/backend/portable-classification.js');
  assert.deepEqual([...classifier.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]), ['./winpath.js']);
});

test('generic portable discovery still uses remembered folders without generating packages', async () => {
  const root = 'D:\\CustomApps', walks = [];
  let settings = JSON.stringify({ portableFolders: [root], retainedLegacyPackage: 'D:\\Packages\\App.paf.exe' });
  setSys({ info: { env: {}, home: 'C:\\FixtureHome', dataDir: 'C:\\PortableFixture' },
    readOptionalText: async () => settings, stat: async () => ({ size: 100 }),
    writeTextAtomic: async (_p, value) => { settings = value; },
    readDir: async p => p === root ? [{ name: 'Editor', dir: true }] : [],
    walk: async roots => { walks.push(...roots); return [`F${roots[0]}\\app.exe`]; },
    runPS: async () => '[]',
  });
  assert.deepEqual(await api.invoke('portable:addFolder', 'E:\\MoreApps'), [root, 'E:\\MoreApps']);
  assert.deepEqual(await api.invoke('portable:removeFolder', 'e:\\moreapps'), [root]);
  const result = await api.invoke('portable:find');
  assert.deepEqual(result.folders, [root]);
  assert.ok(result.apps.some(app => app.folder === root));
  assert.ok(result.apps.some(app => app.folder === `${root}\\Editor`));
  assert.ok(walks.includes(root));
  assert.equal(JSON.parse(settings).retainedLegacyPackage, 'D:\\Packages\\App.paf.exe');
  await assert.rejects(api.invoke('portable:register', { folder: 'C:\\Windows\\System32', name: 'Fixture' }), /cannot be registered/);
  await assert.rejects(api.invoke('portable:unregister', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RealApp'), /Not a portable-app entry/);
});
