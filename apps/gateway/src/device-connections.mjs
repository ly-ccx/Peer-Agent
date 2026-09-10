/** In-memory authenticated connections, never persisted as online state.
 * attach accepts only a principal returned by the server's device authenticator.
 * Handles remain server-internal and are never accepted from a browser payload.
 * A new Gateway process starts empty; epoch alone is not authentication.
 */
export function createDeviceConnections({ store, now = Date.now, leaseMs = 60_000, capacity = 1000 }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('INVALID_CONNECTION_LIMIT');
  }
  const connections = new Map();
  let epoch = 0;
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + leaseMs)) throw new Error('INVALID_CLOCK');
    return value;
  };
  const bindingMatches = principal => {
    const binding = store.getDeviceBinding(principal.deviceId);
    return binding && !binding.revoked && binding.ownerId === principal.ownerId
      && binding.bindingVersion === principal.bindingVersion;
  };
  function drop(record) {
    if (connections.get(record.principal.deviceId) !== record) return;
    connections.delete(record.principal.deviceId);
    // Logical invalidation happens before physical socket close; close errors cannot restore it.
    try { record.close(); } catch { /* already invalidated */ }
  }
  function current(record, at) {
    if (!record) return false;
    if (record.expiresAt <= at || !bindingMatches(record.principal)) { drop(record); return false; }
    return true;
  }
  function sweep(at) { for (const record of connections.values()) current(record, at); }
  return {
    attach(principal, { close }) {
      const at = time();
      if (!principal || typeof principal.connectionId !== 'string' || !principal.connectionId
          || typeof close !== 'function' || !bindingMatches(principal)) throw new Error('DEVICE_AUTH_DENIED');
      sweep(at);
      const previous = connections.get(principal.deviceId);
      if (!previous && connections.size >= capacity) throw new Error('RATE_LIMITED');
      if (!Number.isSafeInteger(epoch + 1)) throw new Error('EPOCH_EXHAUSTED');
      const handle = Object.freeze({ deviceId: principal.deviceId, connectionId: principal.connectionId, epoch: ++epoch });
      if (previous) drop(previous);
      connections.set(principal.deviceId, { principal: { ...principal }, handle, close, expiresAt: at + leaseMs });
      return handle;
    },
    heartbeat(handle) {
      const at = time();
      const record = connections.get(handle?.deviceId);
      if (!record || record.handle !== handle || !current(record, at)) return false;
      record.expiresAt = at + leaseMs;
      return true;
    },
    /** Call immediately before dispatch; offline submissions are not queued here. */
    resolve(ownerId, deviceId) {
      const at = time();
      const binding = store.getDeviceBinding(deviceId);
      if (!binding || binding.ownerId !== ownerId || binding.revoked) throw new Error('DEVICE_UNAVAILABLE');
      const record = connections.get(deviceId);
      if (!current(record, at)) throw new Error('DEVICE_OFFLINE');
      return record.handle;
    },
    disconnect(handle) {
      const record = connections.get(handle?.deviceId);
      if (record?.handle === handle) drop(record);
    },
    sweep() { sweep(time()); },
    close() { for (const record of connections.values()) drop(record); },
  };
}
