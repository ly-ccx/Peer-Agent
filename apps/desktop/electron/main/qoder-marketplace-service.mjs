const DEFAULT_BASE_URL = 'https://qoder.com';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_PAGE_SIZE = 50;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`qoder_invalid_${label}`);
  return value.trim();
}

function optionalPositiveInt(value, label, max) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`qoder_invalid_${label}`);
  return value;
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) throw new Error('qoder_invalid_download_url');
  return candidate;
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function mapEntry(item) {
  if (!item || typeof item !== 'object') throw new Error('qoder_invalid_entry');
  const skillId = requiredString(item.skill_id, 'skill_id');
  return {
    skillId,
    name: typeof item.display_name === 'string' && item.display_name ? item.display_name : (item.skill_name ?? skillId),
    nameCn: typeof item.display_name_cn === 'string' && item.display_name_cn ? item.display_name_cn : (item.skill_name_cn ?? item.skill_name ?? skillId),
    description: typeof item.description === 'string' ? item.description : '',
    descriptionCn: typeof item.description_cn === 'string' ? item.description_cn : '',
    iconUrl: typeof item.icon_url === 'string' && item.icon_url ? item.icon_url : null,
    author: typeof item.author === 'string' ? item.author : '',
    authorName: typeof item.author_name === 'string' ? item.author_name : '',
    installCount: Number.isFinite(item.install_count) ? item.install_count : 0,
    category: typeof item.category === 'string' ? item.category : '',
    contentUpdatedAt: toEpochMs(item.content_updated_at),
  };
}

function mapFileNode(node) {
  if (!node || typeof node !== 'object') return null;
  const files = Array.isArray(node.files) ? node.files.map(mapFileNode).filter(Boolean) : [];
  return {
    name: typeof node.name === 'string' ? node.name : '',
    path: typeof node.path === 'string' ? node.path : '/',
    type: node.type === 'directory' ? 'directory' : 'file',
    size: Number.isFinite(node.size) ? node.size : 0,
    files,
  };
}

export function createQoderApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function requestJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'PeerAgent/0.0.9 (skill marketplace)' },
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!response.ok) {
        const errorCode = payload?.errorCode ?? response.status;
        throw new Error(`qoder_api_error_${errorCode}`);
      }
      if (!payload || typeof payload !== 'object') throw new Error('qoder_api_invalid_payload');
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestBinary(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs * 3);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'PeerAgent/0.0.9 (skill marketplace)' },
      });
      if (!response.ok) throw new Error(`qoder_download_error_${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_ZIP_BYTES) throw new Error('qoder_zip_size_invalid');
      return buffer;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async listSkills({ keyword, page = 1, pageSize = 20, sortBy = 'hot' } = {}) {
      const safePage = optionalPositiveInt(page, 'page', 100000) ?? 1;
      const safePageSize = optionalPositiveInt(pageSize, 'page_size', MAX_PAGE_SIZE) ?? 20;
      const params = new URLSearchParams();
      params.append('extension_types', 'skill');
      params.append('page', String(safePage));
      params.append('page_size', String(safePageSize));
      if (sortBy === 'hot' || sortBy === 'latest') params.append('sort_by', sortBy);
      if (typeof keyword === 'string' && keyword.trim()) params.append('keyword', keyword.trim());
      const payload = await requestJson(`/apphub/api/v1/marketplace/catalog/extensions?${params.toString()}`);
      const skills = payload.skills;
      if (!skills || !Array.isArray(skills.items)) throw new Error('qoder_api_invalid_payload');
      const pages = skills.pages ?? {};
      const nextPage = Number.isSafeInteger(pages.next_page) ? pages.next_page : null;
      return {
        currentPage: Number.isSafeInteger(pages.current_page) ? pages.current_page : safePage,
        nextPage: nextPage && nextPage > safePage ? nextPage : null,
        lastPage: Number.isSafeInteger(pages.last_page) ? pages.last_page : safePage,
        pageSize: Number.isSafeInteger(pages.page_size) ? pages.page_size : safePageSize,
        totalSize: Number.isSafeInteger(pages.total_size) ? pages.total_size : skills.items.length,
        items: skills.items.map(mapEntry),
      };
    },

    async getSkillDetail({ skillId }) {
      const id = requiredString(skillId, 'skill_id');
      const payload = await requestJson(`/apphub/api/v1/marketplace/skills/${encodeURIComponent(id)}/detail`);
      const raw = payload.skill ?? payload;
      const downloadUrl = normalizeUrl(raw.download_url);
      if (!downloadUrl) throw new Error('qoder_invalid_download_url');
      return {
        skillId: id,
        name: typeof raw.skill_name === 'string' ? raw.skill_name : id,
        nameCn: typeof raw.skill_name_cn === 'string' && raw.skill_name_cn ? raw.skill_name_cn : (raw.skill_name ?? id),
        description: typeof raw.description === 'string' ? raw.description : '',
        descriptionCn: typeof raw.description_cn === 'string' ? raw.description_cn : '',
        iconUrl: typeof raw.icon_url === 'string' && raw.icon_url ? raw.icon_url : null,
        author: typeof raw.author === 'string' ? raw.author : '',
        authorName: typeof raw.author_name === 'string' ? raw.author_name : '',
        installCount: Number.isFinite(raw.install_count) ? raw.install_count : 0,
        category: typeof raw.category === 'string' ? raw.category : '',
        version: typeof raw.version === 'string' && raw.version ? raw.version : 'unknown',
        downloadUrl,
        githubPath: typeof raw.github_path === 'string' && raw.github_path ? raw.github_path : null,
        skillMd: null,
        fileTree: mapFileNode(raw.file_tree),
      };
    },

    async getSkillFile({ skillId, path = '/SKILL.md' } = {}) {
      const id = requiredString(skillId, 'skill_id');
      const filePath = typeof path === 'string' && path.startsWith('/') ? path : `/${path}`;
      const payload = await requestJson(`/api/v1/marketplace/skills/${encodeURIComponent(id)}/files?path=${encodeURIComponent(filePath)}`);
      if (typeof payload.content !== 'string') return null;
      return payload.content;
    },

    downloadZip(url) {
      const target = normalizeUrl(url);
      if (!target) throw new Error('qoder_invalid_download_url');
      return requestBinary(target);
    },
  });
}

export function createQoderMarketplaceService({ apiClient, installSkillFromZip }) {
  if (!apiClient) throw new TypeError('apiClient is required');
  if (typeof installSkillFromZip !== 'function') throw new TypeError('installSkillFromZip must be a function');

  return Object.freeze({
    query: (query) => apiClient.listSkills(query ?? {}),
    getSkillDetail: (identity) => apiClient.getSkillDetail(identity),

    async getSkillDetailWithReadme(identity) {
      const detail = await apiClient.getSkillDetail(identity);
      let skillMd = null;
      try {
        skillMd = await apiClient.getSkillFile({ skillId: detail.skillId, path: '/SKILL.md' });
      } catch {
        skillMd = null; // SKILL.md 拉取失败不阻塞详情展示
      }
      return { ...detail, skillMd };
    },

    async install({ skillId, scope = 'global', iconUrl = null }) {
      const id = requiredString(skillId, 'skill_id');
      const installScope = scope === 'workspace' ? 'workspace' : 'global';
      const detail = await apiClient.getSkillDetail({ skillId: id });
      const zipBuffer = await apiClient.downloadZip(detail.downloadUrl);
      const installed = await installSkillFromZip(zipBuffer, {
        scope: installScope,
        source: 'qoder-marketplace',
        iconUrl,
        meta: {
          marketplace: 'qoder',
          skillId: id,
          version: detail.version,
          author: detail.authorName || detail.author,
          category: detail.category,
          installCount: detail.installCount,
          downloadUrl: detail.downloadUrl,
        },
      });
      if (!installed?.id && !installed?.skillId) throw new Error('qoder_install_failed');
      return {
        ok: true,
        skillId: id,
        installedSkillId: installed.skillId ?? installed.id,
        version: detail.version,
        scope: installScope,
      };
    },
  });
}
