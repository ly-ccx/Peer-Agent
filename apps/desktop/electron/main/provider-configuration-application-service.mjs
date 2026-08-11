function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function promptTargetChanged(before = null, after = null) {
  if (!after?.isDefault) return false;
  if (!before) return true;
  return before.provider !== after.provider || before.model !== after.model;
}

export function createProviderConfigurationApplicationService({
  listChannels,
  listServiceTemplates,
  refreshExpiredOAuth,
  backfillMissingPricing,
  listProviders,
  listGroups,
  addProvider,
  updateProvider,
  duplicateProvider,
  duplicateModel,
  addModel,
  removeProvider,
  removeGroup,
  setDefault,
  testConnection,
  completePrompt,
  recordBaseline,
  notifyOAuthRefreshed = () => {},
  reportRefreshError = () => {},
  reportBackfillResult = () => {},
  reportBackfillError = () => {},
} = {}) {
  const ports = {
    listChannels: assertFunction(listChannels, 'listChannels'),
    listServiceTemplates: assertFunction(
      listServiceTemplates || (() => []),
      'listServiceTemplates',
    ),
    refreshExpiredOAuth: assertFunction(refreshExpiredOAuth, 'refreshExpiredOAuth'),
    backfillMissingPricing: assertFunction(backfillMissingPricing, 'backfillMissingPricing'),
    listProviders: assertFunction(listProviders, 'listProviders'),
    listGroups: assertFunction(listGroups, 'listGroups'),
    addProvider: assertFunction(addProvider, 'addProvider'),
    updateProvider: assertFunction(updateProvider, 'updateProvider'),
    duplicateProvider: assertFunction(duplicateProvider, 'duplicateProvider'),
    duplicateModel: assertFunction(duplicateModel, 'duplicateModel'),
    addModel: assertFunction(addModel, 'addModel'),
    removeProvider: assertFunction(removeProvider, 'removeProvider'),
    removeGroup: assertFunction(removeGroup, 'removeGroup'),
    setDefault: assertFunction(setDefault, 'setDefault'),
    testConnection: assertFunction(testConnection, 'testConnection'),
    completePrompt: assertFunction(completePrompt, 'completePrompt'),
    recordBaseline: assertFunction(recordBaseline, 'recordBaseline'),
    notifyOAuthRefreshed: assertFunction(notifyOAuthRefreshed, 'notifyOAuthRefreshed'),
    reportRefreshError: assertFunction(reportRefreshError, 'reportRefreshError'),
    reportBackfillResult: assertFunction(reportBackfillResult, 'reportBackfillResult'),
    reportBackfillError: assertFunction(reportBackfillError, 'reportBackfillError'),
  };
  let backfillPromise = null;
  let oauthRefreshPromise = null;

  // 列表请求不再把 OAuth 静默刷新作为前置卡口：立即返回本地列表，
  // 后台合并触发一次刷新；真正刷到 token 后通过 notifyOAuthRefreshed 通知渲染层增量刷新。
  function scheduleOAuthRefresh(reason = 'llm:list') {
    if (oauthRefreshPromise) return oauthRefreshPromise;
    oauthRefreshPromise = Promise.resolve()
      .then(() => ports.refreshExpiredOAuth())
      .then((result) => {
        const refreshed = Number(result?.refreshed) || 0;
        if (refreshed > 0) ports.notifyOAuthRefreshed({ reason, refreshed });
      })
      .catch((error) => {
        ports.reportRefreshError(error);
      })
      .finally(() => {
        oauthRefreshPromise = null;
      });
    return oauthRefreshPromise;
  }

  function scheduleMissingPricingBackfill(reason = 'startup') {
    if (backfillPromise) return backfillPromise;
    backfillPromise = Promise.resolve()
      .then(() => ports.backfillMissingPricing())
      .then((result) => {
        ports.reportBackfillResult(reason, result);
        return result;
      })
      .catch((error) => {
        ports.reportBackfillError(error);
        return null;
      })
      .finally(() => {
        backfillPromise = null;
      });
    return backfillPromise;
  }

  function getProviders() {
    void scheduleOAuthRefresh('llm:list');
    void scheduleMissingPricingBackfill('llm:list');
    return ports.listProviders();
  }

  function getGroups() {
    void scheduleOAuthRefresh('llm:list');
    return ports.listGroups();
  }

  function currentDefault() {
    return ports.listProviders().find((provider) => provider.isDefault) ?? null;
  }

  return Object.freeze({
    listChannels: () => ports.listChannels(),
    listServiceTemplates: () => ports.listServiceTemplates(),
    listGroups: getGroups,
    listProviders: getProviders,
    listChatProviders: getProviders,
    add(config) {
      const provider = ports.addProvider(config);
      if (provider.isDefault) ports.recordBaseline('initial', provider);
      return provider;
    },
    update(id, patch) {
      const before = ports.listProviders().find((provider) => provider.id === id) ?? null;
      const updated = ports.updateProvider(id, patch);
      if (promptTargetChanged(before, updated)) {
        ports.recordBaseline('model_switch', updated);
      }
      return updated;
    },
    duplicate(id) {
      ports.duplicateProvider(id);
      return ports.listProviders();
    },
    duplicateModel(id) {
      ports.duplicateModel(id);
      return ports.listProviders();
    },
    addModel(groupId, patch) {
      ports.addModel(groupId, patch);
      return ports.listProviders();
    },
    remove(id) {
      const beforeDefault = currentDefault();
      const providers = ports.removeProvider(id);
      const afterDefault = providers.find((provider) => provider.isDefault) ?? null;
      if (beforeDefault?.id === id && afterDefault) {
        ports.recordBaseline('model_switch', afterDefault);
      }
      return providers;
    },
    removeGroup(groupId) {
      const beforeDefault = currentDefault();
      const providers = ports.removeGroup(groupId);
      const afterDefault = providers.find((provider) => provider.isDefault) ?? null;
      if (
        beforeDefault
        && (beforeDefault.groupId ?? beforeDefault.id) === groupId
        && afterDefault
      ) {
        ports.recordBaseline('model_switch', afterDefault);
      }
      return providers;
    },
    setDefault(id) {
      const beforeDefault = currentDefault();
      const providers = ports.setDefault(id);
      const afterDefault = providers.find((provider) => provider.id === id) ?? null;
      if (afterDefault && beforeDefault?.id !== afterDefault.id) {
        ports.recordBaseline('model_switch', afterDefault);
      }
      return providers;
    },
    test: (id) => ports.testConnection(id),
    complete: (params) => ports.completePrompt(params),
    scheduleMissingPricingBackfill,
  });
}
