function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
}

function assertName(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOwner(owner, index, label = 'initialOwners') {
  if (!owner || typeof owner !== 'object') {
    throw new TypeError(`${label}[${index}] must be an object`);
  }
  const name = assertName(owner.name, `${label}[${index}].name`);
  assertFunction(owner.dispose, `${label}[${index}].dispose`);
  return Object.freeze({ name, dispose: owner.dispose });
}

function normalizePhase(phase, index) {
  if (!phase || typeof phase !== 'object') {
    throw new TypeError(`phases[${index}] must be an object`);
  }
  const name = assertName(phase.name, `phases[${index}].name`);
  assertFunction(phase.start, `phases[${index}].start`);
  if (phase.onError != null) assertFunction(phase.onError, `phases[${index}].onError`);
  return Object.freeze({
    name,
    start: phase.start,
    fatal: phase.fatal !== false,
    onError: phase.onError ?? null,
  });
}

function normalizeStartedOwner(value, phaseName) {
  if (value == null) return null;
  if (typeof value === 'function') {
    return Object.freeze({ name: phaseName, dispose: value });
  }
  if (typeof value !== 'object' || typeof value.dispose !== 'function') {
    throw new TypeError(
      `Desktop startup phase "${phaseName}" must return a disposer function, { dispose }, or nothing`,
    );
  }
  return Object.freeze({
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : phaseName,
    dispose: () => value.dispose(),
  });
}

async function disposeOwners(owners, emitTrace) {
  const errors = [];
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index];
    emitTrace({ type: 'owner:dispose:start', owner: owner.name });
    try {
      await owner.dispose();
      emitTrace({ type: 'owner:dispose:complete', owner: owner.name });
    } catch (error) {
      errors.push(error);
      emitTrace({ type: 'owner:dispose:failed', owner: owner.name, error });
    }
  }
  owners.length = 0;
  return errors;
}

function throwCleanupErrors(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * Owns Desktop startup stages and every disposer created by those stages.
 * Initial owners are already active when the composition root is created; phases
 * are started in declaration order and all owners are disposed in reverse order.
 */
export function createDesktopCompositionRoot({
  initialOwners = [],
  phases = [],
  logger = console,
  trace = null,
} = {}) {
  if (!Array.isArray(initialOwners)) throw new TypeError('initialOwners must be an array');
  if (!Array.isArray(phases)) throw new TypeError('phases must be an array');
  if (trace != null) assertFunction(trace, 'trace');

  const normalizedOwners = initialOwners.map((owner, index) => normalizeOwner(owner, index));
  const normalizedPhases = phases.map(normalizePhase);
  const names = new Set();
  for (const item of [...normalizedOwners, ...normalizedPhases]) {
    if (names.has(item.name)) throw new Error(`Duplicate Desktop composition owner: ${item.name}`);
    names.add(item.name);
  }

  const activeOwners = [...normalizedOwners];
  let status = 'idle';
  let startPromise = null;
  let disposePromise = null;

  const emitTrace = (event) => {
    try {
      trace?.(Object.freeze({ ...event }));
    } catch {
      // Startup governance must not depend on diagnostics succeeding.
    }
  };

  for (const owner of normalizedOwners) {
    emitTrace({ type: 'owner:adopted', owner: owner.name });
  }

  async function start() {
    if (status === 'started') return false;
    if (status === 'disposed' || status === 'disposing') {
      throw new Error(`Cannot start Desktop composition root while ${status}`);
    }
    if (startPromise) return startPromise;

    status = 'starting';
    startPromise = (async () => {
      let failedPhase = null;
      try {
        for (const phase of normalizedPhases) {
          failedPhase = phase.name;
          emitTrace({ type: 'phase:start', owner: phase.name });
          try {
            const startedOwner = normalizeStartedOwner(await phase.start(), phase.name);
            if (startedOwner) activeOwners.push(startedOwner);
            emitTrace({ type: 'phase:complete', owner: phase.name });
          } catch (error) {
            emitTrace({ type: 'phase:failed', owner: phase.name, fatal: phase.fatal, error });
            if (phase.fatal) throw error;
            try {
              phase.onError?.(error);
            } catch (reportError) {
              logger?.warn?.(
                `[desktop-composition] failed to report optional phase "${phase.name}"`,
                reportError,
              );
            }
          }
        }
        failedPhase = null;
        status = 'started';
        emitTrace({ type: 'root:started' });
        return true;
      } catch (startupError) {
        status = 'rolling-back';
        const cleanupErrors = await disposeOwners(activeOwners, emitTrace);
        status = 'failed';
        emitTrace({ type: 'root:startup-failed', owner: failedPhase, error: startupError });
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [startupError, ...cleanupErrors],
            `Desktop startup failed in phase "${failedPhase}" and rollback also failed`,
          );
        }
        throw startupError;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function dispose() {
    if (status === 'disposed') return false;
    if (disposePromise) return disposePromise;

    disposePromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // A failed start already rolled back every active owner.
        }
      }
      if (status === 'failed' && activeOwners.length === 0) {
        status = 'disposed';
        return false;
      }
      status = 'disposing';
      const cleanupErrors = await disposeOwners(activeOwners, emitTrace);
      status = 'disposed';
      emitTrace({ type: 'root:disposed', errors: cleanupErrors.length });
      throwCleanupErrors(cleanupErrors, 'Failed to dispose one or more Desktop composition owners');
      return true;
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    dispose,
    getStatus: () => status,
    getActiveOwners: () => activeOwners.map((owner) => owner.name),
  });
}

const boundRoots = new WeakSet();

/**
 * Binds one composition root to one Electron app lifecycle. Async cleanup is
 * awaited by preventing the first before-quit event and reissuing app.quit()
 * only after every disposer has run.
 */
export function bindDesktopAppLifecycle({
  app,
  root,
  platform = process.platform,
  onActivate = () => {},
  onFatalStartupError = null,
  logger = console,
} = {}) {
  if (!app || typeof app !== 'object') throw new TypeError('app must be an object');
  assertFunction(app.whenReady, 'app.whenReady');
  assertFunction(app.on, 'app.on');
  assertFunction(app.removeListener, 'app.removeListener');
  assertFunction(app.quit, 'app.quit');
  if (!root || typeof root !== 'object') throw new TypeError('root must be an object');
  assertFunction(root.start, 'root.start');
  assertFunction(root.dispose, 'root.dispose');
  assertFunction(onActivate, 'onActivate');
  if (onFatalStartupError != null) {
    assertFunction(onFatalStartupError, 'onFatalStartupError');
  }
  if (boundRoots.has(root)) throw new Error('Desktop composition root lifecycle is already bound');
  boundRoots.add(root);

  let started = false;
  let allowQuit = false;
  let shutdownPromise = null;
  let resumeQuit = () => app.quit();
  let unbound = false;

  const onAppActivate = () => {
    if (started && !shutdownPromise) onActivate();
  };
  const onWindowAllClosed = () => {
    if (platform !== 'darwin') app.quit();
  };
  const unbind = () => {
    if (unbound) return false;
    unbound = true;
    app.removeListener('activate', onAppActivate);
    app.removeListener('window-all-closed', onWindowAllClosed);
    app.removeListener('before-quit', onBeforeQuit);
    boundRoots.delete(root);
    return true;
  };
  const finishShutdown = async () => {
    try {
      await root.dispose();
    } catch (error) {
      logger?.error?.('[desktop-composition] shutdown cleanup failed:', error);
    } finally {
      allowQuit = true;
      unbind();
      resumeQuit();
    }
  };
  function shutdown({ resume = null } = {}) {
    if (resume != null) assertFunction(resume, 'shutdown.resume');
    if (!shutdownPromise) {
      if (resume) resumeQuit = resume;
      shutdownPromise = finishShutdown();
    }
    return shutdownPromise;
  }
  function onBeforeQuit(event) {
    if (allowQuit) return;
    event?.preventDefault?.();
    void shutdown();
  }

  app.on('activate', onAppActivate);
  app.on('window-all-closed', onWindowAllClosed);
  app.on('before-quit', onBeforeQuit);

  const ready = Promise.resolve()
    .then(() => app.whenReady())
    .then(() => root.start())
    .then(() => {
      started = true;
      return true;
    })
    .catch((error) => {
      logger?.error?.('[desktop-composition] startup failed:', error);
      try {
        onFatalStartupError?.(error);
      } catch (reportError) {
        logger?.error?.('[desktop-composition] fatal startup reporter failed:', reportError);
      }
      app.quit();
      return false;
    });

  return Object.freeze({
    ready,
    shutdown,
    unbind,
    getShutdownPromise: () => shutdownPromise,
  });
}
