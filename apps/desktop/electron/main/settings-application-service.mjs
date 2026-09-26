import { isRoutableProvider, resolveRoleRoute, resolveStoredModelRouting } from '@peer-agent/runtime-node';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createSettingsApplicationService({
  getSettings,
  mergeSettings,
  applyAppearance,
  normalizeSystemInstructions,
  recordInstructionBaseline,
  resolveLocalAccessLevel,
  setSessionAccessLevel,
  setRuntimeAccessLevel,
  chooseExportDirectory,
  chooseImportDirectory,
  exportBundle,
  importBundle,
  diagnostics,
  setSessionLocale,
  rebuildAppMenu,
  getSession,
} = {}) {
  const read = assertFunction(getSettings, 'getSettings');
  const merge = assertFunction(mergeSettings, 'mergeSettings');
  const publishAppearance = assertFunction(applyAppearance, 'applyAppearance');
  const normalizeInstructions = assertFunction(
    normalizeSystemInstructions,
    'normalizeSystemInstructions',
  );
  const recordBaseline = assertFunction(recordInstructionBaseline, 'recordInstructionBaseline');
  const resolveAccess = assertFunction(resolveLocalAccessLevel, 'resolveLocalAccessLevel');
  const setSessionAccess = assertFunction(setSessionAccessLevel, 'setSessionAccessLevel');
  const setRuntimeAccess = assertFunction(setRuntimeAccessLevel, 'setRuntimeAccessLevel');
  const pickExportDirectory = assertFunction(chooseExportDirectory, 'chooseExportDirectory');
  const pickImportDirectory = assertFunction(chooseImportDirectory, 'chooseImportDirectory');
  const writeBundle = assertFunction(exportBundle, 'exportBundle');
  const readBundle = assertFunction(importBundle, 'importBundle');
  const readDiagnostics = assertFunction(diagnostics, 'diagnostics');
  const setLocale = assertFunction(setSessionLocale, 'setSessionLocale');
  const rebuildMenu = assertFunction(rebuildAppMenu, 'rebuildAppMenu');
  const readSession = assertFunction(getSession, 'getSession');

  function get() {
    return read();
  }

  function update(partial) {
    const before = read();
    const next = merge(partial);
    if (isRecord(partial) && Object.prototype.hasOwnProperty.call(partial, 'appearance')) {
      publishAppearance(next.appearance);
    }
    if (
      isRecord(partial)
      && Object.prototype.hasOwnProperty.call(partial, 'systemInstructions')
      && normalizeInstructions(before.systemInstructions) !== normalizeInstructions(next.systemInstructions)
    ) {
      recordBaseline(next.systemInstructions);
    }
    if (isRecord(partial) && Object.prototype.hasOwnProperty.call(partial, 'localAccessLevel')) {
      const accessLevel = resolveAccess(next.localAccessLevel);
      setSessionAccess(accessLevel);
      setRuntimeAccess(accessLevel);
      if (next.localAccessLevel !== accessLevel) {
        merge({ localAccessLevel: accessLevel });
        return { ...next, localAccessLevel: accessLevel };
      }
    }
    return next;
  }

  function getDeveloperSettings() {
    return read().developer ?? {};
  }

  function updateDeveloperSettings(partial) {
    const current = read().developer;
    const currentDeveloper = isRecord(current) ? current : {};
    const nextPartial = isRecord(partial) ? partial : {};
    const next = { ...currentDeveloper, ...nextPartial };
    merge({ developer: next });
    return next;
  }

  function resetDeveloperSettings() {
    merge({ developer: {} });
    return {};
  }

  async function exportSettings() {
    const targetDirectory = await pickExportDirectory();
    if (!targetDirectory) return { canceled: true, exported: [] };
    return { canceled: false, ...writeBundle(targetDirectory) };
  }

  async function importSettings() {
    const sourceDirectory = await pickImportDirectory();
    if (!sourceDirectory) return { canceled: true, imported: [] };
    return { canceled: false, ...readBundle(sourceDirectory) };
  }

  function updateLocale(payload) {
    setLocale(payload.locale);
    merge({ locale: payload.locale });
    rebuildMenu();
    return readSession();
  }

  function getModelRouting(providers = []) {
    return resolveStoredModelRouting(read().modelRouting, Array.isArray(providers) ? providers : []);
  }

  function updateModelRouting(partial) {
    const current = isRecord(read().modelRouting) ? read().modelRouting : {};
    const nextPartial = isRecord(partial) ? partial : {};
    const next = { ...current };
    if (isRecord(nextPartial.tiers)) next.tiers = { ...(isRecord(current.tiers) ? current.tiers : {}), ...nextPartial.tiers };
    if (isRecord(nextPartial.roles)) next.roles = { ...(isRecord(current.roles) ? current.roles : {}), ...nextPartial.roles };
    if (typeof nextPartial.verifierPreferDifferentFamily === 'boolean') {
      next.verifierPreferDifferentFamily = nextPartial.verifierPreferDifferentFamily;
    }
    if (Number.isFinite(Number(nextPartial.dailySpendCapUsd)) && Number(nextPartial.dailySpendCapUsd) >= 0) {
      next.dailySpendCapUsd = Number(nextPartial.dailySpendCapUsd);
    }
    if (isRecord(nextPartial.roleSpendCaps)) {
      const caps = { ...(isRecord(current.roleSpendCaps) ? current.roleSpendCaps : {}) };
      for (const [role, amount] of Object.entries(nextPartial.roleSpendCaps)) {
        if (amount == null || amount === '') delete caps[role];
        else if (Number.isFinite(Number(amount)) && Number(amount) >= 0) caps[role] = Number(amount);
      }
      if (Object.keys(caps).length) next.roleSpendCaps = caps;
      else delete next.roleSpendCaps;
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    merge({ modelRouting: next });
    return next;
  }

  function projectRoutingProvider(provider) {
    if (!isRoutableProvider(provider)) return null;
    const context = Number(provider.contextWindow);
    const label = [provider.modelLabel, provider.model, provider.name, provider.id]
      .find((value) => typeof value === 'string' && value.trim());
    return {
      id: String(provider.id).trim(),
      label: String(label).trim(),
      providerName: typeof provider.name === 'string' ? provider.name.trim() : '',
      supportsVision: provider.supportsVision === true,
      supportsTools: provider.supportsTools !== false && provider.capabilities?.toolUse !== false,
      supportsStructured: provider.supportsStructured !== false,
      contextTokens: Number.isFinite(context) && context > 0 ? context : 128_000,
    };
  }

  function describeModelRouting(providers = []) {
    const list = Array.isArray(providers) ? providers : [];
    const projected = list.map(projectRoutingProvider).filter(Boolean);
    const usable = list.filter((provider) => projected.some((item) => item.id === provider.id));
    return {
      routing: getModelRouting(usable),
      providers: projected,
      singleModel: projected.length <= 1,
    };
  }

  function previewModelRouting(providers = [], { spentByRole = {} } = {}) {
    const described = describeModelRouting(providers);
    const usable = (Array.isArray(providers) ? providers : []).filter((provider) => (
      described.providers.some((item) => item.id === provider.id)
    ));
    const resolutions = [
      'project_agent',
      'session_worker',
      'explorer',
      'verifier',
      'visual_verifier',
      'memory_curator',
      'objective_probe',
      'compactor',
    ].map((role) => {
      const resolved = resolveRoleRoute({
        role,
        providers: usable,
        routing: read().modelRouting,
        spentUsd: Number(spentByRole?.[role]) || 0,
      });
      const chosenId = resolved.ok ? resolved.selection.modelProviderId : '';
      const chosen = described.providers.find((item) => item.id === chosenId) || null;
      return {
        role,
        ok: resolved.ok === true,
        modelProviderId: chosenId || null,
        label: chosen?.label || chosenId || '',
        source: resolved.ok ? (resolved.source || null) : null,
        missing: resolved.ok ? null : (resolved.missing || null),
        reason: resolved.ok ? null : (resolved.reason || null),
        spendExceeded: resolved.spendExceeded === true,
        sameFamilyAsWorker: typeof resolved.sameFamilyAsWorker === 'boolean' ? resolved.sameFamilyAsWorker : null,
      };
    });
    return { ...described, resolutions };
  }

  return Object.freeze({
    get,
    update,
    getDeveloperSettings,
    updateDeveloperSettings,
    resetDeveloperSettings,
    diagnostics: readDiagnostics,
    exportSettings,
    importSettings,
    updateLocale,
    getModelRouting,
    updateModelRouting,
    describeModelRouting,
    previewModelRouting,
  });
}

export function createPermissionGrantService({ createId, now, resolveGrant } = {}) {
  const newId = assertFunction(createId, 'createId');
  const clock = assertFunction(now, 'now');
  const resolve = assertFunction(resolveGrant, 'resolveGrant');

  function decide(payload, granted) {
    const grant = {
      grantId: newId(),
      toolCallId: payload.toolCallId,
      granted,
      duration: granted ? (payload.duration || 'once') : 'denied',
      scope: payload.scope || 'client_session',
      decidedAt: clock().toISOString(),
    };
    resolve(payload.toolCallId, grant);
    return grant;
  }

  return Object.freeze({
    approve: (payload) => decide(payload, true),
    deny: (payload) => decide(payload, false),
  });
}
