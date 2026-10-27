// Tests for portable packaging classification (#4).
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyForPortable } from '../src/backend/portableapps.js';

test('program with no system-wide changes is portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo Editor\\Foo Editor' },
    { kind: 'file', path: 'C:\\Program Files\\Foo Editor\\Foo Editor.exe' },
    { kind: 'file', path: 'C:\\Program Files\\Foo Editor\\data.bin' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, true);
  assert.equal(result.reasons.length, 0);
});

test('program that installs a service is not portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'service', path: 'FooSvc' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some((r) => r.includes('service')), 'mentions service');
  assert.ok(result.reasons.some((r) => r.includes('system-wide')), 'explains why');
});

test('program that installs a driver (.sys) is not portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'file', path: 'C:\\Windows\\System32\\drivers\\foo.sys' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some((r) => r.includes('driver')), 'mentions driver');
});

test('program that creates a scheduled task is not portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'task', path: '\\FooUpdateTask' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some((r) => r.includes('scheduled task')), 'mentions scheduled task');
});

test('program that writes licensing data is not portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'key', path: 'HKLM\\Software\\Foo\\LicenseKey' },
    { kind: 'value', path: 'HKLM\\Software\\Foo', name: 'ActivationCode' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some((r) => r.includes('licensing')), 'mentions licensing');
});

test('program that writes outside the app folder is not portable', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'file', path: 'C:\\Users\\Public\\Documents\\Foo config.cfg' },
    { kind: 'dir', path: 'C:\\ProgramData\\Foo\\Cache' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some((r) => r.includes('outside a program folder')), 'mentions outside program folder');
});

test('multiple issues are all reported', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'service', path: 'FooSvc' },
    { kind: 'file', path: 'C:\\Windows\\System32\\drivers\\foo.sys' },
    { kind: 'key', path: 'HKLM\\Software\\Foo\\LicenseKey' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, false);
  assert.ok(result.reasons.length >= 3, `expected at least 3 reasons, got ${result.reasons.length}`);
});

test('App Paths registry key is allowed (not licensing)', async () => {
  const items = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'key', path: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\foo.exe' },
  ];
  const result = await classifyForPortable(items);
  assert.equal(result.portable, true);
});

test('empty item list is portable', async () => {
  const result = await classifyForPortable([]);
  assert.equal(result.portable, true);
  assert.equal(result.reasons.length, 0);
});
