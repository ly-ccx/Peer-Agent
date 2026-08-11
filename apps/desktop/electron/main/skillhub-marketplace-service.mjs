export function createSkillHubMarketplaceService({ store, installer, apiClient }) {
  if (!store || !installer || !apiClient) throw new TypeError('SkillHub marketplace dependencies are required');
  let activeSync = null;

  function startSync(options) {
    if (!activeSync) {
      activeSync = store.sync(options).finally(() => { activeSync = null; });
    }
    return activeSync;
  }

  return Object.freeze({
    query: (query) => store.query(query),
    getStatus: () => store.getStatus(),
    sync: (options) => startSync(options),
    getDetail: async ({ namespace, slug }) => apiClient.getSkillDetail({ namespace, slug }),
    install: (identity) => installer.install(identity),
    // 本地分类字典为空时自动拉取 /api/v1/categories，避免 UI 长期显示英文 key。
    listCategories: async () => {
      const current = store.listCategories();
      if (Array.isArray(current) && current.length > 0) return current;
      return store.refreshCategories();
    },
    refreshCategories: () => store.refreshCategories(),
  });
}
