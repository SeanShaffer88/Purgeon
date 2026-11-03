import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as transfer from '../src/backend/transfer.js';
import { addPlan, absent, identityKey } from './transfer-fixture.js';
const key='HKEY_CURRENT_USER\\Software\\PinnedFixture', root='C:\\PinnedFixture', id='456';
const original=`Windows Registry Editor Version 5.00\r\n\r\n[${key}]\r\n"Name"="original"\r\n`;
const changed=original.replace('original','replaced');
function fixture(options={}) {
  const record=options.record??addPlan({id,complete:true,pending:[],dirs:[],files:[],keys:[{path:key,before:'before-1.reg'}],values:[],replaced:[]},()=>original);
  let disk=JSON.stringify(record), bytes=original, imported, writes=0, nextPin=0;
  const current=new Map(record.undoPlan.items.map(item=>[identityKey(item),structuredClone(item.expected)]));
  const calls=[], pins=new Map();
  setSys({info:{dataDir:root,home:'C:\\Users\\PinnedTester',env:{}},makeDir:async()=>{},acquireTransferUndo:async()=> 'lease',releaseTransferUndo:async()=>{calls.push('release');pins.clear();},readText:async()=>disk,writeTextAtomic:async(_p,text)=>{writes++;if(options.failWrite?.(JSON.parse(text),writes))throw Error('checkpoint denied');disk=text;},observeTransferTarget:async(target)=>structuredClone(current.get(identityKey(target))??absent()),
    runPS:async()=>JSON.stringify({text:bytes}),
    pinTransferRegistryExport:async(_lease,name)=>{calls.push('pin');if(options.pinFailure)throw Error('Pin denied');const target=record.keys.find(item=>item.before===name)?.path;const pin={id:(++nextPin).toString(16).padStart(32,'0'),text:options.invalidText??(target===key?bytes:original.replace(key,target)),target};pins.set(pin.id,pin);return options.response===undefined?{id:pin.id,text:pin.text}:options.response;},
    importTransferRegistryExport:async(_lease,pin)=>{const held=pins.get(pin);if(!held)throw Error('Unknown pin');pins.delete(pin);calls.push('native-import');if(options.importFailure)throw Error('Native importer failed');if(options.replaceAtImport)bytes=changed;imported=held.text;const item=record.undoPlan.items.find(item=>item.path===held.target);current.set(identityKey(item),structuredClone(item.goal));if(options.importAfter)throw Error('Native response lost');return {ok:options.unconfirmed?false:true};},
    exec:async(_exe,args)=>{calls.push(args[0]);if(args[0]==='delete'){const item=record.undoPlan.items.find(item=>item.path===args[1]);current.set(identityKey(item),absent());}if(args[0]==='import'){bytes=changed;imported=bytes;current.set(identityKey(record.undoPlan.items[0]),structuredClone(record.undoPlan.items[0].goal));}return {ok:true,stderr:'',stdout:''};}
  });
  return {calls,run:async()=>{await transfer.setRoot(root);return transfer.undo(id);},imported:()=>imported,disk:()=>JSON.parse(disk),options,pins};
}
test('the validated recovery export survives a filename replacement at the import boundary',async()=>{
 const f=fixture({replaceAtImport:true});const rows=await f.run();assert.ok(rows.every(row=>row.ok));assert.equal(f.imported(),original);assert.ok(f.calls.includes('native-import'));assert.equal(f.calls.includes('import'),false);
});

test('pin failures and semantic or evidence changes stop full preflight before any deletion',async()=>{
 for(const options of [{pinFailure:true},{invalidText:'broken header'},{invalidText:changed}]){const f=fixture(options);await assert.rejects(f.run());assert.equal(f.calls.includes('delete'),false);assert.equal(f.calls.includes('native-import'),false);assert.equal(f.calls.at(-1),'release');assert.equal(f.pins.size,0);}
});
test('all unfinished key exports are pinned before the first key is cleared',async()=>{
 const other=key+'Other';const record=addPlan({id,complete:true,pending:[],dirs:[],files:[],keys:[{path:key,before:'before-1.reg'},{path:other,before:'before-2.reg'}],values:[],replaced:[]},path=>original.replace(key,path));const f=fixture({record});const result=await f.run();assert.ok(result.every(row=>row.ok));assert.deepEqual(f.calls.slice(0,3),['pin','pin','delete']);
});
test('checkpoint failures release pins and prevent any unrecorded mutation',async()=>{
 const f=fixture({failWrite:()=>true});const result=await f.run();assert.equal(result[0].ok,false);assert.equal(f.calls.includes('delete'),false);assert.equal(f.calls.includes('native-import'),false);assert.equal(f.pins.size,0);
});
test('native importer failure retries only the import phase with a freshly pinned export',async()=>{
 const f=fixture({importFailure:true});assert.equal((await f.run())[0].ok,false);assert.equal(f.disk().undoPlan.items[0].phase,'import');f.options.importFailure=false;assert.equal((await f.run())[0].ok,true);assert.equal(f.calls.filter(call=>call==='delete').length,1);assert.equal(f.calls.filter(call=>call==='pin').length,2);assert.equal(f.pins.size,0);
});
test('a lost import response reconciles its goal and completed retries need no export pin',async()=>{
 const f=fixture({importAfter:true});assert.equal((await f.run())[0].ok,false);f.options.importAfter=false;assert.equal((await f.run())[0].ok,true);const pins=f.calls.filter(call=>call==='pin').length;f.options.pinFailure=true;assert.equal((await f.run())[0].ok,true);assert.equal(f.calls.filter(call=>call==='pin').length,pins);assert.equal(f.calls.filter(call=>call==='native-import').length,1);
});

test('malformed native pin responses fail before any key deletion',async()=>{
 for(const response of [null,{}, {id:'',text:original},{id:'bogus',text:original},{id:'a'.repeat(33),text:original},{id:'a'.repeat(32),text:42},{id:'a'.repeat(32),text:original,extra:true},{id:'a'.repeat(32),text:'x'.repeat(8388609)}]){const f=fixture({response});await assert.rejects(f.run());assert.equal(f.calls.includes('delete'),false);assert.equal(f.calls.includes('native-import'),false);assert.equal(f.calls.at(-1),'release');}
});
