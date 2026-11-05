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

test('the desktop marker adapter sends no path and flushes through IPC before quitting', async (t) => {
  const { createTauriSys } = await import('../src/backend/tauri-sys.js');
  for (const key of ['window', '__APP_VERSION__']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }

  const calls = [];
  const root = 'C:\\DesktopMarkerLogFixture';
  let observation = false;
  globalThis.__APP_VERSION__ = '1.6.1';
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push([command, args]);
        switch (command) {
          case 'sys_info':
            return { exe: 'C:\\UntrustedRendererValue\\Purgeon.exe', env: {} };
          case 'make_dir':
          case 'append_text':
          case 'quit':
            return undefined;
          case 'read_dir':
            return [];
          case 'consume_update_exit_marker':
            if (observation instanceof Error) throw observation;
            return observation;
          default:
            throw Error(`Unexpected IPC command ${command}`);
        }
      },
    },
  };

  setSys(await createTauriSys());
  await setLogRoot(root);
  assert.deepEqual(calls.splice(0), [
    ['sys_info', {}], ['make_dir', { path: root }], ['read_dir', { path: root }],
  ]);

  for (const value of [false, 'true', Error('inert IPC rejection')]) {
    observation = value;
    assert.equal(await checkExitMarker(), false);
    assert.deepEqual(calls.splice(0), [['consume_update_exit_marker', {}]]);
  }

  observation = true;
  writeLog('pending desktop IPC fixture');
  assert.equal(await checkExitMarker(), true);
  assert.deepEqual(calls.map(([command]) => command), ['consume_update_exit_marker', 'append_text', 'quit']);
  assert.deepEqual(calls[0][1], {});
  assert.match(calls[1][1].path, /^C:\\DesktopMarkerLogFixture\\\d{4}-\d{2}-\d{2}\.log$/);
  assert.match(calls[1][1].contents, /pending desktop IPC fixture/);
  assert.deepEqual(calls[2][1], { code: 0 });
});
