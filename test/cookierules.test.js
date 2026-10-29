// Cookie site rules: pattern cleaning and policy numbering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPattern, nextIndex } from '../src/backend/cookierules.js';

test('patterns clean down to a site and validate', () => {
  assert.equal(cleanPattern('https://Example.COM/some/page?x=1'), 'example.com');
  assert.equal(cleanPattern('  sub.example.co.uk '), 'sub.example.co.uk');
  assert.equal(cleanPattern('[*.]example.com'), '[*.]example.com');
  assert.equal(cleanPattern('not a site'), null);
  assert.equal(cleanPattern('localhost'), null, 'a bare word is not a site pattern');
  assert.equal(cleanPattern(''), null);
});

test('the next policy number follows the highest used', () => {
  assert.equal(nextIndex([]), 1);
  assert.equal(nextIndex(['1', '2']), 3);
  assert.equal(nextIndex(['1', '7']), 8);
  assert.equal(nextIndex(['PSPath', '3']), 4);
});
