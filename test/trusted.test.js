import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as trusted from '../src/backend/trusted.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('trusted list starts empty', async () => {
  const list = await trusted.list();
  assert.ok(Array.isArray(list));
});

test('trusted add then list contains it', async () => {
  await trusted.add('Microsoft Corporation');
  const list = await trusted.list();
  assert.ok(list.includes('Microsoft Corporation'));
});

test('trusted add normalizes duplicates', async () => {
  await trusted.add('Adobe Inc.');
  await trusted.add('Adobe Inc.');
  const list = await trusted.list();
  const count = list.filter((p) => p.toLowerCase() === 'adobe inc.').length;
  assert.equal(count, 1, 'duplicate publisher should be deduplicated');
});

test('trusted remove removes entry', async () => {
  await trusted.add('Example Corp');
  await trusted.remove('Example Corp');
  const list = await trusted.list();
  assert.ok(!list.includes('Example Corp'));
});

test('trusted isTrusted returns match or null', async () => {
  await trusted.add('Test Publisher');
  assert.ok(await trusted.isTrusted('Test Publisher'));
  assert.equal(await trusted.isTrusted('Unknown Publisher'), null);
  assert.equal(await trusted.isTrusted(''), null);
  assert.equal(await trusted.isTrusted(null), null);
});

test('trusted add rejects empty name', async () => {
  await assert.rejects(trusted.add(''), /required/);
  await assert.rejects(trusted.add('   '), /required/);
});

test('filterInsights marks trusted signers', async () => {
  await trusted.add('Signed Publisher');
  const insights = {
    prog1: { signer: 'Signed Publisher', name: 'Prog 1' },
    prog2: { signer: 'Other Publisher', name: 'Prog 2' },
    prog3: { name: 'No Signer' },
  };
  const out = await trusted.filterInsights(insights);
  assert.ok(out.prog1.trusted);
  assert.equal(out.prog2.trusted, undefined);
  assert.equal(out.prog3.trusted, undefined);
});
