function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createPendingTaskIpcRegistrations({ pendingTask } = {}) {
  const ports = {
    write: assertFunction(pendingTask?.write, 'pendingTask.write'),
    consume: assertFunction(pendingTask?.consume, 'pendingTask.consume'),
    peek: assertFunction(pendingTask?.peek, 'pendingTask.peek'),
    clear: assertFunction(pendingTask?.clear, 'pendingTask.clear'),
  };

  return Object.freeze([
    owner('pending-task-ipc', (ipc) => {
      ipc.handle('pending-task:write', (_event, task = {}) => ports.write(task));
      ipc.handle('pending-task:consume', () => ports.consume());
      ipc.handle('pending-task:peek', () => ports.peek());
      ipc.handle('pending-task:clear', () => ports.clear());
    }),
  ]);
}
