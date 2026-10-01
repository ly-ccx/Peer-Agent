const ONE_TIME_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * 同一 capabilityId + argsDigest 的一次性放行。用过或过期后下一次仍要问。
 */
export function createOneTimeApprovalBook({ ttlMs = ONE_TIME_GRANT_TTL_MS } = {}) {
  const entries = new Map();
  function scopeId(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
  function keyOf(capabilityId, argsDigest, sessionId) {
    if (typeof capabilityId !== 'string' || !capabilityId.trim()) return '';
    if (typeof argsDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(argsDigest)) return '';
    const base = `${capabilityId.trim()}::${argsDigest.toLowerCase()}`;
    const session = scopeId(sessionId);
    return session ? `${base}::${session}` : base;
  }
  function remember({ capabilityId, argsDigest, at, sessionId, workspaceId }) {
    const key = keyOf(capabilityId, argsDigest, sessionId);
    if (!key || !Number.isFinite(at)) return null;
    const record = { expiresAt: at + ttlMs, used: false, workspaceId: scopeId(workspaceId) };
    entries.set(key, record);
    return {
      capabilityId: capabilityId.trim(),
      argsDigest: argsDigest.toLowerCase(),
      expiresAt: record.expiresAt,
      ...(scopeId(sessionId) ? { sessionId: scopeId(sessionId) } : {}),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    };
  }
  function match({ capabilityId, argsDigest, at, sessionId, workspaceId }) {
    const key = keyOf(capabilityId, argsDigest, sessionId);
    if (!key || !Number.isFinite(at)) return false;
    const record = entries.get(key);
    if (!record) return false;
    if (record.workspaceId && record.workspaceId !== scopeId(workspaceId)) return false;
    if (record.used || at >= record.expiresAt) {
      entries.delete(key);
      return false;
    }
    record.used = true;
    return true;
  }
  return { remember, match };
}
