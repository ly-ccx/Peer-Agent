function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

/**
 * IPC surface for remote access.
 *
 *   remote-access:status  - current settings + live connection state (never secrets)
 *   remote-access:update  - persist a patch, then reconcile the connection
 *   remote-access:apply   - reconcile from stored settings (startup / manual retry)
 *
 * Errors come back as { ok, error } instead of a thrown rejection: a rejected
 * `invoke` loses the error code, and the UI needs the code to tell "bad address"
 * apart from "server unreachable".
 *
 * The controller is resolved through `getRemoteAccess` on every call. This host
 * registers early in startup while the controller only exists once the local
 * runtime is up, so capturing it here would freeze a null.
 */
export function createRemoteAccessIpcRegistrations({ getRemoteAccess } = {}) {
  const resolveController = assertFunction(getRemoteAccess, 'getRemoteAccess');

  /** Run one controller call, converting throws into a result the UI can render. */
  async function guarded(run) {
    const controller = resolveController();
    if (!controller) return { ok: false, error: 'REMOTE_NOT_READY' };
    try {
      return { ok: true, status: await run(controller) };
    } catch (error) {
      const code = typeof error?.message === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(error.message)
        ? error.message
        : 'REMOTE_UPDATE_FAILED';
      return { ok: false, error: code };
    }
  }

  const IDLE_STATUS = {
    settings: { enabled: false, gatewayOrigin: '', workspaceId: '' },
    active: false, online: false, deviceId: null, connectionEpoch: 0,
  };

  return Object.freeze([
    owner('remote-access-ipc', (ipc) => {
      ipc.handle('remote-access:status', () => {
        const controller = resolveController();
        return { ok: true, status: controller ? controller.status() : IDLE_STATUS };
      });
      ipc.handle('remote-access:update', (_event, patch) => guarded(c => c.update(patch)));
      ipc.handle('remote-access:apply', () => guarded(c => c.apply()));
    }),
  ]);
}
