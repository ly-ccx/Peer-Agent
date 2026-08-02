function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createProviderConfigurationIpcRegistrations({ providers } = {}) {
  const ports = {
    listChannels: assertFunction(providers?.listChannels, 'providers.listChannels'),
    listGroups: assertFunction(providers?.listGroups, 'providers.listGroups'),
    listProviders: assertFunction(providers?.listProviders, 'providers.listProviders'),
    listChatProviders: assertFunction(providers?.listChatProviders, 'providers.listChatProviders'),
    add: assertFunction(providers?.add, 'providers.add'),
    update: assertFunction(providers?.update, 'providers.update'),
    duplicate: assertFunction(providers?.duplicate, 'providers.duplicate'),
    duplicateModel: assertFunction(providers?.duplicateModel, 'providers.duplicateModel'),
    addModel: assertFunction(providers?.addModel, 'providers.addModel'),
    remove: assertFunction(providers?.remove, 'providers.remove'),
    removeGroup: assertFunction(providers?.removeGroup, 'providers.removeGroup'),
    setDefault: assertFunction(providers?.setDefault, 'providers.setDefault'),
    test: assertFunction(providers?.test, 'providers.test'),
  };

  return Object.freeze([
    owner('provider-configuration-ipc', (ipc) => {
      ipc.handle('llm:channels:list', () => ports.listChannels());
      ipc.handle('llm:groups:list', () => ports.listGroups());
      ipc.handle('llm:list', () => ports.listProviders());
      ipc.handle('llm:chat:list', () => ports.listChatProviders());
      ipc.handle('llm:add', (_event, config) => ports.add(config));
      ipc.handle('llm:update', (_event, { id, ...patch }) => ports.update(id, patch));
      ipc.handle('llm:duplicate', (_event, { id }) => ports.duplicate(id));
      ipc.handle('llm:duplicate-model', (_event, { id }) => ports.duplicateModel(id));
      ipc.handle('llm:add-model', (_event, { groupId, ...patch }) =>
        ports.addModel(groupId, patch));
      ipc.handle('llm:remove', (_event, { id }) => ports.remove(id));
      ipc.handle('llm:remove-group', (_event, { groupId }) => ports.removeGroup(groupId));
      ipc.handle('llm:set-default', (_event, { id }) => ports.setDefault(id));
      ipc.handle('llm:test', (_event, { id }) => ports.test(id));
    }),
  ]);
}
