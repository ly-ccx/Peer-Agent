import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQoderApiClient, createQoderMarketplaceService } from './qoder-marketplace-service.mjs';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

function makeClient(listPayload, detailPayload, { filePayload = null, zipBuffer = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/catalog/extensions')) return jsonResponse(listPayload);
    if (url.includes('/detail')) return jsonResponse(detailPayload);
    if (url.includes('/files?')) return jsonResponse(filePayload ?? { name: 'SKILL.md', content: '---\nname: demo\n---\n# demo' });
    return { ok: true, status: 200, arrayBuffer: async () => zipBuffer ?? new Uint8Array([1, 2, 3]).buffer };
  };
  return { client: createQoderApiClient({ fetchImpl }), calls };
}

const LIST_PAYLOAD = {
  skills: {
    items: [{
      skill_id: 'official03866510',
      skill_name: 'deep-research',
      skill_name_cn: '深入研究',
      display_name: 'deep-research',
      display_name_cn: '深入研究',
      description: 'Deep research skill',
      description_cn: '深度研究技能',
      icon_url: '',
      author: 'Jose-Luis-Nunez',
      author_name: 'Jose-Luis-Nunez',
      install_count: 31049,
      category: 'Knowledge',
      content_updated_at: '1783319161575',
    }],
    pages: { prev_page: 1, current_page: 1, next_page: 2, last_page: 2171, page_size: 20, total_size: 43415, next_token: '' },
  },
};

const DETAIL_PAYLOAD = {
  skill_id: 'official03866510',
  skill_name: 'deep-research',
  skill_name_cn: '深入研究',
  description: 'Deep research skill',
  description_cn: '深度研究技能',
  icon_url: '',
  author: 'Jose-Luis-Nunez',
  author_name: 'Jose-Luis-Nunez',
  install_count: 31049,
  category: 'Knowledge',
  version: '1.0.0',
  download_url: 'https://qoder-skills.oss-accelerate.aliyuncs.com/public/deep-research/latest/deep-research.zip',
  github_path: 'https://github.com/Jose-Luis-Nunez/FitnessApp/tree/main/.claude/skills/deep-research',
  file_tree: { name: 'deep-research', path: '/', type: 'directory', size: 0, files: [{ name: 'SKILL.md', path: '/SKILL.md', type: 'file', size: 30142, files: [] }] },
};

test('listSkills maps entries and pagination', async () => {
  const { client, calls } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD);
  const page = await client.listSkills({ keyword: 'research', page: 1, pageSize: 20, sortBy: 'hot' });
  assert.equal(page.items.length, 1);
  const entry = page.items[0];
  assert.equal(entry.skillId, 'official03866510');
  assert.equal(entry.nameCn, '深入研究');
  assert.equal(entry.installCount, 31049);
  assert.equal(entry.contentUpdatedAt, 1783319161575);
  assert.equal(page.currentPage, 1);
  assert.equal(page.nextPage, 2);
  assert.equal(page.lastPage, 2171);
  assert.equal(page.totalSize, 43415);
  assert.ok(calls[0].includes('extension_types=skill'));
  assert.ok(calls[0].includes('keyword=research'));
  assert.ok(calls[0].includes('sort_by=hot'));
});

test('listSkills rejects invalid pagination', async () => {
  const { client } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD);
  await assert.rejects(() => client.listSkills({ page: 0 }), /qoder_invalid_page/);
  await assert.rejects(() => client.listSkills({ pageSize: 999 }), /qoder_invalid_page/);
});

test('getSkillDetail maps detail fields and download url', async () => {
  const { client } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD);
  const detail = await client.getSkillDetail({ skillId: 'official03866510' });
  assert.equal(detail.skillId, 'official03866510');
  assert.equal(detail.version, '1.0.0');
  assert.equal(detail.downloadUrl, DETAIL_PAYLOAD.download_url);
  assert.equal(detail.githubPath, DETAIL_PAYLOAD.github_path);
  assert.equal(detail.fileTree.files[0].name, 'SKILL.md');
});

test('getSkillDetail rejects missing download url', async () => {
  const { client } = makeClient(LIST_PAYLOAD, { ...DETAIL_PAYLOAD, download_url: '' });
  await assert.rejects(() => client.getSkillDetail({ skillId: 'x' }), /qoder_invalid_download_url/);
});

test('install flows detail -> zip download -> installSkillFromZip with meta', async () => {
  const zipBuffer = Buffer.from('fake-zip');
  const { client } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD, { zipBuffer: zipBuffer.buffer });
  const installs = [];
  const service = createQoderMarketplaceService({
    apiClient: client,
    installSkillFromZip: async (buffer, options) => {
      installs.push({ buffer, options });
      return { skillId: 'deep-research' };
    },
  });
  const result = await service.install({ skillId: 'official03866510', scope: 'global', iconUrl: null });
  assert.equal(result.ok, true);
  assert.equal(result.installedSkillId, 'deep-research');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.scope, 'global');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].options.source, 'qoder-marketplace');
  assert.equal(installs[0].options.scope, 'global');
  assert.equal(installs[0].options.meta.marketplace, 'qoder');
  assert.equal(installs[0].options.meta.skillId, 'official03866510');
});

test('install normalizes invalid scope to global', async () => {
  const zipBuffer = Buffer.from('fake-zip');
  const { client } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD, { zipBuffer: zipBuffer.buffer });
  const service = createQoderMarketplaceService({
    apiClient: client,
    installSkillFromZip: async () => ({ skillId: 'deep-research' }),
  });
  const result = await service.install({ skillId: 'official03866510', scope: 'bogus' });
  assert.equal(result.scope, 'global');
});

test('install surfaces installer failure', async () => {
  const zipBuffer = Buffer.from('fake-zip');
  const { client } = makeClient(LIST_PAYLOAD, DETAIL_PAYLOAD, { zipBuffer: zipBuffer.buffer });
  const service = createQoderMarketplaceService({
    apiClient: client,
    installSkillFromZip: async () => null,
  });
  await assert.rejects(() => service.install({ skillId: 'official03866510' }), /qoder_install_failed/);
});

test('api errors surface as qoder_api_error_*', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ errorCode: 'InternalError', errorMessage: 'boom' }),
  });
  const client = createQoderApiClient({ fetchImpl });
  await assert.rejects(() => client.listSkills({}), /qoder_api_error_InternalError/);
});

test('service requires dependencies', () => {
  assert.throws(() => createQoderMarketplaceService({}), TypeError);
  assert.throws(() => createQoderMarketplaceService({ apiClient: {} }), TypeError);
});
