import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as startup from '../src/backend/startup.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('approvedEnabled parses hex correctly', () => {
  assert.equal(startup.approvedEnabled('020000000000000000000000'), true); // even first byte = enabled
  assert.equal(startup.approvedEnabled('030000000000000000000000'), false); // odd first byte = disabled
  assert.equal(startup.approvedEnabled(''), true); // empty = enabled
  assert.equal(startup.approvedEnabled('040000000000000000000000'), true);
  assert.equal(startup.approvedEnabled('050000000000000000000000'), false);
});
