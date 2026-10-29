// Power Options: the powercfg output parsers (the rest is powercfg itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlans, parseIndexes } from '../src/backend/power.js';

const LIST = `
Existing Power Schemes (* Active)
-----------------------------------
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *
Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)
Power Scheme GUID: a1841308-3541-4fab-bc81-f71556f20b4a  (Power saver)
`;

test('plans parse with names, guids and the active marker', () => {
  const plans = parsePlans(LIST);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0], { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', active: true });
  assert.equal(plans[1].active, false);
  assert.equal(plans[2].name, 'Power saver');
  assert.deepEqual(parsePlans(''), []);
  assert.deepEqual(parsePlans('no schemes here'), []);
});

const QUERY = `
Power Setting GUID: 3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e (Turn off display after)
  Minimum Possible Setting: 0x00000000
  Maximum Possible Setting: 0x00015180
  Current AC Power Setting Index: 0x00000258
  Current DC Power Setting Index: 0x0000012c
`;

test('current AC/DC indexes parse from hex', () => {
  assert.deepEqual(parseIndexes(QUERY), { ac: 600, dc: 300 });
  assert.deepEqual(parseIndexes('nothing'), { ac: null, dc: null });
});
