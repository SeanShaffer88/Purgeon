import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as monitor from '../src/backend/monitor.js';

// An in-memory Windows-shaped system layer (monitor stores use Windows paths).
function fakeSys() {
  const files = new Map();
  return {
    files,
    info: { env: {}, home: 'C:\\Users\\Test', dataDir: 'C:\\PurgeonTest', exe: 'C:\\PurgeonTest\\Purgeon.exe' },
    makeDir: async () => {},
    exists: async (p) => files.has(p),
    readText: async (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeTextAtomic: async (p, s) => { files.set(p, s); },
    removePath: async (p) => { files.delete(p); },
    readDir: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => ({ name: k.slice(dir.length + 1), file: true, dir: false })),
  };
}

test('cleanNotes keeps text and caps its length', () => {
  assert.equal(monitor.cleanNotes('hello'), 'hello');
  assert.equal(monitor.cleanNotes(null), '');
  assert.equal(monitor.cleanNotes('x'.repeat(9999)).length, 4000);
});

test('setNotes saves notes on the record and list returns them', async () => {
  const fake = fakeSys();
  setSys(fake);
  await monitor.setRoot('C:\\PurgeonTest\\monitored');
  fake.files.set('C:\\PurgeonTest\\monitored\\programs\\42.json', JSON.stringify({ id: '42', name: 'Thing', installer: 'C:\\setup.exe', items: [] }));
  const rec = await monitor.setNotes('42', 'Downloaded from the vendor site; chose the portable option.');
  assert.match(rec.notes, /portable option/);
  const listed = await monitor.list();
  assert.equal(listed.find((r) => r.id === '42').notes, rec.notes);
});

test('installerInfo always returns the source path, even with no stamp data', async () => {
  const info = await monitor.installerInfo('');
  assert.deepEqual(info, { path: '', product: '', company: '', version: '' });
});
