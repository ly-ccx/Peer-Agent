import { reprojectContextAccountingWindow } from '@peer-agent/runtime-core';
const EFFORTS = new Set(['off','low','default','medium','high','xhigh','max']);

/** Read-side presentation of frozen task identity and current context-window accounting. */
export function createConversationReadProjection({ conversationStore, goalPlanStore, llmConfigStore }) {
  return id => {
    let conversation = conversationStore.getConversation(id);
    if (!conversation) return conversation;
    if (conversation.role === 'work_session' && conversation.delegation?.sessionId) {
      const metas = goalPlanStore.listPlansByConversation(id);
      for (const meta of metas) {
        const plan = goalPlanStore.getPlan(meta.planId), origin = plan?.delegationOrigin;
        if (plan?.conversationId !== id || origin?.sessionId !== conversation.delegation.sessionId
          || origin.workspaceId !== conversation.workspaceId) continue;
        const worker = origin.modelSelection?.worker;
        if (typeof worker?.modelProviderId === 'string' && worker.modelProviderId) {
          conversation = { ...conversation, modelProviderId: worker.modelProviderId,
            effort: EFFORTS.has(worker.reasoningEffort) ? worker.reasoningEffort : 'default' };
        }
        break;
      }
    }
    if (conversation.contextSnapshot?.version !== 1) return conversation;
    const providers = llmConfigStore.listProviders(), bound = conversation.modelProviderId;
    const provider = providers.find(p => bound && p.id === bound) || providers.find(p => p.isDefault) || providers[0];
    if (!provider?.contextWindow) return conversation;
    const contextSnapshot = reprojectContextAccountingWindow(conversation.contextSnapshot, provider.contextWindow);
    return !contextSnapshot || contextSnapshot === conversation.contextSnapshot ? conversation : { ...conversation, contextSnapshot };
  };
}
