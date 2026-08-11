import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillHubMarketplaceStore } from './skillhub-marketplace-store.mjs';

function item(id, overrides = {}) {
  const [namespace, slug] = id.split('/');
  return {
    catalogId: `skillhub:${id}`, namespace, slug, canonicalName: `@${id}`, name: slug, description: `${slug} description`, descriptionOriginal: '',
    version: '1.0.0', category: 'development', subCategories: [], labels: {}, source: 'community', sourceUrl: null, iconUrl: null,
    ownerName: namespace, score: 10, downloads: 1, installs: 0, stars: 0, verified: false, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function storeFile(name) { return path.join(mkdtempSync(path.join(os.tmpdir(), name)), 'skillhub-index.json'); }

test('syncs every page, de-duplicates identities, and persists a completed checkpoint', async () => {
  const calls = [];
  const pages = {
    1: { page: 1, pageSize: 2, total: 3, items: [item('a/one'), item('a/two')] },
    2: { page: 2, pageSize: 2, total: 3, items: [item('a/two', { score: 99 }), item('b/three')] },
  };
  const filePath = storeFile('skillhub-sync-');
  const store = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => { calls.push(page); return pages[page]; } }, now: () => 123 });
  const status = await store.sync();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(status.indexed, 3);
  assert.equal(status.nextPage, 1);
  assert.equal(store.getById('skillhub:a/two').score, 99);
  const restored = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills() { throw new Error('not called'); } } });
  assert.equal(restored.query().total, 3);
});

test('advances past a page containing only malformed records and keeps skip diagnostics', async () => {
  const calls = [];
  const store = createSkillHubMarketplaceStore({ filePath: storeFile('skillhub-skipped-'), apiClient: { listSkills: async ({ page }) => {
    calls.push(page);
    return page === 1
      ? { page, pageSize: 1, total: 2, received: 1, items: [], skipped: 1, skippedReasons: { skillhub_invalid_namespace: 1 } }
      : { page, pageSize: 1, total: 2, received: 1, items: [item('a/valid')], skipped: 0, skippedReasons: {} };
  } } });
  await store.sync();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.getStatus().status, 'idle');
  assert.equal(store.getStatus().nextPage, 1);
  assert.equal(store.getStatus().skipped, 1);
  assert.deepEqual(store.getStatus().skippedReasons, { skillhub_invalid_namespace: 1 });
  assert.deepEqual(store.query().items.map((entry) => entry.slug), ['valid']);
});

test('resumes from the persisted next page after an interrupted bounded sync', async () => {
  const filePath = storeFile('skillhub-resume-');
  const firstCalls = [];
  const first = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => {
    firstCalls.push(page); return { page, pageSize: 1, total: 2, items: [item('a/one')] };
  } } });
  await first.sync({ maxPages: 1 });
  assert.deepEqual(firstCalls, [1]);
  assert.equal(first.getStatus().nextPage, 2);
  const resumedCalls = [];
  const resumed = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => {
    resumedCalls.push(page); return { page, pageSize: 1, total: 2, items: [item('b/two')] };
  } } });
  await resumed.sync();
  assert.deepEqual(resumedCalls, [2]);
  assert.equal(resumed.query().total, 2);
});

test('restarts at the failed page after process recreation', async () => {
  const filePath = storeFile('skillhub-failed-page-');
  const failedCalls = [];
  const first = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => {
    failedCalls.push(page);
    if (page === 2) throw new Error('temporary_network_failure');
    return { page, pageSize: 1, total: 3, items: [item('a/one')] };
  } } });
  await assert.rejects(() => first.sync(), /temporary_network_failure/);
  assert.deepEqual(failedCalls, [1, 2]);
  assert.equal(first.getStatus().nextPage, 2);

  const resumedCalls = [];
  const resumed = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => {
    resumedCalls.push(page);
    return { page, pageSize: 1, total: 3, items: [item(page === 2 ? 'b/two' : 'c/three')] };
  } } });
  await resumed.sync();
  assert.deepEqual(resumedCalls, [2, 3]);
  assert.equal(resumed.query().total, 3);
  assert.equal(resumed.getStatus().status, 'idle');
});

test('publishes a completed refresh atomically and removes entries deleted upstream', async () => {
  const filePath = storeFile('skillhub-refresh-');
  let generation = 1;
  const store = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async () => generation === 1
    ? { page: 1, pageSize: 100, total: 2, items: [item('a/kept'), item('a/deleted')] }
    : { page: 1, pageSize: 100, total: 1, items: [item('a/kept', { score: 42 })] }
  } });
  await store.sync();
  assert.equal(store.query().total, 2);
  generation = 2;
  await store.sync();
  assert.equal(store.query().total, 1);
  assert.equal(store.getById('skillhub:a/deleted'), null);
  assert.equal(store.getById('skillhub:a/kept').score, 42);
});

test('keeps the last complete snapshot visible when a refresh fails', async () => {
  const filePath = storeFile('skillhub-refresh-failure-');
  let fail = false;
  const store = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async ({ page }) => {
    if (fail && page === 2) throw new Error('refresh_failed');
    if (fail) return { page: 1, pageSize: 1, total: 2, items: [item('b/new')] };
    return { page: 1, pageSize: 100, total: 1, items: [item('a/stable')] };
  } } });
  await store.sync();
  fail = true;
  await assert.rejects(() => store.sync(), /refresh_failed/);
  assert.deepEqual(store.query().items.map((entry) => entry.slug), ['stable']);
  assert.equal(store.getStatus().nextPage, 2);
});

test('keeps a legacy index readable but marks it stale for a v3 refresh', () => {
  const filePath = storeFile('skillhub-legacy-');
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    source: 'skillhub',
    updatedAt: 999,
    sync: { status: 'syncing', nextPage: 10, total: 1000, error: null },
    items: [item('legacy/visible')],
  }));
  const store = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async () => { throw new Error('not called'); } } });
  assert.equal(store.query().items[0].slug, 'visible');
  assert.equal(store.getStatus().updatedAt, null);
  assert.equal(store.getStatus().nextPage, 1);
});

test('supports local search, category filters, sorting and pagination', async () => {
  const store = createSkillHubMarketplaceStore({ filePath: storeFile('skillhub-query-'), apiClient: {
    listSkills: async () => ({
      page: 1, pageSize: 100, total: 3, items: [
        item('a/alpha', { description: 'MCP tools', downloads: 4, score: 1 }),
        item('b/beta', { category: 'design', downloads: 20, score: 2 }),
        item('c/gamma', { description: 'MCP server', downloads: 10, score: 3 }),
      ],
    }),
    listCategories: async () => ({
      count: 2,
      items: [
        { key: 'design', name: '设计多媒体', nameEn: 'Design Media', sortOrder: 10, active: true, level: 1, version: 2 },
        { key: 'development', name: '开发编程', nameEn: 'Dev Programming', sortOrder: 20, active: true, level: 1, version: 2 },
      ],
    }),
  } });
  await store.sync();
  const search = store.query({ keyword: 'mcp', sortBy: 'downloads', page: 1, pageSize: 1 });
  assert.equal(search.total, 2);
  assert.equal(search.items[0].slug, 'gamma');
  assert.equal(store.query({ category: 'design' }).items[0].slug, 'beta');
  assert.equal(store.getCategoryName('design'), '设计多媒体');
  assert.deepEqual(store.listCategories().map((item) => item.key), ['design', 'development']);
});

test('supports featured, stars, created and rising sort semantics', async () => {
  const now = Date.now();
  const store = createSkillHubMarketplaceStore({
    filePath: storeFile('skillhub-sort-'),
    apiClient: {
      listSkills: async () => ({
        page: 1,
        pageSize: 100,
        total: 4,
        items: [
          item('a/old-popular', { downloads: 100, stars: 1, score: 10, verified: false, createdAt: now - 40 * 864e5, updatedAt: now - 40 * 864e5 }),
          item('b/verified-mid', { downloads: 20, stars: 8, score: 50, verified: true, createdAt: now - 20 * 864e5, updatedAt: now - 2 * 864e5 }),
          item('c/new-hot', { downloads: 80, stars: 3, score: 30, verified: false, createdAt: now - 1 * 864e5, updatedAt: now - 1 * 864e5 }),
          item('d/starred', { downloads: 15, stars: 30, score: 20, verified: false, createdAt: now - 10 * 864e5, updatedAt: now - 3 * 864e5 }),
        ],
      }),
    },
  });
  await store.sync();
  assert.equal(store.query({ sortBy: 'featured' }).items[0].slug, 'verified-mid');
  assert.equal(store.query({ sortBy: 'stars' }).items[0].slug, 'starred');
  assert.equal(store.query({ sortBy: 'created' }).items[0].slug, 'new-hot');
  assert.equal(store.query({ sortBy: 'rising' }).items[0].slug, 'new-hot');
  assert.ok(store.query({ sortBy: 'rising' }).items.every((entry) => entry.updatedAt >= now - 14 * 864e5));
});

test('persists failure status without losing the previous checkpoint', async () => {
  const filePath = storeFile('skillhub-error-');
  const store = createSkillHubMarketplaceStore({ filePath, apiClient: { listSkills: async () => { throw new Error('network_down'); } } });
  await assert.rejects(() => store.sync(), /network_down/);
  assert.equal(store.getStatus().status, 'error');
  assert.equal(store.getStatus().nextPage, 1);
});
