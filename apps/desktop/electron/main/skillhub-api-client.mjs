const DEFAULT_BASE_URL = 'https://api.skillhub.cn';
const MAX_PAGE_SIZE = 100;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`skillhub_invalid_${label}`);
  return value;
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`skillhub_invalid_${label}`);
  return value;
}

function normalizeSkill(raw) {
  const namespace = raw?.namespace;
  const slug = requiredString(raw?.slug, 'slug');
  const handle = requiredString(namespace?.handle, 'namespace');
  return Object.freeze({
    catalogId: `skillhub:${handle}/${slug}`,
    namespace: handle,
    canonicalName: typeof namespace?.canonicalName === 'string' ? namespace.canonicalName : `@${handle}/${slug}`,
    slug,
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name : slug,
    description: (typeof raw?.description_zh === 'string' && raw.description_zh.trim())
      ? raw.description_zh
      : (typeof raw?.description === 'string' ? raw.description : ''),
    descriptionOriginal: typeof raw?.description === 'string' ? raw.description : '',
    version: requiredString(raw?.version, 'version'),
    category: typeof raw?.category === 'string' ? raw.category : 'other',
    subCategories: Array.isArray(raw?.subCategories)
      ? raw.subCategories.filter((item) => item && typeof item.key === 'string').map((item) => ({ key: item.key, name: item.name ?? item.key }))
      : [],
    labels: raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels) ? raw.labels : {},
    source: typeof raw?.source === 'string' ? raw.source : 'unknown',
    sourceUrl: typeof raw?.upstream_url === 'string' && raw.upstream_url
      ? raw.upstream_url
      : (typeof raw?.homepage === 'string' ? raw.homepage : null),
    iconUrl: typeof raw?.iconUrl === 'string' ? raw.iconUrl : null,
    ownerName: typeof raw?.ownerName === 'string' ? raw.ownerName : handle,
    score: Number.isFinite(raw?.score) ? raw.score : 0,
    downloads: requiredInteger(raw?.downloads ?? 0, 'downloads'),
    installs: requiredInteger(raw?.installs ?? 0, 'installs'),
    stars: requiredInteger(raw?.stars ?? 0, 'stars'),
    verified: raw?.verified === true,
    createdAt: requiredInteger(raw?.created_at ?? 0, 'created_at'),
    updatedAt: requiredInteger(raw?.updated_at ?? 0, 'updated_at'),
  });
}

function queryString(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export function createSkillHubApiClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const root = baseUrl.replace(/\/$/, '');

  async function request(path, { binary = false } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      headers: { accept: binary ? 'application/zip' : 'application/json', 'user-agent': 'Peer-Agent-Marketplace/1.0' },
    });
    if (!response.ok) throw new Error(`skillhub_http_${response.status}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  return Object.freeze({
    async listSkills({ page = 1, pageSize = MAX_PAGE_SIZE, sortBy = 'score', keyword, category } = {}) {
      if (!Number.isSafeInteger(page) || page < 1) throw new Error('skillhub_invalid_page');
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new Error('skillhub_invalid_page_size');
      const result = await request(`/api/skills?${queryString({ page, pageSize, sortBy, keyword, category })}`);
      if (!result?.data || !Array.isArray(result.data.skills)) throw new Error('skillhub_invalid_list_response');
      const items = [];
      const skippedReasons = {};
      for (const raw of result.data.skills) {
        try {
          items.push(normalizeSkill(raw));
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'skillhub_invalid_skill';
          skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
        }
      }
      return Object.freeze({
        page,
        pageSize,
        total: requiredInteger(result.data.total, 'total'),
        received: result.data.skills.length,
        items,
        skipped: result.data.skills.length - items.length,
        skippedReasons: Object.freeze(skippedReasons),
      });
    },
    getSkillDetail({ namespace, slug }) {
      return request(`/api/v1/skills/${encodeURIComponent(requiredString(slug, 'slug'))}?${queryString({ namespace: requiredString(namespace, 'namespace') })}`);
    },
    getSkillFiles({ namespace, slug, version }) {
      return request(`/api/v1/skills/${encodeURIComponent(requiredString(slug, 'slug'))}/files?${queryString({ version: requiredString(version, 'version'), namespace: requiredString(namespace, 'namespace') })}`);
    },
    getPlatformKeys() {
      return request('/api/v1/open/platform/keys');
    },
    getVersionSignature({ namespace, slug, version }) {
      return request(`/api/v1/open/skills/${encodeURIComponent(requiredString(slug, 'slug'))}/versions/${encodeURIComponent(requiredString(version, 'version'))}/signature?${queryString({ namespace: requiredString(namespace, 'namespace') })}`);
    },
    downloadSkill({ namespace, slug, version }) {
      return request(`/api/download?${queryString({ slug: requiredString(slug, 'slug'), version: requiredString(version, 'version'), namespace: requiredString(namespace, 'namespace') })}`, { binary: true });
    },
    async listCategories() {
      const result = await request('/api/v1/categories');
      const items = Array.isArray(result?.items) ? result.items : (Array.isArray(result?.data?.items) ? result.data.items : null);
      if (!Array.isArray(items)) throw new Error('skillhub_invalid_categories_response');
      return Object.freeze({
        count: requiredInteger(result?.count ?? result?.data?.count ?? items.length, 'count'),
        items: items
          .filter((item) => item && typeof item.key === 'string' && item.key.trim())
          .map((item) => Object.freeze({
            key: item.key.trim(),
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.key.trim(),
            nameEn: typeof item.nameEn === 'string' ? item.nameEn : '',
            sortOrder: Number.isSafeInteger(item.sortOrder) ? item.sortOrder : 0,
            active: item.active !== false,
            level: Number.isSafeInteger(item.level) ? item.level : 1,
            version: Number.isSafeInteger(item.version) ? item.version : 0,
          }))
          .filter((item) => item.active)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
      });
    },
  });
}

export const SKILLHUB_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
