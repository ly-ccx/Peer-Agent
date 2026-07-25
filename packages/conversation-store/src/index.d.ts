export interface ConversationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly [key: string]: unknown;
}

export interface ConversationContextSnapshot {
  readonly nextRequestInputTokens: number;
  readonly contextWindow: number | null;
  readonly contentRevision: number;
  readonly modelProviderId: string | null;
  readonly model: string | null;
  readonly computedAt: string;
  readonly source: 'desktop' | 'tui';
  readonly projectorVersion: number;
}

export interface ConversationMeta {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly mode?: string;
  readonly updatedAt?: string;
  readonly model?: string;
  readonly modelProviderId?: string | null;
  readonly contentRevision?: number;
  readonly contextSnapshot?: ConversationContextSnapshot | null;
  readonly effort?: string;
  readonly messageCount?: number;
  readonly [key: string]: unknown;
}

export interface StoredConversation extends ConversationMeta {
  readonly messages: readonly Record<string, unknown>[];
}

export interface ConversationListPage {
  readonly items: ConversationMeta[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly total: number;
}

export interface ConversationChangeEvent {
  readonly conversationId: string;
  readonly workspacePath: string | null;
  readonly changeType: 'created' | 'messages-updated' | 'metadata-updated' | 'deleted';
  readonly revision: string;
  readonly writerPid: number;
  readonly changedAt: string;
}

export interface ConversationListParams {
  status?: string | readonly string[];
  includeMessageCount?: boolean;
  /** 显式同步回填 messageCount（会读 jsonl）；默认 false，list 热路径永不读正文 */
  backfillMessageCount?: boolean;
  limit?: number;
  cursor?: string | null;
  /** true 时返回 ConversationListPage；默认 false 兼容旧调用方返回数组 */
  paginated?: boolean;
}

export interface ConversationStore {
  listConversations(params?: ConversationListParams): ConversationMeta[] | ConversationListPage;
  listConversationsByWorkspace?(workspacePath: string | null | undefined, params?: ConversationListParams): ConversationMeta[] | ConversationListPage;
  scheduleMessageCountMigration?(ids?: readonly string[] | null): void;
  backfillMessageCounts?(): ConversationMeta[];
  searchConversations(params?: {
    query?: string;
    status?: string | readonly string[];
    workspacePath?: string | null;
    limit?: number;
    includeWorkspaceNameMatch?: boolean;
  }): ConversationMeta[];
  getConversation(id: string): StoredConversation | null;
  createConversation(input?: { title?: string; workspacePath?: string; mode?: string }): ConversationMeta;
  appendMessage(id: string, message: object): unknown;
  updateMode(id: string, mode: string): unknown;
  updateModelEffort(id: string, input: { effort?: string; modelProviderId?: string | null; model?: string | null }): unknown;
  updateContextSnapshot(id: string, snapshot: Omit<ConversationContextSnapshot, 'contentRevision' | 'computedAt'> & { computedAt?: string }): ConversationMeta | null;
  addUsage(id: string, usage: ConversationUsage): unknown;
  subscribeChanges(listener: (event: ConversationChangeEvent) => void, options?: { interval?: number }): () => void;
  readonly [key: string]: unknown;
}

export function createConversationStore(options?: { storeDir?: string }): ConversationStore;

export function rankConversationMatch(
  meta: Pick<ConversationMeta, 'title' | 'workspacePath'> | null | undefined,
  query?: string,
  options?: { includeWorkspaceNameMatch?: boolean },
): number;
