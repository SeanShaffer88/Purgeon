import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys, sys } from '../src/backend/sys.js';
import * as settings from '../src/backend/settings.js';
import * as queue from '../src/backend/queue.js';
import * as trials from '../src/backend/trials.js';
import * as snapshots from '../src/backend/snapshots.js';
let sequence=0;
const queueRecord=()=>({created:'legacy date',programs:[{key:'old',name:'Old',status:'legacy-complete',custom:{retained:true}}],leftovers:[{kind:'file',path:'C:\\Fixture\\leftover',extra:1}],unknown:{keep:true}});
const trialRecord=()=>[{id:'legacy-id',snapshotId:'123',name:'Old',installer:null,started:'legacy date',unknown:{keep:true}}];
async function fixture(options={}){
  const root=`C:\\StateReadFixture${++sequence}`, paths={settings:root+'\\settings.json',queue:root+'\\queue\\queue.json',trials:root+'\\trials\\trials.json'},files=new Map(),calls=[],reads=[];let stamp=100;
  for(const key of ['settings','queue','trials'])if(Object.hasOwn(options,key))files.set(paths[key],typeof options[key]==='string'?options[key]:JSON.stringify(options[key]));
  const control={...options};
  setSys({info:{dataDir:root,home:'C:\\Users\\Fixture',env:{}},makeDir:async()=>{},stat:async(path)=>{if(control.statError)throw Error('Metadata unavailable');if(control.statInvalid)return {modified:{invalid:true}};if(control.statNull)return null;return files.has(path)?{modified:stamp}:null;},
    readText:async()=>{throw Error('Nonoptional data read is forbidden');},
    readOptionalText:async(path)=>{reads.push(path);if(control.readError&&Object.values(paths).includes(path))throw Error(control.readError);if(path.includes('.damaged-')){if(control.copyReadError)throw Error('Copy read denied');if(control.copyMismatch)return 'different preserved bytes';}if(control.badOptional&&Object.values(paths).includes(path))return undefined;return files.get(path)??null;},
    writeText:async(path,text)=>{calls.push(['copy',path,text]);if(control.copyFailure)throw Error('Copy write denied');files.set(path,text);},
    writeTextAtomic:async(path,text)=>{calls.push(['write',path,text]);if(control.writeFailure===path||control.writeFailure===true)throw Error('Atomic save denied');files.set(path,text);stamp++;},
    secretSet:async(value)=>{calls.push(['secret',value]);if(control.secretFailure)throw Error('Vault denied');},
    removePath:async(path)=>{calls.push(['remove',path]);files.delete(path);},
    exec:async(file,args)=>{calls.push(['exec',file,args]);return {ok:true,stdout:'',stderr:''};},
    takeSnapshot:async(...args)=>{calls.push(['snapshot',...args]);if(control.snapshotError)throw Error('Capture failed');return control.snapshotCancel?{cancelled:true}:{files:0,values:0};},
    exists:async()=>true,trash:async(path)=>{calls.push(['trash',path]);if(control.trashFailure)throw Error('Snapshot cleanup denied');},
    compareSnapshots:async()=>{calls.push(['compare']);return {};},
  });
  await queue.setRoot(root+'\\queue');await trials.setRoot(root+'\\trials');await snapshots.setRoot(root+'\\snapshots');
  return {root,paths,files,calls,reads,control};
}
const writes=(f,path)=>f.calls.filter(call=>call[0]==='write'&&(!path||call[1]===path));
const assertUnchanged=(f,before)=>{assert.deepEqual([...f.files],before);assert.deepEqual(f.calls,[]);};

test('true missing files allow first-run defaults, new queue and new trials',async()=>{
  const f=await fixture();assert.equal((await settings.readSettings()).gridLines,true);assert.equal(await queue.get(),null);assert.deepEqual(await trials.list(),[]);assert.equal(f.calls.length,0);
  await settings.writeSettings({safeMode:true});assert.equal(JSON.parse(f.files.get(f.paths.settings)).safeMode,true);
  assert.equal((await queue.add([{key:'new',name:'New'}])).programs[0].status,'pending');
  const trial=await trials.start(null,'New');assert.equal(typeof trial.snapshotId,'string');assert.equal(JSON.parse(f.files.get(f.paths.trials))[0].id,trial.id);
});

test('settings I/O and invalid adapter reads fail without defaults, quarantine, secrets or writes',async()=>{
  for(const readError of ['ACCESS_DENIED','EPERM','EIO','Invalid UTF-8','Sharing violation']){
    const f=await fixture({settings:{encryptionKey:'legacy',safeMode:true},readError});const before=[...f.files];
    for(const action of [()=>settings.readSettings(),()=>settings.writeSettings({gridLines:false}),()=>settings.replaceSettings({safeMode:false})])await assert.rejects(action,/could not be read or preserved/);
    assertUnchanged(f,before);
  }
  const f=await fixture({settings:{gridLines:false},badOptional:true});await assert.rejects(settings.writeSettings({safeMode:true}));assert.equal(f.calls.length,0);
});

test('metadata null/error/invalid stamp disables cache but strict reads preserve existing settings',async()=>{
  for(const mode of ['statNull','statError','statInvalid']){const f=await fixture({settings:{gridLines:false,custom:{keep:true}},[mode]:true});assert.equal((await settings.readSettings()).gridLines,false);await settings.writeSettings({safeMode:true});const stored=JSON.parse(f.files.get(f.paths.settings));assert.deepEqual(stored.custom,{keep:true});assert.equal(stored.gridLines,false);assert.equal(stored.safeMode,true);assert.ok(f.reads.length>=2);}
});

test('both settings writers bypass a warm cache and read faults invalidate it',async()=>{
  for(const writer of [()=>settings.writeSettings({gridLines:false}),()=>settings.replaceSettings({safeMode:false})]){const f=await fixture({settings:{safeMode:true}});await settings.readSettings();const readCount=f.reads.length;await settings.readSettings();assert.equal(f.reads.length,readCount,'read-only cache remains effective');f.control.readError='ACCESS_DENIED';await assert.rejects(writer,/ACCESS_DENIED/);await assert.rejects(settings.readSettings(),/ACCESS_DENIED/);assert.equal(f.calls.length,0);delete f.control.readError;f.files.set(f.paths.settings,JSON.stringify({safeMode:false}));assert.equal((await settings.readSettings()).safeMode,false);}
  const a=await fixture({settings:{safeMode:true}});await settings.readSettings();const b=await fixture({settings:{safeMode:false}});assert.equal((await settings.readSettings()).safeMode,false,'cache cannot cross data roots at the same mtime');assert.notEqual(a.paths.settings,b.paths.settings);
});

test('damaged settings require a successful matching quarantine copy before defaults overwrite',async()=>{
  for(const source of ['{broken','null','[]','42','"text"']){const f=await fixture({settings:source});const value=await settings.readSettings();assert.equal(value.gridLines,true);const copy=f.calls.find(c=>c[0]==='copy');assert.equal(copy[2],source);assert.equal(f.files.get(copy[1]),source);assert.ok(f.reads.includes(copy[1]));assert.equal(writes(f,f.paths.settings).length,1);assert.ok(f.calls.findIndex(c=>c[0]==='copy')<f.calls.findIndex(c=>c[0]==='write'));}
  for(const control of ['copyFailure','copyReadError','copyMismatch']){const f=await fixture({settings:'{broken',[control]:true});await assert.rejects(settings.writeSettings({encryptionKey:'replacement'}));assert.equal(f.files.get(f.paths.settings),'{broken');assert.equal(writes(f,f.paths.settings).length,0);assert.ok(!f.calls.some(c=>c[0]==='secret'));}
});

test('failed defaults replacement never caches recovery success; postcommit metadata errors do not fake failure',async()=>{
  const f=await fixture({settings:'{broken'});f.control.writeFailure=f.paths.settings;await assert.rejects(settings.readSettings(),/Atomic save denied/);assert.equal(f.files.get(f.paths.settings),'{broken');f.files.set(f.paths.settings,JSON.stringify({gridLines:false}));delete f.control.writeFailure;assert.equal((await settings.readSettings()).gridLines,false);
  const g=await fixture({settings:{gridLines:false}});const write=sys.writeTextAtomic;sys.writeTextAtomic=async(...args)=>{await write(...args);g.control.statError=true;};assert.equal((await settings.writeSettings({safeMode:true})).safeMode,true);assert.equal(JSON.parse(g.files.get(g.paths.settings)).safeMode,true);
});

test('valid legacy plaintext migration keeps vault order and unknown settings metadata',async()=>{
  const f=await fixture({settings:{encryptionKey:'old',custom:{retained:true}}});await settings.writeSettings({encryptionKey:'new',gridLines:false});assert.deepEqual(f.calls.filter(c=>c[0]==='secret').map(c=>c[1]),['old','new']);const value=JSON.parse(f.files.get(f.paths.settings));assert.equal(Object.hasOwn(value,'encryptionKey'),false);assert.deepEqual(value.custom,{retained:true});
});

test('queue I/O, JSON and shape failures block every writer, clear and RunOnce mutation',async()=>{
  const sources=['{broken','null','[]','42',JSON.stringify({programs:[],leftovers:{}}),JSON.stringify({programs:[{key:5}],leftovers:[]}),JSON.stringify({programs:[],leftovers:[null]})];
  for(const source of sources){const f=await fixture({queue:source});const before=[...f.files];for(const action of [()=>queue.get(),()=>queue.add([{key:'new'}]),()=>queue.remove('old'),()=>queue.save(queueRecord()),()=>queue.clear()])await assert.rejects(action,/queue could not be read/);assertUnchanged(f,before);}
  for(const readError of ['EACCES','EIO','Invalid UTF-8']){const f=await fixture({queue:queueRecord(),readError});const before=[...f.files];await assert.rejects(queue.add([{key:'new'}]));await assert.rejects(queue.save(queueRecord()));await assert.rejects(queue.clear());assertUnchanged(f,before);}
});

test('valid queue metadata and legacy statuses survive updates, input validation and serialized writes',async()=>{
  const f=await fixture({queue:queueRecord()});await Promise.all([queue.add([{key:'a'}]),queue.add([{key:'b'}])]);const q=await queue.get();assert.deepEqual(q.programs.map(p=>p.key),['old','a','b']);assert.equal(q.programs[0].status,'legacy-complete');assert.deepEqual(q.unknown,{keep:true});assert.deepEqual(q.leftovers,queueRecord().leftovers);
  const count=f.calls.length;await assert.rejects(queue.add([{key:4}]));await assert.rejects(queue.save({programs:[],leftovers:null}));assert.equal(f.calls.length,count);await queue.remove('a');assert.deepEqual((await queue.get()).programs.map(p=>p.key),['old','b']);await queue.clear();assert.ok(f.calls.some(c=>c[0]==='remove'));assert.ok(f.calls.some(c=>c[0]==='exec'));
});

test('trial read/JSON/schema failures prevent capture, comparison, deletion and overwrites',async()=>{
  for(const trials of ['{broken','null','{}','[null]',JSON.stringify([{id:'old'}]),JSON.stringify([{id:'old',snapshotId:4}])]){const f=await fixture({trials});const before=[...f.files];for(const action of [()=>trialList(),()=>trialStart(),()=>trialFinish(),()=>trialCompare()])await assert.rejects(action);assertUnchanged(f,before);}
  for(const readError of ['ACCESS_DENIED','EIO','Invalid UTF-8']){const f=await fixture({trials:trialRecord(),readError});const before=[...f.files];await assert.rejects(trials.start(null,'New'));await assert.rejects(trials.finish('legacy-id'));assertUnchanged(f,before);}
});
const trialList=()=>trials.list(),trialStart=()=>trials.start(null,'New'),trialFinish=()=>trials.finish('legacy-id'),trialCompare=()=>trials.tryOver('legacy-id');

test('trial completion saves references before cleanup and failed saves leave snapshots untouched',async()=>{
  const f=await fixture({trials:trialRecord()});f.control.writeFailure=f.paths.trials;await assert.rejects(trials.finish('legacy-id'),/Atomic save denied/);assert.deepEqual(JSON.parse(f.files.get(f.paths.trials)),trialRecord());assert.ok(!f.calls.some(c=>c[0]==='trash'));
  const g=await fixture({trials:trialRecord(),trashFailure:true});await trials.finish('legacy-id');assert.deepEqual(JSON.parse(g.files.get(g.paths.trials)),[]);assert.equal(g.calls[0][0],'write');assert.ok(g.calls.some(c=>c[0]==='trash'));
});

test('valid trial legacy/unknown fields survive append and cancelled capture does not write a trial',async()=>{
  const f=await fixture({trials:trialRecord()});await trials.start(null,'New');const list=await trials.list();assert.deepEqual(list[0],trialRecord()[0]);assert.equal(list.length,2);assert.ok(f.reads.indexOf(f.paths.trials)>=0);
  for(const option of ['snapshotCancel','snapshotError']){const g=await fixture({trials:trialRecord(),[option]:true});if(option==='snapshotCancel')assert.deepEqual(await trials.start(null,'New'),{cancelled:true});else await assert.rejects(trials.start(null,'New'));assert.equal(writes(g,g.paths.trials).length,0);assert.deepEqual(JSON.parse(g.files.get(g.paths.trials)),trialRecord());}
});

test('missing optional-read capability fails closed with no compatibility readText fallback',async()=>{
  const f=await fixture({settings:{safeMode:true},queue:queueRecord(),trials:trialRecord()});const reader=sys.readOptionalText;sys.readOptionalText=undefined;for(const action of [()=>settings.writeSettings({safeMode:false}),()=>queue.add([{key:'new'}]),()=>trials.start(null,'New')])await assert.rejects(action);sys.readOptionalText=reader;assert.equal(f.calls.length,0);
});
test('read-only damaged recovery shares the existing write chain and cannot stale-reset a later patch',async()=>{
  const f=await fixture({settings:'{broken'});const copy=sys.writeText;let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});let held=false;
  sys.writeText=async(...args)=>{if(!held){held=true;entered();await gate;}return copy(...args);};
  const first=settings.readSettings();await waiting;const patched=settings.writeSettings({safeMode:true});const concurrent=settings.readSettings();release();await Promise.all([first,patched,concurrent]);assert.equal(JSON.parse(f.files.get(f.paths.settings)).safeMode,true);assert.equal(f.calls.filter(c=>c[0]==='copy').length,1);
});
test('a preservation failure releases the write chain without resetting evidence or poisoning a later retry',async()=>{
  const f=await fixture({settings:'{broken',copyFailure:true});await assert.rejects(settings.readSettings(),/Copy write denied/);assert.equal(writes(f,f.paths.settings).length,0);assert.equal(f.files.get(f.paths.settings),'{broken');delete f.control.copyFailure;await settings.writeSettings({safeMode:true});assert.equal(JSON.parse(f.files.get(f.paths.settings)).safeMode,true);
});
test('parse/schema errors never include the corrupted record contents',async()=>{
  const marker='PRIVATE_RECORD_CONTENT';const f=await fixture({queue:`{"password":"${marker}",broken`,trials:`["${marker}",broken`});for(const action of [()=>queue.get(),()=>trials.list()])await assert.rejects(action,error=>!error.message.includes(marker)&&/preserved/.test(error.message));assert.equal(f.calls.length,0);
});