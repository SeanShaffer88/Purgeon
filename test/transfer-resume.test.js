import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as transfer from '../src/backend/transfer.js';
import { addPlan, state, absent, identityKey } from './transfer-fixture.js';

const root = 'C:\\ResumeFixture', id = '789';
const first = 'C:\\Users\\ResumeTester\\AppData\\Roaming\\Fixture\\first.ini';
const second = first.replace('first.ini', 'second.ini');
const key = 'HKEY_CURRENT_USER\\Software\\ResumeFixture';
const text = (path) => `Windows Registry Editor Version 5.00\r\n\r\n[${path}]\r\n"Original"="saved"\r\n`;
const originalReceipt = (path = first) => ({ version: 1, target: path, sid: 'S-1-5-21-1', machine: 'fixture', infoName: '$Ioriginal.ini', infoSha256: 'a'.repeat(64), identity: { volume: 1, high: 2, low: 3 }, directory: false, digest: 'b'.repeat(64) });
const journal = (extra = {}) => addPlan({ id, complete: true, pending: [], dirs: [], files: [first, second], keys: [], values: [], replaced: [], ...extra }, text);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function fixture(saved = journal(), options = {}) {
  let disk = JSON.stringify(saved), leased = false, writes = 0;
  const pins = new Map();
  const calls = [], current = new Map(saved.undoPlan?.items.map((i) => [identityKey(i), structuredClone(i.expected)]) || []), staged = new Map();
  const exports = new Map((saved.keys || []).filter(k => k.before).map(k => [`${root}\\${id}\\${k.before}`, text(k.path)]));
  const items = saved.undoPlan?.items || [];
  const lookup = path => items.find(i => i.path === path);
  const sys = { info: { dataDir: root, home: 'C:\\Users\\ResumeTester', env: {} }, makeDir: async () => {},
    acquireTransferUndo: async () => { if (leased || options.leaseFail) throw Error('busy'); leased = true; calls.push(['lock']); return 'lease'; },
    releaseTransferUndo: async () => { leased = false; pins.clear(); calls.push(['release']); },
    pinTransferRegistryExport: async (_lease,name) => { const path=`${root}\\${id}\\${name}`; const pin={id:(pins.size+1).toString(16).padStart(32,'0'),text:exports.get(path)}; pins.set(pin.id,path); return pin; },
    importTransferRegistryExport: async (_lease,pin) => { const path=pins.get(pin); if(!path)throw Error('Missing pin');pins.delete(pin);return sys.exec('reg.exe',['import',path]); },
    readText: async () => { calls.push(['read']); return disk; },
    writeTextAtomic: async (_path, value) => { writes++; const result = options.failWrite?.(JSON.parse(value), writes); if (result === 'commit') disk = value; if (result) throw Error('checkpoint denied'); disk = value; calls.push(['save', JSON.parse(value)]); },
    observeTransferTarget: async target => structuredClone(current.get(identityKey(target)) || absent()),
    stageTransferUndo: async (_lease,_id,step,target,expected,apply) => {
      const actual = current.get(identityKey(target)) || absent(), saved = staged.get(step);
      if (!actual.exists && equal(saved, expected)) return true;
      if (!equal(actual, expected) || saved) throw Error('staging conflict');
      if (!apply) return false;
      if (options.deny?.has(target.path)) throw Error('stage denied');
      calls.push(['stage',target.path]); staged.set(step,structuredClone(expected)); current.set(identityKey(target),absent());
      if (options.stageAfter?.(target.path)) throw Error('stage response lost');
      return true;
    },
    savedTransferUndoStage: async (_lease,_id,step,_target,expected) => equal(staged.get(step),expected),
    validateTransferReplacement: async path => { calls.push(['validate',path]); if (options.missingReceipt) throw Error('original missing'); },
    transferOriginalAtTarget: async (path, receipt) => equal(current.get(identityKey(lookup(path))), { version: 1, exists: true, identity: receipt.identity, digest: receipt.digest }) || equal(current.get(identityKey(lookup(path))), { version: 1, exists: true, digest: receipt.digest, identity: receipt.identity }),
    restoreTransferReplacement: async path => { const item = lookup(path); if ((current.get(identityKey(item)) || absent()).exists) throw Error('destination conflict'); calls.push(['original',path]); current.set(identityKey(item), structuredClone(item.goal)); if (options.originalAfter) throw Error('original response lost'); return { restored: true }; },
    runPS: async (_script,input) => JSON.stringify({ text: exports.get(JSON.parse(input)) }),
    exec: async (_exe,args) => {
      const item = args[0] === 'import' ? items.find(i => i.kind === 'key') : items.find(i => i.path === args[1] && (i.kind === 'key' || i.name === (args.includes('/ve') ? '' : args[args.indexOf('/v')+1])));
      calls.push([args[0],item.path]);
      if (options.regDeny?.(args)) return { ok: false, stderr: 'registry denied' };
      current.set(identityKey(item), args[0] === 'delete' && item.kind === 'key' ? absent() : structuredClone(item.goal));
      if (options.regPartial?.(args)) { current.set(identityKey(item), state(item.kind,99)); return { ok: false, stderr: 'partial import' }; }
      if (options.regAfter?.(args)) throw Error('registry response lost');
      return { ok: true, stdout: '', stderr: '' };
    },
    trash: async () => { throw Error('Blind path deletion forbidden'); }, removePath: async () => { throw Error('Recovery data must remain'); },
  };
  setSys(sys); await transfer.setRoot(root);
  return { current, staged, calls, exports, options, sys, run: () => transfer.undo(id), disk: () => JSON.parse(disk), replaceDisk: (value) => { disk = JSON.stringify(value); }, writes: () => writes, leased: () => leased };
}
const mutations = f => f.calls.filter(c => ['stage','original','delete','add','import'].includes(c[0]));

test('retry skips a completed file even when newer user data now occupies its path', async () => {
  const deny = new Set([second]), f = await fixture(journal(), { deny });
  const partial = await f.run(); assert.equal(partial[0].ok,true); assert.equal(partial[1].ok,false);
  const changed = state('file',999); f.current.set(identityKey(f.disk().undoPlan.items[0]),changed); deny.clear();
  const result = await f.run(); assert.ok(result.every(r => r.ok && r.undoComplete));
  assert.deepEqual(f.current.get(identityKey(f.disk().undoPlan.items[0])),changed);
  assert.equal(mutations(f).filter(c => c[1] === first).length,1);
  const count = mutations(f).length; assert.ok((await f.run()).every(r => r.ok)); assert.equal(mutations(f).length,count);
});

test('conflicting file identity or contents stops before that item and every later item', async () => {
  for (const contentOnly of [false,true]) {
    const f=await fixture(); const item=f.disk().undoPlan.items[0], changed=structuredClone(item.expected); if(contentOnly)changed.digest='f'.repeat(64);else changed.identity.low++;
    f.current.set(identityKey(item),changed); const result=await f.run(); assert.ok(result.every(r=>!r.ok)); assert.deepEqual(mutations(f),[]); assert.equal(f.leased(),false);
  }
});

test('failed intent save prevents mutation, and a successful retry starts only the unfinished item', async () => {
  let fail=true; const f=await fixture(journal(),{failWrite:()=>fail?'fail':null});
  assert.ok((await f.run()).every(r=>!r.ok)); assert.deepEqual(mutations(f),[]); assert.equal(f.writes(),1);
  fail=false; assert.ok((await f.run()).every(r=>r.ok)); assert.equal(mutations(f).length,2);
});

test('crash after stage and completion checkpoint failures reconcile without replay', async () => {
  for (const committed of [false,true]) {
    let fail=true; const f=await fixture(journal(),{failWrite:(record)=>fail&&record.undoPlan.items[0].status==='done'?(committed?'commit':'fail'):null});
    const partial=await f.run(); assert.ok(partial.every(r=>!r.ok)); assert.equal(mutations(f).length,1); fail=false;
    assert.ok((await f.run()).every(r=>r.ok)); assert.equal(mutations(f).filter(c=>c[1]===first).length,1);
  }
  let lost=true; const f=await fixture(journal(),{stageAfter:()=>{const result=lost;lost=false;return result;}});
  assert.ok((await f.run()).every(r=>!r.ok)); assert.ok((await f.run()).every(r=>r.ok)); assert.equal(mutations(f).filter(c=>c[1]===first).length,1);
});

test('exact original moved before a crash is recognized without restaging or restoring it again', async () => {
  const saved=journal({files:[first],replaced:[first],replacementReceipts:[originalReceipt()]});
  const f=await fixture(saved,{originalAfter:true}); assert.equal((await f.run())[0].ok,false); assert.equal(f.disk().undoPlan.items[0].phase,'original');
  assert.equal((await f.run())[0].ok,true); assert.deepEqual(mutations(f).map(c=>c[0]),['stage','original']);
});

test('key clear/import phases resume after failure without deleting a restored key again', async () => {
  const saved=journal({files:[],keys:[{path:key,before:'before-1.reg'},{path:key+'Later',before:null}]});
  let lost=true; const f=await fixture(saved,{regAfter:args=>args[0]==='import'&&lost?(lost=false,true):false});
  const first=await f.run(); assert.ok(first.every(r=>!r.ok)); assert.equal(f.disk().undoPlan.items[0].phase,'import');
  assert.ok((await f.run()).every(r=>r.ok)); assert.equal(mutations(f).filter(c=>c[0]==='delete'&&c[1]===key).length,1); assert.equal(mutations(f).filter(c=>c[0]==='import').length,1);
});

test('partial registry import conflicts halt retries instead of deleting or blindly reimporting', async () => {
  const f=await fixture(journal({files:[],keys:[{path:key,before:'before-1.reg'}],values:[{path:key+'Other',name:'v',old:null}]}),{regPartial:args=>args[0]==='import'});
  assert.ok((await f.run()).every(r=>!r.ok)); const before=mutations(f).length; assert.ok((await f.run()).every(r=>!r.ok)); assert.equal(mutations(f).length,before);
});

test('changed raw registry data conflicts and typed value restoration is checkpointed', async () => {
  const saved=journal({files:[],values:[{path:key,name:'v',old:{kind:'String',data:'original'}}]});
  const f=await fixture(saved); f.current.set(identityKey(saved.undoPlan.items[0]),state('value',88)); assert.equal((await f.run())[0].ok,false); assert.deepEqual(mutations(f),[]);
  f.current.set(identityKey(saved.undoPlan.items[0]),saved.undoPlan.items[0].expected); assert.equal((await f.run())[0].ok,true); const count=mutations(f).length; assert.equal((await f.run())[0].ok,true); assert.equal(mutations(f).length,count);
});

test('legacy, malformed, reordered and tampered recovery evidence fail before mutation', async () => {
  for (const mutate of [r=>delete r.undoPlan,r=>r.undoPlan.version=2,r=>r.undoPlan.items.reverse(),r=>r.undoPlan.items[0].expected.digest='bad',r=>r.undoPlan.items[1].status='done']) {
    const saved=journal();mutate(saved);const f=await fixture(saved); await assert.rejects(f.run()); assert.deepEqual(mutations(f),[]); assert.equal(f.leased(),false);
  }
  const saved=journal({files:[],values:[{path:key,name:'v',old:{kind:'String',data:'original'}}]}); saved.values[0].old.data='tampered'; const f=await fixture(saved);await assert.rejects(f.run(),/evidence/);assert.deepEqual(mutations(f),[]);
  const k=await fixture(journal({files:[],keys:[{path:key,before:'before-1.reg'}]}));k.exports.set(`${root}\\${id}\\before-1.reg`,text(key).replace('saved','tampered'));await assert.rejects(k.run(),/evidence/);assert.deepEqual(mutations(k),[]);
});

test('native lock precedes reads, concurrent calls refuse, and every exception releases it', async () => {
  const f=await fixture(); let unblock; const wait=new Promise(resolve=>{unblock=resolve;}); f.sys.readText=async()=>{await wait;return JSON.stringify(f.disk());};setSys(f.sys);
  const pending=f.run(); await Promise.resolve(); await assert.rejects(f.run(),/already in use/); unblock();await pending; assert.equal(f.leased(),false);
  const busy=await fixture(journal(),{leaseFail:true});await assert.rejects(busy.run(),/busy/);assert.equal(busy.calls.some(c=>c[0]==='read'),false);
});

test('key clear, value writes and committed intent responses resume at their proven phase', async () => {
  for (const value of [false, true]) {
    const saved = value ? journal({files:[],values:[{path:key,name:'v',old:{kind:'String',data:'original'}}]}) : journal({files:[],keys:[{path:key,before:'before-1.reg'}]});
    let lost=true; const f=await fixture(saved,{regAfter:args=>(value?args[0]==='add':args[0]==='delete')&&lost?(lost=false,true):false});
    assert.equal((await f.run())[0].ok,false); assert.equal((await f.run())[0].ok,true);
    assert.equal(mutations(f).filter(c=>c[0]===(value?'add':'delete')).length,1);
  }
  let lost=true;const f=await fixture(journal(),{failWrite:record=>lost&&record.undoPlan.items[0].status==='intent'?(lost=false,'commit'):null});
  assert.ok((await f.run()).every(r=>!r.ok));assert.deepEqual(mutations(f),[]);assert.ok((await f.run()).every(r=>r.ok));
});

test('forged original phase without its exact retained stage refuses before any mutation', async () => {
  const saved=journal({files:[first],replaced:[first],replacementReceipts:[originalReceipt()]});saved.undoPlan.items[0].phase='original';
  const f=await fixture(saved);f.current.set(identityKey(saved.undoPlan.items[0]),absent());
  await assert.rejects(f.run(),/staging evidence/);assert.deepEqual(mutations(f),[]);
});

test('overlapping registry and filesystem plans are rejected before any undo operation', async () => {
  for(const saved of [journal({dirs:[first],files:[first+'\\child']}),journal({files:[],keys:[{path:key,before:null}],values:[{path:key+'\\Child',name:'v',old:null}]})]){
    const f=await fixture(saved);await assert.rejects(f.run(),/Overlapping/);assert.deepEqual(mutations(f),[]);
  }
});
