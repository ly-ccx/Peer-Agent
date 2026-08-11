export const ACTIVATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Owns the timestamp shared by startup, manual, periodic, and activation checks.
 * claimIfDue() records the claim synchronously so overlapping Electron events
 * cannot launch duplicate checks before the first promise settles.
 */
export function createUpdateCheckSchedule({
  minIntervalMs = ACTIVATION_CHECK_INTERVAL_MS,
  now = Date.now,
} = {}) {
  let lastCheckAt;

  function markChecked(at = now()) {
    lastCheckAt = at;
    return lastCheckAt;
  }

  function isDue(at = now()) {
    if (lastCheckAt === undefined) return true;
    const elapsed = at - lastCheckAt;
    return elapsed < 0 || elapsed >= minIntervalMs;
  }

  function claimIfDue(at = now()) {
    if (!isDue(at)) return false;
    markChecked(at);
    return true;
  }

  return Object.freeze({
    markChecked,
    isDue,
    claimIfDue,
    getLastCheckAt: () => lastCheckAt,
  });
}

/**
 * Connect Electron activation signals to the updater's governed check path.
 * The returned disposer keeps listener lifecycle inside the updater module.
 */
export function registerActivationUpdateChecks({ app, schedule, checkForUpdates }) {
  if (!app?.on || !app?.removeListener) {
    throw new TypeError('app must support on/removeListener');
  }
  if (!schedule?.claimIfDue) {
    throw new TypeError('schedule.claimIfDue must be a function');
  }
  if (typeof checkForUpdates !== 'function') {
    throw new TypeError('checkForUpdates must be a function');
  }

  const handleActivation = () => {
    if (!schedule.claimIfDue()) return;
    void Promise.resolve().then(checkForUpdates).catch(() => {});
  };

  app.on('activate', handleActivation);
  app.on('browser-window-focus', handleActivation);

  return () => {
    app.removeListener('activate', handleActivation);
    app.removeListener('browser-window-focus', handleActivation);
  };
}
