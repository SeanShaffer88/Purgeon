import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as history from '../src/backend/history.js';

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
