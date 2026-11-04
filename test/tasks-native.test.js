import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setSys } from '../src/backend/sys.js';
import { recoveryLeaseFixture } from './recovery-lease-fixture.js';
import * as tasks from '../src/backend/tasks.js';
import * as history from '../src/backend/history.js';
import * as backups from '../src/backend/backups.js';
import * as autostart from '../src/backend/autostart.js';
import * as maintenance from '../src/backend/maintenance.js';
import * as schedule from '../src/backend/schedule.js';
import * as startup from '../src/backend/startup.js';
import { scanDeep } from '../src/backend/deepscan.js';
const taskId='a'.repeat(32),planId='b'.repeat(32),grantId='c'.repeat(32);
const row={name:'Fixture',path:'\\Vendor\\',state:'Disabled',author:'Fixture',lastRun:'',nextRun:'',lastResult:null,isWindows:false,taskId,enabled:false,command:'C:\\Fixture\\fixture.exe',arguments:'',workingDirectory:'',instanceGuids:[],unsupportedReason:null};
async function fixture(options={}){
  const calls=[];let saved='[]';let request;let step=0;
  const impl={info:{dataDir:'C:\\MockTaskHistory',exe:'C:\\RendererCannotChoose.exe',env:{}},makeDir:async()=>{},readOptionalText:async()=>saved,readText:async()=>{throw new Error('No fixture file');},writeTextAtomic:async(_file,text)=>{saved=text;},
    runPS:async()=>{throw new Error('Forbidden generic scheduler PowerShell');},exec:async()=>{throw new Error('Forbidden generic scheduler executable');},
    taskInventory:async(cursor)=>{calls.push(['inventory',cursor]);if(options.queryError)throw new Error(options.queryError);return options.pages?options.pages[cursor||'first']:{rows:options.rows||[row],nextCursor:null};},
    selectTaskProgram:async()=>({id:grantId,displayPath:'C:\\Fixture\\fixture.exe'}),
    prepareTask:async(value)=>{calls.push(['prepare',value]);request=value;if(options.prepareError)throw new Error(options.prepareError);return {id:planId,summary:'Native exact task',requiresElevation:true};},
    executeTask:async(id)=>{calls.push(['execute',id]);if(options.onExecute)await options.onExecute(id);if(options.executeError)throw new Error(options.executeError);return {ok:true,journalId:options.badResult?'f'.repeat(32):id,changed:true,settled:request.kind!=='configureOwned'||step++>0,recoverable:!['run','stop','recover'].includes(request.kind),detail:'Native verified action',task:null,instanceGuid:request.kind==='run'?'{11111111-2222-3333-4444-555555555555}':null};},
    taskOwnedStatus:async(role)=>{calls.push(['owned',role]);return {registered:true,enabled:true,owned:true,nextRun:'',lastRun:'',lastResult:null};},
    taskRecovery:async(journalId)=>({journalId,completed:true,recovered:false,recoverable:true,path:'\\Vendor\\Fixture'}),
  };
  Object.assign(impl, recoveryLeaseFixture());setSys(impl);await history.setRoot('C:\\MockTaskHistory');return {calls,impl};
}
test('task inventory uses bounded native pagination and read-only unsupported rows',async()=>{
  const {calls}=await fixture({pages:{first:{rows:[row],nextCursor:'next'},next:{rows:[{...row,name:'Foreign',taskId:null,enabled:null,unsupportedReason:'Unsupported principal'}],nextCursor:null}}});assert.equal((await tasks.list()).length,2);assert.deepEqual(calls,[['inventory',null],['inventory','next']]);
  await fixture({pages:{first:{rows:[],nextCursor:'same'},same:{rows:[],nextCursor:'same'}}});await assert.rejects(tasks.list(),/invalid native/);
  await fixture({queryError:'Native task ACL unavailable'});await assert.rejects(tasks.list(),/ACL unavailable/);
});
test('task actions accept opaque IDs only and record journal recovery instead of renderer paths',async()=>{
  const {calls}=await fixture();await tasks.setEnabled(row,true);await tasks.runNow(row);await tasks.stop(row);await tasks.remove(row);
  assert.deepEqual(calls.filter(([kind])=>kind==='prepare').map(([,value])=>value),[{kind:'setEnabled',taskId,enabled:true},{kind:'run',taskId},{kind:'stop',taskId},{kind:'remove',taskId}]);
  const entries=await history.list();assert.ok(entries.some((entry)=>entry.undo?.channel==='tasks:restore'&&entry.undo.arg.journalId===planId));assert.ok(entries.filter((entry)=>entry.title.includes('start')||entry.title.includes('instances')).every((entry)=>entry.undo===null));
  await assert.rejects(tasks.remove({name:'Fixture',path:'\\Vendor\\'}),/native identity/);await assert.rejects(tasks.restoreFromBackup('C:\\task-backups\\caller.xml','Fixture'),/Legacy task XML/);
});
test('native EXE selection and disabled creation reject raw executable paths/XML',async()=>{
  const {calls}=await fixture();assert.equal((await tasks.pickProgram()).id,grantId);
  await tasks.create({name:'Fixture',programGrant:grantId,trigger:'weekly',time:'09:15',day:'Friday'});assert.deepEqual(calls.find(([kind])=>kind==='prepare')[1],{kind:'create',name:'Fixture',programGrant:grantId,trigger:{kind:'weekly',day:'Friday',time:'09:15'}});
  await assert.rejects(tasks.create({name:'Unsafe',program:'C:\\caller.exe',trigger:'logon'}),/raw program paths/);
});
test('native cancellation, stale state, uncertain result and result mismatch never retry or record success',async()=>{
  for(const options of [{prepareError:'USER_CANCELLED'},{prepareError:'Task changed'},{executeError:'Native uncertainty; journal retained'},{badResult:true}]){const {calls}=await fixture(options);await assert.rejects(tasks.remove(row));assert.equal((await history.list()).length,0);assert.ok(calls.filter(([kind])=>kind==='execute').length<=1);}
});
test('awaited native journal reservation persists before execute and failed persistence prevents mutation',async()=>{
  const trace=[];await fixture({onExecute:async(id)=>{assert.deepEqual(trace,[['persist',id]]);}});await tasks.remove(row,{onPrepared:async(id)=>{await Promise.resolve();trace.push(['persist',id]);}});
  const {calls}=await fixture();await assert.rejects(tasks.remove(row,{onPrepared:async()=>{throw new Error('outer intent cannot be saved');}}),/outer intent/);assert.equal(calls.some(([kind])=>kind==='execute'),false);
});
test('all owned runtime registrations use native catalogs and distinct reviewed steps',async()=>{
  const {calls}=await fixture();await autostart.set(true);await maintenance.apply({enabled:true,day:'Monday',time:'11:30'});await schedule.apply({enabled:true,checkStartup:false});
  const requests=calls.filter(([kind])=>kind==='prepare').map(([,value])=>value);assert.ok(requests.every((value)=>value.kind==='configureOwned'&&!('program' in value)&&!('xml' in value)&&!('exe' in value)));assert.ok(requests.some((value)=>value.role==='signin'));assert.ok(requests.some((value)=>value.role==='maintenance'&&value.day==='Monday'));assert.ok(requests.some((value)=>value.role==='background'&&value.checkStartup===false));
});
test('startup and deeper scans merge native task IDs without scheduler shell fallback',async()=>{
  const {calls,impl}=await fixture();impl.runPS=async(script)=>{assert.doesNotMatch(script,/ScheduledTask|schtasks|Schedule\.Service/i);return '[]';};impl.readDir=async()=>[];setSys(impl);
  const entries=await startup.list();assert.equal(entries.find((entry)=>entry.type==='task').taskId,taskId);
  const deeper=await scanDeep({},{nameKey:'fixture',location:'C:\\Fixture'});assert.equal(deeper.find((entry)=>entry.kind==='task').taskId,taskId);assert.ok(calls.some(([kind])=>kind==='inventory'));
});
test('every runtime backend file is free of generic scheduler commands and COM',async()=>{
  const root=new URL('../src/backend/',import.meta.url);for(const entry of await fs.readdir(root)){if(!entry.endsWith('.js'))continue;const text=await fs.readFile(new URL(entry,root),'utf8');assert.doesNotMatch(text,/(?:Get|Set|New|Register|Unregister|Enable|Disable|Start|Stop|Export)-ScheduledTask|schtasks(?:\.exe)?|Schedule\.Service|TaskScheduler\.TaskScheduler/i,entry);}
});
test('backup native task intent retains durable journal link, halts later tasks and reconciles only proven completion',async()=>{
  for(const mode of ['uncertain','outer-record','mismatched-toggle']){
    const files=new Map();const root=`C:\\MockTaskBridge\\${mode}`;let nativeCalled=false,allowRecord=false,recovered=false,prepared=0,currentRequest;
    const {impl}=await fixture();Object.assign(impl,{info:{dataDir:root,env:{}},makeDir:async()=>{},readOptionalText:async(file)=>files.get(file)??null,readText:async(file)=>{if(!files.has(file))throw new Error('Not found');return files.get(file);},writeTextAtomic:async(file,text)=>{if(mode!=='uncertain'&&nativeCalled&&!allowRecord&&file.endsWith('manifest.json')&&JSON.parse(text).entries.length)throw new Error('outer record save failed');files.set(file,text);},writeText:async(file,text)=>files.set(file,text),removePath:async(file)=>files.delete(file),exists:async(file)=>files.has(file),readDir:async()=>[],stat:async()=>null,secretGet:async()=>'',secretKeys:async()=>[],sha256Files:async()=>[],
      taskInventory:async()=>({rows:[row],nextCursor:null}),prepareTask:async(request)=>{prepared++;currentRequest=request;return {id:planId,summary:'Fixture reviewed task',requiresElevation:true};},
      taskRecovery:async(journalId)=>({journalId,completed:mode!=='uncertain',deleted:mode==='outer-record',recovered,recoverable:mode!=='uncertain'&&!recovered,path:'\\Vendor\\Fixture'}),
      executeTask:async()=>{if(currentRequest.kind==='recoverDeleted'){recovered=true;return {ok:true,journalId:planId,changed:true,settled:true,recoverable:false,detail:'Recovered disabled'};}
        const stored=JSON.parse([...files].find(([key])=>key.endsWith('manifest.json'))[1]);assert.equal(stored.inFlight.nativeTaskJournalId,planId);nativeCalled=true;
        if(mode==='uncertain')throw new Error('Native outcome uncertain');return {ok:true,journalId:planId,changed:true,settled:true,recoverable:true,detail:'Deleted native task'};
      },
    });setSys(impl);await history.setRoot(`${root}\\history`);await backups.setRoot(`${root}\\backups`);
    const result=await backups.removeItems({title:'Task fixture',items:[{kind:'task',path:'\\Vendor\\Fixture',name:'Fixture',taskId},{kind:'task',path:'\\Vendor\\Later',name:'Later',taskId}]});assert.equal(nativeCalled,true);assert.equal(result.interrupted,true);assert.equal(prepared,1);
    const retained=JSON.parse([...files].find(([key])=>key.endsWith('manifest.json'))[1]);assert.equal(retained.inFlight.nativeTaskJournalId,planId);assert.equal(retained.entries.length,0);
    allowRecord=true;
    if(mode!=='outer-record'){await assert.rejects(backups.resolveInterrupted('rollback'),/uncertain task/);assert.equal(prepared,1);}
    else{const rolled=await backups.resolveInterrupted('rollback');assert.equal(rolled.results[0].ok,true);assert.equal(recovered,true);assert.equal(prepared,2);}
  }
});

test('disabled owned task still exists but all schedule and health status wrappers report off',async()=>{
  const {impl}=await fixture();impl.taskOwnedStatus=async()=>({registered:true,enabled:false,owned:true,running:true,nextRun:'',lastRun:'',lastResult:null});setSys(impl);
  assert.equal(await autostart.enabled(),false);
  for(const status of [await maintenance.status(),await schedule.status(),await tasks.configureOwned('maintenance',false)]){
    assert.equal(status.registered,false);assert.equal(status.exists,true);assert.equal(status.enabled,false);assert.equal(status.running,true);
  }
});
