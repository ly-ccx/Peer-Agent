import type { BotChatCard } from './botConversationState';
export function cardDecisionKey(card: BotChatCard): string {
  return JSON.stringify([card.cardId, card.content, card.refs, card.actions, card.resolvedState, card.resolution]);
}
/** Match the actual host decision, including a timeout racing an Allow click. */
export function approvalCardReceipt(workspaceId: string, card: BotChatCard, result: unknown): BotChatCard | null {
  if (!result || typeof result !== 'object' || !['approval', 'plan_approval'].includes(card.kind)) return null;
  const approval = (result as { approval?: unknown }).approval;
  if (!approval || typeof approval !== 'object') return null;
  const row = approval as { workspaceId?: unknown; approvalId?: unknown; state?: unknown; decisionReason?: unknown };
  if (row.workspaceId !== workspaceId || typeof row.approvalId !== 'string'
    || row.approvalId !== card.refs?.approvalId || !['approved', 'denied', 'expired', 'cancelled'].includes(String(row.state))) return null;
  return { ...card, resolvedState: 'resolved', resolution: { state: String(row.state) }, actions: [],
    refs: { ...card.refs, ...(typeof row.decisionReason === 'string' ? { decisionReason: row.decisionReason } : {}) } };
}
