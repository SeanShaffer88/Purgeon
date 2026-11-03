import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { FileCache } from '../src/backend/filecache.js';
import { installedTogether, programExe, programInsights } from '../src/backend/insights.js';
import * as tasks from '../src/backend/tasks.js';

test('cache cap preserves JS numeric ordering and updates do not reorder existing keys',async()=>{
  const entries=Object.fromEntries(Array.from({length:4002},(_,i)=>[String(4001-i),{stamp:'s',value:i}]));
  setSys({readText:async()=>JSON.stringify(entries)});
  const cache=await new FileCache('memory').init();
  assert.equal(cache.count,4000); assert.equal(cache.hit('0','s'),undefined);assert.equal(cache.hit('1','s'),undefined);
  cache.put('2','s','updated');cache.put('new','s','new');
  assert.equal(cache.hit('2','s'),undefined,'smallest numeric own key evicted even after update');
  assert.equal(cache.hit('new','s'),'new'); assert.equal(cache.count,4000);
});
test('put during pending save stays dirty and is persisted on next save',async()=>{
  let release; const writes=[];
  setSys({readText:async()=>'{"own":null}',writeTextAtomic:async(_p,s)=>{writes.push(s);if(writes.length===1)await new Promise(r=>{release=r;});}});
  const cache=await new FileCache('memory').init();cache.put('own','s',1);assert.equal(cache.count,1);
  const pending=cache.save(); cache.put('later','s',2);release();await pending;assert.equal(cache.dirty,true);
  await cache.save();assert.equal(cache.dirty,false);assert.equal(JSON.parse(writes[1]).later.value,2);
});
test('time window preserves reference output and mate order over adversarial deterministic corpus',()=>{
  const old=(programs,times)=>{const out=new Map();const runtime=/visual c\+\+|\.net|asp\.net|windows desktop runtime|webview2|directx|redistributable|runtime|sdk|driver|chipset/i;const timed=programs.filter(p=>!runtime.test(p.name)&&times[p.key]).map(p=>({p,t:times[p.key],pub:p.publisher.toLowerCase()}));for(const a of timed){const mates=timed.filter(b=>b!==a&&Math.abs(b.t-a.t)<=120000&&(!a.pub||!b.pub||b.pub!==a.pub));if(mates.length&&mates.length<=4)out.set(a.p.key,mates.map(m=>m.p.name));}return out;};
  for(let n=1;n<90;n++){
    const ps=Array.from({length:n},(_,i)=>({key:String(i),name:i%17===0?'Runtime':`App${i}`,publisher:i%5===0?'':`P${i%3}`}));
    const times=Object.fromEntries(ps.map((p,i)=>[p.key,i%19===0?Infinity:i%23===0?'invalid':1700000000000+((i*71+n*31)%13)*60000]));
    assert.deepEqual(installedTogether(ps,times),old(ps,times),`n=${n}`);
  }
});
test('task inventory uses one invocation and preserves unknown per-task fields and errors',async()=>{
  let calls=0;
  setSys({runPS:async()=>{calls++;return JSON.stringify({rows:[{TaskName:'B',TaskPath:'\\',State:'Ready'},{TaskName:'A',TaskPath:'\\'}],infos:[{TaskName:'B',TaskPath:'\\',LastTaskResult:0}]});}});
  const rows=await tasks.list();assert.equal(calls,1);assert.deepEqual(rows.map(r=>[r.name,r.lastResult]),[['A',null],['B',0]]);
  setSys({runPS:async()=>{throw Error('Denied');}});assert.deepEqual(await tasks.list(),[]);
});
test('executable memo coalesces pending reads and does not retain negative results',async()=>{
  let reads=0, present=false;
  setSys({readDir:async()=>{reads++;await new Promise(setImmediate);return present?[{file:true,name:'main.exe'}]:[];},stat:async()=>({size:10})});
  const p={key:'memo-fixture',location:'C:\\MemoFixture'};
  assert.deepEqual(await Promise.all([programExe(p),programExe(p)]),[null,null]);assert.equal(reads,1);
  present=true;assert.equal(await programExe(p),'C:\\MemoFixture\\main.exe');assert.equal(reads,2);
  await programExe(p);assert.equal(reads,2);
  assert.equal(await programExe({...p,location:'C:\\MemoChanged'}),'C:\\MemoChanged\\main.exe');assert.equal(reads,3);
});
test('executable memo bounds standalone entries and drops entries outside active inventory',async()=>{
  let reads=0;
  setSys({readDir:async()=>{reads++;return [{file:true,name:'main.exe'}];},stat:async()=>({size:10}),readText:async()=>'{}',writeTextAtomic:async()=>{},uninstallKeyTimes:async()=>({})});
  const p={key:'memo-cap-fixture',location:'C:\\MemoCap'};await programExe(p);
  for(let i=0;i<4001;i++)await programExe({key:`cap-${i}`,icon:`C:\\Cap\\app${i}.exe`});
  await programExe(p);assert.equal(reads,2,'oldest standalone entry was evicted');
  await programInsights([]);await programExe(p);assert.equal(reads,3,'new empty inventory drops obsolete identity');
});
