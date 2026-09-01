import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillHubMarketplaceService, mapSkillHubRemoteSortBy } from './skillhub-marketplace-service.mjs';

const ITEM = Object.freeze({
  catalogId: 'skillhub:owner/demo-skill',
  namespace: 'owner',
  slug: 'demo-skill',
  name: 'Demo Skill',
});

function createService({ listSkills, listCategories, getSkillDetail, install } = {}) {
  const calls = [];
  const service = createSkillHubMarketplaceService({
    now: () => 1_700_000_000_000,
    installer: {
      install: install ?? (async (identity) => ({ ok: true, skillId: identity.slug })),
    },
    apiClient: {
      listSkills: async (query) => {
        calls.push(query);
        return listSkills ? listSkills(query) : {
          page: query.page,
          pageSize: query.pageSize,
          total: 128,
          items: [ITEM],
          skipped: 1,
          skippedReasons: { skillhub_invalid_skill: 1 },
        };
      },
      listCategories: listCategories ?? (async () => ({ items: [{ key: 'dev', name: '开发编程' }] })),
      getSkillDetail: getSkillDetail ?? (async (identity) => identity),
    },
  });
  return { service, calls };
}

test('maps UI sort keys onto SkillHub remote sortBy values', () => {
  assert.equal(mapSkillHubRemoteSortBy('score'), 'score');
  assert.equal(mapSkillHubRemoteSortBy('downloads'), 'downloads');
  assert.equal(mapSkillHubRemoteSortBy('stars'), 'stars');
  assert.equal(mapSkillHubRemoteSortBy('installs'), 'installs');
  assert.equal(mapSkillHubRemoteSortBy('updated'), 'updated_at');
  assert.equal(mapSkillHubRemoteSortBy('featured'), 'score');
  assert.equal(mapSkillHubRemoteSortBy(undefined), 'score');
});

test('query forwards keyword, category, pagination and mapped sort to listSkills', async () => {
  const { service, calls } = createService();
  const page = await service.query({
    page: 2,
    pageSize: 24,
    keyword: ' mcp tools ',
    category: 'dev',
    sortBy: 'updated',
  });
  assert.deepEqual(calls[0], {
    page: 2,
    pageSize: 24,
    keyword: 'mcp tools',
    category: 'dev',
    sortBy: 'updated_at',
  });
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 24);
  assert.equal(page.total, 128);
  assert.equal(page.items[0].catalogId, ITEM.catalogId);
  assert.equal(page.sync.status, 'idle');
  assert.equal(page.sync.total, 128);
  assert.equal(page.sync.indexed, 1);
  assert.equal(page.sync.updatedAt, 1_700_000_000_000);
  assert.equal(page.sync.skipped, 1);
});

test('query omits empty keyword/category and falls back unknown sort to score', async () => {
  const { service, calls } = createService();
  await service.query({ page: 1, pageSize: 24, keyword: '  ', category: '', sortBy: 'rising' });
  assert.deepEqual(calls[0], {
    page: 1,
    pageSize: 24,
    keyword: undefined,
    category: undefined,
    sortBy: 'score',
  });
});

test('sync does not call listSkills and only returns last remote query status', async () => {
  const { service, calls } = createService();
  const idle = await service.sync();
  assert.equal(calls.length, 0);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.updatedAt, null);
  await service.query({ page: 3, pageSize: 24, sortBy: 'downloads' });
  const status = await service.sync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sortBy, 'downloads');
  assert.equal(status.updatedAt, 1_700_000_000_000);
  assert.equal(status.total, 128);
});

test('listCategories reads the remote dictionary without a local index file', async () => {
  const { service } = createService();
  const items = await service.listCategories();
  assert.deepEqual(items, [{ key: 'dev', name: '开发编程' }]);
});

test('install stays on the verified installer path', async () => {
  const installs = [];
  const { service } = createService({
    install: async (identity) => {
      installs.push(identity);
      return { ok: true, skillId: 'demo-skill' };
    },
  });
  const result = await service.install({ namespace: 'owner', slug: 'demo-skill', version: '1.0.0' });
  assert.equal(result.ok, true);
  assert.equal(installs[0].slug, 'demo-skill');
});

test('service requires installer and listSkills', () => {
  assert.throws(() => createSkillHubMarketplaceService({}), TypeError);
  assert.throws(() => createSkillHubMarketplaceService({ apiClient: {}, installer: { install() {} } }), TypeError);
  assert.throws(() => createSkillHubMarketplaceService({ apiClient: { listSkills() {} }, installer: {} }), TypeError);
});
