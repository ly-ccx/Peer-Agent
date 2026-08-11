import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillHubApiClient } from './skillhub-api-client.mjs';

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, arrayBuffer: async () => new ArrayBuffer(0) };
}

const rawSkill = {
  slug: 'demo-skill', name: 'Demo Skill', version: '1.2.3', namespace: { handle: 'owner', canonicalName: '@owner/demo-skill' },
  description: 'Original', description_zh: '中文简介', category: 'development-tools', subCategories: [{ key: 'testing', name: '测试' }],
  labels: { requires_api_key: 'false' }, source: 'community', homepage: 'https://example.test/demo', iconUrl: null, ownerName: 'Owner',
  score: 99, downloads: 10, installs: 4, stars: 2, verified: true, created_at: 1000, updated_at: 2000,
};

test('normalizes SkillHub list responses and encodes filters', async () => {
  const urls = [];
  const client = createSkillHubApiClient({ baseUrl: 'https://skillhub.test/', fetchImpl: async (url) => {
    urls.push(String(url));
    return jsonResponse({ data: { total: 1, skills: [rawSkill] } });
  } });
  const page = await client.listSkills({ page: 2, pageSize: 50, sortBy: 'score', keyword: 'mcp tools', category: 'dev' });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].catalogId, 'skillhub:owner/demo-skill');
  assert.equal(page.items[0].description, '中文简介');
  assert.match(urls[0], /page=2/);
  assert.match(urls[0], /keyword=mcp\+tools/);
});

test('skips malformed list records without weakening stable marketplace identity', async () => {
  const malformed = { ...rawSkill, slug: 'broken-skill', namespace: null };
  const client = createSkillHubApiClient({ fetchImpl: async () => jsonResponse({ data: { total: 2, skills: [rawSkill, malformed] } }) });
  const page = await client.listSkills();
  assert.equal(page.received, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].catalogId, 'skillhub:owner/demo-skill');
  assert.equal(page.skipped, 1);
  assert.deepEqual(page.skippedReasons, { skillhub_invalid_namespace: 1 });
});

test('normalizes SkillHub categories and filters inactive entries', async () => {
  const urls = [];
  const client = createSkillHubApiClient({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse({
        count: 3,
        items: [
          { key: 'office-efficiency', name: '办公效率', nameEn: 'Office Efficiency', sortOrder: 20, active: true, level: 1, version: 2 },
          { key: 'pay-skill', name: 'Pay Skill', nameEn: 'Pay Skill', sortOrder: 10, active: true, level: 1, version: 2 },
          { key: 'legacy', name: '旧分类', nameEn: 'Legacy', sortOrder: 1, active: false, level: 1, version: 1 },
        ],
      });
    },
  });
  const result = await client.listCategories();
  assert.equal(result.count, 3);
  assert.deepEqual(result.items.map((item) => item.key), ['pay-skill', 'office-efficiency']);
  assert.equal(result.items[1].name, '办公效率');
  assert.match(urls[0], /\/api\/v1\/categories$/);
});

test('rejects page sizes over the observed SkillHub limit and malformed responses', async () => {
  const client = createSkillHubApiClient({ fetchImpl: async () => jsonResponse({ data: { total: 0, skills: [] } }) });
  await assert.rejects(() => client.listSkills({ pageSize: 101 }), /invalid_page_size/);
  const malformed = createSkillHubApiClient({ fetchImpl: async () => jsonResponse({ data: {} }) });
  await assert.rejects(() => malformed.listSkills(), /invalid_list_response/);
});

test('uses namespace, slug and version for detail, files, signature and ZIP endpoints', async () => {
  const urls = [];
  const client = createSkillHubApiClient({ baseUrl: 'https://skillhub.test', fetchImpl: async (url) => {
    urls.push(String(url));
    if (String(url).includes('/api/download')) {
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer };
    }
    return jsonResponse({ ok: true });
  } });
  const identity = { namespace: 'owner name', slug: 'demo-skill', version: '1.2.3-beta' };
  await client.getSkillDetail(identity);
  await client.getSkillFiles(identity);
  await client.getVersionSignature(identity);
  const zip = await client.downloadSkill(identity);
  assert.deepEqual([...zip], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(urls.length, 4);
  assert.equal(urls.every((url) => url.includes('namespace=owner+name')), true);
  assert.match(urls[2], /versions\/1.2.3-beta\/signature/);
});

test('surfaces non-success HTTP status as a stable SkillHub error', async () => {
  const client = createSkillHubApiClient({ fetchImpl: async () => jsonResponse({}, 429) });
  await assert.rejects(() => client.listSkills(), /skillhub_http_429/);
});
