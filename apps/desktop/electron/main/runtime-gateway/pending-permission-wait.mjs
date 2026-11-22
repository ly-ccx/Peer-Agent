import { randomUUID } from 'node:crypto';

export const DEFAULT_PERMISSION_WAIT_MS = 5 * 60 * 1000;

/** Owns live wait identity, deadlines and abort listeners. No permission policy or grants. */
export function createPendingPermissionWait({ now = Date.now, waitMs = DEFAULT_PERMISSION_WAIT_MS, onEnd,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  const pending = new Map();
  const timeout = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 30 * 60 * 1000) : DEFAULT_PERMISSION_WAIT_MS;
  const deadlineAt = () => new Date(Number(now()) + timeout).toISOString();
  function remove(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    unschedule(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    return entry;
  }
  function end(id, reason) {
    if (!pending.has(id)) return;
    onEnd(id, { grantId: `ended-${randomUUID()}`, toolCallId: id, granted: false, duration: 'denied',
      decidedAt: new Date(Number(now())).toISOString(), reason }, { reason, terminal: true });
  }
  return {
    deadlineAt,
    get: id => pending.get(id),
    entries: () => pending.entries(),
    add(id, entry) {
      if (pending.has(id)) throw new Error('permission_request_already_pending');
      const deadline = Date.parse(entry.deadlineAt);
      const onAbort = () => end(id, 'permission_cancelled');
      const timer = schedule(() => end(id, 'permission_timeout'), Math.max(0, deadline - Number(now())));
      timer?.unref?.();
      pending.set(id, { ...entry, timer, onAbort });
      entry.signal?.addEventListener('abort', onAbort, { once: true });
      if (entry.signal?.aborted) onAbort();
    },
    /** Claim before any grant is stored. A late decision loses to abort/deadline. */
    take(id, terminal = false) {
      const entry = pending.get(id);
      if (!entry) return null;
      if (!terminal && (entry.signal?.aborted || Number(now()) >= Date.parse(entry.deadlineAt))) {
        end(id, entry.signal?.aborted ? 'permission_cancelled' : 'permission_timeout');
        return null;
      }
      return remove(id);
    },
  };
}
