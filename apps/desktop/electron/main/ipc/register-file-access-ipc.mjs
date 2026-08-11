function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createFileAccessIpcRegistrations({ fileAccess } = {}) {
  const ports = {
    getGitDiff: assertFunction(fileAccess?.getGitDiff, 'fileAccess.getGitDiff'),
    exists: assertFunction(fileAccess?.exists, 'fileAccess.exists'),
    readDirectory: assertFunction(fileAccess?.readDirectory, 'fileAccess.readDirectory'),
    watchDirectories: assertFunction(
      fileAccess?.watchDirectories,
      'fileAccess.watchDirectories',
    ),
    readFile: assertFunction(fileAccess?.readFile, 'fileAccess.readFile'),
    readImageDataUrl: assertFunction(fileAccess?.readImageDataUrl, 'fileAccess.readImageDataUrl'),
    writeFile: assertFunction(fileAccess?.writeFile, 'fileAccess.writeFile'),
    mkdir: assertFunction(fileAccess?.mkdir, 'fileAccess.mkdir'),
    dispose: assertFunction(fileAccess?.dispose, 'fileAccess.dispose'),
  };

  return Object.freeze([
    owner('file-access-ipc', (ipc) => {
      ipc.handle('git:diff', (_event, payload) => ports.getGitDiff(payload));
      ipc.handle('fs:exists', (_event, payload) => ports.exists(payload));
      ipc.handle('fs:read-dir', (_event, payload) => ports.readDirectory(payload));
      ipc.handle('fs:watch-dirs', (event, payload) => (
        ports.watchDirectories(event.sender, payload)
      ));
      ipc.handle('file:read', (_event, payload) => ports.readFile(payload));
      ipc.handle('file:read-image-data-url', (_event, payload) => ports.readImageDataUrl(payload));
      ipc.handle('file:write', (_event, payload) => ports.writeFile(payload));
      ipc.handle('fs:mkdir', (_event, payload) => ports.mkdir(payload));
      return () => ports.dispose();
    }),
  ]);
}
