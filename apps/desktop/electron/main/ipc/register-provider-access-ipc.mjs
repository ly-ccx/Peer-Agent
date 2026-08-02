function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createProviderAccessIpcRegistrations({ providers } = {}) {
  const ports = {
    quota: assertFunction(providers?.quota, 'providers.quota'),
    startOAuth: assertFunction(providers?.startOAuth, 'providers.startOAuth'),
    openPendingOAuth: assertFunction(providers?.openPendingOAuth, 'providers.openPendingOAuth'),
    cancelOAuth: assertFunction(providers?.cancelOAuth, 'providers.cancelOAuth'),
    listModels: assertFunction(providers?.listModels, 'providers.listModels'),
    fetchModels: assertFunction(providers?.fetchModels, 'providers.fetchModels'),
    dispose: assertFunction(providers?.dispose, 'providers.dispose'),
  };

  return Object.freeze([
    owner(
      'provider-access-ipc',
      (ipc) => {
        ipc.handle('llm:quota', (_event, { id, force } = {}) => ports.quota(id, force));
        ipc.handle('llm:oauth:start', (event, params) => ports.startOAuth(event.sender, params));
        ipc.handle('llm:oauth:open-pending', () => ports.openPendingOAuth());
        ipc.handle('llm:oauth:cancel', () => ports.cancelOAuth());
        ipc.handle('llm:models:list', (_event, { id } = {}) => ports.listModels(id));
        ipc.handle('llm:models:fetch', (_event, config) => ports.fetchModels(config));
        return () => ports.dispose();
      },
    ),
  ]);
}
