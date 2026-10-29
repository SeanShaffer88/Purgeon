// Boot Options: bcdedit /enum parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBcd, bootState } from '../src/backend/boot.js';

const ENUM_SAFE = `
Windows Boot Manager
--------------------
identifier              {bootmgr}
device                  partition=\\Device\\HarddiskVolume1
description             Windows Boot Manager
default                 {current}
timeout                 10

Windows Boot Loader
-------------------
identifier              {current}
device                  partition=C:
osdevice                partition=C:
description             Windows 11
safeboot                Minimal
`;

const ENUM_NORMAL = `
Windows Boot Manager
--------------------
identifier              {bootmgr}
description             Windows Boot Manager
default                 {9dea862c-5cdd-4e70-acc1-f32b344d4795}
timeout                 30

Windows Boot Loader
-------------------
identifier              {9dea862c-5cdd-4e70-acc1-f32b344d4795}
device                  partition=C:
description             Windows 11
`;

test('boot state reads timeout, safe mode and entries', () => {
  const s = bootState(parseBcd(ENUM_SAFE));
  assert.equal(s.timeout, 10);
  assert.equal(s.safeboot, 'minimal');
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0], { id: '{current}', name: 'Windows 11', isCurrent: true, isDefault: true });
});

test('a normal start reports no safe mode and the default entry', () => {
  const s = bootState(parseBcd(ENUM_NORMAL));
  assert.equal(s.timeout, 30);
  assert.equal(s.safeboot, 'none');
  assert.equal(s.entries[0].isCurrent, false);
  assert.equal(s.entries[0].isDefault, true);
  assert.deepEqual(bootState(parseBcd('')) , { timeout: null, safeboot: 'none', entries: [] });
});
