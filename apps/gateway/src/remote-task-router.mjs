import { randomUUID } from 'node:crypto';

/**
 * Routes a read-only task request to the online device that owns the task, and
 * correlates the device's answer back to the caller.
 *
 * Boundaries (ADR 75, M1):
 *   - The Gateway relays. It holds no execution truth, no queue, no replay and
 *     no permission decision. The device re-checks everything before executing.
 *   - Versions, epoch and workspace list come from the delegation projection the
 *     device itself published for this connection, never from the browser.
 *   - A request that was sent but not answered resolves as OUTCOME_UNKNOWN, not
 *     as a failure: the device may have executed it. Re-submitting is a new
 *     request, never a replay.
 */
export function createRemoteTaskRouter({ connections, now = Date.now, limit = 200,
  requestTtlMs = 25_000, answerTimeoutMs = 20_000 } = {}) {
  if (typeof connections?.route !== 'function') throw new Error('INVALID_ROUTER_CONFIG');
  for (const value of [limit, requestTtlMs, answerTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_ROUTER_CONFIG');
  }
  // The protocol refuses requests whose lifetime exceeds 30s, so a longer TTL
  // could only produce requests the device rejects.
  if (requestTtlMs > 30_000 || answerTimeoutMs > requestTtlMs) throw new Error('INVALID_ROUTER_CONFIG');
  const pending = new Map();
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CLOCK');
    return value;
  };
  const text = (value, max = 200) => typeof value === 'string' && value.length > 0
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  /** Resolves a pending entry once. Returns false for a late or unknown answer. */
  function settle(message) {
    const requestId = message?.requestId;
    if (typeof requestId !== 'string') return false;
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (message.status === 'ok') entry.resolve({ requestId, status: 'ok', result: message.result });
    else entry.reject(new Error(String(message.code)));
    return true;
  }
  return {
    /** Submit one read. Rejects with a stable code; never throws a raw transport error. */
    async submit({ ownerId, deviceId, workspaceId, taskId } = {}) {
      const at = time();
      if (!text(ownerId) || !text(deviceId) || !text(workspaceId) || !text(taskId)) throw new Error('INVALID_REQUEST');
      if (pending.size >= limit) throw new Error('RATE_LIMITED');
      // Re-checks binding, revocation, lease and liveness; throws DEVICE_OFFLINE
      // or DEVICE_UNAVAILABLE. Offline submissions are never queued.
      const route = connections.route(ownerId, deviceId);
      const delegation = route.delegation;
      // No projection means the device has not published a delegation on this
      // connection, which is also the ready gate: routing before it exists would
      // race the device's own handshake.
      if (!delegation) throw new Error('DELEGATION_UNAVAILABLE');
      if (!Number.isSafeInteger(delegation.expiresAt) || delegation.expiresAt <= at) throw new Error('DELEGATION_EXPIRED');
      if (delegation.allowTaskRead !== true) throw new Error('CAPABILITY_DENIED');
      if (!Array.isArray(delegation.workspaceIds) || !delegation.workspaceIds.includes(workspaceId)) {
        throw new Error('WORKSPACE_DENIED');
      }
      const requestId = randomUUID();
      const request = {
        protocolVersion: 1, type: 'task.submit', requestId,
        ownerId, deviceId, workspaceId,
        bindingVersion: route.bindingVersion,
        connectionEpoch: route.handle.epoch,
        delegationVersion: delegation.version,
        expiresAt: at + requestTtlMs,
        operation: 'task.read', taskId,
      };
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('OUTCOME_UNKNOWN'));
        }, answerTimeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer });
        try {
          route.send({ type: 'remote.task.request', protocolVersion: 1, request });
        } catch {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error('DEVICE_UNAVAILABLE'));
        }
      });
    },
    settle,
    /** Current projection for a device, or null. Read-only; never throws. */
    describe(ownerId, deviceId) {
      try {
        const route = connections.route(ownerId, deviceId);
        return route.delegation ? { ...route.delegation } : null;
      } catch { return null; }
    },
    pendingCount: () => pending.size,
    close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('OUTCOME_UNKNOWN'));
      }
      pending.clear();
    },
  };
}
