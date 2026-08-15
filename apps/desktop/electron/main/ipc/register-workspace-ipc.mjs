import { searchWorkspaceFiles } from '../workspace-file-search.mjs';

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
    previewDefault: assertFunction(
      workspace?.previewDefaultWorkspace,
      'workspace.previewDefaultWorkspace',
    ),
    add: assertFunction(workspace?.addWorkspace, 'workspace.addWorkspace'),
    setActive: assertFunction(
      workspace?.setActiveWorkspace,
      'workspace.setActiveWorkspace',
    ),
    remove: assertFunction(workspace?.removeWorkspace, 'workspace.removeWorkspace'),
    update: assertFunction(workspace?.updateWorkspace, 'workspace.updateWorkspace'),
    addLinkedFolder: assertFunction(workspace?.addLinkedFolder, 'workspace.addLinkedFolder'),
    removeLinkedFolder: assertFunction(workspace?.removeLinkedFolder, 'workspace.removeLinkedFolder'),
    setPrimary: assertFunction(workspace?.setPrimaryFolder, 'workspace.setPrimaryFolder'),
    getInfo: assertFunction(workspace?.getWorkspaceInfo, 'workspace.getWorkspaceInfo'),
  };

  return Object.freeze([
    owner('workspace-ipc', (ipc) => {
      ipc.handle('workspace:list', () => ports.list());
      ipc.handle('workspace:ensure-default', () => ports.ensureDefault());
      ipc.handle('workspace:preview-default', () => ports.previewDefault());
      ipc.handle('workspace:add', (event) => ports.add(event.sender));
      ipc.handle('workspace:set-active', (_event, { path } = {}) => ports.setActive(path));
      ipc.handle('workspace:remove', (_event, { path } = {}) => ports.remove(path));
      ipc.handle('workspace:update', (_event, payload = {}) => ports.update(payload));
      ipc.handle('workspace:add-linked-folder', (event, payload = {}) => ports.addLinkedFolder(event.sender, payload));
      ipc.handle('workspace:remove-linked-folder', (_event, payload = {}) => ports.removeLinkedFolder(payload));
      ipc.handle('workspace:set-primary', (_event, payload = {}) => ports.setPrimary(payload));
      ipc.handle('workspace:info', (_event, { path } = {}) => ports.getInfo(path));
      ipc.handle('workspace:search-files', (_event, payload = {}) => searchWorkspaceFiles(
        payload.workspacePath,
        { query: payload.query, limit: payload.limit },
      ));
    }),
  ]);
}
