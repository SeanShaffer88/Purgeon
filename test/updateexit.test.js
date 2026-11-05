import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { setRoot as setLogRoot, write as writeLog } from '../src/backend/log.js';
import { checkExitMarker, watchExitMarker } from '../src/backend/updateexit.js';

function fakeSys(result, calls) {
  setSys({
    info: { exe: 'C:\\RendererValue\\Other.exe', env: {} },
    stat: async () => { calls.push(['stat']); return { modified: Date.now() }; },
    removePath: async () => { calls.push(['remove']); },
    makeDir: async () => {},
    readDir: async () => [],
    appendText: async () => { calls.push(['flush']); },
    consumeUpdateExitMarker: result === undefined ? undefined : async (...args) => {
      calls.push(['consume', ...args]);
      if (result instanceof Error) throw result;
      return result;
    },
    quit: async (...args) => { calls.push(['quit', ...args]); },
  });
}

test('a positive no-argument native observation flushes the log before normal quit', async () => {
  const calls = [];
  fakeSys(true, calls);
  await setLogRoot('C:\\ExitMarkerFixture');
  writeLog('inert pending marker fixture');
  assert.equal(await checkExitMarker(), true);
  assert.deepEqual(calls, [['consume'], ['flush'], ['quit']]);
});

for (const [label, result] of [
  ['false', false],
  ['invalid', 'true'],
  ['rejected', Error('inert native refusal')],
  ['unsupported', undefined],
]) {
  test(`a ${label} native observation never uses generic path operations or quits`, async () => {
    const calls = [];
    fakeSys(result, calls);
    assert.equal(await checkExitMarker(), false);
    assert.deepEqual(calls, label === 'unsupported' ? [] : [['consume']]);
  });
}

test('the watcher checks immediately and uses the existing cadence without a duplicate timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  fakeSys(false, calls);
  watchExitMarker();
  watchExitMarker();
  assert.deepEqual(calls, [['consume']]);
  t.mock.timers.tick(1999);
  assert.deepEqual(calls, [['consume']]);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [['consume'], ['consume']]);
});
