import { delegationFactsForWorkspace } from '@peer-agent/runtime-node';

/** Read current ownership metadata once; task watches never need chat bodies. */
export function createDelegationFactsReader({ conversationStore, goalPlanStore }) {
  const cache = new Map();
  return workspaceId => {
    if (typeof workspaceId !== 'string' || !workspaceId) return { sessions: [] };
    const conversations = conversationStore.listConversations({
      roles: ['default', 'project_agent', 'work_session'],
      includeMessageCount: false,
    });
    const ownership = new Map(conversations.map(meta => [meta.id, meta.workspaceId]));
    const metas = (goalPlanStore.listPlanMetadata?.() ?? goalPlanStore.listPlans?.() ?? [])
      .filter(meta => ownership.get(meta.conversationId) === workspaceId);
    const stamp = typeof goalPlanStore.planReadStamp === 'function'
      ? metas.map(meta => `${meta.planId}=${goalPlanStore.planReadStamp(meta.planId)}`).join('|')
      : null;
    const hit = stamp == null ? null : cache.get(workspaceId);
    if (hit && hit.stamp === stamp) return hit.facts;
    const plans = metas
      .map(meta => goalPlanStore.getPlan(meta.planId))
      .filter(Boolean);
    const facts = delegationFactsForWorkspace(plans, workspaceId);
    if (stamp != null) cache.set(workspaceId, { stamp, facts });
    return facts;
  };
}
