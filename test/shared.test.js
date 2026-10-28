// Shared Components shaping: runtimes by name, folders shared by several
// programs (same location, or a Common Files parent), and SharedDLLs files
// with a refcount of 2 or more — sorted runtimes, folders, then files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComponents } from '../src/backend/shared.js';

const STATE = {
  programs: [
    { key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VC', name: 'Microsoft Visual C++ 2015-2022 Redistributable', location: '' },
    { key: 'k1', name: 'Contoso Editor', location: 'C:\\Program Files\\Common Files\\Fabrikam\\Editor' },
    { key: 'k2', name: 'Fabrikam Viewer', location: 'C:\\Program Files\\Common Files\\Fabrikam\\Viewer' },
    { key: 'k3', name: 'Duo One', location: 'D:\\Apps\\Duo' },
    { key: 'k4', name: 'Duo Two', location: 'D:\\Apps\\Duo' },
    { key: 'k5', name: 'Solo App', location: 'C:\\Program Files\\Solo' },
  ],
  shared: [
    { path: 'C:\\Windows\\System32\\shared.dll', count: 5 },
    { path: 'C:\\Windows\\System32\\solo.dll', count: 1 },
    { path: 'C:\\Windows\\System32\\pair.dll', count: 2 },
  ],
};

test('buildComponents finds runtimes, shared folders and shared files', () => {
  const out = buildComponents(STATE);
  const runtime = out.find((c) => c.kind === 'runtime');
  assert.ok(runtime && /Visual C\+\+/.test(runtime.name), 'the redistributable is a shared runtime');
  const fabrikam = out.find((c) => c.kind === 'folder' && c.path.includes('Fabrikam'));
  assert.ok(fabrikam, 'the Common Files parent shared by two programs is a component');
  assert.deepEqual(fabrikam.dependents, ['Contoso Editor', 'Fabrikam Viewer']);
  const duo = out.find((c) => c.kind === 'folder' && c.path === 'D:\\Apps\\Duo');
  assert.ok(duo && duo.dependents.length === 2, 'one location used by two programs is a component');
  assert.ok(!out.some((c) => c.path === 'C:\\Program Files\\Solo'), 'a single-program folder is not shared');
  const files = out.filter((c) => c.kind === 'file');
  assert.deepEqual(files.map((f) => f.name), ['shared.dll', 'pair.dll'], 'refcount 1 files are out; the rest sort by count');
  assert.equal(files[0].tag, 'used by 5');
  assert.ok(/does not record which ones/.test(files[0].detail), 'the file detail is honest that Windows does not name the users');
});

test('buildComponents orders runtimes, then folders, then files', () => {
  const kinds = buildComponents(STATE).map((c) => c.kind);
  assert.deepEqual(kinds, ['runtime', 'folder', 'folder', 'file', 'file']);
});

test('buildComponents tolerates an empty state', () => {
  assert.deepEqual(buildComponents({ programs: [], shared: [] }), []);
  assert.deepEqual(buildComponents(null), []);
});
