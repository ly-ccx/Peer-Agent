/**
 * Remote access controller: the single owner of the remote-connection lifecycle.
 *
 * Everything that can start or stop the connection goes through here, so the
 * settings UI, the environment (first-run bootstrap) and the resident service
 * cannot fight each other. Two rules make that work:
 *
 *   1. Settings are persisted before the connection is touched. A crash between
 *      the two leaves a saved intent that the next start applies, rather than a
 *      running connection with nothing recorded about why.
 *   2. `apply()` is idempotent and serialized. Repeated calls with the same
 *      settings do not reconnect; a call during an in-flight change waits.
 *
 * The status payload is deliberately secret-free: it reports what the UI needs
 * (configured, connected, device id) and never the identity or binding key.
 */
const GATEWAY_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Normalize + validate a settings patch. Throws on anything malformed so the
 * UI gets an error instead of silently persisting a value that cannot work. */
export function normalizeRemoteSettings(input, current = {}) {
  const next = {
    enabled: current.enabled === true,
    gatewayOrigin: typeof current.gatewayOrigin === 'string' ? current.gatewayOrigin : '',
    workspaceId: typeof current.workspaceId === 'string' ? current.workspaceId : '',
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return next;
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('INVALID_ENABLED');
    next.enabled = input.enabled;
  }
  if ('gatewayOrigin' in input) {
    const raw = typeof input.gatewayOrigin === 'string' ? input.gatewayOrigin.trim() : '';
    // Strip trailing slashes *before* validating: a user pasting
    // "https://peer.example:8443/" is giving a valid origin, not a bad one.
    const value = raw.replace(/\/+$/, '');
    // Only https, and no path: the client appends its own endpoints, and a
    // path segment would produce malformed URLs.
    if (value && !GATEWAY_PATTERN.test(value)) throw new Error('INVALID_GATEWAY_ORIGIN');
    next.gatewayOrigin = value;
  }
  if ('workspaceId' in input) {
    const value = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
    if (value && !WORKSPACE_PATTERN.test(value)) throw new Error('INVALID_WORKSPACE_ID');
    next.workspaceId = value;
  }
  if (next.enabled && (!next.gatewayOrigin || !next.workspaceId)) {
    throw new Error('INCOMPLETE_REMOTE_SETTINGS');
  }
  return next;
}

/**
 * @param {object} options
 * @param {object} options.settingsStore - { getAll, merge }
 * @param {string} options.settingsKey   - namespace inside the settings file
 * @param {object} options.deviceName    - shown in the device list
 * @param {Function} options.createSession - ({gatewayOrigin, workspaceId, deviceName}) => { start, stop, status }
 * @param {object} [options.logger]
 */
export function createRemoteAccessController({
  settingsStore, settingsKey = 'remoteAccess', deviceName,
  createSession, logger = { info() {}, warn() {}, error() {} },
}) {
  if (!settingsStore || typeof settingsStore.getAll !== 'function' || typeof settingsStore.merge !== 'function') {
    throw new Error('INVALID_SETTINGS_STORE');
  }
  if (typeof createSession !== 'function') throw new Error('INVALID_CREATE_SESSION');

  let session = null;
  // Serializes apply() so two rapid toggles cannot interleave start/stop.
  let queue = Promise.resolve();
  // Remember what the live session was created for, to make apply() idempotent.
  let sessionFor = null;

  function readSettings() {
    try {
      const all = settingsStore.getAll();
      const raw = all && typeof all === 'object' ? all[settingsKey] : null;
      return normalizeRemoteSettings(raw ?? {});
    } catch {
      // External edits or migration artifacts can leave invalid data; a status
      // query must never throw — the UI depends on it.
      return { enabled: false, gatewayOrigin: '', workspaceId: '' };
    }
  }

  /** 远程没填 workspaceId 时，用当前项目的稳定 id，不再要求手写一串标识。 */
  function projectWorkspaceId() {
    try {
      const all = settingsStore.getAll();
      const list = Array.isArray(all?.workspaces) ? all.workspaces : [];
      const active = typeof all?.activeWorkspace === 'string' ? all.activeWorkspace : '';
      const current = list.find((item) => item?.path === active)
        ?? list.find((item) => typeof item?.id === 'string');
      const id = typeof current?.id === 'string' ? current.id.trim() : '';
      return WORKSPACE_PATTERN.test(id) ? id : '';
    } catch {
      return '';
    }
  }

  function patchWithWorkspaceDefault(patch, current) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const next = { ...patch };
    const explicit = Object.prototype.hasOwnProperty.call(next, 'workspaceId')
      ? (typeof next.workspaceId === 'string' ? next.workspaceId.trim() : '')
      : null;
    const missing = explicit === null ? current.workspaceId === '' : explicit === '';
    if (!missing) return next;
    const fallback = projectWorkspaceId();
    if (fallback) next.workspaceId = fallback;
    return next;
  }

  /** The live truth: configured values plus what the connection is actually doing. */
  function status() {
    const settings = readSettings();
    let live = { online: false, deviceId: null, connectionEpoch: 0 };
    try { live = { ...live, ...(session?.status?.() ?? {}) }; } catch { /* status must never throw */ }
    return {
      settings,
      active: session !== null,
      online: live.online === true,
      deviceId: live.deviceId ?? null,
      connectionEpoch: Number.isSafeInteger(live.connectionEpoch) ? live.connectionEpoch : 0,
      // Present only after a dial actually failed, so the surface can stop
      // reporting "connecting…" for a connection that already gave up.
      lastFailure: live.lastFailure ?? null,
      // Present only while the server is waiting for this device to be claimed.
      pairing: live.pairing ?? null,
    };
  }

  function stopSession(reason) {
    if (!session) return;
    try { session.stop(); } catch (error) { logger.warn('[remote] stop failed: %s', error?.message ?? error); }
    session = null;
    sessionFor = null;
    logger.info('[remote] stopped (%s)', reason);
  }

  function startSession(settings) {
    session = createSession({
      gatewayOrigin: settings.gatewayOrigin,
      workspaceId: settings.workspaceId,
      deviceName,
    });
    sessionFor = { gatewayOrigin: settings.gatewayOrigin, workspaceId: settings.workspaceId };
    logger.info('[remote] started against %s (workspace %s)', settings.gatewayOrigin, settings.workspaceId);
  }

  /** Reconcile the live connection with the persisted settings. */
  async function applyInternal() {
    const settings = readSettings();
    if (!settings.enabled) { stopSession('disabled'); return status(); }
    const unchanged = sessionFor
      && sessionFor.gatewayOrigin === settings.gatewayOrigin
      && sessionFor.workspaceId === settings.workspaceId;
    if (unchanged) return status();
    // Anything that changes the target requires a fresh session: the connector
    // pins origin and delegation at construction.
    if (session) stopSession('settings changed');
    startSession(settings);
    // start() opens the socket; awaiting it keeps errors attributable to this call.
    try { await session.start?.(); } catch (error) {
      logger.error('[remote] start failed: %s', error?.message ?? error);
      stopSession('start failed');
      throw error;
    }
    return status();
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    // Keep the chain alive even when a caller's task rejects.
    queue = run.then(() => {}, () => {});
    return run;
  }

  return {
    /** Persist a patch, then reconcile. Returns the resulting status. */
    update(patch) {
      return enqueue(async () => {
        const current = readSettings();
        const merged = normalizeRemoteSettings(patchWithWorkspaceDefault(patch, current), current);
        settingsStore.merge({ [settingsKey]: merged });
        return applyInternal();
      });
    },
    /** Reconcile without changing settings (startup, or after an external edit). */
    apply() { return enqueue(applyInternal); },
    /** Stop and forget; settings are left alone so the intent stays visible. */
    stop() {
      return enqueue(async () => { stopSession('manual'); return status(); });
    },
    status,
    /** Test seam: what the live session was created for. */
    sessionTarget: () => (sessionFor ? { ...sessionFor } : null),
  };
}
