// Safety tests for the logic that decides what gets deleted or changed.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { nameKey, nameMatches, publisherKey, under, scanFiles } = require('../electron/leftovers.cjs');
const { isProtected, GENERIC } = require('../electron/paths.cjs');
const { collapse } = require('../electron/monitor.cjs');
const { TWEAKS, needsAdmin } = require('../electron/debloat.cjs');
const { explain } = require('../electron/restore.cjs');
const { iconPathFor, formatDate } = require('../electron/programs.cjs');

test('nameKey strips versions, architectures and punctuation', () => {
  assert.equal(nameKey('Foo Editor 3.2.1 (x64)'), 'fooeditor');
  assert.equal(nameKey('Notepad++ (64-bit x64)'), 'notepad');
  assert.equal(nameKey('Python 3.13.5 (64-bit)'), 'python');
  assert.equal(nameKey('7-Zip 24.08 (x64)'), '7zip');
});

test('publisherKey drops company suffixes', () => {
  assert.equal(publisherKey('Blizzard Entertainment, Inc.'), 'blizzardentertainment');
  assert.equal(publisherKey('Acme Software GmbH'), 'acme');
});

test('nameMatches accepts real matches and rejects generic or short ones', () => {
  assert.ok(nameMatches('Foo Editor', 'fooeditor'));
  assert.ok(nameMatches('FooEditor2', 'fooeditor'));
  assert.ok(nameMatches('Battle.net_components', 'battlenet'));
  assert.ok(!nameMatches('Microsoft', 'microsoftteams'), 'generic folder names never match');
  assert.ok(!nameMatches('Common Files', 'commonfilestool'));
  assert.ok(!nameMatches('Foo', 'fooeditor'), 'prefixes shorter than 5 characters do not match');
  assert.ok(!nameMatches('', 'fooeditor'));
  assert.ok(!nameMatches('Foo', ''));
  for (const g of GENERIC) assert.ok(!nameMatches(g, g), `generic name "${g}" must never match`);
});

test('isProtected guards system and root folders', () => {
  const win = process.env.SystemRoot || 'C:\\Windows';
  for (const p of ['C:\\', 'C:', win, path.join(win, 'System32'), os.homedir(), path.join(os.homedir(), 'Desktop'), process.env.ProgramFiles, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.ProgramData, '']) {
    if (p !== undefined) assert.ok(isProtected(p), `${p || '(empty)'} must be protected`);
  }
  for (const rel of ['Foo', '.\\Foo', '..', 'C:Foo', '\\Windows']) assert.ok(isProtected(rel), `relative path "${rel}" must be protected`);
  assert.ok(!isProtected(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Foo Editor')));
  assert.ok(!isProtected(path.join(process.env.APPDATA || 'C:\\Users\\x\\AppData\\Roaming', 'FooEditor')));
});

test('under compares paths case-insensitively without prefix false positives', () => {
  assert.ok(under('C:\\Program Files\\Foo\\bin\\a.exe', 'C:\\program files\\foo'));
  assert.ok(under('C:\\Program Files\\Foo', 'C:\\Program Files\\Foo\\'));
  assert.ok(!under('C:\\Program Files\\FooBar\\a.exe', 'C:\\Program Files\\Foo'));
});

test('collapse keeps only top-most added paths', () => {
  const out = collapse([
    'C:\\A\\New',
    'C:\\A\\New\\sub',
    'C:\\A\\New\\sub\\file.txt',
    'C:\\B\\file.txt',
    'HKEY_CURRENT_USER\\Software\\Foo',
    'HKEY_CURRENT_USER\\Software\\Foo\\Settings',
    'C:\\A\\NewOther',
  ]);
  assert.deepEqual(out, ['C:\\A\\New', 'C:\\A\\NewOther', 'C:\\B\\file.txt', 'HKEY_CURRENT_USER\\Software\\Foo']);
});

test('debloat tweaks are well formed and reversible', () => {
  const ids = new Set();
  for (const t of TWEAKS) {
    assert.ok(!ids.has(t.id), `duplicate tweak id ${t.id}`);
    ids.add(t.id);
    assert.ok(['immediate', 'explorer', 'reboot'].includes(t.effect), `${t.id} has a valid effect`);
    assert.ok(t.title && t.detail && t.category, `${t.id} has text`);
    assert.ok(t.values.length > 0, `${t.id} changes something`);
    for (const v of t.values) {
      assert.match(v.key, /^(HKCU|HKLM)\\/, `${t.id} writes only HKCU/HKLM`);
      assert.ok(v.on !== undefined, `${t.id} has a tweak value`);
      assert.ok(v.off !== undefined || v.deleteKeyOnRevert, `${t.id} can be reverted`);
      assert.notEqual(String(v.on), String(v.off), `${t.id} tweak and default differ`);
      if (v.deleteKeyOnRevert) assert.ok(under(v.key, v.deleteKeyOnRevert), `${t.id} only deletes its own key`);
    }
    if (t.values.some((v) => v.key.startsWith('HKLM\\'))) assert.ok(needsAdmin(t), `${t.id} is marked admin`);
  }
});

test('restore point skip reasons are explained', () => {
  assert.match(explain('A new system restore point cannot be created because one has already been created within the past 1440 minutes.'), /24 hours/);
  assert.match(explain('The service cannot be started, either because it is disabled'), /System Protection/);
  assert.match(explain(''), /did not create/);
});

test('icon paths and dates are parsed from registry strings', () => {
  assert.equal(iconPathFor({ icon: '"C:\\Apps\\Foo\\foo.exe",0' }), 'C:\\Apps\\Foo\\foo.exe');
  assert.equal(iconPathFor({ icon: '', uninstall: '"C:\\Apps\\Foo\\unins000.exe" /SILENT' }), 'C:\\Apps\\Foo\\unins000.exe');
  assert.equal(iconPathFor({ icon: '', uninstall: 'MsiExec.exe /X{1234}' }), null);
  assert.equal(formatDate('20260314'), '2026-03-14');
  assert.equal(formatDate(''), '');
});

test('scanFiles finds program folders and never offers protected or generic ones', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  const saved = {};
  const env = { ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', ProgramData: 'pd', APPDATA: 'roaming', LOCALAPPDATA: 'local' };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = path.join(root, v);
    fs.mkdirSync(process.env[k], { recursive: true });
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const mk = (...p) => fs.mkdirSync(path.join(root, ...p), { recursive: true });
  mk('pf', 'Foo Editor', 'bin');
  mk('pf', 'Acme', 'FooEditor');
  mk('pf', 'Microsoft', 'Foo Editor Helper');
  mk('roaming', 'FooEditor');
  mk('local', 'Unrelated App');
  mk('pf', 'Acme Studio Pro', 'FooEditor'); // another Acme product: not the publisher's folder
  const startMenu = path.join('roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  mk(startMenu, 'Foo Editor');
  mk(startMenu, 'Acme Studio Pro');

  const items = scanFiles({ name: 'Foo Editor 2.1 (x64)', publisher: 'Acme Inc.', location: path.join(root, 'pf', 'Foo Editor') }, () => ({}));
  const paths = items.map((i) => path.relative(root, i.path));
  assert.ok(paths.includes(path.join('pf', 'Foo Editor')), 'install folder');
  assert.ok(paths.includes(path.join('pf', 'Acme', 'FooEditor')), 'folder under publisher');
  assert.ok(paths.includes(path.join('roaming', 'FooEditor')), 'AppData folder');
  const pub = items.find((i) => i.path.endsWith(path.join('pf', 'Acme')));
  assert.equal(pub.confidence, 'low', 'publisher folder is only a low-confidence guess');
  assert.equal(items.find((i) => i.path.endsWith(path.join('Acme', 'FooEditor'))).confidence, 'high', 'the guess does not hide the program folder inside it');
  assert.ok(!paths.some((p) => p.startsWith(path.join('pf', 'Microsoft'))), 'generic publisher folders are not entered');
  assert.ok(!paths.some((p) => p.includes('Unrelated')), 'unrelated folders are not offered');
  assert.ok(!paths.some((p) => p.includes('Acme Studio Pro')), "another product of the same publisher is not offered (Chrome vs Google Play Games)");
  assert.ok(paths.includes(path.join(startMenu, 'Foo Editor')), 'Start Menu folder of the program');
  assert.ok(items.every((i) => !isProtected(i.path)), 'nothing protected is offered');
  assert.equal(new Set(items.map((i) => i.path.toLowerCase())).size, items.length, 'no duplicates');
});

const { programFolder, folderSize } = require('../electron/measure.cjs');

test('folderSize adds file sizes and respects its budget', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(root, 'a', 'b', 'two.bin'), Buffer.alloc(2500));
  const r = await folderSize(root);
  assert.equal(r.bytes, 3500);
  assert.equal(r.truncated, false);
  const limited = await folderSize(root, { maxEntries: 0 });
  assert.equal(limited.truncated, true);
});

test('programFolder never measures protected, cache or unrelated folders', () => {
  const win = process.env.SystemRoot || 'C:\\Windows';
  assert.equal(programFolder({ location: win }), null);
  assert.equal(programFolder({ location: 'C:' }), null);
  assert.equal(programFolder({ location: '', icon: `${win}\\Installer\\{GUID}\\app.ico` }), null);
  assert.equal(programFolder({ location: '', icon: `${process.env.ProgramFiles}\\NVIDIA Corporation\\Installer2\\x\\app.exe` }), null);
  assert.equal(programFolder({ location: '', icon: `${process.env.ProgramData}\\Package Cache\\{GUID}\\setup.exe` }), null);
});

const { scoreFor, merge, AUTO_TICK } = require('../electron/leftovers.cjs');

test('merge scores items, keeps the strongest duplicate and ticks only confident ones', () => {
  const out = merge([
    { kind: 'dir', path: 'C:\\P\\Foo', confidence: 'high', reason: 'Folder named after program' },
    { kind: 'dir', path: 'c:\\p\\foo', score: 100, reason: 'Install location' },
    { kind: 'file', path: 'C:\\D\\Foo.lnk', confidence: 'low', reason: 'Shortcut named after program' },
    { kind: 'task', path: '\\FooUpdate', score: 60, reason: 'Scheduled task named after program' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out.find((i) => i.kind === 'dir').score, 100);
  for (const i of out) assert.equal(i.confidence, i.score >= AUTO_TICK ? 'high' : 'low');
  assert.equal(out.find((i) => i.kind === 'task').confidence, 'low', 'name-only task matches are not ticked');
  assert.ok(scoreFor({ reason: 'Publisher folder (would be empty)' }) < AUTO_TICK, 'publisher guesses are never ticked');
});
