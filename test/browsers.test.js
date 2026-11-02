import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionDetails } from '../src/backend/browsers.js';

test('extensionDetails reads the author from a string, an object, or the developer stamp', () => {
  assert.equal(extensionDetails({ author: 'Jane Dev' }).author, 'Jane Dev');
  assert.equal(extensionDetails({ author: { name: 'Jane Dev' } }).author, 'Jane Dev');
  assert.equal(extensionDetails({ developer: { name: 'Acme' } }).author, 'Acme');
  assert.equal(extensionDetails({}).author, '');
  assert.equal(extensionDetails(null).author, '');
});

test('extensionDetails lists API permissions and shortens host patterns to the site', () => {
  const d = extensionDetails({
    permissions: ['tabs', 'storage', '*://*.example.com/*', 'https://api.test.org/x', '<all_urls>'],
    host_permissions: ['*://*.example.com/*'],
  });
  assert.deepEqual(d.permissions, ['tabs', 'storage', '*.example.com', 'api.test.org', 'all websites']);
});

test('extensionDetails invents nothing for a manifest without the fields', () => {
  assert.deepEqual(extensionDetails({ name: 'X', version: '1.0' }), { author: '', permissions: [] });
  assert.deepEqual(extensionDetails(undefined), { author: '', permissions: [] });
});
