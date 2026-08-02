function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function createPendingTaskApplicationService({
  workspaceRoot,
  writePendingTask,
  consumePendingTask,
  peekPendingTask,
  clearPendingTask,
  reportWorkspaceMismatch = () => {},
} = {}) {
  const write = assertFunction(writePendingTask, 'writePendingTask');
  const consume = assertFunction(consumePendingTask, 'consumePendingTask');
  const peek = assertFunction(peekPendingTask, 'peekPendingTask');
  const clear = assertFunction(clearPendingTask, 'clearPendingTask');
  const reportMismatch = assertFunction(reportWorkspaceMismatch, 'reportWorkspaceMismatch');

  function withWorkspace(task) {
    return { ...task, workspace: workspaceRoot };
  }

  function matchWorkspace(record) {
    if (!record) return null;
    if (workspaceRoot && record.workspace && record.workspace !== workspaceRoot) {
      reportMismatch(record.workspace, workspaceRoot);
      clear();
      return null;
    }
    return record;
  }

  return Object.freeze({
    write: (task = {}) => write(withWorkspace(task)),
    consume: () => matchWorkspace(consume()),
    peek: () => matchWorkspace(peek()),
    clear: () => {
      clear();
      return true;
    },
  });
}
