/** Schedules a fresh host projection at deadlines. Never decides permission or task outcomes. */
export function createAttentionExpiry({ now, schedule = setTimeout, cancel = clearTimeout, onExpired }) {
  const pending = new Map();
  function observe(workspaceId, expiresAt) {
    const previous = pending.get(workspaceId);
    if (previous?.expiresAt === expiresAt) return;
    if (previous) { cancel(previous.timer); pending.delete(workspaceId); }
    const at = Date.parse(expiresAt), current = Date.parse(now());
    if (!Number.isFinite(at) || !Number.isFinite(current) || at <= current) return;
    const row = { expiresAt, timer: null };
    row.timer = schedule(() => {
      if (pending.get(workspaceId) !== row) return;
      pending.delete(workspaceId);
      if (Date.parse(now()) < at) observe(workspaceId, expiresAt);
      else onExpired(workspaceId);
    }, Math.min(at - current, 2147483647));
    pending.set(workspaceId, row);
  }
  return { observe, retain(ids) {
    const retained = new Set(ids);
    for (const id of pending.keys()) if (!retained.has(id)) observe(id, null);
  }, dispose() { for (const id of pending.keys()) observe(id, null); } };
}
