import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';
import * as settings from '../src/backend/settings.js';
import * as groups from '../src/backend/groups.js';
import * as diskusage from '../src/backend/diskusage.js';
import * as winpath from '../src/backend/winpath.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('a damaged interrupted-removal record is reported, not silently lost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  await backups.setRoot(root);
  const pending = winpath.join(root, 'pending.json'); // the path the module itself uses
  // A crash in the middle of writing the record leaves invalid JSON behind.
  fs.writeFileSync(pending, '{ "id": "x", "title": "half-writ');
  const found = await backups.interrupted();
  assert.ok(found, 'the damaged record still surfaces');
  assert.equal(found.corrupt, true);
  const out = await backups.resolveInterrupted('keep');
  assert.equal(out.corrupt, true);
  assert.equal(fs.existsSync(pending), false, 'choosing to leave things as they are clears the damaged record');
  assert.equal(await backups.interrupted(), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('two settings writes at the same time keep both changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir } });
  const slowWrite = async (p, text) => {
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(p, text);
  };
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir }, writeTextAtomic: slowWrite });
  await Promise.all([settings.writeSettings({ textScale: 1.25 }), settings.writeSettings({ reducedMotion: true })]);
  const after = JSON.parse(fs.readFileSync(settings.settingsFile(), 'utf8'));
  assert.equal(after.textScale, 1.25);
  assert.equal(after.reducedMotion, true);
  setSys(nodeSys);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a group name cannot impersonate a built-in group', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  await groups.setRoot(dir);
  await groups.set(['prog1'], '\u0001recent');
  const all = await groups.get();
  assert.ok(!all.prog1?.startsWith('\u0001'), `stored name must not start with the built-in marker, got ${JSON.stringify(all.prog1)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drives with no readable space at all are not listed', async () => {
  setSys({
    ...nodeSys,
    runPS: async () =>
      JSON.stringify([
        { root: 'C:\\', used: 171798691840, free: 85899345920 },
        { root: 'E:\\', used: 0, free: 0 },
        { root: 'F:\\', used: 0, free: 32212254720 },
      ]),
  });
  const ds = await diskusage.drives();
  assert.deepEqual(ds.map((d) => d.root), ['C:\\', 'F:\\']);
  setSys(nodeSys);
});

test('the drives script asks PowerShell for JSON, not a table', async () => {
  // Field failure (v1.0.7 on a real PC): the script lacked ConvertTo-Json, so
  // PowerShell printed a table, the JSON parse failed, and the view reported
  // "No drives found". This fake behaves like real PowerShell: JSON only
  // when the script asks for it, a formatted table otherwise.
  const scripts = [];
  setSys({
    ...nodeSys,
    runPS: async (script) => {
      scripts.push(script);
      if (!script.includes('ConvertTo-Json')) return 'Root Used         Free\n---- ----         ----\nC:\\  171798691840 85899345920';
      return JSON.stringify([{ root: 'C:\\', used: 171798691840, free: 85899345920 }]);
    },
  });
  const ds = await diskusage.drives();
  assert.deepEqual(ds.map((d) => d.root), ['C:\\']);
  assert.ok(scripts[0].includes('ConvertTo-Json'), 'the first drives script must request JSON');
  setSys(nodeSys);
});

test('no bare view-name style rule can restyle the generic row icon', async () => {
  // Regression (field report on 1.0.8): list rows without a program icon render
  // <span class="generic-icon <view>">. A bare `.timeline { padding: 6px 16px 4px }`
  // rule (the snapshot strip in the Snapshots view) also matched the Timeline
  // view's icon, stretched it to 34px wide, and covered the start of every event
  // title. The strip is now .snapshot-timeline; no bare rule named after a list
  // view may come back.
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  // Every view name, not just the list views: a custom view that later gains
  // list rows (or a renamed view) must not be able to re-create the clash.
  // The Debloat/Startup container is .tweak-list and Disk Usage's is .disk-view
  // for exactly this reason.
  for (const view of ['desktop', 'store', 'monitored', 'backups', 'snapshots', 'history', 'timeline', 'archive', 'startup', 'debloat', 'junk', 'disk']) {
    assert.ok(!new RegExp(`^\\.${view} \\{`, 'm').test(css), `bare .${view} rule would restyle generic row icons`);
  }
  const snapshots = fs.readFileSync(new URL('../src/snapshots.jsx', import.meta.url), 'utf8');
  assert.ok(snapshots.includes('className="snapshot-timeline"'), 'the snapshot strip uses its own class name');
});

test('menubar dropdowns never clip their flyout panels', async () => {
  // Regression (field report on 1.0.10): a later stylesheet rule gave
  // .context-menu.dropdown `overflow-y: auto` ("long menus scroll"), which
  // turned every menubar dropdown into a clip box — the Advanced Tools
  // flyout, positioned at the dropdown's right edge, painted behind it.
  // No dropdown rule may set overflow to anything but visible.
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const m of css.matchAll(/\.context-menu\.dropdown\s*\{([^}]*)\}/g)) {
    const overflow = /overflow(-[xy])?\s*:\s*([^;]+)/.exec(m[1]);
    assert.ok(!overflow || overflow[2].trim() === 'visible', `menubar dropdown overflow must stay visible, found: ${m[1].trim()}`);
  }
});

test('data stores write atomically: complete JSON lands and no temp file remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-atomic-'));
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir } });
  await settings.writeSettings({ textScale: 1.5 });
  const saved = JSON.parse(fs.readFileSync(settings.settingsFile(), 'utf8'));
  assert.equal(saved.textScale, 1.5);
  await groups.setRoot(dir);
  await groups.set(['C:\\Apps\\One'], 'Favourites');
  assert.equal((await groups.get())['C:\\Apps\\One'], 'Favourites');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'the temp file is renamed away, never left behind');
  setSys(nodeSys);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every data-store module writes through the atomic path', async () => {
  // The stores below hold only Purgeon state (no user-chosen export files), so a
  // plain sys.writeText in any of them is a torn-write risk sneaking back in.
  for (const name of ['settings', 'groups', 'history', 'archive', 'debloat', 'insights', 'filecache', 'monitor', 'snapshots', 'plugins', 'profiler', 'queue', 'running', 'schedule', 'startup', 'trials', 'transfer']) {
    const src = fs.readFileSync(new URL(`../src/backend/${name}.js`, import.meta.url), 'utf8');
    assert.ok(!src.includes('sys.writeText('), `${name}.js must write state via sys.writeTextAtomic`);
    assert.ok(src.includes('sys.writeTextAtomic('), `${name}.js writes state atomically`);
  }
  const backupsSrc = fs.readFileSync(new URL('../src/backend/backups.js', import.meta.url), 'utf8');
  assert.ok(backupsSrc.includes('sys.writeTextAtomic(pendingFile()'), 'the interrupted-removal record is written atomically');
  assert.ok(backupsSrc.includes('await sys.writeTextAtomic(p, toWrite)'), 'backup content files are written atomically');
});

test('a damaged settings file is quarantined and reported, never silently reset', async () => {
  const { default: datadamage } = await import('../src/backend/datadamage.js').then((m) => ({ default: m }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-damage-'));
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir } });
  const file = settings.settingsFile();
  fs.writeFileSync(file, '{ "textScale": 1.5, "reducedMotion": tr');
  fs.utimesSync(file, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const before = datadamage.list().length;
  const value = await settings.readSettings();
  assert.equal(value.textScale, 1, 'defaults are used after damage');
  const entry = datadamage.list().at(-1);
  assert.ok(datadamage.list().length > before && entry.file === 'settings.json', 'the damage is recorded for the user to be told');
  const copyText = await nodeSys.readText(winpath.join(winpath.dirname(file), entry.copy));
  assert.ok(copyText.includes('"textScale": 1.5'), 'the damaged text is kept as a copy beside the original');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'settings.json itself is valid again');
  setSys(nodeSys);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a damaged groups file is quarantined and reported the same way', async () => {
  const datadamage = await import('../src/backend/datadamage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-damage-'));
  await groups.setRoot(dir);
  // groups.js speaks Windows paths; on this machine the file lands under the
  // winpath-joined name the module itself uses — write through the module's sys.
  await groups.set(['prog1'], 'Games');
  assert.equal((await groups.get()).prog1, 'Games', 'a normal save round-trips first');
  const file2 = winpath.join(dir, 'groups.json');
  fs.writeFileSync(file2, '{ "prog1": "Gam');
  const before = datadamage.list().length;
  const all = await groups.get();
  assert.deepEqual(all, {}, 'a damaged groups file reads as an empty set');
  const entry = datadamage.list().at(-1);
  assert.ok(datadamage.list().length > before && entry.file === 'groups.json', 'the damage is recorded');
  const copyText = await nodeSys.readText(winpath.join(winpath.dirname(file2), entry.copy));
  assert.ok(copyText.includes('"prog1": "Gam'), 'the damaged text is kept as a copy beside the original');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('damaged debloat restore data is quarantined and flagged, never silently lost', async () => {
  const debloat = await import('../src/backend/debloat.js');
  const datadamage = await import('../src/backend/datadamage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-damage-'));
  setSys(nodeSys);
  await debloat.setRoot(dir);
  const file = winpath.join(dir, 'previous-values.json');
  fs.writeFileSync(file, '{ "adid": { "existed": tr');
  const before = datadamage.list().length;
  const previous = await debloat.readPrevious();
  assert.deepEqual(previous, {}, 'damaged restore data reads as none');
  assert.equal(debloat.previousDamaged(), true, 'the damage is flagged for the Debloat view warning');
  const entry = datadamage.list().at(-1);
  assert.ok(datadamage.list().length > before && entry.file === 'previous-values.json', 'the damage is recorded');
  const copyText = await nodeSys.readText(winpath.join(winpath.dirname(file), entry.copy));
  assert.ok(copyText.includes('"adid"'), 'the damaged text is kept as a copy beside the original');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'previous-values.json itself is valid again');
  fs.rmSync(dir, { recursive: true, force: true });
});
