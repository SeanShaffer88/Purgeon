import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as history from '../src/backend/history.js';
import { __handlers } from '../src/backend/api.js';

test('history distinguishes absence, corruption and denied reads without overwriting evidence', async () => {
  let source = null;
  let denied = false;
  const writes = [];
  setSys({ makeDir: async () => {}, readOptionalText: async () => { if (denied) throw new Error('Denied'); return source; }, writeTextAtomic: async (path, value) => { writes.push(value); source = value; } });
  await history.setRoot('C:\\MockHistory');
  assert.deepEqual(await history.list(), []);
  await history.record({ type: 'Test', title: 'First' });
  assert.equal(writes.length, 1);
  for (const invalid of ['{broken', '{}', '[null]', '[{"title":"incomplete"}]']) {
    source = invalid;
    await assert.rejects(() => history.record({ type: 'Test', title: 'Blocked' }), /preserved/);
    assert.equal(source, invalid);
  }
  denied = true;
  await assert.rejects(() => history.markUndone('missing'), /Denied/);
  assert.equal(writes.length, 1);
  denied = false;
  source = writes[0];
  await history.record({ type: 'Test', title: 'Recovered' });
  assert.equal((await history.list()).length, 2, 'failed queue operation does not poison future updates');
});

test('partial transfer undo remains retryable and history marks only confirmed completion', async () => {
  let source=JSON.stringify([{id:'fixture',time:new Date().toISOString(),type:'Restore',title:'Fixture',detail:'',undone:false,undo:{channel:'transfer:undo',arg:'123'}}]);
  setSys({makeDir:async()=>{},readOptionalText:async()=>source,writeTextAtomic:async(_path,text)=>{source=text;}});
  await history.setRoot('C:\\HistoryResume');
  const original=__handlers['transfer:undo'];let result=[{ok:false,undoComplete:false}];
  __handlers['transfer:undo']=async()=>result;
  try {
    await __handlers['history:undo']('fixture');assert.equal((await history.list())[0].undone,false);
    result=[{ok:true,undoComplete:false}];await __handlers['history:undo']('fixture');assert.equal((await history.list())[0].undone,false);
    result=[{ok:true,undoComplete:true}];await __handlers['history:undo']('fixture');assert.equal((await history.list())[0].undone,true);
  } finally { __handlers['transfer:undo']=original; }
});
