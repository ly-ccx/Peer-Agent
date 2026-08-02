import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpApplicationService } from './mcp-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const server = { id: 'server-1', auth: { credentialRef: 'credential-1' } };
  const connectedProbe = {
    state: 'connected',
    ok: true,
    manifest: { tools: [{ name: 'search' }] },
    health: { status: 'ok' },
    toolsCount: 1,
  };
  const ports = {
    listInstalled: () => [],
    listCapabilities: () => [],
    listCredentials: () => [],
    putCredential: (item) => item,
    deleteCredential: (credentialRef) => credentialRef,
    installServer: (item) => item,
    upsertServer: (item) => ({ ...item, id: 'server-1' }),
    getServer: (serverId) => (serverId === 'server-1' ? server : null),
    uninstallServer: (serverId) => ({ removed: serverId }),
    setServerEnabled: (serverId, enabled) => ({ serverId, enabled }),
    setToolVisibility: (serverId, toolName, visible) => ({ serverId, toolName, visible }),
    updateManifest: (serverId, manifest) => ({ id: serverId, manifest }),
    updateHealth: (serverId, health) => ({ id: serverId, health }),
    testConnection: async () => ({ ok: true, health: { status: 'ok' } }),
    probeConnection: async () => connectedProbe,
    disconnectServer: () => {},
    waitForOAuthCallback: () => Promise.resolve('oauth-code'),
    closeOAuthCallback: () => {},
    startOAuth: async () => ({ status: 'redirect', redirected: true }),
    finishOAuth: async () => ({ ok: true }),
    readResource: async (_server, uri) => ({ uri }),
    getPrompt: async (_server, name, args) => ({ name, args }),
    reportCredentialCleanupError: () => {},
    ...overrides,
  };
  const service = createMcpApplicationService(ports);
  return { calls, connectedProbe, ports, server, service };
}

test('MCP uninstall removes the bound credential after the server and degrades cleanup failure', () => {
  const calls = [];
  const cleanupError = new Error('vault unavailable');
  const { service } = createHarness({
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return { id: serverId, auth: { credentialRef: 'credential-1' } };
    },
    uninstallServer: (serverId) => {
      calls.push(['uninstall', serverId]);
      return { removed: true };
    },
    deleteCredential: (credentialRef) => {
      calls.push(['delete-credential', credentialRef]);
      throw cleanupError;
    },
    reportCredentialCleanupError: (error) => calls.push(['cleanup-error', error]),
  });

  assert.deepEqual(service.uninstall('server-1'), { removed: true });
  assert.deepEqual(calls, [
    ['get', 'server-1'],
    ['uninstall', 'server-1'],
    ['delete-credential', 'credential-1'],
    ['cleanup-error', cleanupError],
  ]);
});

test('MCP test connection persists health only for a stored server', async () => {
  const calls = [];
  const storedServer = { id: 'server-1' };
  const { service } = createHarness({
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return storedServer;
    },
    testConnection: async (server) => {
      calls.push(['test', server]);
      return { ok: true, health: { status: 'ok' } };
    },
    updateHealth: (serverId, health) => calls.push(['health', serverId, health]),
  });

  const storedResult = await service.testConnection({ mcpId: 'server-1' });
  const draft = { name: 'draft', transport: 'stdio' };
  const draftResult = await service.testConnection(draft);

  assert.deepEqual(storedResult, { ok: true, health: { status: 'ok' } });
  assert.deepEqual(draftResult, { ok: true, health: { status: 'ok' } });
  assert.deepEqual(calls, [
    ['get', 'server-1'],
    ['test', storedServer],
    ['health', 'server-1', { status: 'ok' }],
    ['test', draft],
  ]);
});

test('MCP refresh persists manifest, disconnects the refreshed server, and preserves response aliases', async () => {
  const calls = [];
  const server = { id: 'server-1' };
  const refreshed = { id: 'server-1', revision: 2 };
  const probe = {
    state: 'connected',
    manifest: { tools: [] },
    health: { status: 'ok' },
    toolsCount: 4,
  };
  const { service } = createHarness({
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return server;
    },
    probeConnection: async (value) => {
      calls.push(['probe', value]);
      return probe;
    },
    updateManifest: (serverId, manifest) => {
      calls.push(['manifest', serverId, manifest]);
      return refreshed;
    },
    disconnectServer: (value) => calls.push(['disconnect', value]),
  });

  assert.deepEqual(await service.refreshManifest('server-1'), {
    ...probe,
    success: true,
    toolCount: 4,
    view: refreshed,
  });
  assert.deepEqual(calls, [
    ['get', 'server-1'],
    ['probe', server],
    ['manifest', 'server-1', probe.manifest],
    ['get', 'server-1'],
    ['disconnect', server],
  ]);
});

test('MCP OAuth authorized path closes callback and reprobes without finishing a code', async () => {
  const calls = [];
  const server = { id: 'server-1' };
  const probe = { state: 'connected', manifest: {}, health: {}, toolsCount: 2 };
  const view = { id: 'server-1', revision: 3 };
  const { service } = createHarness({
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return server;
    },
    waitForOAuthCallback: () => {
      calls.push(['wait-callback']);
      return Promise.resolve('unused');
    },
    startOAuth: async (value) => {
      calls.push(['start', value]);
      return { status: 'authorized', redirected: false };
    },
    closeOAuthCallback: () => calls.push(['close-callback']),
    finishOAuth: () => assert.fail('authorized path must not exchange a code'),
    probeConnection: async (value) => {
      calls.push(['probe', value]);
      return probe;
    },
    updateManifest: (serverId, manifest) => {
      calls.push(['manifest', serverId, manifest]);
      return view;
    },
    disconnectServer: (value) => calls.push(['disconnect', value]),
  });

  assert.deepEqual(await service.startOAuth('server-1'), {
    ...probe,
    success: true,
    toolCount: 2,
    view,
    oauth: 'authorized',
  });
  assert.deepEqual(calls, [
    ['get', 'server-1'],
    ['wait-callback'],
    ['start', server],
    ['close-callback'],
    ['probe', server],
    ['manifest', 'server-1', probe.manifest],
    ['get', 'server-1'],
    ['disconnect', server],
  ]);
});

test('MCP OAuth redirect path exchanges callback code before reprobe and disconnects both sessions', async () => {
  const calls = [];
  const server = { id: 'server-1' };
  const probe = { state: 'failed', health: { status: 'failed' }, toolsCount: 0 };
  const view = { id: 'server-1', health: probe.health };
  const { service } = createHarness({
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return server;
    },
    waitForOAuthCallback: () => {
      calls.push(['wait-callback']);
      return Promise.resolve('oauth-code');
    },
    startOAuth: async (value) => {
      calls.push(['start', value]);
      return { status: 'redirect', redirected: true };
    },
    finishOAuth: async (value, code) => calls.push(['finish', value, code]),
    probeConnection: async (value) => {
      calls.push(['probe', value]);
      return probe;
    },
    updateHealth: (serverId, health) => {
      calls.push(['health', serverId, health]);
      return view;
    },
    disconnectServer: (value) => calls.push(['disconnect', value]),
  });

  assert.deepEqual(await service.startOAuth('server-1'), {
    ...probe,
    success: false,
    toolCount: 0,
    view,
    oauth: 'connected',
  });
  assert.deepEqual(calls, [
    ['get', 'server-1'],
    ['wait-callback'],
    ['start', server],
    ['finish', server, 'oauth-code'],
    ['get', 'server-1'],
    ['disconnect', server],
    ['probe', server],
    ['health', 'server-1', probe.health],
    ['get', 'server-1'],
    ['disconnect', server],
  ]);
});

test('MCP OAuth start failure closes callback before rethrowing', async () => {
  const calls = [];
  const failure = new Error('discovery failed');
  const { service } = createHarness({
    waitForOAuthCallback: () => {
      calls.push(['wait']);
      return new Promise(() => {});
    },
    startOAuth: async () => {
      calls.push(['start']);
      throw failure;
    },
    closeOAuthCallback: () => calls.push(['close']),
  });

  await assert.rejects(service.startOAuth('server-1'), failure);
  assert.deepEqual(calls, [['wait'], ['start'], ['close']]);
});

test('MCP connect-and-register preserves server projection and failed health response', async () => {
  const calls = [];
  const server = { id: 'server-1' };
  const probe = { state: 'failed', health: { status: 'failed' }, toolsCount: 0 };
  const refreshed = { id: 'server-1', health: probe.health };
  const { service } = createHarness({
    upsertServer: (item) => {
      calls.push(['upsert', item]);
      return { id: 'server-1' };
    },
    getServer: (serverId) => {
      calls.push(['get', serverId]);
      return server;
    },
    probeConnection: async (value) => {
      calls.push(['probe', value]);
      return probe;
    },
    updateHealth: (serverId, health) => {
      calls.push(['health', serverId, health]);
      return refreshed;
    },
    disconnectServer: (value) => calls.push(['disconnect', value]),
  });

  assert.deepEqual(await service.connectAndRegister('https://mcp.example', 'Example'), {
    ...probe,
    success: false,
    toolCount: 0,
    view: refreshed,
  });
  assert.deepEqual(calls, [
    ['upsert', {
      displayName: 'Example',
      name: 'Example',
      transport: 'streamable_http',
      url: 'https://mcp.example',
      serverUrl: 'https://mcp.example',
      auth: { mode: 'none' },
      enabled: true,
    }],
    ['get', 'server-1'],
    ['probe', server],
    ['health', 'server-1', probe.health],
    ['get', 'server-1'],
    ['disconnect', server],
  ]);
  await assert.rejects(service.connectAndRegister('', 'Example'), /serverUrl and serverName are required/);
});

test('MCP resource and prompt calls require a registered server and preserve arguments', async () => {
  const calls = [];
  const server = { id: 'server-1' };
  const { service } = createHarness({
    getServer: (serverId) => (serverId === 'server-1' ? server : null),
    readResource: async (value, uri) => {
      calls.push(['resource', value, uri]);
      return { uri };
    },
    getPrompt: async (value, name, args) => {
      calls.push(['prompt', value, name, args]);
      return { name, args };
    },
  });

  assert.deepEqual(await service.readResource('server-1', 'file://one'), { uri: 'file://one' });
  assert.deepEqual(await service.getPrompt('server-1', 'review', { depth: 2 }), {
    name: 'review',
    args: { depth: 2 },
  });
  await assert.rejects(service.readResource('missing', 'file://one'), /MCP server not found: missing/);
  assert.deepEqual(calls, [
    ['resource', server, 'file://one'],
    ['prompt', server, 'review', { depth: 2 }],
  ]);
});
