import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderConfigurationApplicationService } from './provider-configuration-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  let providers = [
    { id: 'p1', groupId: 'g1', provider: 'openai', model: 'm1', isDefault: true },
    { id: 'p2', groupId: 'g2', provider: 'anthropic', model: 'm2', isDefault: false },
  ];
  const ports = {
    listChannels: () => ['openai'],
    refreshExpiredOAuth: async () => calls.push(['refresh']),
    backfillMissingPricing: async () => {
      calls.push(['backfill']);
      return { updated: 1, examined: 2 };
    },
    listProviders: () => providers,
    listGroups: () => [{ id: 'g1' }],
    addProvider: (config) => {
      const provider = { id: 'new', ...config };
      providers = [...providers, provider];
      return provider;
    },
    updateProvider: (id, patch) => {
      const before = providers.find((provider) => provider.id === id);
      const updated = { ...before, ...patch };
      providers = providers.map((provider) => (provider.id === id ? updated : provider));
      return updated;
    },
    duplicateProvider: (id) => calls.push(['duplicate', id]),
    duplicateModel: (id) => calls.push(['duplicate-model', id]),
    addModel: (groupId, patch) => calls.push(['add-model', groupId, patch]),
    removeProvider: (id) => {
      providers = providers.filter((provider) => provider.id !== id);
      if (!providers.some((provider) => provider.isDefault) && providers[0]) {
        providers = providers.map((provider, index) => ({ ...provider, isDefault: index === 0 }));
      }
      return providers;
    },
    removeGroup: (groupId) => {
      providers = providers.filter((provider) => (provider.groupId ?? provider.id) !== groupId);
      if (!providers.some((provider) => provider.isDefault) && providers[0]) {
        providers = providers.map((provider, index) => ({ ...provider, isDefault: index === 0 }));
      }
      return providers;
    },
    setDefault: (id) => {
      providers = providers.map((provider) => ({ ...provider, isDefault: provider.id === id }));
      return providers;
    },
    testConnection: (id) => ({ id, ok: true }),
    completePrompt: async (params) => ({ success: true, text: '{"name":"x","scheduleKind":"daily","hour":9,"minute":0}', params }),
    recordBaseline: (reason, provider) => calls.push(['baseline', reason, provider.id]),
    notifyOAuthRefreshed: (payload) => calls.push(['refreshed', payload]),
    reportRefreshError: (error) => calls.push(['refresh-error', error.message]),
    reportBackfillResult: (reason, result) => calls.push(['backfill-result', reason, result]),
    reportBackfillError: (error) => calls.push(['backfill-error', error.message]),
    ...overrides,
  };
  const service = createProviderConfigurationApplicationService(ports);
  return { calls, getProviders: () => providers, service };
}

test('provider lists return immediately and schedule one background OAuth refresh', async () => {
  const { calls, service } = createHarness();

  assert.deepEqual(await service.listGroups(), [{ id: 'g1' }]);
  assert.equal((await service.listProviders()).length, 2);
  await service.scheduleMissingPricingBackfill('joined');
  // 后台刷新/回填在微任务里完成后断言
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ['refresh'],
    ['backfill'],
    ['backfill-result', 'llm:list', { updated: 1, examined: 2 }],
  ]);
});

test('provider list requests coalesce concurrent background OAuth refreshes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, service } = createHarness({
    refreshExpiredOAuth: async () => {
      calls.push(['refresh']);
      await gate;
      return { attempted: 1, refreshed: 1 };
    },
  });

  // 用 listGroups（不触发 pricing backfill）聚焦验证刷新合并语义。
  const first = service.listGroups();
  const second = service.listGroups();
  const third = service.listGroups();
  assert.deepEqual(await first, [{ id: 'g1' }]);
  assert.deepEqual(await second, [{ id: 'g1' }]);
  assert.deepEqual(await third, [{ id: 'g1' }]);
  release();
  await new Promise((resolve) => setImmediate(resolve));

  // 三次列表请求只合并成一次后台刷新，且刷新完成后通知一次。
  assert.deepEqual(calls, [
    ['refresh'],
    ['refreshed', { reason: 'llm:list', refreshed: 1 }],
  ]);
});

test('background OAuth refresh does not notify when nothing was refreshed', async () => {
  const { calls, service } = createHarness({
    refreshExpiredOAuth: async () => {
      calls.push(['refresh']);
      return { attempted: 0, refreshed: 0 };
    },
  });

  assert.deepEqual(await service.listGroups(), [{ id: 'g1' }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [['refresh']]);
});

test('provider list requests are not blocked by a pending OAuth refresh', async () => {
  // 模拟一个永远挂起的刷新（如网络卡死）：列表必须立即返回，不等待。
  const { service } = createHarness({
    refreshExpiredOAuth: () => new Promise(() => {}),
  });

  const listed = await Promise.race([
    service.listGroups(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('listGroups blocked on refresh')), 50)),
  ]);
  assert.deepEqual(listed, [{ id: 'g1' }]);
});

test('provider silent refresh and pricing backfill failures are degraded', async () => {
  const { calls, service } = createHarness({
    refreshExpiredOAuth: async () => { throw new Error('refresh failed'); },
    backfillMissingPricing: async () => { throw new Error('backfill failed'); },
    reportRefreshError: (error) => calls.push(['refresh-error', error.message]),
    reportBackfillError: (error) => calls.push(['backfill-error', error.message]),
  });

  assert.equal((await service.listProviders()).length, 2);
  assert.equal(await service.scheduleMissingPricingBackfill('joined'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['refresh-error', 'refresh failed'],
    ['backfill-error', 'backfill failed'],
  ]);
});

test('provider pricing backfill coalesces concurrent requests', async () => {
  let resolveBackfill;
  let runs = 0;
  const pending = new Promise((resolve) => { resolveBackfill = resolve; });
  const { service } = createHarness({
    backfillMissingPricing: () => {
      runs += 1;
      return pending;
    },
  });

  const first = service.scheduleMissingPricingBackfill('one');
  const second = service.scheduleMissingPricingBackfill('two');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runs, 1);
  resolveBackfill({ updated: 0, examined: 1 });
  await first;
});

test('provider add and update record only meaningful default target baselines', () => {
  const { calls, service } = createHarness();

  service.add({ provider: 'openai', model: 'm3', isDefault: false });
  service.add({ provider: 'google', model: 'gemini', isDefault: true });
  service.update('p2', { model: 'm2-new' });
  service.update('p1', { modelLabel: 'M1' });
  service.update('p1', { model: 'm1-new' });

  assert.deepEqual(calls, [
    ['baseline', 'initial', 'new'],
    ['baseline', 'model_switch', 'p1'],
  ]);
});

test('provider duplicate and model mutations preserve refreshed provider-list results', () => {
  const { calls, getProviders, service } = createHarness();

  assert.equal(service.duplicate('p1'), getProviders());
  assert.equal(service.duplicateModel('p1'), getProviders());
  assert.equal(service.addModel('g1', { model: 'm3' }), getProviders());
  assert.deepEqual(calls, [
    ['duplicate', 'p1'],
    ['duplicate-model', 'p1'],
    ['add-model', 'g1', { model: 'm3' }],
  ]);
});

test('provider removal and default selection record fallback baseline transitions', () => {
  const removeHarness = createHarness();
  const removed = removeHarness.service.remove('p1');
  assert.equal(removed[0].id, 'p2');
  assert.deepEqual(removeHarness.calls, [['baseline', 'model_switch', 'p2']]);

  const groupHarness = createHarness();
  const afterGroup = groupHarness.service.removeGroup('g1');
  assert.equal(afterGroup[0].id, 'p2');
  assert.deepEqual(groupHarness.calls, [['baseline', 'model_switch', 'p2']]);

  const defaultHarness = createHarness();
  const afterDefault = defaultHarness.service.setDefault('p2');
  assert.equal(afterDefault.find((provider) => provider.isDefault).id, 'p2');
  defaultHarness.service.setDefault('p2');
  assert.deepEqual(defaultHarness.calls, [['baseline', 'model_switch', 'p2']]);
});

test('provider channels and connection test forward their values', () => {
  const { service } = createHarness();
  assert.deepEqual(service.listChannels(), ['openai']);
  assert.deepEqual(service.test('p1'), { id: 'p1', ok: true });
});
