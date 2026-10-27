import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import { FileCache, stampOf } from '../src/backend/filecache.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-filecache-'));
setSys(createNodeSys(dir));

test('stampOf is a pure function of the stat modified time and size', () => {
  assert.equal(stampOf({ modified: 123, size: 45 }), '123:45');
  assert.equal(stampOf({ modified: 123, size: 45 }), stampOf({ modified: 123, size: 45 }));
  assert.equal(stampOf(null), '0:0');
  assert.equal(stampOf(undefined), '0:0');
  assert.equal(stampOf({}), '0:0');
});

test('put and hit roundtrip, keys are case-insensitive, a changed stamp misses', async () => {
  const cache = new FileCache(path.join(dir, 'cache.json'));
  await cache.init();
  const file = path.join(dir, 'some.exe');
  fs.writeFileSync(file, 'abc');
  const stamp = await cache.stampFor(file);
  assert.ok(stamp);
  assert.equal(cache.hit(file, stamp), undefined);
  cache.put(file, stamp, { status: 'Valid', signer: 'Example' });
  assert.deepEqual(cache.hit(file, stamp), { status: 'Valid', signer: 'Example' });
  assert.deepEqual(cache.hit(file.toUpperCase(), stamp), { status: 'Valid', signer: 'Example' });
  assert.equal(cache.hit(file, '999:999'), undefined);
  // The file changes: its new stamp must miss, so a stale value is never served.
  fs.writeFileSync(file, 'abcd');
  const stamp2 = await cache.stampFor(file);
  assert.notEqual(stamp2, stamp);
  assert.equal(cache.hit(file, stamp2), undefined);
});

test('saved values are loaded by a new instance over the same file', async () => {
  const file = path.join(dir, 'persist.json');
  const target = path.join(dir, 'other.exe');
  fs.writeFileSync(target, 'xyz');
  const first = new FileCache(file);
  await first.init();
  const stamp = await first.stampFor(target);
  first.put(target, stamp, 'x64');
  await first.save();
  const second = new FileCache(file);
  await second.init();
  assert.equal(second.hit(target, stamp), 'x64');
});

test('a missing cache file inits empty, and stampFor is null for a missing file', async () => {
  const cache = new FileCache(path.join(dir, 'missing-cache.json'));
  await cache.init();
  assert.equal(await cache.stampFor(path.join(dir, 'missing.exe')), null);
  assert.equal(cache.hit('C:\\anything.exe', '1:1'), undefined);
});

test('the map is capped at 4000 keys with the oldest-inserted dropped first', async () => {
  const cache = new FileCache(path.join(dir, 'capped.json'));
  await cache.init();
  for (let i = 0; i < 4005; i++) cache.put(`C:\\f${i}.exe`, '1:1', i);
  assert.equal(Object.keys(cache.map).length, 4000);
  assert.equal(cache.hit('C:\\f0.exe', '1:1'), undefined);
  assert.equal(cache.hit('C:\\f4004.exe', '1:1'), 4004);
});
