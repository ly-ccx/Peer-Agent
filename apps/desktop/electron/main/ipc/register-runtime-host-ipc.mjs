function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createRuntimeHostIpcRegistrations({ shell, clientTool } = {}) {
  const shellPorts = {
    openPath: assertFunction(shell?.openPath, 'shell.openPath'),
    listEditors: assertFunction(shell?.listEditors, 'shell.listEditors'),
    setDefaultEditor: assertFunction(shell?.setDefaultEditor, 'shell.setDefaultEditor'),
    listTasks: assertFunction(shell?.listTasks, 'shell.listTasks'),
    stopActiveTask: assertFunction(shell?.stopActiveTask, 'shell.stopActiveTask'),
    stopTask: assertFunction(shell?.stopTask, 'shell.stopTask'),
    listPermissionRules: assertFunction(
      shell?.listPermissionRules,
      'shell.listPermissionRules',
    ),
    addPermissionRule: assertFunction(shell?.addPermissionRule, 'shell.addPermissionRule'),
  };
  const executeClientTool = assertFunction(clientTool?.execute, 'clientTool.execute');

  return Object.freeze([
    owner('shell-ipc', (ipc) => {
      ipc.handle('shell:open-path', (_event, payload = {}) => shellPorts.openPath(payload));
      ipc.handle('shell:editors:list', () => shellPorts.listEditors());
      ipc.handle('shell:editors:set-default', (_event, payload = {}) =>
        shellPorts.setDefaultEditor(payload?.editorId));
      ipc.handle('shell:tasks:list', () => shellPorts.listTasks());
      ipc.handle('shell:tasks:stop-active', () => shellPorts.stopActiveTask());
      ipc.handle('shell:tasks:stop', (_event, payload) =>
        shellPorts.stopTask(payload?.taskId || payload?.toolCallId));
      ipc.handle('shell:permissions:list', () => shellPorts.listPermissionRules());
      ipc.handle('shell:permissions:add', (_event, payload) => shellPorts.addPermissionRule(payload));
    }),
    owner('client-tool-ipc', (ipc) => {
      ipc.handle('client-tool:execute', (_event, payload) => executeClientTool(payload));
    }),
  ]);
}
