function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createMcpIpcRegistrations({ mcp } = {}) {
  const ports = {
    listInstalled: assertFunction(mcp?.listInstalled, 'mcp.listInstalled'),
    listCapabilities: assertFunction(mcp?.listCapabilities, 'mcp.listCapabilities'),
    listCredentials: assertFunction(mcp?.listCredentials, 'mcp.listCredentials'),
    putCredential: assertFunction(mcp?.putCredential, 'mcp.putCredential'),
    deleteCredential: assertFunction(mcp?.deleteCredential, 'mcp.deleteCredential'),
    install: assertFunction(mcp?.install, 'mcp.install'),
    upsertServer: assertFunction(mcp?.upsertServer, 'mcp.upsertServer'),
    uninstall: assertFunction(mcp?.uninstall, 'mcp.uninstall'),
    setEnabled: assertFunction(mcp?.setEnabled, 'mcp.setEnabled'),
    setToolVisibility: assertFunction(mcp?.setToolVisibility, 'mcp.setToolVisibility'),
    testConnection: assertFunction(mcp?.testConnection, 'mcp.testConnection'),
    refreshManifest: assertFunction(mcp?.refreshManifest, 'mcp.refreshManifest'),
    startOAuth: assertFunction(mcp?.startOAuth, 'mcp.startOAuth'),
    finishOAuth: assertFunction(mcp?.finishOAuth, 'mcp.finishOAuth'),
    readResource: assertFunction(mcp?.readResource, 'mcp.readResource'),
    getPrompt: assertFunction(mcp?.getPrompt, 'mcp.getPrompt'),
    connectAndRegister: assertFunction(mcp?.connectAndRegister, 'mcp.connectAndRegister'),
  };

  return Object.freeze([
    owner('mcp-ipc', (ipc) => {
      ipc.handle('mcp:list-installed', () => ports.listInstalled());
      ipc.handle('mcp:list-capabilities', () => ports.listCapabilities());
      ipc.handle('mcp:list-credentials', () => ports.listCredentials());
      ipc.handle('mcp:put-credential', (_event, item) => ports.putCredential(item));
      ipc.handle('mcp:delete-credential', (_event, params) =>
        ports.deleteCredential(params?.credentialRef ?? params));
      ipc.handle('mcp:install', (_event, item) => ports.install(item));
      ipc.handle('mcp:upsert-server', (_event, item) => ports.upsertServer(item));
      ipc.handle('mcp:uninstall', (_event, params) =>
        ports.uninstall(params?.mcpId ?? params?.serverId));
      ipc.handle('mcp:set-enabled', (_event, params) =>
        ports.setEnabled(params?.serverId ?? params?.mcpId, params?.enabled));
      ipc.handle('mcp:set-tool-visibility', (_event, params) =>
        ports.setToolVisibility(
          params?.serverId ?? params?.mcpId,
          params?.toolName,
          params?.visible,
        ));
      ipc.handle('mcp:test-connection', (_event, params) => ports.testConnection(params));
      ipc.handle('mcp:refresh-manifest', (_event, params) =>
        ports.refreshManifest(params?.serverId ?? params?.mcpId));
      ipc.handle('mcp:start-oauth', (_event, params) =>
        ports.startOAuth(params?.serverId ?? params?.mcpId));
      ipc.handle('mcp:finish-oauth', (_event, params) =>
        ports.finishOAuth(
          params?.serverId ?? params?.mcpId,
          params?.authorizationCode ?? params?.code,
        ));
      ipc.handle('mcp:read-resource', (_event, params) =>
        ports.readResource(params?.serverId ?? params?.mcpId, params?.uri));
      ipc.handle('mcp:get-prompt', (_event, params) =>
        ports.getPrompt(
          params?.serverId ?? params?.mcpId,
          params?.name,
          params?.arguments ?? {},
        ));
      ipc.handle('mcp:connect-and-register', (_event, { serverUrl, serverName }) =>
        ports.connectAndRegister(serverUrl, serverName));
    }),
  ]);
}
