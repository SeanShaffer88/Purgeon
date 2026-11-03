import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { setSys } from '../src/backend/sys.js';
import * as transfer from '../src/backend/transfer.js';
import { addPlan, absent, identityKey } from './transfer-fixture.js';
const root='C:\\MockTransferUndo', id='123';
const key='HKEY_CURRENT_USER\\Software\\UndoFixture';
const target='C:\\Users\\UndoTester\\AppData\\Roaming\\UndoFixture\\settings.ini';
const regText=(path=key)=>`Windows Registry Editor Version 5.00\r\n\r\n[${path}]\r\n"Earlier"="saved"\r\n`;
const journal=()=>({id,complete:true,pending:[],dirs:[],files:[],keys:[],values:[],replaced:[]});
const replacementReceipt=()=>({version:1,target,sid:'S-1-5-21-1',machine:'fixture',infoName:'$Ioriginal.ini',infoSha256:'a'.repeat(64),identity:{volume:1,high:2,low:3},directory:false,digest:'b'.repeat(64)});
async function fixture(record=journal(),options={}){
  record=addPlan(record,regText);const states=new Map(record.undoPlan.items.map(i=>[identityKey(i),i.expected])), staged=new Set();
  const calls=[], reads=[], files=new Map([[`${root}\\${id}\\restore.json`,JSON.stringify(record)]]), present=new Set([...(Array.isArray(record?.dirs)?record.dirs:[]),...(Array.isArray(record?.files)?record.files:[])]);
  for(const entry of Array.isArray(record?.keys)?record.keys:[])if(typeof entry?.before==='string')files.set(`${root}\\${id}\\${entry.before}`,regText(entry.path));
  const original=files.get(`${root}\\${id}\\restore.json`);
  setSys({info:{dataDir:root,home:'C:\\Users\\UndoTester',env:{LOCALAPPDATA:'C:\\Users\\UndoTester\\AppData\\Local',SystemRoot:'C:\\Windows'}},makeDir:async()=>{},
    readText:async(path)=>{reads.push(path);if(!files.has(path))throw Error('Missing fixture');return files.get(path);},
    exists:async(path)=>present.has(path),trash:async(path)=>{calls.push(['trash',path]);if(options.trashFailure)throw Error('Recycle denied');if(!options.trashStillPresent)present.delete(path);},
    acquireTransferUndo:async()=> 'lease',releaseTransferUndo:async()=>{},observeTransferTarget:async(t)=>states.get(identityKey(t))??absent(),
    stageTransferUndo:async(_token,_id,step,t,_expected,apply)=>{if(staged.has(step))return true;if(!apply)return false;calls.push(['trash',t.path]);if(options.trashFailure)throw Error('Recycle denied');if(options.trashStillPresent)throw Error('Restored copy is still present');staged.add(step);states.set(identityKey(t),absent());return true;},
    savedTransferUndoStage:async(_t,_i,step)=>staged.has(step),validateTransferReplacement:async()=>{},transferOriginalAtTarget:async(path)=>{const i=record.undoPlan.items.find(i=>i.path===path);return states.get(identityKey(i))===i.goal;},restoreTransferReplacement:async(path)=>{calls.push(['exact',path]);const i=record.undoPlan.items.find(i=>i.path===path);states.set(identityKey(i),i.goal);return {restored:true};},
    exec:async(file,args)=>{calls.push(['exec',file,args]);const result=options.exec?options.exec(args):{ok:true,stdout:'',stderr:''};if(result.ok){const i=record.undoPlan.items.find(i=>i.path===args[1]&&(i.kind==='key'||i.name===(args.includes('/ve')?'':args[args.indexOf('/v')+1])))??record.undoPlan.items.find(i=>i.kind==='key');states.set(identityKey(i),args[0]==='delete'&&i.kind==='key'?absent():i.goal);}return result;},
    runPS:async(script,input)=>{
      if(script.includes('$inputPath')){const path=JSON.parse(input);reads.push(path);if(options.reader)return options.reader(script,input,path);if(options.exportChanged&&reads.filter(p=>p===path).length>1)return JSON.stringify({text:regText(key).replace('saved','changed')});if(!files.has(path))throw Error('Missing export');return JSON.stringify({text:files.get(path)});}
      calls.push(['recycle',JSON.parse(input)]);return JSON.stringify(Object.fromEntries(JSON.parse(input).map(p=>[p,'OK'])));
    },removePath:async()=>{throw Error('Undo must retain evidence');},writeText:async()=>{throw Error('Unexpected write');},writeTextAtomic:async(path,text)=>{files.set(path,text);}});
  await transfer.setRoot(root);return {calls,reads,files,original};
}
const noChanges=async(record,configure)=>{const f=await fixture(record);configure?.(f);await assert.rejects(transfer.undo(id));assert.deepEqual(f.calls,[]);assert.equal(f.files.get(`${root}\\${id}\\restore.json`),f.original);};

test('valid current undo preserves result shape, typed values/default name and completed file/key recovery',async()=>{
  const record={...journal(),files:[target],keys:[{path:key,before:'before-1.reg'}],values:[{path:key+'Values',name:'',old:null},...['String','ExpandString','DWord','QWord','Binary','MultiString'].map((kind,i)=>({path:key+'Values',name:`v${i}`,old:{kind,data:['text','%TEMP%','-1','18446744073709551615','00abff','one\\0two'][i]}}))]};
  const f=await fixture(record),results=await transfer.undo(123);assert.equal(results.length,9);assert.ok(results.every(r=>r.ok));
  const args=f.calls.filter(c=>c[0]==='exec').map(c=>c[2]);assert.deepEqual(args[0],['delete',key,'/f']);assert.deepEqual(args[1],['import',`${root}\\${id}\\before-1.reg`]);assert.deepEqual(args[2],['delete',key+'Values','/ve','/f']);
  assert.deepEqual(args.slice(3).map(a=>a[a.indexOf('/t')+1]),['REG_SZ','REG_EXPAND_SZ','REG_DWORD','REG_QWORD','REG_BINARY','REG_MULTI_SZ']);assert.equal(args.at(-1)[args.at(-1).indexOf('/d')+1],'one\\0two');assert.ok(JSON.parse(f.files.get(`${root}\\${id}\\restore.json`)).undoPlan.items.every(i=>i.status==='done'));
});

test('completion, identity, arrays and uncertain markers are mandatory before any action',async()=>{
  for(const mutate of [r=>delete r.id,r=>r.id='999',r=>delete r.complete,r=>r.complete=false,r=>r.complete='true',r=>r.inFlight=null,r=>r.recovery={},r=>r.pending=[{}],r=>r.pending={},...['dirs','files','keys','values'].flatMap(name=>[r=>delete r[name],r=>r[name]={}]),r=>r.replaced={},r=>r.created={},r=>r.files=Array(10001).fill(target)]){const r=journal();mutate(r);await noChanges(r);}
  for(const bad of ['0','001','1/2','1e3',0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){const f=await fixture();await assert.rejects(transfer.undo(bad));assert.deepEqual(f.calls,[]);}
});

test('late unsafe file, registry key/value and replacement targets refuse the entire journal',async()=>{
  for(const mutate of [r=>r.files.push('C:\\Windows\\System32\\bad'),r=>r.files.push('C:\\Unsafe\\..\\other'),r=>r.files.push('C:\\Unsafe\\data:stream'),r=>r.keys.push({path:'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Bad',before:null}),r=>r.values.push({path:'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Bad',name:'Start',old:null}),r=>r.values.push({path:'HKCU\\Software\\UndoFixture\\..',name:'v',old:null}),r=>r.keys.push({path:'Registry::HKCU\\Software\\UndoFixture',before:null}),r=>r.keys.push({path:'HKCU\\Software\\\\UndoFixture',before:null}),r=>r.replaced.push('C:\\NotRestored\\missing'),r=>{r.files.push('C:\\OutsideProfile\\a');r.replaced.push('C:\\OutsideProfile\\a');}]){const r={...journal(),files:[target]};mutate(r);await noChanges(r);}
});

test('before exports are basename-confined, present, bounded and entirely scoped before earlier file actions',async()=>{
  for(const before of ['..\\outside.reg','C:\\outside.reg','before-1.reg:stream','sub\\before-1.reg','before-0.reg','restore-1.reg',undefined])await noChanges({...journal(),files:[target],keys:[{path:key,before}]});
  for(const payload of [null,'wrong header',regText('HKEY_LOCAL_MACHINE\\SYSTEM\\Bad'),regText('HKEY_CURRENT_USER\\Software\\Other'),regText(key)+'\r\n[-'+key+']',regText(key)+'\0'])await noChanges({...journal(),files:[target],keys:[{path:key,before:'before-1.reg'}]},f=>{const file=`${root}\\${id}\\before-1.reg`;payload===null?f.files.delete(file):f.files.set(file,payload);});
  await noChanges({...journal(),files:[target],keys:[{path:key,before:'before-1.reg'},{path:key+'2',before:'before-2.reg'}]},f=>f.files.delete(`${root}\\${id}\\before-2.reg`));
});

test('invalid old value types/data, missing fields and duplicate targets cause zero mutations',async()=>{
  for(const old of [undefined,{},false,{kind:'Unknown',data:'x'},{kind:['String'],data:'x'},{kind:'String',data:42},{kind:'String',data:'a\0b'},{kind:'Binary',data:'a'},{kind:'Binary',data:'zz'},{kind:'DWord',data:'4294967296'},{kind:'QWord',data:'-9223372036854775809'},{kind:'DWord',data:'not numeric'}])await noChanges({...journal(),files:[target],values:[{path:key,name:'x',old}]});
  for(const name of [undefined,4,'a\0b'])await noChanges({...journal(),values:[{path:key,name,old:null}]});
  await noChanges({...journal(),dirs:[target],files:[target]});await noChanges({...journal(),keys:[{path:key,before:null},{path:'HKCU\\Software\\UndoFixture',before:null}]});await noChanges({...journal(),values:[{path:key,name:'x',old:null},{path:key,name:'X',old:null}]});
});

test('failed registry deletion cannot become synthetic success or trigger an import',async()=>{
  for(const before of [null,'before-1.reg']){const f=await fixture({...journal(),keys:[{path:key,before}]},{exec:()=>({ok:false,stderr:'Access denied'})});const results=await transfer.undo(id);assert.equal(results[0].ok,false);assert.match(results[0].detail,/^Access denied/);assert.equal(f.calls.filter(c=>c[0]==='exec').length,1);}
  const f=await fixture({...journal(),keys:[{path:key,before:'before-1.reg'}]},{exec:args=>({ok:args[0]==='delete',stderr:args[0]==='import'?'Import denied':''})});assert.match((await transfer.undo(id))[0].detail,/^Import denied/);assert.equal(f.calls.length,2);
});

test('value failures report actual error even with misleading missing text and thrown adapters',async()=>{
  for(const old of [null,{kind:'String',data:'earlier'}]){await fixture({...journal(),values:[{path:key,name:'v',old}]},{exec:()=>({ok:false,stderr:'Unable to find; Access denied'})});const [result]=await transfer.undo(id);assert.equal(result.ok,false);assert.match(result.detail,/^Unable to find; Access denied/);}
  await fixture({...journal(),values:[{path:key,name:'v',old:null}]},{exec:()=>{throw Error('Transport failed');}});assert.match((await transfer.undo(id))[0].detail,/^Transport failed/);
});

test('export content changes after preflight refuse deletion and retain saved evidence',async()=>{
  const f=await fixture({...journal(),keys:[{path:key,before:'before-1.reg'}]},{exportChanged:true});const [result]=await transfer.undo(id);assert.equal(result.ok,false);assert.match(result.detail,/changed/);assert.deepEqual(f.calls,[]);assert.equal(f.files.size,2);
});

test('export changes after key deletion stop import and accurately retain failure evidence',async()=>{
  for(const malformed of [false,true]){
    let reads=0;
    const f=await fixture({...journal(),keys:[{path:key,before:'before-1.reg'}]},{reader:()=>{reads++;return reads<3?JSON.stringify({text:regText()}):JSON.stringify(malformed?{}:{text:regText().replace('saved','changed')});}});
    const [result]=await transfer.undo(id);assert.equal(result.ok,false);assert.doesNotMatch(result.detail,/nothing was changed/);assert.equal(f.calls.length,1);assert.equal(f.calls[0][2][0],'delete');assert.equal(f.files.size,2);
  }
});

test('replacement restore only runs after the current copy is verified absent',async()=>{
  for(const options of [{trashFailure:true},{trashStillPresent:true}]){const f=await fixture({...journal(),files:[target],replaced:[target],replacementReceipts:[replacementReceipt()]},options);const results=await transfer.undo(id);assert.ok(results.every(r=>!r.ok));assert.equal(f.calls.filter(c=>c[0]==='exact').length,0);}
  const f=await fixture({...journal(),files:[target],replaced:[target],replacementReceipts:[replacementReceipt()]});assert.ok((await transfer.undo(id)).every(r=>r.ok));assert.deepEqual(f.calls.at(-1),['exact',target]);
});

test('the fixed export reader supports actual UTF-16LE BOM and UTF-8 scratch exports without registry access',async()=>{
  const scratch=fs.mkdtempSync(nodePath.join(os.tmpdir(),'purgeon-undo-export-'));
  try { for(const utf16 of [true,false]){
    const file=nodePath.join(scratch,utf16?'utf16.reg':'utf8.reg'),text=regText();fs.writeFileSync(file,utf16?Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]):text);
    await fixture({...journal(),keys:[{path:key,before:'before-1.reg'}]},{reader:(script)=>{assert.doesNotMatch(script,/reg\.exe|Import-|Remove-|New-Item/);const result=spawnSync(nodePath.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify(file),encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;}});
    assert.equal((await transfer.undo(id))[0].ok,true);
  }} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
});
test('current valid registry key names may contain colons after the anchored hive',async()=>{
  const path=key+':Profile';await fixture({...journal(),keys:[{path,before:'before-1.reg'}],values:[{path:path+'Values',name:'line\nname',old:{kind:'String',data:'saved\ntext'}}]});assert.ok((await transfer.undo(id)).every(r=>r.ok));
});
