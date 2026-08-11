function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createChatIpcRegistrations({ chat } = {}) {
  const ports = {
    send: assertFunction(chat?.send, 'chat.send'),
    startTask: assertFunction(chat?.startTask, 'chat.startTask'),
    abort: assertFunction(chat?.abort, 'chat.abort'),
    reattach: assertFunction(chat?.reattach, 'chat.reattach'),
    listActive: assertFunction(chat?.listActive, 'chat.listActive'),
    compact: assertFunction(chat?.compact, 'chat.compact'),
    getCompaction: assertFunction(chat?.getCompaction, 'chat.getCompaction'),
    contextRestored: assertFunction(chat?.contextRestored, 'chat.contextRestored'),
  };

  return [
    owner('chat-ipc', (ipc) => {
      ipc.handle('chat:send', (event, payload = {}) => ports.send(payload, event.sender));
      ipc.handle('chat:start-task', (event, payload = {}) => ports.startTask(payload, event.sender));
      ipc.handle('chat:abort', (_event, payload = {}) => ports.abort(payload));
      ipc.handle('chat:stream:reattach', (_event, payload = {}) => ports.reattach(payload));
      ipc.handle('chat:stream:list-active', () => ports.listActive());
      ipc.handle('chat:compact', (event, payload = {}) => ports.compact(payload, event.sender));
      ipc.handle('chat:compaction:get', (_event, payload = {}) => ports.getCompaction(payload));
      ipc.handle('chat:context:restored', (event, payload = {}) =>
        ports.contextRestored(payload, event.sender));
    }),
  ];
}
