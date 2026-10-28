// Secure Erase: files are overwritten before they are deleted, protected
// paths are refused at collection time, and a cancel leaves the rest in
// place (a file caught mid-overwrite is reported as partially overwritten).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as erase from '../src/backend/erase.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('erase overwrites a file with the pattern before deleting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-erase-'));
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'TOP SECRET DATA');
  const seen = [];
  setSys({
    ...nodeSys,
    secureErase: async (p, passes) => {
      // Stand-in for the native command that records what the file held
      // after overwriting, then deletes it.
      const len = fs.statSync(p).size;
      fs.writeFileSync(p, Buffer.alloc(len, 0));
      seen.push({ passes, content: fs.readFileSync(p) });
      fs.unlinkSync(p);
    },
  });
  const out = await erase.erase({ files: [{ path: file, size: 15 }], pattern: 'zero', shouldStop: () => false });
  assert.equal(out.results[0].ok, true);
  assert.deepEqual(seen[0].passes, ['zero']);
  assert.ok(seen[0].content.every((b) => b === 0), 'the bytes on disk were zeros before the delete');
  assert.equal(seen[0].content.length, 15, 'the full length was overwritten');
  assert.ok(!fs.existsSync(file), 'the file is deleted after overwriting');
  assert.equal(out.cancelled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('erase stops between files when cancelled, and a native cancel marks the file partial', async () => {
  const erased = [];
  setSys({
    ...nodeSys,
    secureErase: async (p) => {
      erased.push(p);
      if (p.endsWith('b.txt')) throw new Error('cancelled');
    },
  });
  const files = [{ path: 'C:\\Temp\\a.txt' }, { path: 'C:\\Temp\\b.txt' }, { path: 'C:\\Temp\\c.txt' }];
  const out = await erase.erase({ files, pattern: 'random', shouldStop: () => false });
  assert.equal(out.cancelled, true);
  assert.deepEqual(erased, ['C:\\Temp\\a.txt', 'C:\\Temp\\b.txt'], 'nothing after the cancelled file was touched');
  assert.match(out.results[1].detail, /partially overwritten/);
  assert.match(out.results[2].detail, /Left in place/);
});

test('erase honors shouldStop before starting the next file', async () => {
  let calls = 0;
  setSys({ ...nodeSys, secureErase: async () => { calls++; } });
  const files = [{ path: 'C:\\Temp\\a.txt' }, { path: 'C:\\Temp\\b.txt' }];
  const out = await erase.erase({ files, pattern: 'zero', shouldStop: () => calls > 0 });
  assert.equal(calls, 1);
  assert.equal(out.cancelled, true);
  assert.equal(out.results[1].ok, false);
});

test('collect expands folders, skips links, and refuses protected paths', async () => {
  const stats = new Map([
    ['C:\\Temp\\Stuff', { dir: true, size: 0 }],
    ['C:\\Temp\\Stuff\\a.txt', { dir: false, size: 10 }],
    ['C:\\Temp\\Stuff\\sub', { dir: true, size: 0 }],
    ['C:\\Temp\\Stuff\\sub\\b.txt', { dir: false, size: 20 }],
  ]);
  setSys({
    ...nodeSys,
    stat: async (p) => stats.get(p) || null,
    readDir: async (p) => {
      if (p === 'C:\\Temp\\Stuff') return [{ name: 'a.txt', file: true }, { name: 'sub', dir: true }, { name: 'link.txt', file: true, link: true }];
      if (p === 'C:\\Temp\\Stuff\\sub') return [{ name: 'b.txt', file: true }];
      return [];
    },
  });
  const out = await erase.collect(['C:\\Temp\\Stuff', 'C:\\Windows\\System32\\drivers\\etc\\hosts']);
  assert.deepEqual(out.files.map((f) => f.path), ['C:\\Temp\\Stuff\\a.txt', 'C:\\Temp\\Stuff\\sub\\b.txt']);
  assert.ok(out.refused.some((r) => r.path.endsWith('link.txt') && /link/i.test(r.reason)), 'links are refused, never followed');
  assert.ok(out.refused.some((r) => r.path.includes('Windows') && /Protected/.test(r.reason)), 'protected paths are refused');
});

test('the three patterns map to the pass lists the native command expects', () => {
  assert.deepEqual(erase.PATTERNS.zero.passes, ['zero']);
  assert.deepEqual(erase.PATTERNS.random.passes, ['random']);
  assert.deepEqual(erase.PATTERNS.three.passes, ['zero', 'random', 'zero']);
});
