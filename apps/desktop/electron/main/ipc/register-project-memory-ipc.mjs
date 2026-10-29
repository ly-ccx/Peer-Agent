function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createProjectMemoryIpcRegistrations({ memory } = {}) {
  const ports = {
    list: assertFunction(memory?.list, 'memory.list'),
    pin: assertFunction(memory?.pin, 'memory.pin'),
    forget: assertFunction(memory?.forget, 'memory.forget'),
    restore: assertFunction(memory?.restore, 'memory.restore'),
    edit: assertFunction(memory?.edit, 'memory.edit'),
    exportMemory: assertFunction(memory?.exportMemory, 'memory.exportMemory'),
    setSwitches: assertFunction(memory?.setSwitches, 'memory.setSwitches'),
  };

  return Object.freeze([
    owner('project-memory-ipc', (ipc) => {
      ipc.handle('project-memory:list', (_event, payload) => ports.list(payload));
      ipc.handle('project-memory:pin', (_event, payload) => ports.pin(payload));
      ipc.handle('project-memory:forget', (_event, payload) => ports.forget(payload));
      ipc.handle('project-memory:restore', (_event, payload) => ports.restore(payload));
      ipc.handle('project-memory:edit', (_event, payload) => ports.edit(payload));
      ipc.handle('project-memory:export', (_event, payload) => ports.exportMemory(payload));
      ipc.handle('project-memory:set-switches', (_event, payload) => ports.setSwitches(payload));
    }),
  ]);
}
