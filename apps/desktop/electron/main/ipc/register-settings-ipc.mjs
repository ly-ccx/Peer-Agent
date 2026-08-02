function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createSettingsIpcRegistrations({ settings, permissions } = {}) {
  const getSettings = assertFunction(settings?.get, 'settings.get');
  const updateSettings = assertFunction(settings?.update, 'settings.update');
  const exportSettings = assertFunction(settings?.exportSettings, 'settings.exportSettings');
  const importSettings = assertFunction(settings?.importSettings, 'settings.importSettings');
  const getDeveloperSettings = assertFunction(
    settings?.getDeveloperSettings,
    'settings.getDeveloperSettings',
  );
  const updateDeveloperSettings = assertFunction(
    settings?.updateDeveloperSettings,
    'settings.updateDeveloperSettings',
  );
  const resetDeveloperSettings = assertFunction(
    settings?.resetDeveloperSettings,
    'settings.resetDeveloperSettings',
  );
  const getDiagnostics = assertFunction(settings?.diagnostics, 'settings.diagnostics');
  const updateLocale = assertFunction(settings?.updateLocale, 'settings.updateLocale');
  const approvePermission = assertFunction(permissions?.approve, 'permissions.approve');
  const denyPermission = assertFunction(permissions?.deny, 'permissions.deny');

  return Object.freeze([
    owner('settings-ipc', (ipc) => {
      ipc.handle('settings:get', () => getSettings());
      ipc.handle('settings:update', (_event, partial) => updateSettings(partial));
      ipc.on('settings:get-sync', (event) => {
        event.returnValue = getSettings();
      });
      ipc.handle('settings:export', () => exportSettings());
      ipc.handle('settings:import', () => importSettings());
    }),
    owner('developer-settings-ipc', (ipc) => {
      ipc.handle('developer-settings:get', () => getDeveloperSettings());
      ipc.handle('developer-settings:update', (_event, partial) => updateDeveloperSettings(partial));
      ipc.handle('developer-settings:reset', () => resetDeveloperSettings());
      ipc.handle('developer-settings:diagnostics', () => getDiagnostics());
    }),
    owner('locale-ipc', (ipc) => {
      ipc.handle('locale:set', (_event, payload) => updateLocale(payload));
    }),
    owner('permission-ipc', (ipc) => {
      ipc.handle('permission:approve', (_event, payload) => approvePermission(payload));
      ipc.handle('permission:deny', (_event, payload) => denyPermission(payload));
    }),
  ]);
}
