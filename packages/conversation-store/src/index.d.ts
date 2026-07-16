export interface ConversationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly [key: string]: unknown;
}

export interface ConversationMeta {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly mode?: string;
  readonly updatedAt?: string;
  readonly model?: string;
  readonly modelProviderId?: string | null;
  readonly effort?: string;
  readonly messageCount?: number;
  readonly [key: string]: unknown;
}

export interface StoredConversation extends ConversationMeta {
  readonly messages: readonly Record<string, unknown>[];
}

export interface ConversationChangeEvent {
  readonly conversationId: string;
  readonly workspacePath: string | null;
  readonly changeType: 'created' | 'messages-updated' | 'metadata-updated' | 'deleted';
  readonly revision: string;
  readonly writerPid: number;
  readonly changedAt: string;
}

export interface ConversationStore {
  listConversations(params?: { status?: string | readonly string[] }): ConversationMeta[];
  getConversation(id: string): StoredConversation | null;
  createConversation(input?: { title?: string; workspacePath?: string; mode?: string }): ConversationMeta;
  appendMessage(id: string, message: object): unknown;
  updateMode(id: string, mode: string): unknown;
  updateModelEffort(id: string, input: { effort: string; modelProviderId: string | null }): unknown;
  addUsage(id: string, usage: ConversationUsage): unknown;
  subscribeChanges(listener: (event: ConversationChangeEvent) => void, options?: { interval?: number }): () => void;
  readonly [key: string]: unknown;
}

export function createConversationStore(options?: { storeDir?: string }): ConversationStore;
