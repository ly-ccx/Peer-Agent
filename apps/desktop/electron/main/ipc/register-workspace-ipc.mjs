function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createWorkspaceIpcRegistrations({ workspace } = {}) {
  const ports = {
    list: assertFunction(workspace?.listWorkspaces, 'workspace.listWorkspaces'),
    ensureDefault: assertFunction(
      workspace?.ensureDefaultWorkspace,
      'workspace.ensureDefaultWorkspace',
    ),
    add: assertFunction(workspace?.addWorkspace, 'workspace.addWorkspace'),
    setActive: assertFunction(
      workspace?.setActiveWorkspace,
      'workspace.setActiveWorkspace',
    ),
    remove: assertFunction(workspace?.removeWorkspace, 'workspace.removeWorkspace'),
    getInfo: assertFunction(workspace?.getWorkspaceInfo, 'workspace.getWorkspaceInfo'),
  };

  return Object.freeze([
    owner('workspace-ipc', (ipc) => {
      ipc.handle('workspace:list', () => ports.list());
      ipc.handle('workspace:ensure-default', () => ports.ensureDefault());
      ipc.handle('workspace:add', (event) => ports.add(event.sender));
      ipc.handle('workspace:set-active', (_event, { path } = {}) => ports.setActive(path));
      ipc.handle('workspace:remove', (_event, { path } = {}) => ports.remove(path));
      ipc.handle('workspace:info', (_event, { path } = {}) => ports.getInfo(path));
    }),
  ]);
}
