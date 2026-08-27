const REMOTE_SORT_BY = Object.freeze({
  score: 'score',
  downloads: 'downloads',
  stars: 'stars',
  installs: 'installs',
  updated: 'updated_at',
});

function emptyStatus(overrides = {}) {
  return {
    status: 'idle',
    nextPage: 1,
    total: 0,
    indexed: 0,
    updatedAt: null,
    error: null,
    skipped: 0,
    skippedReasons: {},
    ...overrides,
  };
}

export function mapSkillHubRemoteSortBy(sortBy) {
  return REMOTE_SORT_BY[sortBy] ?? 'score';
}

function toPage(result, now) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    items,
    sync: emptyStatus({
      total: result.total,
      indexed: items.length,
      updatedAt: now(),
      skipped: result.skipped ?? 0,
      skippedReasons: result.skippedReasons ?? {},
    }),
  };
}

export function createSkillHubMarketplaceService({ installer, apiClient, now = () => Date.now() }) {
  if (!installer || !apiClient) throw new TypeError('SkillHub marketplace dependencies are required');
  if (typeof apiClient.listSkills !== 'function') throw new TypeError('apiClient.listSkills must be a function');
  if (typeof installer.install !== 'function') throw new TypeError('installer.install must be a function');
  let lastStatus = emptyStatus();

  async function query(query = {}) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 24;
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const sortBy = mapSkillHubRemoteSortBy(query.sortBy);
    const result = await apiClient.listSkills({
      page,
      pageSize,
      keyword: keyword || undefined,
      category: category || undefined,
      sortBy,
    });
    const next = toPage(result, now);
    lastStatus = next.sync;
    return next;
  }

  async function listCategories() {
    if (typeof apiClient.listCategories !== 'function') return [];
    const result = await apiClient.listCategories();
    return Array.isArray(result?.items) ? result.items : [];
  }

  return Object.freeze({
    query,
    getDetail: (identity) => apiClient.getSkillDetail(identity),
    getStatus: () => lastStatus,
    // 浏览改为远程查询后，sync 不再翻全站索引；保留 IPC 兼容，语义是返回最近一次查询状态。
    sync: async () => lastStatus,
    install: (identity) => installer.install(identity),
    listCategories,
    refreshCategories: listCategories,
  });
}
