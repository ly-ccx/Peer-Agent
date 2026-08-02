function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
}

function normalizeRegistrations(registrations) {
  if (!Array.isArray(registrations)) throw new TypeError('registrations must be an array');
  const owners = new Set();
  return registrations.map((registration, index) => {
    if (!registration || typeof registration !== 'object') {
      throw new TypeError(`registrations[${index}] must be an object`);
    }
    const owner = registration.owner;
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new TypeError(`registrations[${index}].owner must be a non-empty string`);
    }
    if (owners.has(owner)) throw new Error(`Desktop IPC owner is declared more than once: ${owner}`);
    assertFunction(registration.register, `registrations[${index}].register`);
    owners.add(owner);
    return Object.freeze({ owner, register: registration.register });
  });
}

function runCleanup(items, selectDisposer, errors) {
  for (const item of [...items].reverse()) {
    const disposer = selectDisposer(item);
    if (typeof disposer !== 'function') continue;
    try {
      disposer();
    } catch (error) {
      errors.push(error);
    }
  }
}

function throwRegistrationFailure(owner, registrationError, cleanupErrors) {
  if (cleanupErrors.length === 0) throw registrationError;
  throw new AggregateError(
    [registrationError, ...cleanupErrors],
    `Failed to register Desktop IPC owner and roll back cleanly: ${owner}`,
    { cause: registrationError },
  );
}

function throwCleanupFailures(errors) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'Failed to dispose one or more Desktop IPC owners');
}

/**
 * Register domain-owned IPC modules as one atomic startup unit.
 *
 * Each registration receives only its catalog-enforced owner IPC port. A module may return a
 * synchronous disposer for resources it owns beyond its IPC handlers. Startup rollback and normal
 * shutdown always close every IPC ingress before releasing those resources.
 */
export function registerIpcOwners({ ipc, registrations } = {}) {
  if (!ipc || typeof ipc !== 'object') throw new TypeError('ipc is required');
  assertFunction(ipc.createOwner, 'ipc.createOwner');
  const definitions = normalizeRegistrations(registrations);
  const active = [];

  for (const definition of definitions) {
    let current = null;
    try {
      const ownerIpc = ipc.createOwner(definition.owner);
      current = { ...definition, ownerIpc, disposeResources: null };
      const disposeResources = definition.register(ownerIpc);
      if (disposeResources && typeof disposeResources.then === 'function') {
        throw new TypeError(`Desktop IPC owner registration must be synchronous: ${definition.owner}`);
      }
      if (disposeResources != null && typeof disposeResources !== 'function') {
        throw new TypeError(
          `Desktop IPC owner registration must return a disposer or undefined: ${definition.owner}`,
        );
      }
      current.disposeResources = disposeResources ?? null;
      active.push(current);
    } catch (registrationError) {
      const cleanupErrors = [];
      runCleanup(
        current ? [...active, current] : active,
        (item) => item.ownerIpc.dispose,
        cleanupErrors,
      );
      runCleanup(active, (item) => item.disposeResources, cleanupErrors);
      throwRegistrationFailure(definition.owner, registrationError, cleanupErrors);
    }
  }

  let disposed = false;
  return Object.freeze({
    get ownerCount() {
      return active.length;
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      const cleanupErrors = [];
      runCleanup(active, (item) => item.ownerIpc.dispose, cleanupErrors);
      runCleanup(active, (item) => item.disposeResources, cleanupErrors);
      active.length = 0;
      throwCleanupFailures(cleanupErrors);
      return true;
    },
  });
}
