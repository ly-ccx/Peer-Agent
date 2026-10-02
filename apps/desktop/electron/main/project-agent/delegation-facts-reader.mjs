import { delegationFactsForWorkspace } from '@peer-agent/runtime-node';

/** Read current ownership metadata once; task watches never need chat bodies. */
export function createDelegationFactsReader({ conversationStore, goalPlanStore }) {
  return workspaceId => {
    if (typeof workspaceId !== 'string' || !workspaceId) return { sessions: [] };
    const conversations = conversationStore.listConversations({
      roles: ['default', 'project_agent', 'work_session'],
      includeMessageCount: false,
    });
    const ownership = new Map(conversations.map(meta => [meta.id, meta.workspaceId]));
    const plans = (goalPlanStore.listPlans?.() || [])
      .filter(meta => ownership.get(meta.conversationId) === workspaceId)
      .map(meta => goalPlanStore.getPlan(meta.planId))
      .filter(Boolean);
    return delegationFactsForWorkspace(plans, workspaceId);
  };
}
