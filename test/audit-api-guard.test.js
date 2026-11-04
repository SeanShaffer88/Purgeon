import test from 'node:test';
import assert from 'node:assert/strict';
import { api, __handlers } from '../src/backend/api.js';

test('mutations serialize, reads and cancellation remain available, failures release the guard', async () => {
  const mutations = ['dns:reset', 'tasks:create', 'tasks:stop', 'update:install', 'winget:upgrade', 'junk:cleanSystem', 'snapshots:take', 'monitor:attach', 'startup:delayed'];
  const channels = [...mutations, 'settings:get', 'health:cancel', 'health:run'];
  const saved = Object.fromEntries(channels.map((name) => [name, __handlers[name]]));
  let release;
  try {
    __handlers['health:run'] = () => new Promise((resolve) => { release = resolve; });
    for (const name of mutations) __handlers[name] = async () => 'mutation';
    __handlers['settings:get'] = async () => 'read';
    __handlers['health:cancel'] = async () => 'cancel';
    const running = api.invoke('health:run');
    try {
      for (const name of mutations) await assert.rejects(api.invoke(name), /in progress/, name);
      assert.equal(await api.invoke('settings:get'), 'read');
      assert.equal(await api.invoke('health:cancel'), 'cancel');
    } finally { release(); await running; }
    __handlers['dns:reset'] = async () => { throw Error('fixture failure'); };
    await assert.rejects(api.invoke('dns:reset'), /fixture failure/);
    assert.equal(await api.invoke('tasks:create'), 'mutation');
    __handlers['fixture:newOperation'] = async () => 'new';
    const held = api.invoke('health:run');
    try { await assert.rejects(api.invoke('fixture:newOperation'), /in progress/); }
    finally { release(); await held; delete __handlers['fixture:newOperation']; }
  } finally { Object.assign(__handlers, saved); }
});
