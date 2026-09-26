import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsApplicationService } from '../settings-application-service.mjs';
import { createSettingsIpcRegistrations } from './register-settings-ipc.mjs';

function routingStubs() {
  return {
    describeModelRouting: () => ({ routing: {}, providers: [], singleModel: true }),
    updateModelRouting: () => ({}),
    previewModelRouting: () => ({ routing: {}, providers: [], singleModel: true, resolutions: [] }),
  };
}

function createServices(calls) {
  return {
    settings: {
      get: () => ({ appearance: 'dark' }),
      update: (payload) => ({ ...payload, updated: true }),
      exportSettings: () => ({ canceled: false, exported: ['settings.json'] }),
      importSettings: () => ({ canceled: false, imported: ['settings.json'] }),
      getDeveloperSettings: () => ({ trace: false }),
      updateDeveloperSettings: (payload) => ({ ...payload, updated: true }),
      resetDeveloperSettings: () => ({}),
      diagnostics: () => ({ isDev: true }),
      updateLocale: (payload) => ({ locale: payload.locale }),
      ...routingStubs(),
    },
    permissions: {
      approve: (payload) => {
        calls.push(['approve', payload]);
        return { granted: true, toolCallId: payload.toolCallId };
      },
      deny: (payload) => {
        calls.push(['deny', payload]);
        return { granted: false, toolCallId: payload.toolCallId };
      },
    },
  };
}

function registerAll(registrations) {
  const handlers = new Map();
  const listeners = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
      on(channel, listener) {
        assert.equal(listeners.has(channel), false, `duplicate listener: ${channel}`);
        listeners.set(channel, listener);
      },
    });
  }
  return { handlers, listeners, owners };
}

test('settings registrations expose exact owners and channel transport types', () => {
  const registrations = createSettingsIpcRegistrations(createServices([]));
  const { handlers, listeners, owners } = registerAll(registrations);

  assert.deepEqual(owners, [
    'settings-ipc',
    'model-routing-ipc',
    'developer-settings-ipc',
    'locale-ipc',
    'permission-ipc',
  ]);
  assert.deepEqual([...handlers.keys()].sort(), [
    'developer-settings:diagnostics',
    'developer-settings:get',
    'developer-settings:reset',
    'developer-settings:update',
    'locale:set',
    'model-routing:get',
    'model-routing:preview',
    'model-routing:update',
    'permission:approve',
    'permission:deny',
    'settings:export',
    'settings:get',
    'settings:import',
    'settings:update',
  ]);
  assert.deepEqual([...listeners.keys()], ['settings:get-sync']);
});

test('settings transport preserves payloads, result shapes, and synchronous returnValue', async () => {
  const calls = [];
  const { handlers, listeners } = registerAll(
    createSettingsIpcRegistrations(createServices(calls)),
  );

  const syncEvent = {};
  listeners.get('settings:get-sync')(syncEvent);
  assert.deepEqual(syncEvent.returnValue, { appearance: 'dark' });
  assert.deepEqual(await handlers.get('settings:update')({}, { appearance: 'light' }), {
    appearance: 'light',
    updated: true,
  });
  assert.deepEqual(await handlers.get('developer-settings:update')({}, { trace: true }), {
    trace: true,
    updated: true,
  });
  assert.deepEqual(await handlers.get('locale:set')({}, { locale: 'en-US' }), {
    locale: 'en-US',
  });
  assert.deepEqual(await handlers.get('permission:approve')({}, { toolCallId: 'call-1' }), {
    granted: true,
    toolCallId: 'call-1',
  });
  assert.deepEqual(await handlers.get('permission:deny')({}, { toolCallId: 'call-2' }), {
    granted: false,
    toolCallId: 'call-2',
  });
  assert.deepEqual(calls, [
    ['approve', { toolCallId: 'call-1' }],
    ['deny', { toolCallId: 'call-2' }],
  ]);
});

function textProvider(id, extra = {}) {
  return {
    id,
    enabled: true,
    apiKeyConfigured: true,
    supportsVision: false,
    supportsTools: true,
    supportsStructured: true,
    contextWindow: 32_000,
    provider: 'openai',
    model: id,
    name: id,
    ...extra,
  };
}

function createRoutingHost(providers, { roleSpendUsd = () => ({}) } = {}) {
  let settings = {};
  const merges = [];
  const service = createSettingsApplicationService({
    getSettings: () => ({ ...settings }),
    mergeSettings: (partial) => {
      merges.push(partial);
      settings = { ...settings, ...partial };
      return { ...settings };
    },
    applyAppearance: () => {},
    normalizeSystemInstructions: (value) => String(value ?? ''),
    recordInstructionBaseline: () => {},
    resolveLocalAccessLevel: () => 'manual',
    setSessionAccessLevel: () => {},
    setRuntimeAccessLevel: () => {},
    chooseExportDirectory: async () => null,
    chooseImportDirectory: async () => null,
    exportBundle: () => ({ exported: [] }),
    importBundle: () => ({ imported: [] }),
    diagnostics: () => ({}),
    setSessionLocale: () => {},
    rebuildAppMenu: () => {},
    getSession: () => ({ locale: 'zh-CN' }),
  });
  const { handlers } = registerAll(createSettingsIpcRegistrations({
    settings: service,
    permissions: { approve: () => ({}), deny: () => ({}) },
    listProviders: () => providers,
    roleSpendUsd,
  }));
  return { handlers, merges, readSettings: () => settings };
}

test('model routing ipc previews roles in main and refuses writes when one model is usable', async () => {
  const text = textProvider('text-model', { isDefault: true });
  const vision = textProvider('vision-model', {
    supportsVision: true,
    provider: 'anthropic',
    isDefault: false,
  });
  const host = createRoutingHost([text, vision], {
    roleSpendUsd: () => ({ explorer: 2, project_agent: 5 }),
  });

  const described = await host.handlers.get('model-routing:get')();
  assert.equal(described.singleModel, false);
  assert.equal(described.routing.tiers.vision.primary, 'vision-model');
  assert.equal(described.routing.tiers.economy.primary, 'text-model');
  assert.equal(host.merges.length, 0);

  const preview = await host.handlers.get('model-routing:preview')();
  const visual = preview.resolutions.find((row) => row.role === 'visual_verifier');
  const explorer = preview.resolutions.find((row) => row.role === 'explorer');
  assert.equal(visual.modelProviderId, 'vision-model');
  assert.equal(explorer.modelProviderId, 'text-model');

  const updated = await host.handlers.get('model-routing:update')({}, {
    verifierPreferDifferentFamily: false,
    roleSpendCaps: { explorer: 1, project_agent: 1 },
  });
  assert.equal(updated.routing.verifierPreferDifferentFamily, false);
  const again = await host.handlers.get('model-routing:get')();
  assert.equal(again.routing.verifierPreferDifferentFamily, false);

  const capped = await host.handlers.get('model-routing:preview')();
  const cappedExplorer = capped.resolutions.find((row) => row.role === 'explorer');
  const cappedAgent = capped.resolutions.find((row) => row.role === 'project_agent');
  assert.equal(cappedExplorer.ok, false);
  assert.equal(cappedExplorer.reason, 'spend_cap_reached');
  assert.equal(cappedAgent.ok, true);
  assert.equal(cappedAgent.spendExceeded, true);

  const alone = createRoutingHost([text]);
  const current = await alone.handlers.get('model-routing:get')();
  assert.equal(current.singleModel, true);
  const refused = await alone.handlers.get('model-routing:update')({}, {
    verifierPreferDifferentFamily: false,
  });
  assert.equal(refused.singleModel, true);
  assert.equal(alone.merges.length, 0);
  assert.equal(alone.readSettings().modelRouting, undefined);
});
