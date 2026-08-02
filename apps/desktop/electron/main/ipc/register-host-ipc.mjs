function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createHostIpcRegistrations({ os, host } = {}) {
  const getStartupPermissions = assertFunction(
    os?.getStartupPermissions,
    'os.getStartupPermissions',
  );
  const restartHost = assertFunction(host?.restart, 'host.restart');

  return Object.freeze([
    owner('os-ipc', (ipc) => {
      ipc.handle('os:startup-permissions', () => getStartupPermissions());
    }),
    owner('host-ipc', (ipc) => {
      ipc.handle('host:restart', (_event, payload = {}) => restartHost(payload));
    }),
  ]);
}
