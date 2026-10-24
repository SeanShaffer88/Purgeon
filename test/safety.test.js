// Safety tests for the logic that decides what gets deleted or changed.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as winpath from '../src/backend/winpath.js';
import { nameKey, nameMatches, publisherKey, under, scanFiles, scoreFor, merge, AUTO_TICK } from '../src/backend/leftovers.js';
import { isProtected, GENERIC } from '../src/backend/paths.js';
import { collapse } from '../src/backend/monitor.js';
import { TWEAKS, needsAdmin } from '../src/backend/debloat.js';
import { explain } from '../src/backend/restore.js';
import { iconPathFor, formatDate } from '../src/backend/programs.js';
import { programFolder, folderSize } from '../src/backend/measure.js';
import { approvedEnabled } from '../src/backend/startup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeSys = createNodeSys();
setSys(nodeSys);
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

test('scanFiles finds program folders and never offers protected or generic ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  const env = { ...process.env };
  for (const [k, v] of Object.entries({ ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', ProgramData: 'pd', APPDATA: 'roaming', LOCALAPPDATA: 'local' })) {
    env[k] = path.join(root, v);
    fs.mkdirSync(env[k], { recursive: true });
  }
  setSys({ ...nodeSys, info: { ...nodeSys.info, env } });
  t.after(() => {
    setSys(nodeSys);
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

  const items = await scanFiles({ name: 'Foo Editor 2.1 (x64)', publisher: 'Acme Inc.', location: path.join(root, 'pf', 'Foo Editor') }, async () => new Map());
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

test('programFolder never measures protected, cache or unrelated folders', async () => {
  const win = process.env.SystemRoot || 'C:\\Windows';
  assert.equal(await programFolder({ location: win }), null);
  assert.equal(await programFolder({ location: 'C:' }), null);
  assert.equal(await programFolder({ location: '', icon: `${win}\\Installer\\{GUID}\\app.ico` }), null);
  assert.equal(await programFolder({ location: '', icon: `${process.env.ProgramFiles}\\NVIDIA Corporation\\Installer2\\x\\app.exe` }), null);
  assert.equal(await programFolder({ location: '', icon: `${process.env.ProgramData}\\Package Cache\\{GUID}\\setup.exe` }), null);
});


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


test('StartupApproved flags are read like Task Manager', () => {
  assert.equal(approvedEnabled(''), true, 'no flag means enabled');
  assert.equal(approvedEnabled('020000000000000000000000'), true);
  assert.equal(approvedEnabled('060000000000000000000000'), true);
  assert.equal(approvedEnabled('030000000000000000000000'), false);
  assert.equal(approvedEnabled('07000000a1b2c3d4e5f60708'), false);
});

test('PowerShell snippets never use the automatic $args variable', () => {
  // `$args`/`@args` silently splat an empty list in a script block: a restore once ran
  // New-NetFirewallRule with no settings and still reported success.
  const dir = path.join(here, '..', 'src', 'backend');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/[@$]args\b/.test(src), `${f} uses $args/@args inside PowerShell`);
  }
});

test('winpath joins and resolves Windows paths like Node does', () => {
  for (const [parts, want] of [
    [['C:\\Program Files', 'Foo'], 'C:\\Program Files\\Foo'],
    [['C:\\Users\\x\\AppData\\Local', '..', 'LocalLow'], 'C:\\Users\\x\\AppData\\LocalLow'],
    [['C:\\A\\', '\\B\\', 'c.txt'], 'C:\\A\\B\\c.txt'],
    [['C:\\A', '.', 'B'], 'C:\\A\\B'],
  ]) assert.equal(winpath.join(...parts), want);
  assert.equal(winpath.resolve('C:\\Program Files\\Foo\\..\\..\\Windows'), 'C:\\Windows', '.. is resolved before the protected-folder check');
  assert.equal(winpath.resolve('C:/A/b'), 'C:\\A\\b');
  assert.equal(winpath.basename('C:\\A\\Foo.lnk', '.lnk'), 'Foo');
  assert.equal(winpath.extname('C:\\A\\Foo.Setup.exe'), '.exe');
  assert.equal(winpath.dirname('C:\\A\\b.exe'), 'C:\\A');
  assert.equal(winpath.dirname('C:\\b.exe'), 'C:\\');
  assert.ok(isProtected('C:\\Program Files\\Foo\\..\\..\\Windows'), 'a path climbing into Windows is protected');
});
import { isProtectedKey } from '../src/backend/paths.js';

test('isProtectedKey refuses Windows-critical keys and allows program leftovers', () => {
  for (const k of [
    'HKEY_LOCAL_MACHINE', 'HKLM\\SOFTWARE', 'HKEY_CURRENT_USER\\Software', 'HKLM\\SOFTWARE\\WOW6432Node',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Foo', 'HKLM\\SAM', 'HKLM\\SOFTWARE\\Microsoft',
    'HKLM\\SOFTWARE\\Microsoft\\Windows', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\.txt', 'HKCR\\*', 'HKCR\\CLSID', 'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell',
    'HKLM\\SOFTWARE\\Policies\\Microsoft', 'HKU\\S-1-5-21-1\\Software', 'NotAHive\\Foo', '',
  ]) assert.ok(isProtectedKey(k), `${k || '(empty)'} must be protected`);
  for (const k of [
    'HKEY_CURRENT_USER\\Software\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\Battle.net',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\obs64.exe',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Directory\\shell\\git_gui', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\obs', 'HKLM\\SOFTWARE\\Microsoft\\Teams', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection',
  ]) assert.ok(!isProtectedKey(k), `${k} should be removable`);
});

test('merge never offers protected keys or folders', () => {
  const out = merge([
    { kind: 'key', path: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', score: 100, reason: 'test' },
    { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\.txt', score: 90, reason: 'test' },
    { kind: 'dir', path: process.env.SystemRoot || 'C:\\Windows', score: 100, reason: 'test' },
    { kind: 'key', path: 'HKEY_CURRENT_USER\\Software\\OBS Studio', score: 80, reason: 'test' },
  ]);
  assert.deepEqual(out.map((i) => i.path), ['HKEY_CURRENT_USER\\Software\\OBS Studio']);
});

import { regAddArgs, revertible } from '../src/backend/snapshots.js';

test('snapshot data converts to exact reg.exe arguments', () => {
  assert.deepEqual(regAddArgs('HKCU\\Software\\Foo', 'Path', 1, 'C:\\\\Apps\\\\Foo'), ['add', 'HKCU\\Software\\Foo', '/v', 'Path', '/t', 'REG_SZ', '/d', 'C:\\Apps\\Foo', '/f']);
  assert.deepEqual(regAddArgs('HKCU\\Software\\Foo', '', 1, 'x'), ['add', 'HKCU\\Software\\Foo', '/ve', '/t', 'REG_SZ', '/d', 'x', '/f'], 'default value');
  assert.deepEqual(regAddArgs('K', 'N', 4, '42').slice(4), ['/t', 'REG_DWORD', '/d', '42', '/f']);
  assert.deepEqual(regAddArgs('K', 'N', 7, 'a\\0b').slice(4), ['/t', 'REG_MULTI_SZ', '/d', 'a\\0b', '/f'], 'multi-string keeps the \\0 separator');
  assert.deepEqual(regAddArgs('K', 'N', 3, '00ff10').slice(4), ['/t', 'REG_BINARY', '/d', '00ff10', '/f']);
  assert.equal(regAddArgs('K', 'N', 3, '#0123456789abcdef'), null, 'hashed (too large) data is never written');
  assert.equal(regAddArgs('K', 'N', 9, 'ab'), null, 'unusual value types are never written');
  assert.ok(revertible(11, '18446744073709551615'));
  assert.ok(!revertible(1, null));
});

import { recordItems } from '../src/backend/monitor.js';

test('installation recordings remove what was added and put back what was changed', () => {
  const items = recordItems({
    added: [
      { kind: 'dir', path: 'C:\\Program Files\\Foo' },
      { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo' },
      { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\FooSvc' },
      { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\.foo' },
      { kind: 'value', path: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Foo' },
      { kind: 'dir', path: process.env.SystemRoot || 'C:\\Windows' },
    ],
    changed: [
      { kind: 'value', path: 'HKEY_CURRENT_USER\\Software\\Classes\\.txt', name: '', valueType: 1, before: 'txtfile', after: 'Foo.Document' },
      { kind: 'value', path: 'HKEY_CURRENT_USER\\Software\\X', name: 'Big', valueType: 3, before: '#00ff', after: '#11ff' },
      { kind: 'file', path: 'C:\\Windows\\win.ini' },
    ],
    removed: [],
  });
  const kinds = items.map((i) => `${i.kind}:${i.path}${i.name !== undefined ? `|${i.name}` : ''}`);
  assert.deepEqual(kinds, [
    'dir:C:\\Program Files\\Foo',
    'key:HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo',
    'service:FooSvc',
    'value:HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run|Foo',
    'setvalue:HKEY_CURRENT_USER\\Software\\Classes\\.txt|',
  ]);
  assert.equal(items.find((i) => i.kind === 'setvalue').data, 'txtfile', 'the file association goes back to what it was');
});

import * as junk from '../src/backend/junk.js';
import * as groups from '../src/backend/groups.js';
import * as backups from '../src/backend/backups.js';
import { runCli } from '../src/cli.js';

// Runs `fn` with some environment variables replaced (the backend reads env through setSys).
async function withEnv(vars, fn) {
  const saved = nodeSys.info.env;
  setSys({ ...nodeSys, info: { ...nodeSys.info, env: { ...saved, ...vars } } });
  try {
    return await fn();
  } finally {
    setSys({ ...nodeSys, info: { ...nodeSys.info, env: saved } });
  }
}

test('junk cleanup is limited to the contents of the known junk folders', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-junk-'));
  await withEnv({ TEMP: temp, SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => {
    assert.equal(junk.isJunkPath(path.join(temp, 'old.tmp')), true);
    assert.equal(junk.isJunkPath(path.join(temp, 'sub', 'deep.log')), true);
    assert.equal(junk.isJunkPath(temp), false, 'never the junk folder itself');
    assert.equal(junk.isJunkPath(path.join(temp, '..', 'Documents')), false, 'no climbing out with ..');
    assert.equal(junk.isJunkPath('C:\\Windows\\System32\\drivers\\etc\\hosts'), false);
    assert.equal(junk.isJunkPath('C:\\Windows\\Temp\\x.tmp'), true);
    assert.equal(junk.isJunkPath('C:\\Windows\\MEMORY.DMP'), true);
    assert.equal(junk.isJunkPath('C:\\Windows\\notepad.exe'), false);
    assert.equal(junk.isJunkPath('C:\\Users\\x\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_96.db'), true);
    assert.equal(junk.isJunkPath('relative\\path'), false);
  });
  fs.rmSync(temp, { recursive: true, force: true });
});

test('junk scan keeps recently used temp items and reports sizes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-junk-'));
  const old = path.join(temp, 'old-folder');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'a.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(temp, 'fresh.tmp'), 'x');
  const past = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(path.join(old, 'a.bin'), past, past);
  fs.utimesSync(old, past, past);
  const cats = await withEnv({ TEMP: temp, SystemRoot: path.join(temp, 'nowin'), LOCALAPPDATA: path.join(temp, 'nolocal'), ProgramData: path.join(temp, 'nodata') }, () => junk.scan());
  const t = cats.find((c) => c.id === 'usertemp');
  assert.deepEqual(t.items.map((i) => path.basename(i.path)), ['old-folder']);
  assert.equal(t.bytes, 1000);
  const items = junk.cleanupItems([t]);
  assert.deepEqual(items.map((i) => i.kind), ['junk']);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('removeItems refuses junk items outside the junk folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-bk-'));
  await backups.setRoot(root);
  const trashed = [];
  const { results, backupId } = await backups.removeItems({
    title: 'junk',
    items: [{ kind: 'junk', path: path.join(os.homedir(), 'Documents', 'important.docx') }],
    trashItem: async (p) => trashed.push(p),
  });
  assert.equal(trashed.length, 0);
  assert.equal(results[0].ok, false);
  assert.equal(backupId, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('groups can be set, cleared and put back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-groups-'));
  await groups.setRoot(dir);
  await groups.set(['A', 'B'], 'Games');
  const previous = await groups.set(['B', 'C'], 'Work');
  assert.deepEqual(previous, { B: 'Games', C: '' });
  assert.deepEqual(await groups.get(), { A: 'Games', B: 'Work', C: 'Work' });
  await groups.restore(previous);
  assert.deepEqual(await groups.get(), { A: 'Games', B: 'Games' });
  await groups.set(['A'], '');
  assert.deepEqual(groups.names(await groups.get()), ['Games']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('command line prints help and fails cleanly on bad requests', async () => {
  const out = [];
  let code = null;
  setSys({ ...nodeSys, print: async (t) => out.push(t), quit: async (c) => (code = c) });
  try {
    await runCli(['--help']);
    assert.match(out.join(''), /--snapshot/);
    assert.equal(code, 0);
    out.length = 0;
    await runCli(['--snapshot']);
    assert.match(out.join(''), /Error: Give the snapshot a name/);
    assert.equal(code, 1);
    await runCli(['--snapshot', 'x', '--preset', 'huge']);
    assert.equal(code, 1);
  } finally {
    setSys(nodeSys);
  }
});
