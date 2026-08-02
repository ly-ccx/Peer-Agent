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
  recordBaseline,
  reportRefreshError = () => {},
  reportBackfillResult = () => {},
  reportBackfillError = () => {},
} = {}) {
  const ports = {
    listChannels: assertFunction(listChannels, 'listChannels'),
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
    recordBaseline: assertFunction(recordBaseline, 'recordBaseline'),
    reportRefreshError: assertFunction(reportRefreshError, 'reportRefreshError'),
    reportBackfillResult: assertFunction(reportBackfillResult, 'reportBackfillResult'),
    reportBackfillError: assertFunction(reportBackfillError, 'reportBackfillError'),
  };
  let backfillPromise = null;

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

  async function silentlyRefreshOAuth() {
    try {
      await ports.refreshExpiredOAuth();
    } catch (error) {
      ports.reportRefreshError(error);
    }
  }

  async function getProviders() {
    await silentlyRefreshOAuth();
    void scheduleMissingPricingBackfill('llm:list');
    return ports.listProviders();
  }

  async function getGroups() {
    await silentlyRefreshOAuth();
    return ports.listGroups();
  }

  function currentDefault() {
    return ports.listProviders().find((provider) => provider.isDefault) ?? null;
  }

  return Object.freeze({
    listChannels: () => ports.listChannels(),
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
    scheduleMissingPricingBackfill,
  });
}
