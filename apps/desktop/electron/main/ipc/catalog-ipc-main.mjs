import { DESKTOP_IPC_CATALOG } from '../../ipc/channels.mjs';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
}

function resolveEntry(catalog, key, allowedTransports) {
  const entry = catalog[key];
  if (!entry) throw new Error(`Unknown Desktop IPC catalog key: ${key}`);
  if (!allowedTransports.includes(entry.transport)) {
    throw new Error(
      `Desktop IPC transport mismatch for ${key}: expected ${allowedTransports.join(' or ')}, got ${entry.transport}`,
    );
  }
  return entry;
}

function runAuthorization(authorize, entry, event) {
  const result = authorize({ entry, event });
  if (result && typeof result.then === 'function') {
    throw new TypeError(`Desktop IPC authorization must be synchronous: ${entry.key}`);
  }
}

function throwCleanupErrors(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

export function createCatalogIpcMain({
  ipcMain,
  catalog = DESKTOP_IPC_CATALOG,
  authorize = () => {},
} = {}) {
  if (!ipcMain || typeof ipcMain !== 'object') throw new TypeError('ipcMain is required');
  assertFunction(ipcMain.handle, 'ipcMain.handle');
  assertFunction(ipcMain.on, 'ipcMain.on');
  assertFunction(authorize, 'authorize');

  const registrations = [];
  const registeredKeys = new Set();
  const ownerScopes = new Map();
  let disposed = false;

  function assertCanRegister(key) {
    if (disposed) throw new Error('Desktop IPC registry is already disposed');
    if (registeredKeys.has(key)) throw new Error(`Desktop IPC key is already registered: ${key}`);
  }

  function register(kind, key, callback, ownerScope = null) {
    assertFunction(callback, `${kind === 'handle' ? 'handler' : 'listener'} for ${key}`);
    assertCanRegister(key);
    const allowedTransports = kind === 'handle' ? ['invoke'] : ['send', 'send-sync'];
    const entry = resolveEntry(catalog, key, allowedTransports);
    if (ownerScope && entry.owner !== ownerScope.owner) {
      throw new Error(
        `Desktop IPC owner mismatch for ${key}: expected ${entry.owner}, got ${ownerScope.owner}`,
      );
    }
    const wrapped = (event, ...args) => {
      runAuthorization(authorize, entry, event);
      return callback(event, ...args);
    };
    if (kind === 'handle') ipcMain.handle(entry.channel, wrapped);
    else ipcMain.on(entry.channel, wrapped);
    registeredKeys.add(key);
    registrations.push(Object.freeze({
      key,
      channel: entry.channel,
      kind,
      ownerScope,
      wrapped,
    }));
    return wrapped;
  }

  function removeRegistration(registration) {
    try {
      if (registration.kind === 'handle') {
        ipcMain.removeHandler?.(registration.channel);
      } else {
        ipcMain.removeListener?.(registration.channel, registration.wrapped);
      }
    } finally {
      const index = registrations.indexOf(registration);
      if (index >= 0) registrations.splice(index, 1);
      registeredKeys.delete(registration.key);
    }
  }

  function removeWhere(predicate, message) {
    const errors = [];
    for (const registration of [...registrations].reverse()) {
      if (!predicate(registration)) continue;
      try {
        removeRegistration(registration);
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors, message);
  }

  function handle(key, handler) {
    return register('handle', key, handler);
  }

  function on(key, listener) {
    return register('on', key, listener);
  }

  function createOwner(owner) {
    if (disposed) throw new Error('Desktop IPC registry is already disposed');
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new TypeError('Desktop IPC owner must be a non-empty string');
    }
    if (ownerScopes.has(owner)) throw new Error(`Desktop IPC owner is already active: ${owner}`);

    const ownerScope = Object.freeze({ owner });
    let ownerDisposed = false;
    ownerScopes.set(owner, ownerScope);

    return Object.freeze({
      owner,
      handle: (key, handler) => {
        if (ownerDisposed) throw new Error(`Desktop IPC owner is disposed: ${owner}`);
        return register('handle', key, handler, ownerScope);
      },
      on: (key, listener) => {
        if (ownerDisposed) throw new Error(`Desktop IPC owner is disposed: ${owner}`);
        return register('on', key, listener, ownerScope);
      },
      dispose: () => {
        if (ownerDisposed) return false;
        ownerDisposed = true;
        if (ownerScopes.get(owner) === ownerScope) ownerScopes.delete(owner);
        removeWhere(
          (registration) => registration.ownerScope === ownerScope,
          `Failed to dispose Desktop IPC owner: ${owner}`,
        );
        return true;
      },
      get registeredCount() {
        return registrations.filter((registration) => registration.ownerScope === ownerScope).length;
      },
    });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    ownerScopes.clear();
    removeWhere(() => true, 'Failed to dispose Desktop IPC registry');
    return true;
  }

  return Object.freeze({
    handle,
    on,
    createOwner,
    dispose,
    get registeredCount() {
      return registrations.length;
    },
    get activeOwnerCount() {
      return ownerScopes.size;
    },
  });
}
