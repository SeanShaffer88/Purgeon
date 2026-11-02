import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as logs from '../src/backend/eventlogs.js';
import * as history from '../src/backend/history.js';
const channelId = 'a'.repeat(32), planId = 'b'.repeat(32), grantId = 'c'.repeat(32), journalId = 'd'.repeat(64);
const row = (overrides = {}) => ({ name: 'Example/Operational', records: 42, sizeBytes: 1024, enabled: true, guarded: false, channelId, metadataError: null, configError: null, ...overrides });
async function fixture(options = {}) {
  const calls = []; let request; let saved = '[]';
  setSys({
    info: { dataDir: 'C:\\MockLogHistory' }, makeDir: async () => {}, readOptionalText: async () => saved,
    writeTextAtomic: async (_path,contents) => { saved = contents; },
    runPS: async () => { throw new Error('Forbidden generic PowerShell'); }, exec: async () => { throw new Error('Forbidden generic command'); },
    queryOperation: async (value) => { calls.push(['query',value]); if (options.queryError) throw new Error(options.queryError); return value.kind === 'eventLogChannels' ? { kind: value.kind, channels: options.rows || [row()] } : { kind: value.kind, config: { channelId, name: options.name || 'Example/Operational', enabled: true, guarded: false } }; },
    selectResource: async (value) => { calls.push(['select',value]); return options.cancel ? null : { id: options.invalidGrant ? '../bad' : grantId, displayPath: 'C:\\UserChoice.evtx' }; },
    prepareOperation: async (value) => { calls.push(['prepare',value]); if (options.prepareError) throw new Error(options.prepareError); request = value; return { id: planId, summary: 'Fixture', requiresElevation: true, recoveryLimits: 'No blind retry' }; },
    executeOperation: async (value) => { calls.push(['execute',value]); if (options.executeError) throw new Error(options.executeError); return { kind: options.wrongKind ? 'unexpected' : request.kind, ok: true, backup: 'C:\\NativeRecovery\\fixture.evtx', path: 'C:\\UserChoice.evtx', previousEnabled: options.previousEnabled ?? true, journalId }; },
  });
  await history.setRoot('C:\\MockLogHistory');
  return calls;
}

test('unknown native metadata remains unknown rather than zero/on', async () => {
  await fixture({ rows: [row({records:null,sizeBytes:null,enabled:null,channelId:null,metadataError:'Denied',configError:'Unavailable'})] });
  const [value] = await logs.channels();
  assert.equal(value.records,null); assert.equal(value.sizeBytes,null); assert.equal(value.enabled,null);
  assert.equal(value.channelId,null);
  assert.throws(() => logs.shapeChannels([{name:'bad'}]),/invalid event-log response/);
});

test('clear and enable use closed grants/plans only and history records actual prior state', async () => {
  const calls = await fixture({ previousEnabled: false });
  assert.equal((await logs.clearLog(channelId)).ok,true);
  assert.equal((await logs.setEnabled(channelId,true)).previousEnabled,false);
  await new Promise(setImmediate);
  const entry = (await history.list()).find((value) => value.undo);
  assert.equal(entry.undo.channel,'logs:undoEnabled');
  assert.equal(entry.undo.arg.on,false);
  assert.equal(entry.undo.arg.expectedCurrentEnabled,true);
  assert.deepEqual(calls.filter(([kind]) => kind === 'prepare').map(([,value]) => value), [{kind:'eventLogClear',channelId},{kind:'eventLogSetEnabled',channelId,enabled:true}]);
  assert.equal(calls.filter(([kind]) => kind === 'execute').length,2);
});

test('export picker cancellation does not prepare and successful export passes opaque destination grant', async () => {
  const cancelled = await fixture({cancel:true});
  assert.equal(await logs.exportLog(channelId),null);
  assert.equal(cancelled.some(([kind]) => kind === 'prepare'),false);
  const calls = await fixture();
  await logs.exportLog(channelId,'C:\\RendererCannotAuthorize.evtx');
  assert.deepEqual(calls.find(([kind]) => kind === 'select')[1],{kind:'eventLogExportDestination',channelId});
  assert.deepEqual(calls.find(([kind]) => kind === 'prepare')[1],{kind:'eventLogExport',channelId,destinationGrant:grantId});
});

test('invalid/stale grants, native consent denial and malformed results never fallback or retry', async () => {
  const invalid = await fixture({invalidGrant:true});
  await assert.rejects(() => logs.exportLog(channelId),/invalid event-log response/);
  assert.equal(invalid.some(([kind]) => kind === 'prepare'),false);
  for (const options of [{queryError:'Grant expired'},{prepareError:'Grant expired'},{executeError:'Native consent declined'},{wrongKind:true}]) {
    const calls = await fixture(options);
    await assert.rejects(() => logs.clearLog(channelId));
    assert.ok(calls.filter(([kind]) => kind === 'execute').length <= 1);
  }
  await assert.rejects(() => logs.clearLog('../arbitrary'),/Refresh/);
});

test('Security clearing and built-in log recording changes are refused before prepare', async () => {
  for (const name of ['Security','Application','System']) {
    const calls = await fixture({name});
    await assert.rejects(() => logs.setEnabled(channelId,false),/does not allow/);
    if (name === 'Security') await assert.rejects(() => logs.clearLog(channelId),/view-and-save/);
    assert.equal(calls.some(([kind]) => kind === 'prepare'),false);
  }
});

test('undo reacquires a fresh exact-name grant and refuses ambiguous or changed state', async () => {
  const request = {name:'Example/Operational',on:false,expectedCurrentEnabled:true,journalId};
  const calls = await fixture();
  await logs.undoEnabled(request);
  assert.equal(calls[0][1].kind,'eventLogChannels');
  assert.deepEqual(calls.find(([kind]) => kind === 'prepare')[1],{kind:'eventLogSetEnabled',channelId,enabled:false});
  for (const rows of [[row(),row()],[row({enabled:false})],[row({channelId:null})],[row({configError:'Denied'})]]) {
    const guarded = await fixture({rows});
    await assert.rejects(() => logs.undoEnabled(request),/unavailable or changed/);
    assert.equal(guarded.some(([kind]) => kind === 'prepare'),false);
  }
});
