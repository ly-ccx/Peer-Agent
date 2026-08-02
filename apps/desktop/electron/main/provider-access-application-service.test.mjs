import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderAccessApplicationService } from './provider-access-application-service.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const calls = [];
  let providers = [{ id: 'p1', authMethod: 'oauth_chatgpt', model: 'gpt-5', isDefault: true }];
  const credentialById = new Map();
  const sessions = [];
  const defaultOperations = {
    startBrowserLogin() {
      const session = { ...deferred(), cancel() { calls.push(['cancel-session']); } };
      sessions.push(session);
      return session;
    },
    startGoogleBrowserLogin() { throw new Error('unexpected_google_login'); },
    startGrokOAuthLogin() { throw new Error('unexpected_grok_login'); },
    ensureFreshTokens: async (tokens) => ({ tokens, refreshed: false }),
    ensureFreshGoogleTokens: async (tokens) => ({ tokens, refreshed: false }),
    ensureFreshGrokTokens: async (tokens) => ({ tokens, refreshed: false }),
    listSubscriptionModels: async () => ({ models: [{ id: 'gpt-5' }], source: 'builtin' }),
    listOpenAICompatibleModels: async () => ({ models: [{ id: 'remote' }], source: 'remote' }),
    listGrokBuildModels: async () => ({ models: [], source: 'remote' }),
    listGeminiModels: async () => ({ models: [], source: 'builtin' }),
    preferGeminiModel: () => null,
    listQoderModels: async () => ({ models: [{ id: 'qoder' }], source: 'qoder' }),
    resolveChannel: (config) => ({ ...config, headers: { Authorization: 'Bearer secret' }, wire: 'openai' }),
    resolveGeminiCodeAssistProjectId: async () => null,
  };
  const service = createProviderAccessApplicationService({
    fetchQuota: async (id, force) => ({ id, force }),
    listProviders: () => providers.map((provider) => ({ ...provider })),
    addProvider: (draft) => {
      const provider = { id: `p${providers.length + 1}`, ...draft };
      providers.push(provider);
      calls.push(['add', provider.id]);
      return { ...provider };
    },
    updateProvider: (id, patch) => {
      const index = providers.findIndex((provider) => provider.id === id);
      if (index < 0) return null;
      providers[index] = { ...providers[index], ...patch };
      calls.push(['update', id, patch]);
      return { ...providers[index] };
    },
    removeProvider: (id) => {
      providers = providers.filter((provider) => provider.id !== id);
      calls.push(['remove', id]);
    },
    getCredential: (id) => credentialById.get(id) ?? null,
    setOAuthTokens: (id, tokens) => {
      const provider = providers.find((entry) => entry.id === id);
      credentialById.set(id, { authMethod: provider?.authMethod, tokens });
      calls.push(['tokens', id]);
    },
    getApiKeyRequestConfig: (id) => ({ id, baseUrl: 'https://example.test', apiKey: 'secret' }),
    fetchWithRecovery: async () => ({ ok: true }),
    openExternal: async (url) => calls.push(['open', url]),
    writeClipboard: (text) => calls.push(['clipboard', text]),
    sendOAuthEvent: (caller, channel, payload) => calls.push(['event', caller, channel, payload]),
    recordBaseline: (reason, provider) => calls.push(['baseline', reason, provider.id]),
    wait: async (duration) => calls.push(['wait', duration]),
    now: () => '2026-08-01T00:00:00.000Z',
    reportProjectResolutionError: (error) => calls.push(['project-error', error.message]),
    operations: { ...defaultOperations, ...overrides.operations },
    ...overrides.ports,
  });
  return { service, calls, sessions, credentialById, getProviders: () => providers };
}

test('provider access forwards quota and model discovery modes', async () => {
  const { service, credentialById } = createHarness();
  assert.deepEqual(await service.quota('p1', true), { id: 'p1', force: true });
  credentialById.set('p1', { authMethod: 'oauth_chatgpt', tokens: { access: 'token' } });
  assert.deepEqual(await service.listModels('p1'), {
    success: true,
    models: [{ id: 'gpt-5' }],
    source: 'builtin',
    error: undefined,
  });
  assert.deepEqual(await service.fetchModels({ channelId: 'openai', apiKey: 'secret' }), {
    success: true,
    models: [{ id: 'remote' }],
    source: 'remote',
  });
});

test('provider access keeps qoder model discovery on the local source', async () => {
  const { service } = createHarness({
    ports: {
      listProviders: () => [{ id: 'q1', authMethod: 'local_cli', channelId: 'qoder' }],
    },
  });
  assert.deepEqual(await service.listModels('q1'), {
    success: true,
    models: [{ id: 'qoder' }],
    source: 'qoder',
    error: undefined,
  });
  assert.deepEqual(await service.fetchModels({ channelId: 'qoder' }), {
    success: true,
    models: [{ id: 'qoder' }],
    source: 'qoder',
  });
});

test('OAuth creates a draft only after token success and records its baseline', async () => {
  const { service, sessions, calls, getProviders } = createHarness();
  const resultPromise = service.startOAuth({ id: 7 }, {
    draft: { authMethod: 'oauth_chatgpt', model: 'gpt-5' },
  });
  sessions[0].resolve({ access: 'token' });
  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(getProviders().length, 2);
  assert.deepEqual(calls, [
    ['add', 'p2'],
    ['tokens', 'p2'],
    ['baseline', 'oauth_login', 'p2'],
  ]);
});

test('OAuth rolls back a newly created provider when token persistence fails', async () => {
  const { service, sessions, calls, getProviders } = createHarness({
    ports: {
      setOAuthTokens: () => { throw new Error('persist_failed'); },
    },
  });
  const resultPromise = service.startOAuth({}, {
    draft: { authMethod: 'oauth_chatgpt', model: 'gpt-5' },
  });
  sessions[0].resolve({ access: 'token' });
  assert.deepEqual(await resultPromise, { success: false, error: 'persist_failed' });
  assert.equal(getProviders().length, 1);
  assert.deepEqual(calls, [['add', 'p2'], ['remove', 'p2']]);
});

test('starting another OAuth session cancels the previous one before replacement', async () => {
  const { service, sessions, calls } = createHarness();
  const first = service.startOAuth({}, { id: 'p1' });
  await Promise.resolve();
  const second = service.startOAuth({}, { id: 'p1' });
  sessions[0].reject(new Error('cancelled'));
  await first;
  await Promise.resolve();
  assert.deepEqual(calls.slice(0, 2), [['cancel-session'], ['wait', 200]]);
  sessions[1].resolve({ access: 'new-token' });
  await second;
});

test('pending OAuth open and cancel are fail-safe', async () => {
  const { service } = createHarness();
  assert.deepEqual(await service.openPendingOAuth(), {
    success: false,
    error: 'oauth_pending_url_unavailable',
  });
  assert.deepEqual(service.cancelOAuth(), { success: true });
});
