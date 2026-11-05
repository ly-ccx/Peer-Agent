import type { PersistedConversationHistory } from '@peer-agent/conversation-store';

export function readStoredWorkHistory(storeDir: string, scope: {
  workspaceId: string;
  parentConversationId: string;
  conversationId: string;
  sessionId: string;
}, readBudget?: { remainingBytes: number }): PersistedConversationHistory | null;
