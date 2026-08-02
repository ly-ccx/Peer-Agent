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
