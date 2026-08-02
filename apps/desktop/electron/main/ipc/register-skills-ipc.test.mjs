import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillsIpcRegistrations } from './register-skills-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createSkillsIpcRegistrations({
    skills: {
      list: port('list'),
      getDetail: port('get-detail'),
      refresh: port('refresh'),
      upload: port('upload'),
      enable: port('enable'),
      disable: port('disable'),
      listAvailable: port('list-available'),
      link: port('link'),
      unlink: port('unlink'),
    },
  });
  const handlers = new Map();
  const ipc = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  };
  for (const registration of registrations) registration.register(ipc);
  return { calls, handlers, registrations };
}

test('skills IPC has one owner for the exact canonical channel set', () => {
  const { handlers, registrations } = createHarness();

  assert.deepEqual(registrations.map(({ owner }) => owner), ['skills-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'skills:disable',
    'skills:enable',
    'skills:get-detail',
    'skills:link',
    'skills:list',
    'skills:list-available',
    'skills:refresh',
    'skills:unlink',
    'skills:upload',
  ]);
});

test('skills IPC preserves payload and result projection', async () => {
  const { calls, handlers } = createHarness();

  assert.equal(await handlers.get('skills:list')(), 'list');
  assert.equal(await handlers.get('skills:get-detail')(null, { skillId: 'skill-1' }), 'get-detail');
  assert.equal(await handlers.get('skills:get-detail')(null), 'get-detail');
  assert.equal(await handlers.get('skills:refresh')(), 'refresh');
  assert.equal(await handlers.get('skills:upload')(null, { zipBase64: 'emlw' }), 'upload');
  assert.equal(await handlers.get('skills:enable')(null, { skillId: 'skill-1' }), 'enable');
  assert.equal(await handlers.get('skills:disable')(null, { skillId: 'skill-1' }), 'disable');
  assert.equal(await handlers.get('skills:list-available')(), 'list-available');
  assert.equal(await handlers.get('skills:link')(null, { skillId: 'skill-2' }), 'link');
  assert.equal(await handlers.get('skills:unlink')(null, { skillId: 'skill-2' }), 'unlink');

  assert.deepEqual(calls, [
    ['list'],
    ['get-detail', 'skill-1'],
    ['get-detail', undefined],
    ['refresh'],
    ['upload', 'emlw'],
    ['enable', 'skill-1'],
    ['disable', 'skill-1'],
    ['list-available'],
    ['link', 'skill-2'],
    ['unlink', 'skill-2'],
  ]);
});

test('skills IPC rejects missing narrow ports at composition time', () => {
  assert.throws(
    () => createSkillsIpcRegistrations({ skills: {} }),
    /skills\.list must be a function/,
  );
});
