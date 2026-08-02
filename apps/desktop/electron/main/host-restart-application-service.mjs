function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function createHostRestartApplicationService({
  workspaceRoot,
  restartHost,
  writePendingTask,
  reportPendingTaskError,
} = {}) {
  const restart = assertFunction(restartHost, 'restartHost');
  const persistPendingTask = assertFunction(writePendingTask, 'writePendingTask');
  const reportError = assertFunction(reportPendingTaskError, 'reportPendingTaskError');

  function restartWithHandoff(payload = {}) {
    let hostDir = payload.hostDir;
    if (!hostDir && workspaceRoot) {
      hostDir = workspaceRoot.endsWith('-lab')
        ? workspaceRoot.slice(0, -'-lab'.length)
        : workspaceRoot;
    }

    if (payload.pendingTask) {
      try {
        persistPendingTask(payload.pendingTask);
      } catch (error) {
        reportError(error);
      }
    }

    return restart({ hostDir, port: payload.port });
  }

  return Object.freeze({ restart: restartWithHandoff });
}
