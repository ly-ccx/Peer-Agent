import { createUsageRequestLog } from '../usage-request-log.mjs';
import { startOfLocalDayMs, sumRoleSpendUsd } from '../usage-stats.mjs';

const MODEL_ROUTING_ROLES = [
  'project_agent',
  'session_worker',
  'explorer',
  'verifier',
  'visual_verifier',
  'memory_curator',
  'objective_probe',
  'compactor',
];

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function readTodayRoleSpend() {
  const rows = createUsageRequestLog().readAll({ limit: 20_000 });
  const sinceMs = startOfLocalDayMs();
  return Object.fromEntries(MODEL_ROUTING_ROLES.map((role) => [
    role,
    sumRoleSpendUsd(rows, { role, sinceMs }),
  ]));
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createSettingsIpcRegistrations({ settings, permissions, listProviders, roleSpendUsd } = {}) {
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
  const describeModelRouting = assertFunction(settings?.describeModelRouting, 'settings.describeModelRouting');
  const updateModelRouting = assertFunction(settings?.updateModelRouting, 'settings.updateModelRouting');
  const previewModelRouting = assertFunction(settings?.previewModelRouting, 'settings.previewModelRouting');
  const readProviders = typeof listProviders === 'function' ? listProviders : () => [];
  const readSpend = typeof roleSpendUsd === 'function' ? roleSpendUsd : readTodayRoleSpend;

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
    owner('model-routing-ipc', (ipc) => {
      ipc.handle('model-routing:get', () => describeModelRouting(readProviders()));
      ipc.handle('model-routing:update', (_event, partial) => {
        const current = describeModelRouting(readProviders());
        if (current.singleModel) return current;
        updateModelRouting(partial);
        return describeModelRouting(readProviders());
      });
      ipc.handle('model-routing:preview', () => previewModelRouting(readProviders(), {
        spentByRole: readSpend() || {},
      }));
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
