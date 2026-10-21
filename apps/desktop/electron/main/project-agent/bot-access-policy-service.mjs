import { refreshActiveAccessPolicies } from '../chat-runtime/permission-gate.mjs';

/** Local UI authority port; generic profile edits and remote tools cannot call this mutation. */
export function createBotAccessPolicyService({ authority, enabled, changed, approvals = null }) {
  function retirePreviousRequests(policy) {
    const stamp = `bot:${policy.workspaceId}:${policy.conversationId}:${policy.revision}`;
    for (const record of approvals?.list?.({ workspaceId: policy.workspaceId }) ?? []) {
      if (!['open', 'stale'].includes(record.state) || record.policyRevision === stamp
        || record.capabilityId === 'goal.plan' || record.approvalId?.startsWith('plan:')) continue;
      const owner = authority.resolve({ conversationId: record.conversationId, workspaceId: record.workspaceId,
        planId: record.planId, sessionId: record.sessionId }, { presentation: true });
      if (!owner?.ok || owner.policy?.conversationId !== policy.conversationId) continue;
      approvals.append({ ...record, state: 'expired', decidedBy: 'policy',
        decisionReason: 'permission_policy_changed', decidedAt: new Date().toISOString() });
    }
  }
  function read(payload = {}) {
    // Classic task windows still display the same persisted Bot authority when its shell is disabled.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['workspaceId', 'conversationId'].includes(key))
      || Boolean(payload.workspaceId) === Boolean(payload.conversationId)) return { ok: false, code: 'INVALID_INPUT' };
    if (!authority) return { ok: false, code: 'POLICY_UNAVAILABLE' };
    if (payload.workspaceId) return authority.read(payload.workspaceId);
    if (typeof payload.conversationId !== 'string') return { ok: false, code: 'INVALID_INPUT' };
    return authority.resolve({ conversationId: payload.conversationId }, { presentation: true })
      ?? { ok: true, policy: null, inherited: false };
  }
  function update(payload) {
    if (!enabled()) return { ok: false, code: 'PROJECT_AGENT_DISABLED' };
    const result = authority?.update(payload) ?? { ok: false, code: 'POLICY_UNAVAILABLE' };
    if (result.ok) {
      refreshActiveAccessPolicies();
      if (result.policy.revision !== payload.expectedRevision) {
        try { retirePreviousRequests(result.policy); }
        catch (error) { console.warn('[bot-access] stale request receipt could not be saved:', error?.message); }
      }
      changed(result.policy.workspaceId);
    }
    return result;
  }
  return { read, update };
}
