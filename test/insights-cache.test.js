import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as insights from '../src/backend/insights.js';
import * as programs from '../src/backend/programs.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-insights-'));

// Insights only accepts Windows-style program paths, so the two "program files"
// are fake paths whose stat answers come from the table below; everything else
// about the system layer is the real Node one.
const exeA = 'C:\\Programs\\Alpha\\alpha.exe';
const exeB = 'C:\\Programs\\Beta\\beta.exe';
const stamps = new Map([
  [exeA.toLowerCase(), { size: 100, modified: 1000 }],
  [exeB.toLowerCase(), { size: 200, modified: 2000 }],
]);

// A counting PowerShell stand-in: signature scripts get one row per requested
// path, the icon script gets one PNG row per requested file. No real PowerShell
// ever runs, so the call count is exactly what the caches are meant to save.
let psCalls = 0;
const base = createNodeSys(dir);
setSys({
  ...base,
  stat: async (p) => {
    const s = stamps.get(String(p).toLowerCase());
    return s ? { size: s.size, dir: false, created: 0, modified: s.modified } : base.stat(p);
  },
  runPS: async (script, input) => {
    psCalls++;
    const wanted = JSON.parse(input);
    if (typeof wanted[0] === 'string') return JSON.stringify(wanted.map((p) => ({ path: p, status: 'Valid', signer: 'Example Corp' })));
    return JSON.stringify(wanted.map((w) => ({ key: w.key, png: 'QUJD' })));
  },
});

test('signatures runs PowerShell once, then serves repeats from the cache', async () => {
  await insights.setRoot(path.join(dir, 'insights'));
  psCalls = 0;
  const first = await insights.signatures([exeA, exeB]);
  assert.equal(psCalls, 1);
  assert.deepEqual(first.get(exeA.toLowerCase()), { status: 'Valid', signer: 'Example Corp' });
  assert.deepEqual(first.get(exeB.toLowerCase()), { status: 'Valid', signer: 'Example Corp' });
  psCalls = 0;
  const second = await insights.signatures([exeA, exeB]);
  assert.equal(psCalls, 0);
  assert.deepEqual(second, first);
});

test('signatures re-checks only the file whose stamp changed', async () => {
  stamps.set(exeB.toLowerCase(), { size: 201, modified: 3000 });
  psCalls = 0;
  const out = await insights.signatures([exeA, exeB]);
  assert.equal(psCalls, 1);
  assert.equal(out.get(exeB.toLowerCase()).status, 'Valid');
  psCalls = 0;
  await insights.signatures([exeA, exeB]);
  assert.equal(psCalls, 0);
});

test('iconsFor extracts once per file, then serves repeats from the cache', async () => {
  await programs.setRoot(path.join(dir, 'programs'));
  const list = [
    { key: 'a', icon: exeA },
    { key: 'b', icon: exeB },
    { key: 'a2', icon: exeA },
  ];
  psCalls = 0;
  const first = await programs.iconsFor(list);
  assert.equal(psCalls, 1);
  assert.equal(first.a, 'data:image/png;base64,QUJD');
  assert.equal(first.b, 'data:image/png;base64,QUJD');
  assert.equal(first.a2, first.a); // two programs sharing one file share one extraction
  psCalls = 0;
  const second = await programs.iconsFor(list);
  assert.equal(psCalls, 0);
  assert.deepEqual(second, first);
});
