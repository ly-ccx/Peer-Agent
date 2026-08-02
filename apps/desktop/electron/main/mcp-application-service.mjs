function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function serverNotFound(serverId) {
  return new Error(`MCP server not found: ${serverId ?? ''}`);
}

export function createMcpApplicationService({
  listInstalled,
  listCapabilities,
  listCredentials,
  putCredential,
  deleteCredential,
  installServer,
  upsertServer,
  getServer,
  uninstallServer,
  setServerEnabled,
  setToolVisibility,
  updateManifest,
  updateHealth,
  testConnection,
  probeConnection,
  disconnectServer,
  waitForOAuthCallback,
  closeOAuthCallback,
  startOAuth,
  finishOAuth,
  readResource,
  getPrompt,
  reportCredentialCleanupError = () => {},
} = {}) {
  const ports = {
    listInstalled: assertFunction(listInstalled, 'listInstalled'),
    listCapabilities: assertFunction(listCapabilities, 'listCapabilities'),
    listCredentials: assertFunction(listCredentials, 'listCredentials'),
    putCredential: assertFunction(putCredential, 'putCredential'),
    deleteCredential: assertFunction(deleteCredential, 'deleteCredential'),
    installServer: assertFunction(installServer, 'installServer'),
    upsertServer: assertFunction(upsertServer, 'upsertServer'),
    getServer: assertFunction(getServer, 'getServer'),
    uninstallServer: assertFunction(uninstallServer, 'uninstallServer'),
    setServerEnabled: assertFunction(setServerEnabled, 'setServerEnabled'),
    setToolVisibility: assertFunction(setToolVisibility, 'setToolVisibility'),
    updateManifest: assertFunction(updateManifest, 'updateManifest'),
    updateHealth: assertFunction(updateHealth, 'updateHealth'),
    testConnection: assertFunction(testConnection, 'testConnection'),
    probeConnection: assertFunction(probeConnection, 'probeConnection'),
    disconnectServer: assertFunction(disconnectServer, 'disconnectServer'),
    waitForOAuthCallback: assertFunction(waitForOAuthCallback, 'waitForOAuthCallback'),
    closeOAuthCallback: assertFunction(closeOAuthCallback, 'closeOAuthCallback'),
    startOAuth: assertFunction(startOAuth, 'startOAuth'),
    finishOAuth: assertFunction(finishOAuth, 'finishOAuth'),
    readResource: assertFunction(readResource, 'readResource'),
    getPrompt: assertFunction(getPrompt, 'getPrompt'),
    reportCredentialCleanupError: assertFunction(
      reportCredentialCleanupError,
      'reportCredentialCleanupError',
    ),
  };

  function requireServer(serverId) {
    const server = ports.getServer(serverId);
    if (!server) throw serverNotFound(serverId);
    return server;
  }

  function persistProbe(serverId, probe) {
    if (probe.state === 'connected' && probe.manifest) {
      return ports.updateManifest(serverId, probe.manifest);
    }
    return ports.updateHealth(serverId, probe.health);
  }

  function probeResponse(probe, view) {
    return {
      ...probe,
      success: probe.state === 'connected',
      toolCount: probe.toolsCount,
      view,
    };
  }

  async function refreshManifest(serverId) {
    const server = requireServer(serverId);
    const probe = await ports.probeConnection(server);
    const view = persistProbe(server.id, probe);
    ports.disconnectServer(ports.getServer(server.id));
    return probeResponse(probe, view);
  }

  async function beginOAuth(serverId) {
    const server = requireServer(serverId);
    const callbackPromise = ports.waitForOAuthCallback();
    let start;
    try {
      start = await ports.startOAuth(server);
    } catch (error) {
      ports.closeOAuthCallback();
      throw error;
    }

    if (start?.status === 'authorized' || start?.redirected === false) {
      ports.closeOAuthCallback();
      const probe = await ports.probeConnection(server);
      const view = persistProbe(server.id, probe);
      ports.disconnectServer(ports.getServer(server.id));
      return { ...probeResponse(probe, view), oauth: 'authorized' };
    }

    const code = await callbackPromise;
    await ports.finishOAuth(server, code);
    ports.disconnectServer(ports.getServer(server.id));
    const probe = await ports.probeConnection(server);
    const view = persistProbe(server.id, probe);
    ports.disconnectServer(ports.getServer(server.id));
    return { ...probeResponse(probe, view), oauth: 'connected' };
  }

  async function completeOAuth(serverId, authorizationCode) {
    const server = requireServer(serverId);
    const result = await ports.finishOAuth(server, authorizationCode);
    ports.disconnectServer(server);
    return result;
  }

  async function connectAndRegister(serverUrl, serverName) {
    if (!serverUrl || !serverName) throw new Error('serverUrl and serverName are required');
    const view = ports.upsertServer({
      displayName: serverName,
      name: serverName,
      transport: 'streamable_http',
      url: serverUrl,
      serverUrl,
      auth: { mode: 'none' },
      enabled: true,
    });
    const server = ports.getServer(view.id);
    const probe = await ports.probeConnection(server);
    const refreshed = persistProbe(view.id, probe);
    ports.disconnectServer(ports.getServer(view.id));
    return probeResponse(probe, refreshed);
  }

  return Object.freeze({
    listInstalled: () => ports.listInstalled(),
    listCapabilities: () => ports.listCapabilities(),
    listCredentials: () => ports.listCredentials(),
    putCredential: (item) => ports.putCredential(item),
    deleteCredential: (credentialRef) => ports.deleteCredential(credentialRef),
    install: (item) => ports.installServer(item),
    upsertServer: (item) => ports.upsertServer(item),
    uninstall(serverId) {
      let boundCredentialRef = null;
      try {
        boundCredentialRef = ports.getServer(serverId)?.auth?.credentialRef ?? null;
      } catch {
        boundCredentialRef = null;
      }
      const result = ports.uninstallServer(serverId);
      if (boundCredentialRef) {
        try {
          ports.deleteCredential(boundCredentialRef);
        } catch (error) {
          ports.reportCredentialCleanupError(error);
        }
      }
      return result;
    },
    setEnabled: (serverId, enabled) => ports.setServerEnabled(serverId, enabled),
    setToolVisibility: (serverId, toolName, visible) =>
      ports.setToolVisibility(serverId, toolName, visible),
    async testConnection(params) {
      const hasStoredServer = Boolean(params?.serverId || params?.mcpId);
      const serverId = params?.serverId ?? params?.mcpId;
      const server = hasStoredServer ? ports.getServer(serverId) : params;
      if (!server) throw serverNotFound(serverId);
      const result = await ports.testConnection(server);
      if (hasStoredServer) ports.updateHealth(server.id, result.health);
      return result;
    },
    refreshManifest,
    startOAuth: beginOAuth,
    finishOAuth: completeOAuth,
    async readResource(serverId, uri) {
      return ports.readResource(requireServer(serverId), uri);
    },
    async getPrompt(serverId, name, args = {}) {
      return ports.getPrompt(requireServer(serverId), name, args);
    },
    connectAndRegister,
  });
}
