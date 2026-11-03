// Tests for the driver store clean-up logic.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOldDriverCandidates } from '../src/backend/drivers.js';
import * as drivers from '../src/backend/drivers.js';
import { setSys } from '../src/backend/sys.js';
import * as history from '../src/backend/history.js';

const driver = (inf, date) => ({ InfFile: inf, Date: date, Provider: 'Acme Corp' });

test('no drivers means no candidates', () => {
  assert.deepEqual(findOldDriverCandidates([]), []);
});

test('a single driver per inf is never a candidate', () => {
  const drivers = [driver('foo.inf', '2026-01-01'), driver('bar.inf', '2026-02-01')];
  assert.deepEqual(findOldDriverCandidates(drivers), []);
});

test('duplicate infs: all but the newest are candidates', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'), // old
    driver('foo.inf', '2026-06-01'), // newest
    driver('bar.inf', '2026-03-01'), // single, not a candidate
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
  assert.equal(out[0].InfFile, 'foo.inf');
});

test('multiple old versions: all but newest are candidates', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'), // oldest
    driver('foo.inf', '2026-02-01'), // middle
    driver('foo.inf', '2026-03-01'), // newest
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 2);
  // Candidates are newest-first among the duplicates (matching the descending sort)
  assert.equal(out[0].Date, '2026-02-01');
  assert.equal(out[1].Date, '2026-01-01');
});

test('drivers without an InfFile are skipped', () => {
  const drivers = [
    { Date: '2026-01-01', Provider: 'Acme' }, // no InfFile
    driver('foo.inf', '2026-01-01'),
    driver('foo.inf', '2026-02-01'),
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
});

test('drivers with an empty InfFile are skipped', () => {
  const drivers = [
    { InfFile: '', Date: '2026-01-01', Provider: 'Acme' },
    driver('foo.inf', '2026-01-01'),
  ];
  assert.deepEqual(findOldDriverCandidates(drivers), []);
});

test('newest is determined by date, not input order', () => {
  const drivers = [
    driver('foo.inf', '2026-03-01'), // newest, listed first
    driver('foo.inf', '2026-01-01'), // old, listed second
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
});

test('drivers with missing Date are treated as oldest', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'),
    { InfFile: 'foo.inf', Provider: 'Acme' }, // no Date -> treated as epoch (oldest)
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].InfFile, 'foo.inf');
  // The no-Date driver is oldest, so it's the candidate
  assert.ok(!out[0].Date || out[0].Date === undefined);
});

const driverId='a'.repeat(32),planId='b'.repeat(32),journalId='c'.repeat(32);
const nativeRow={PublishedName:'oem12.inf',OriginalName:'fixture.inf',InfFile:'fixture.inf',Date:'2026-01-02',Version:'1.2.3.4',Provider:'Fixture Corp',DriverClass:'Fixture',driverId,eligible:true,reason:null};
async function nativeFixture(options={}){
  const calls=[];let saved='[]';let request;
  setSys({info:{dataDir:'C:\\MockDriverHistory'},makeDir:async()=>{},readOptionalText:async()=>saved,writeTextAtomic:async(_path,text)=>{saved=text;},
    exec:async()=>{throw new Error('Forbidden generic executable');},runPS:async()=>{throw new Error('Forbidden generic PowerShell');},
    driverInventory:async()=>{calls.push(['inventory']);if(options.queryError)throw new Error(options.queryError);return options.rows||[nativeRow];},
    prepareDriver:async(value)=>{calls.push(['prepare',value]);request=value;if(options.prepareError)throw new Error(options.prepareError);return {id:options.badPlan?'oem12.inf':planId,summary:'Native exact package',requiresElevation:true};},
    executeDriver:async(value)=>{calls.push(['execute',value]);if(options.executeError)throw new Error(options.executeError);return {ok:true,journalId:options.badResult?journalId:value,stagedOnly:request.kind==='recover',detail:'Native verified result; staging only for recovery.'};},
    driverRecovery:async(value)=>{calls.push(['recovery',value]);return {journalId:value,completed:true,stagedOnly:true};},
  });await history.setRoot('C:\\MockDriverHistory');return calls;
}
test('native driver inventory is structured and unknown/errors never become empty success',async()=>{
  const calls=await nativeFixture();assert.deepEqual(await drivers.listDrivers(),[nativeRow]);assert.deepEqual(calls,[['inventory']]);
  for(const rows of [[{...nativeRow,driverId:'../caller'}],[{...nativeRow,driverId:null}],[{...nativeRow,eligible:undefined}],[{...nativeRow,PublishedName:'caller.inf'}]]){await nativeFixture({rows});await assert.rejects(drivers.listDrivers(),/invalid native driver response/);}
  await nativeFixture({queryError:'Native guard inventory unavailable'});await assert.rejects(drivers.listDrivers(),/guard inventory unavailable/);
});
test('driver removal uses opaque identity and native journal recovery, never raw INF or flags',async()=>{
  const calls=await nativeFixture();await drivers.deleteDriver(driverId);assert.deepEqual(calls,[['prepare',{kind:'remove',driverId}],['execute',planId]]);
  assert.deepEqual((await history.list())[0].undo,{channel:'drivers:recover',arg:{journalId:planId}});
  for(const raw of ['oem12.inf','C:\\caller.inf','oem12.inf /force',null,undefined])await assert.rejects(drivers.deleteDriver(raw),/Raw INF removal/);
});
test('legacy raw-INF API is rejected before dispatch and recovery API sends journal only',async()=>{
  const calls=await nativeFixture();const {api}=await import('../src/backend/api.js');
  await assert.rejects(api.invoke('drivers:delete',{inf:'oem12.inf',driverId}),/Raw INF removal/);assert.deepEqual(calls,[]);
  await api.invoke('drivers:recover',{journalId,path:'C:\\attacker',install:true});assert.deepEqual(calls[0],['prepare',{kind:'recover',journalId}]);assert.equal((await history.list())[0].undo,null);
});
test('native driver cancellation, stale state, backup/journal failures and malformed results never retry or record success',async()=>{
  for(const options of [{prepareError:'USER_CANCELLED'},{prepareError:'UAC denied'},{prepareError:'Driver content changed'},{executeError:'Backup incomplete'},{executeError:'Retained uncertain journal'},{badPlan:true},{badResult:true}]){
    const calls=await nativeFixture(options);await assert.rejects(drivers.deleteDriver(driverId));assert.equal((await history.list()).length,0);assert.ok(calls.filter(([kind])=>kind==='execute').length<=1);
  }
});
test('explicit driver recovery is journal-bound, stage-only and cannot create another undo',async()=>{
  const calls=await nativeFixture();assert.equal((await drivers.recoverDriver(journalId)).stagedOnly,true);assert.deepEqual(calls[0],['prepare',{kind:'recover',journalId}]);assert.equal((await history.list())[0].undo,null);
  assert.equal((await drivers.driverRecovery(journalId)).journalId,journalId);await assert.rejects(drivers.recoverDriver('oem12.inf'),/valid native driver recovery/);
});
test('candidate age never overrides missing native removal eligibility',async()=>{
  await nativeFixture({rows:[{...nativeRow,Date:'2025-01-01',eligible:false,driverId:null,reason:'Device associated'}, {...nativeRow,Date:'2026-01-02'}]});assert.deepEqual(await drivers.oldDriverCandidates(),[]);
});
