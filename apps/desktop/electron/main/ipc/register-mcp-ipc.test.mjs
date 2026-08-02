import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpIpcRegistrations } from './register-mcp-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createMcpIpcRegistrations({
    mcp: {
      listInstalled: port('list-installed'),
      listCapabilities: port('list-capabilities'),
      listCredentials: port('list-credentials'),
      putCredential: port('put-credential'),
      deleteCredential: port('delete-credential'),
      install: port('install'),
      upsertServer: port('upsert-server'),
      uninstall: port('uninstall'),
      setEnabled: port('set-enabled'),
      setToolVisibility: port('set-tool-visibility'),
      testConnection: port('test-connection'),
      refreshManifest: port('refresh-manifest'),
      startOAuth: port('start-oauth'),
      finishOAuth: port('finish-oauth'),
      readResource: port('read-resource'),
      getPrompt: port('get-prompt'),
      connectAndRegister: port('connect-and-register'),
    },
  });
  const handlers = new Map();
  const ipc = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  };
  for (const registration of registrations) registration.register(ipc);
  return { calls, handlers, registrations };
}

test('MCP IPC has one owner for the exact 17-channel catalog set', () => {
  const { handlers, registrations } = createHarness();

  assert.deepEqual(registrations.map(({ owner }) => owner), ['mcp-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'mcp:connect-and-register',
    'mcp:delete-credential',
    'mcp:finish-oauth',
    'mcp:get-prompt',
    'mcp:install',
    'mcp:list-capabilities',
    'mcp:list-credentials',
    'mcp:list-installed',
    'mcp:put-credential',
    'mcp:read-resource',
    'mcp:refresh-manifest',
    'mcp:set-enabled',
    'mcp:set-tool-visibility',
    'mcp:start-oauth',
    'mcp:test-connection',
    'mcp:uninstall',
    'mcp:upsert-server',
  ]);
});

test('MCP IPC preserves aliases, payload defaults, and return forwarding', async () => {
  const { calls, handlers } = createHarness();
  const credential = { credentialRef: 'credential-1' };
  const server = { id: 'server-1' };
  const connection = { serverUrl: 'https://mcp.example', serverName: 'Example' };

  assert.equal(await handlers.get('mcp:list-installed')(), 'list-installed');
  assert.equal(await handlers.get('mcp:list-capabilities')(), 'list-capabilities');
  assert.equal(await handlers.get('mcp:list-credentials')(), 'list-credentials');
  assert.equal(await handlers.get('mcp:put-credential')(null, credential), 'put-credential');
  assert.equal(await handlers.get('mcp:delete-credential')(null, credential), 'delete-credential');
  assert.equal(await handlers.get('mcp:delete-credential')(null, 'credential-2'), 'delete-credential');
  assert.equal(await handlers.get('mcp:install')(null, server), 'install');
  assert.equal(await handlers.get('mcp:upsert-server')(null, server), 'upsert-server');
  assert.equal(await handlers.get('mcp:uninstall')(null, { mcpId: 'server-1' }), 'uninstall');
  assert.equal(await handlers.get('mcp:set-enabled')(null, { mcpId: 'server-1', enabled: false }), 'set-enabled');
  assert.equal(await handlers.get('mcp:set-tool-visibility')(null, {
    serverId: 'server-1',
    toolName: 'search',
    visible: false,
  }), 'set-tool-visibility');
  const probe = { serverId: 'server-1' };
  assert.equal(await handlers.get('mcp:test-connection')(null, probe), 'test-connection');
  assert.equal(await handlers.get('mcp:refresh-manifest')(null, { mcpId: 'server-1' }), 'refresh-manifest');
  assert.equal(await handlers.get('mcp:start-oauth')(null, { serverId: 'server-1' }), 'start-oauth');
  assert.equal(await handlers.get('mcp:finish-oauth')(null, {
    mcpId: 'server-1',
    code: 'oauth-code',
  }), 'finish-oauth');
  assert.equal(await handlers.get('mcp:read-resource')(null, {
    serverId: 'server-1',
    uri: 'file://one',
  }), 'read-resource');
  assert.equal(await handlers.get('mcp:get-prompt')(null, {
    mcpId: 'server-1',
    name: 'review',
  }), 'get-prompt');
  assert.equal(await handlers.get('mcp:connect-and-register')(null, connection), 'connect-and-register');

  assert.deepEqual(calls, [
    ['list-installed'],
    ['list-capabilities'],
    ['list-credentials'],
    ['put-credential', credential],
    ['delete-credential', 'credential-1'],
    ['delete-credential', 'credential-2'],
    ['install', server],
    ['upsert-server', server],
    ['uninstall', 'server-1'],
    ['set-enabled', 'server-1', false],
    ['set-tool-visibility', 'server-1', 'search', false],
    ['test-connection', probe],
    ['refresh-manifest', 'server-1'],
    ['start-oauth', 'server-1'],
    ['finish-oauth', 'server-1', 'oauth-code'],
    ['read-resource', 'server-1', 'file://one'],
    ['get-prompt', 'server-1', 'review', {}],
    ['connect-and-register', 'https://mcp.example', 'Example'],
  ]);
});
