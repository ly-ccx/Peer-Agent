function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createDataIpcRegistrations({ conversations, promptSnapshots, usage } = {}) {
  const conversation = {
    list: assertFunction(conversations?.list, 'conversations.list'),
    search: assertFunction(conversations?.search, 'conversations.search'),
    create: assertFunction(conversations?.create, 'conversations.create'),
    get: assertFunction(conversations?.get, 'conversations.get'),
    updateTitle: assertFunction(conversations?.updateTitle, 'conversations.updateTitle'),
    updateMode: assertFunction(conversations?.updateMode, 'conversations.updateMode'),
    updateFastMode: assertFunction(conversations?.updateFastMode, 'conversations.updateFastMode'),
    updateModelEffort: assertFunction(
      conversations?.updateModelEffort,
      'conversations.updateModelEffort',
    ),
    appendMessage: assertFunction(conversations?.appendMessage, 'conversations.appendMessage'),
    updateLastMessage: assertFunction(
      conversations?.updateLastMessage,
      'conversations.updateLastMessage',
    ),
    replaceMessages: assertFunction(
      conversations?.replaceMessages,
      'conversations.replaceMessages',
    ),
    archive: assertFunction(conversations?.archive, 'conversations.archive'),
    restore: assertFunction(conversations?.restore, 'conversations.restore'),
    pin: assertFunction(conversations?.pin, 'conversations.pin'),
    unpin: assertFunction(conversations?.unpin, 'conversations.unpin'),
    reorderPinned: assertFunction(conversations?.reorderPinned, 'conversations.reorderPinned'),
    autoArchive: assertFunction(conversations?.autoArchive, 'conversations.autoArchive'),
    remove: assertFunction(conversations?.remove, 'conversations.remove'),
    addUsage: assertFunction(conversations?.addUsage, 'conversations.addUsage'),
  };
  const prompt = {
    list: assertFunction(promptSnapshots?.list, 'promptSnapshots.list'),
    get: assertFunction(promptSnapshots?.get, 'promptSnapshots.get'),
    listContextEpochs: assertFunction(
      promptSnapshots?.listContextEpochs,
      'promptSnapshots.listContextEpochs',
    ),
    listContextEpochEvents: assertFunction(
      promptSnapshots?.listContextEpochEvents,
      'promptSnapshots.listContextEpochEvents',
    ),
    getContextEpochChain: assertFunction(
      promptSnapshots?.getContextEpochChain,
      'promptSnapshots.getContextEpochChain',
    ),
  };
  const usagePorts = {
    stats: assertFunction(usage?.stats, 'usage.stats'),
    daily: assertFunction(usage?.daily, 'usage.daily'),
    day: assertFunction(usage?.day, 'usage.day'),
    cacheHitRate: assertFunction(usage?.cacheHitRate, 'usage.cacheHitRate'),
  };

  return Object.freeze([
    owner('conversations-ipc', (ipc) => {
      ipc.handle('conversations:list', (_event, payload = {}) => conversation.list(payload));
      ipc.handle('conversations:search', (_event, payload) => conversation.search(payload));
      ipc.handle('conversations:create', (_event, payload) => conversation.create(payload));
      ipc.handle('conversations:get', (_event, payload) => conversation.get(payload));
      ipc.handle('conversations:update-title', (_event, payload) => conversation.updateTitle(payload));
      ipc.handle('conversations:update-mode', (_event, payload) => conversation.updateMode(payload));
      ipc.handle('conversations:update-fast-mode', (_event, payload) => conversation.updateFastMode(payload));
      ipc.handle('conversations:update-model-effort', (_event, payload) =>
        conversation.updateModelEffort(payload));
      ipc.handle('conversations:append-message', (_event, payload) =>
        conversation.appendMessage(payload));
      ipc.handle('conversations:update-last-message', (_event, payload) =>
        conversation.updateLastMessage(payload));
      ipc.handle('conversations:replace-messages', (_event, payload) =>
        conversation.replaceMessages(payload));
      ipc.handle('conversations:archive', (_event, payload) => conversation.archive(payload));
      ipc.handle('conversations:restore', (_event, payload) => conversation.restore(payload));
      ipc.handle('conversations:pin', (_event, payload) => conversation.pin(payload));
      ipc.handle('conversations:unpin', (_event, payload) => conversation.unpin(payload));
      ipc.handle('conversations:reorder-pinned', (_event, payload) =>
        conversation.reorderPinned(payload));
      ipc.handle('conversations:auto-archive', (_event, payload = {}) =>
        conversation.autoArchive(payload));
      ipc.handle('conversations:delete', (_event, payload) => conversation.remove(payload));
      ipc.handle('conversations:add-usage', (_event, payload) => conversation.addUsage(payload));
    }),
    owner('prompt-snapshots-ipc', (ipc) => {
      ipc.handle('prompt-snapshots:list', (_event, params = {}) =>
        prompt.list({ limit: params?.limit }));
      ipc.handle('prompt-snapshots:get', (_event, { id }) => prompt.get(id));
    }),
    owner('prompt-context-epochs-ipc', (ipc) => {
      ipc.handle('prompt-context-epochs:list', (_event, params = {}) =>
        prompt.listContextEpochs({ limit: params?.limit }));
      ipc.handle('prompt-context-epochs:events', (_event, params = {}) =>
        prompt.listContextEpochEvents({
          limit: params?.limit,
          conversationId: params?.conversationId,
          contextEpochId: params?.contextEpochId,
        }));
      ipc.handle('prompt-context-epochs:chain', (_event, params = {}) =>
        prompt.getContextEpochChain({
          conversationId: params?.conversationId ?? null,
          contextEpochId: params?.contextEpochId ?? null,
          limit: params?.limit,
        }));
    }),
    owner('usage-ipc', (ipc) => {
      ipc.handle('usage:stats', () => usagePorts.stats());
      ipc.handle('usage:daily', (_event, params) => usagePorts.daily({ range: params?.range }));
      ipc.handle('usage:day', (_event, params) => usagePorts.day({ date: params?.date }));
      ipc.handle('usage:cache-hit-rate', () => usagePorts.cacheHitRate());
    }),
  ]);
}
