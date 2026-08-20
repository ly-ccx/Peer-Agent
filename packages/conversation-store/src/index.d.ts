import type {
  AutomationCreateContext,
  ContextAccountingObserved,
  ContextAccountingSnapshot,
  ConversationAutomationOrigin,
  ConversationLifetimeUsage,
  RuntimeTurnUsage,
} from '@peer-agent/protocol';

export interface ConversationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly [key: string]: unknown;
}

export type ConversationContextSnapshot = ContextAccountingSnapshot;

export interface ConversationMeta {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly mode?: string;
  readonly fastMode: boolean;
  readonly updatedAt?: string;
  /**
   * 用户上次打开/阅读该会话的水位时间（ISO）。
   * 用于首页「正在讨论」：updatedAt > lastReadAt 视为未读。
   * 新建会话默认等于 createdAt（创建即已读）。
   */
  readonly lastReadAt?: string | null;
  readonly model?: string;
  readonly modelProviderId?: string | null;
  readonly contentRevision?: number;
  readonly contextSnapshot?: ConversationContextSnapshot | null;
  readonly effort?: string;
  readonly automationCreateContext?: AutomationCreateContext | null;
  /** Durable source for automation Fresh Conversations; rename-safe badge signal. */
  readonly automationOrigin?: ConversationAutomationOrigin | null;
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
  deleteConversationsByWorkspace?(workspacePath: string | null | undefined): ConversationMeta[];
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
  getLatestContextObservation(
    id: string,
    options?: { modelKey?: string | null },
  ): ContextAccountingObserved | null;
  createConversation(input?: {
    title?: string;
    workspacePath?: string;
    mode?: string;
    fastMode?: boolean;
    automationCreateContext?: AutomationCreateContext | null;
    automationOrigin?: ConversationAutomationOrigin | null;
  }): ConversationMeta;
  appendMessage(id: string, message: object): unknown;
  /**
   * 标记会话已读。只推进 lastReadAt，不修改 updatedAt。
   * options.at 可显式传入水位时间；默认 now。水位只前进不回退。
   */
  markRead(id: string, options?: { at?: string }): ConversationMeta | null;
  updateMode(id: string, mode: string): unknown;
  updateFastMode(id: string, fastMode: boolean): ConversationMeta | null;
  updateAutomationCreateContext(id: string, context: AutomationCreateContext | null): ConversationMeta | null;
  updateModelEffort(id: string, input: { effort?: string; modelProviderId?: string | null; model?: string | null }): unknown;
  updateContextSnapshot(id: string, snapshot: ConversationContextSnapshot): ConversationMeta | null;
  addUsage(id: string, usage: ConversationUsage): unknown;
  recordRuntimeTurnUsage(
    id: string,
    input: {
      usage: RuntimeTurnUsage;
      attribution?: {
        id?: string;
        at?: string;
        streamId?: string | null;
        modelProviderId?: string | null;
        model?: string | null;
        providerName?: string | null;
        estimatedCostUsd?: number | null;
        pricingSource?: string | null;
      };
    },
  ): {
    lifetimeUsage: ConversationLifetimeUsage;
    ledgerRow: Readonly<Record<string, unknown>>;
  } | null;
  subscribeChanges(listener: (event: ConversationChangeEvent) => void, options?: { interval?: number }): () => void;
  readonly [key: string]: unknown;
}

export function createConversationStore(options?: {
  storeDir?: string;
  usageLogFile?: string;
}): ConversationStore;

export function rankConversationMatch(
  meta: Pick<ConversationMeta, 'title' | 'workspacePath'> | null | undefined,
  query?: string,
  options?: { includeWorkspaceNameMatch?: boolean },
): number;
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
