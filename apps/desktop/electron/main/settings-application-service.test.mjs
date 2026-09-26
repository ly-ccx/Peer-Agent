import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPermissionGrantService,
  createSettingsApplicationService,
} from './settings-application-service.mjs';

function createHarness({ exportDirectory = '/export', importDirectory = '/import' } = {}) {
  let settings = {
    appearance: 'dark',
    systemInstructions: 'alpha',
    localAccessLevel: 'manual',
    developer: { trace: false },
    locale: 'zh-CN',
  };
  const calls = [];
  const service = createSettingsApplicationService({
    getSettings: () => ({ ...settings }),
    mergeSettings: (partial) => {
      calls.push(['merge', partial]);
      settings = { ...settings, ...partial };
      return { ...settings };
    },
    applyAppearance: (appearance) => calls.push(['appearance', appearance]),
    normalizeSystemInstructions: (value) => String(value ?? '').trim(),
    recordInstructionBaseline: (value) => calls.push(['baseline', value]),
    resolveLocalAccessLevel: (value) => (value === 'full' ? 'full' : 'manual'),
    setSessionAccessLevel: (value) => calls.push(['session-access', value]),
    setRuntimeAccessLevel: (value) => calls.push(['runtime-access', value]),
    chooseExportDirectory: async () => exportDirectory,
    chooseImportDirectory: async () => importDirectory,
    exportBundle: (directory) => ({ exported: [`${directory}/settings.json`] }),
    importBundle: (directory) => ({ imported: [`${directory}/settings.json`] }),
    diagnostics: () => ({ dataHome: '/data', isDev: true }),
    setSessionLocale: (locale) => {
      calls.push(['session-locale', locale]);
      settings = { ...settings, locale };
    },
    rebuildAppMenu: () => calls.push(['rebuild-menu']),
    getSession: () => ({ locale: settings.locale }),
  });
  return {
    service,
    calls,
    getSettings: () => settings,
  };
}

test('settings update preserves persistence-first ordering and normalizes access level', () => {
  const { service, calls, getSettings } = createHarness();
  const result = service.update({
    appearance: 'light',
    systemInstructions: ' beta ',
    localAccessLevel: 'unsupported',
  });

  assert.deepEqual(result, {
    ...getSettings(),
    localAccessLevel: 'manual',
  });
  assert.deepEqual(calls, [
    ['merge', {
      appearance: 'light',
      systemInstructions: ' beta ',
      localAccessLevel: 'unsupported',
    }],
    ['appearance', 'light'],
    ['baseline', ' beta '],
    ['session-access', 'manual'],
    ['runtime-access', 'manual'],
    ['merge', { localAccessLevel: 'manual' }],
  ]);
});

test('developer settings, bundles, diagnostics, and locale keep their response shapes', async () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.getDeveloperSettings(), { trace: false });
  assert.deepEqual(service.updateDeveloperSettings({ verbose: true }), {
    trace: false,
    verbose: true,
  });
  assert.deepEqual(service.resetDeveloperSettings(), {});
  assert.deepEqual(service.diagnostics(), { dataHome: '/data', isDev: true });
  assert.deepEqual(await service.exportSettings(), {
    canceled: false,
    exported: ['/export/settings.json'],
  });
  assert.deepEqual(await service.importSettings(), {
    canceled: false,
    imported: ['/import/settings.json'],
  });
  assert.deepEqual(service.updateLocale({ locale: 'en-US' }), { locale: 'en-US' });
  assert.deepEqual(calls.slice(-3), [
    ['session-locale', 'en-US'],
    ['merge', { locale: 'en-US' }],
    ['rebuild-menu'],
  ]);

  const canceled = createHarness({ exportDirectory: null, importDirectory: null }).service;
  assert.deepEqual(await canceled.exportSettings(), { canceled: true, exported: [] });
  assert.deepEqual(await canceled.importSettings(), { canceled: true, imported: [] });
});

test('permission decisions preserve grant fields and resolve through the injected port', () => {
  const resolved = [];
  let nextId = 0;
  const service = createPermissionGrantService({
    createId: () => `grant-${++nextId}`,
    now: () => new Date('2026-08-01T12:00:00.000Z'),
    resolveGrant: (toolCallId, grant) => resolved.push([toolCallId, grant]),
  });

  const approved = service.approve({
    toolCallId: 'call-1',
    duration: 'session',
    scope: 'workspace',
  });
  const denied = service.deny({ toolCallId: 'call-2' });

  assert.deepEqual(approved, {
    grantId: 'grant-1',
    toolCallId: 'call-1',
    granted: true,
    duration: 'session',
    scope: 'workspace',
    decidedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.deepEqual(denied, {
    grantId: 'grant-2',
    toolCallId: 'call-2',
    granted: false,
    duration: 'denied',
    scope: 'client_session',
    decidedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.deepEqual(resolved, [
    ['call-1', approved],
    ['call-2', denied],
  ]);
});

test('projectAgentMode round-trips in developer settings and reset clears it', () => {
  const { service } = createHarness();
  assert.equal(service.getDeveloperSettings().projectAgentMode, undefined);
  assert.equal(service.updateDeveloperSettings({ projectAgentMode: true }).projectAgentMode, true);
  assert.equal(service.getDeveloperSettings().trace, false);
  assert.deepEqual(service.resetDeveloperSettings(), {});
  assert.equal(service.getDeveloperSettings().projectAgentMode, undefined);
});

test('model routing defaults are computed on read and are not written back', () => {
  const { service, calls, getSettings } = createHarness();
  const providers = [{
    id: 'only-model',
    enabled: true,
    apiKeyConfigured: true,
    supportsVision: true,
    isDefault: true,
    provider: 'openai',
  }];
  const mergesBefore = calls.filter((call) => call[0] === 'merge').length;
  const routing = service.getModelRouting(providers);
  assert.equal(calls.filter((call) => call[0] === 'merge').length, mergesBefore);
  assert.equal(routing.tiers.strong.primary, 'only-model');
  assert.equal(routing.tiers.fast.primary, 'only-model');
  assert.equal(routing.tiers.economy.primary, 'only-model');
  assert.equal(routing.tiers.vision.primary, 'only-model');
  assert.equal(routing.roles.explorer.tier, 'economy');
  assert.equal(routing.verifierPreferDifferentFamily, true);
  assert.equal(getSettings().modelRouting, undefined);

  const stored = service.updateModelRouting({
    tiers: { strong: { primary: 'only-model', fallbacks: ['spare'] } },
    verifierPreferDifferentFamily: false,
    dailySpendCapUsd: 3,
  });
  assert.equal(stored.tiers.strong.primary, 'only-model');
  assert.deepEqual(stored.tiers.strong.fallbacks, ['spare']);
  assert.equal(stored.verifierPreferDifferentFamily, false);
  assert.equal(stored.dailySpendCapUsd, 3);
  assert.equal(stored.roles, undefined);

  const again = service.getModelRouting(providers);
  assert.equal(again.tiers.strong.primary, 'only-model');
  assert.deepEqual(again.tiers.strong.fallbacks, ['spare']);
  assert.equal(again.tiers.economy.primary, 'only-model');
  assert.equal(again.roles.verifier.tier, 'strong');
  assert.equal(again.verifierPreferDifferentFamily, false);
  assert.equal(getSettings().modelRouting.roles, undefined);
  assert.equal(getSettings().modelRouting.tiers.economy, undefined);
});

test('clearing a role spend cap removes that key', () => {
  const { service, calls, getSettings } = createHarness();
  service.updateModelRouting({ roleSpendCaps: { explorer: 1, verifier: 2 } });
  const stored = service.updateModelRouting({ roleSpendCaps: { explorer: null } });
  assert.equal(stored.roleSpendCaps.verifier, 2);
  assert.equal(stored.roleSpendCaps.explorer, undefined);
  assert.equal(getSettings().modelRouting.roleSpendCaps.explorer, undefined);
  const cleared = service.updateModelRouting({ roleSpendCaps: { verifier: '' } });
  assert.equal(cleared.roleSpendCaps, undefined);
  assert.equal(getSettings().modelRouting.roleSpendCaps, undefined);
  const mergesBefore = calls.filter((call) => call[0] === 'merge').length;
  service.updateModelRouting({ roleSpendCaps: { explorer: null } });
  assert.equal(calls.filter((call) => call[0] === 'merge').length, mergesBefore);
});
