import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { api, __handlers } from '../src/backend/api.js';
import * as cookies from '../src/backend/cookierules.js';
import * as power from '../src/backend/power.js';

test('dispatcher rejects inherited and own non-function channels before bookkeeping; valid own function still runs', async () => {
  for (const channel of ['constructor', 'toString', '__proto__']) await assert.rejects(api.invoke(channel), /Unknown request/);
  __handlers['fixture:notFunction'] = {};
  __handlers['fixture:valid'] = async () => 'valid';
  try {
    await assert.rejects(api.invoke('fixture:notFunction'), /Unknown request/);
    assert.equal(await api.invoke('fixture:valid'), 'valid');
  } finally { delete __handlers['fixture:notFunction']; delete __handlers['fixture:valid']; }
});

test('cookie second preparatory read failure reports partial change and original error without success history', async () => {
  let reads = 0, writes = 0, historyWrites = 0;
  setSys({ runPS: async (script) => {
    if (script.includes('ConvertTo-Json')) { if (++reads === 2) throw Error('Second read denied'); return '[]'; }
    writes++; return '';
  }, writeTextAtomic: async () => { historyWrites++; } });
  await assert.rejects(cookies.addRule('blocked', 'example.com'), /Second read denied.*partial.*refresh/i);
  assert.equal(writes, 1);
  assert.equal(historyWrites, 0);
});

for (const [name, run, stage] of [
  ['timeout DC', () => power.setTimeout('screen', 1, 2), 2],
  ['index DC', () => power.setBatterySaver(25), 2],
  ['index activation', () => power.setWakeTimers(true), 3],
  ['USB activation', () => power.setUsbSuspend(true), 3],
]) {
  test(`power ${name} failure identifies completed commands and refresh without rollback or history`, async () => {
    const calls = [];
    let writes = 0;
    setSys({ exec: async (_exe, args) => { calls.push(args); return calls.length === stage ? { ok: false, stderr: 'Stage denied' } : { ok: true }; },
      writeTextAtomic: async () => { writes++; } });
    await assert.rejects(run(), (error) => /partial/i.test(error.message) && /AC.*completed/.test(error.message) && /Stage denied.*Refresh/.test(error.message));
    assert.equal(calls.length, stage);
    assert.equal(writes, 0);
  });
}
