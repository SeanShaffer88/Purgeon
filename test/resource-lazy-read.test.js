import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLazyModule } from '../src/backend/lazy-module.js';
import { createReadContext, forEachRead } from '../src/backend/read-context.js';
import { setSys } from '../src/backend/sys.js';
import * as insights from '../src/backend/insights.js';

test('lazy roots configure without import; concurrent gets initialize once; same root is idempotent',async()=>{
  let imports=0;const roots=[];const mod={setRoot:async(root)=>{roots.push(root);}};
  const loader=createLazyModule(async()=>{imports++;return mod;});
  assert.equal(await loader.get(),mod);assert.deepEqual(roots,[],'pre-init get remains uncached module behavior');
  loader.configureRoot('A');assert.equal(imports,1);
  await Promise.all([loader.get(),loader.get()]);loader.configureRoot('A');await loader.get();
  assert.deepEqual(roots,['A']);assert.equal(imports,1);
  const cold=createLazyModule(async()=>{throw Error('must stay cold');});cold.configureRoot('A');
});
test('lazy import and initialization failures retry, and changing root waits for newest initialization',async()=>{
  let imports=0,failRoot=true;const roots=[];let release;
  const loader=createLazyModule(async()=>{if(++imports===1)throw Error('import');return {setRoot:async(root)=>{roots.push(root);if(failRoot){failRoot=false;throw Error('root');}if(root==='A')await new Promise(resolve=>{release=resolve;});}};});
  loader.configureRoot('A');await assert.rejects(loader.get(),/import/);await assert.rejects(loader.get(),/root/);
  const first=loader.get();await new Promise(setImmediate);loader.configureRoot('B');const second=loader.get();release();await Promise.all([first,second]);
  assert.deepEqual(roots,['A','A','B']);assert.equal(imports,2);
});
test('read context shares normalized stamps only within request, and workers cap active stat calls at six',async()=>{
  let active=0,max=0,calls=0;
  setSys({stat:async()=>{calls++;max=Math.max(max,++active);await new Promise(setImmediate);active--;return {modified:1,size:2};}});
  const context=createReadContext();
  await Promise.all([context.stampFor('C:\\A'),context.stampFor('c:\\a')]);assert.equal(calls,1);
  await forEachRead(Array.from({length:40},(_,i)=>`C:\\${i}`),path=>context.stampFor(path));assert.equal(max,6);
  await createReadContext().stampFor('C:\\A');assert.equal(calls,42,'new request rechecks rather than using stale global stamp');
});
test('one program-insights request shares signature/architecture stamps and later request rechecks',async()=>{
  const reads=[];const files=new Map();
  setSys({makeDir:async()=>{},readText:async(p)=>files.get(p)||'{}',writeTextAtomic:async(p,s)=>files.set(p,s),stat:async(p)=>{reads.push(p);return {modified:1,size:2};},runPS:async(_s,input)=>JSON.stringify(JSON.parse(input).map(path=>({path,status:'Valid',signer:'Fixture'}))),exeArch:async(paths)=>paths.map(()=> 'x64'),uninstallKeyTimes:async()=>({})});
  await insights.setRoot('C:\\ReadFixture');
  const rows=[{key:'one',name:'App',publisher:'Fixture',icon:'C:\\App\\main.exe',sizeKB:1}];
  await insights.programInsights(rows);assert.equal(reads.length,1);
  await insights.programInsights(rows);assert.equal(reads.length,2);
});

test('failed architecture batches leave no cached unknown and retry with the same file stamp', async () => {
  const files = new Map(), batches = [], logs = [];
  const exe = 'C:\\ArchRetry\\main.exe';
  const missing = 'C:\\ArchRetry\\other.exe';
  const rows = [
    { key: 'arch-a', name: 'Architecture A', icon: exe },
    { key: 'arch-b', name: 'Architecture B', icon: missing },
  ];
  const { setRoot: setLogRoot, flushNow } = await import('../src/backend/log.js');
  setSys({
    makeDir: async () => {},
    readDir: async () => [],
    readText: async (file) => files.get(file) || '{}',
    writeTextAtomic: async (file, value) => files.set(file, value),
    appendText: async (_file, value) => logs.push(value),
    stat: async () => ({ modified: 1, size: 2 }),
    runPS: async () => '[]',
    exeArch: async (paths) => {
      batches.push(paths);
      if (batches.length === 1) throw Error('fixture private path C:\\private\\payload.exe');
      if (batches.length === 2) return ['x64'];
      return paths.map((file) => file === exe ? 'x64' : '');
    },
  });
  await setLogRoot('C:\\ArchitectureLog');
  await insights.setRoot('C:\\ArchitectureCache');
  const first = await insights.programInsights(rows);
  assert.equal(first['arch-a']?.arch, undefined);
  const second = await insights.programInsights(rows);
  assert.equal(second['arch-a']?.arch, undefined);
  const third = await insights.programInsights(rows);
  assert.equal(third['arch-a']?.arch, 'x64');
  assert.equal(third['arch-b']?.arch, undefined);
  await insights.programInsights(rows);
  assert.equal(batches.length, 3);
  for (const batch of batches) assert.deepEqual(new Set(batch), new Set([exe, missing]));
  await flushNow();
  assert.equal(logs.join('').match(/PE architecture worker unavailable/g)?.length, 2);
  assert.doesNotMatch(logs.join(''), /private|payload\.exe/);
});

test('Explore reports a redacted architecture worker failure and can retry', async () => {
  const logs = [];
  let calls = 0;
  const exe = 'C:\\ArchExplore\\main.exe';
  const { setRoot: setLogRoot, flushNow } = await import('../src/backend/log.js');
  const { analyze } = await import('../src/backend/explore.js');
  setSys({
    info: { env: {} },
    makeDir: async () => {},
    readDir: async () => [],
    stat: async () => null,
    appendText: async (_file, value) => logs.push(value),
    runPS: async () => '[]',
    exeArch: async (paths) => {
      assert.deepEqual(paths, [exe]);
      if (++calls === 1) throw Error('private fixture path C:\\secret.exe');
      return ['arm64'];
    },
  });
  await setLogRoot('C:\\ArchitectureLog');
  const row = { key: 'explore-arch', name: 'Fixture', icon: exe };
  assert.equal((await analyze(row)).arch, '');
  assert.equal((await analyze(row)).arch, 'arm64');
  assert.equal((await analyze({ name: 'Missing executable' })).arch, '');
  assert.equal(calls, 2);
  await flushNow();
  assert.equal(logs.join('').match(/PE architecture worker unavailable/g)?.length, 1);
  assert.doesNotMatch(logs.join(''), /private|secret\.exe/);
});
