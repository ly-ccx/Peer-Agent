import { reprojectContextAccountingWindow } from '@peer-agent/runtime-core';
const EFFORTS = new Set(['off','low','default','medium','high','xhigh','max']);

function projectConversationView(conversation, { goalPlanStore, llmConfigStore }) {
  if (!conversation) return null;
  if (conversation.role === 'work_session' && conversation.delegation?.sessionId) {
    const metas = goalPlanStore.listPlansByConversation(conversation.id);
    for (const meta of metas) {
      const plan = goalPlanStore.getPlan(meta.planId), origin = plan?.delegationOrigin;
      if (plan?.conversationId !== conversation.id || origin?.sessionId !== conversation.delegation.sessionId
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
}

function asWindowPage(conversation, page = {}) {
  if (!conversation) return null;
  const { messages = [], ...meta } = conversation;
  return {
    meta,
    window: messages,
    cursor: page.cursor ?? null,
    hasMore: page.hasMore === true,
  };
}

/** Read-side presentation of frozen task identity and current context-window accounting. */
export function createConversationReadProjection({ conversationStore, goalPlanStore, llmConfigStore, readWindow }) {
  const project = (conversation) => projectConversationView(conversation, { goalPlanStore, llmConfigStore });
  return (id, options = {}) => {
    if (options.full === true || (typeof readWindow !== 'function' && typeof conversationStore.readConversationWindow !== 'function')) {
      return asWindowPage(project(conversationStore.getConversation(id)));
    }
    const page = typeof readWindow === 'function'
      ? readWindow(id, options)
      : conversationStore.readConversationWindow(id, options);
    if (!page) return null;
    return asWindowPage(project({ ...page.meta, messages: page.window }), page);
  };
}
