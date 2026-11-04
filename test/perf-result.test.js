import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCounts, requireSuccess } from '../scripts/perf-result.mjs';

test('performance counts accept TAP and spec summaries, CRLF and zero counts', () => {
  for (const marker of ['#', 'ℹ']) {
    for (const newline of ['\n', '\r\n']) {
      assert.deepEqual(parseCounts(`test output${newline}${marker} pass 503${newline}${marker} fail 0${newline}`), { pass: 503, fail: 0 });
      assert.deepEqual(parseCounts(`${marker} pass 0${newline}${marker} fail 0${newline}`), { pass: 0, fail: 0 });
    }
  }
});

test('performance counts reject missing or malformed summaries', () => {
  for (const output of ['', '# pass 503', '# fail 0', '# pass nope\n# fail 0', '# pass 1 extra\n# fail 0', 'prefix # pass 1\n# fail 0']) {
    assert.throws(() => parseCounts(output), /Missing or malformed test summary/);
  }
});

test('performance measurements require successful child execution', () => {
  const error = Error('spawn failed');
  assert.throws(() => requireSuccess({ error }), (caught) => caught === error);
  for (const result of [{ status: 1, stderr: 'build failed' }, { status: null, signal: 'SIGTERM' }, { status: null }]) {
    assert.throws(() => requireSuccess(result), /Child command failed/);
  }
  assert.equal(requireSuccess({ status: 0, stdout: 'measured' }), 'measured');
});
