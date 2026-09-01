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
      uninstall: port('uninstall'),
      marketplaceList: port('marketplace-list'),
      marketplaceGetDetail: port('marketplace-get-detail'),
      marketplaceInstall: port('marketplace-install'),
      skillHubQuery: port('skillhub-query'),
      skillHubGetDetail: port('skillhub-get-detail'),
      skillHubGetStatus: port('skillhub-get-status'),
      skillHubSync: port('skillhub-sync'),
      skillHubInstall: port('skillhub-install'),
      skillHubListCategories: port('skillhub-list-categories'),
      qoderQuery: port('qoder-query'),
      qoderGetDetail: port('qoder-get-detail'),
      qoderInstall: port('qoder-install'),
      qoderListTaxonomies: port('qoder-list-taxonomies'),
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
    'skills:marketplace:get-detail',
    'skills:marketplace:install',
    'skills:marketplace:list',
    'skills:qoder:get-detail',
    'skills:qoder:install',
    'skills:qoder:list-taxonomies',
    'skills:qoder:query',
    'skills:refresh',
    'skills:skillhub:get-detail',
    'skills:skillhub:get-status',
    'skills:skillhub:install',
    'skills:skillhub:list-categories',
    'skills:skillhub:query',
    'skills:skillhub:sync',
    'skills:uninstall',
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
  assert.equal(await handlers.get('skills:uninstall')(null, { skillId: 'skill-3' }), 'uninstall');
  assert.equal(await handlers.get('skills:marketplace:list')(), 'marketplace-list');
  assert.equal(await handlers.get('skills:marketplace:get-detail')(null, { catalogId: 'owned/demo' }), 'marketplace-get-detail');
  assert.equal(await handlers.get('skills:marketplace:install')(null, { catalogId: 'owned/demo' }), 'marketplace-install');
  assert.equal(await handlers.get('skills:skillhub:query')(null, { page: 2 }), 'skillhub-query');
  assert.equal(await handlers.get('skills:skillhub:get-detail')(null, { namespace: 'owner', slug: 'demo' }), 'skillhub-get-detail');
  assert.equal(await handlers.get('skills:skillhub:get-status')(), 'skillhub-get-status');
  assert.equal(await handlers.get('skills:skillhub:sync')(null, { reset: true }), 'skillhub-sync');
  assert.equal(await handlers.get('skills:skillhub:install')(null, { namespace: 'owner', slug: 'demo', version: '1' }), 'skillhub-install');
  assert.equal(await handlers.get('skills:skillhub:list-categories')(), 'skillhub-list-categories');
  assert.equal(await handlers.get('skills:qoder:query')(null, { page: 1, keyword: 'pdf' }), 'qoder-query');
  assert.equal(await handlers.get('skills:qoder:get-detail')(null, { skillId: 'official03866510' }), 'qoder-get-detail');
  assert.equal(await handlers.get('skills:qoder:install')(null, { skillId: 'official03866510' }), 'qoder-install');
  assert.equal(await handlers.get('skills:qoder:list-taxonomies')(), 'qoder-list-taxonomies');

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
    ['uninstall', 'skill-3'],
    ['marketplace-list'],
    ['marketplace-get-detail', 'owned/demo'],
    ['marketplace-install', 'owned/demo'],
    ['skillhub-query', { page: 2 }],
    ['skillhub-get-detail', { namespace: 'owner', slug: 'demo' }],
    ['skillhub-get-status'],
    ['skillhub-sync', { reset: true }],
    ['skillhub-install', { namespace: 'owner', slug: 'demo', version: '1' }],
    ['skillhub-list-categories'],
    ['qoder-query', { page: 1, keyword: 'pdf' }],
    ['qoder-get-detail', { skillId: 'official03866510' }],
    ['qoder-install', { skillId: 'official03866510' }],
    ['qoder-list-taxonomies'],
  ]);
});

test('skills IPC rejects missing narrow ports at composition time', () => {
  assert.throws(
    () => createSkillsIpcRegistrations({ skills: {} }),
    /skills\.list must be a function/,
  );
});
