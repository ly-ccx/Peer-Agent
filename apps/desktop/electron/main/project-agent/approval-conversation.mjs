import { projectCards } from '@peer-agent/runtime-node';

/** Save the presentation receipt, so terminal requests cannot leave open history cards.
 * ApprovalStore remains the authority; this message can never sign a permission.
 */
export function syncApprovalConversation({ record, profile, conversationStore, appendMessage }) {
  const conversationId = profile?.agentConversationId;
  if (!record?.deadlineAt || !record.workspaceId || !conversationId || profile.status !== 'active') return;
  const card = projectCards(record.workspaceId, { approvals: [record] })[0];
  if (!card) return;
  const exists = conversationStore.getPersistedConversationHistory(conversationId)?.messages?.some(row => row.id === card.cardId);
  if (exists) {
    conversationStore.updateMessageById(conversationId, card.cardId, { cards: [card] });
  } else {
    appendMessage(conversationId, { id: card.cardId, role: 'assistant', kind: 'system_card', content: '',
      createdAt: record.createdAt, cards: [card] });
  }
}
