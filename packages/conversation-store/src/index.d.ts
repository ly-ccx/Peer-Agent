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
export type ImmutableHistoryValue<T> = T extends object
  ? { readonly [K in keyof T]: ImmutableHistoryValue<T[K]> } : T;

export interface ConversationMeta {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly mode?: string;
  readonly fastMode: boolean;
  /**
   * User opt-in to isolate later writes in a Git worktree.
   * Not isolation truth — Goal deliveryBinding.executionIsolation is.
   */
  readonly preferredExecutionIsolation: 'none' | 'worktree';
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
  /** Materialized list preview. Missing or revision-mismatched reads are rebuilding. */
  readonly preview?: SessionPreview;
  readonly availability?: SessionAvailability;
  /** Missing or any other value is an ordinary conversation. */
  readonly role?: 'project_agent' | 'work_session';
  readonly parentConversationId?: string;
  readonly workspaceId?: string;
  readonly delegation?: {
    readonly sessionId: string;
    readonly anchorMessageId: string;
    readonly inputId: string;
  };
  readonly backgroundSnapshotId?: string;
  readonly [key: string]: unknown;
}

export interface StoredConversation extends ConversationMeta {
  readonly messages: readonly Record<string, unknown>[];
}

export interface PersistedConversationHistory {
  conversationId: string;
  contentRevision: number;
  messages: Record<string, unknown>[];
  excludedFromMessageId: string | null;
  requiresRuntimeCheck: true;
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

export type ConversationRoleFilter = 'default' | 'project_agent' | 'work_session';

export interface ConversationListParams {
  status?: string | readonly string[];
  /**
   * Missing or empty keeps ordinary conversations only.
   * Callers that need task children or the project agent must pass them explicitly.
   */
  roles?: readonly ConversationRoleFilter[];
  includeMessageCount?: boolean;
  /** 显式同步回填 messageCount（会读 jsonl）；默认 false，list 热路径永不读正文 */
  backfillMessageCount?: boolean;
  limit?: number;
  cursor?: string | null;
  /** true 时返回 ConversationListPage；默认 false 兼容旧调用方返回数组 */
  paginated?: boolean;
}

export interface InheritedBackgroundSnapshot {
  schemaVersion: 1;
  sourceConversationId: string;
  sourceRevision: number;
  capturedAt: string;
  excludedFromMessageId: string | null;
  coveredMessageIds: string[];
  entries: { sourceMessageId: string; sourceRole: 'user' | 'assistant'; kind: 'summary' | 'text'; text: string }[];
  missingItems: { sourceMessageId: string; reason: string }[];
  characterCount: number;
  status: 'full' | 'compacted' | 'partial';
  requiresMissingConfirmation: boolean;
  contentHash: string;
  scope?: { kind: 'delegation'; messageIds: string[] };
}

export interface SelectionChildRequest {
  parentConversationId: string;
  requestId: string;
  capturedAt: string;
  confirmMissing?: boolean;
  selection: {
    conversationId: string; messageId: string; blockId: 'content'; revision: number;
    start: number; end: number; exactText: string; sourceTextHash: string;
  };
  runtimeState: { conversationId: string; contentRevision: number; status: 'idle' | 'running'; activeMessageId?: string | null };
}

export interface ConversationStore {
  readInteractionPage(conversationId: string, params?: { before?: string; limit?: number }): Promise<(PersistedConversationHistory & { sourceVersion: string; nextCursor: string | null }) | null>;
  readInteractionProcess(conversationId: string, params: { messageId?: string; turnId?: string }): Promise<{ conversationId: string; sourceVersion: string; messages: Record<string, unknown>[]; nextCursor: null } | null>;
  readInteractionContext(conversationId: string): Promise<PersistedConversationHistory | null>;
  resolveSelectionReference?(request: { conversationId: string; selection: import('@peer-agent/protocol').SelectionRange; runtimeState: { conversationId: string; contentRevision: number; status: string; activeMessageId?: string } }): import('@peer-agent/protocol').SelectionReference;
  /** Internal only: host must authorize and resolve runtimeState before calling. */
  createSelectionChild?(request: SelectionChildRequest): ConversationMeta;
  /**
   * Internal only. `snapshotPolicy: 'inherited'` keeps the selection side-chat shape.
   * Any other policy freezes history through `anchorMessageId` inclusive.
   */
  createChildConversation?(input: {
    parentConversationId: string;
    role?: 'project_agent' | 'work_session';
    anchorMessageId?: string;
    snapshotPolicy?: 'inherited' | 'to_anchor';
    title?: string;
    workspacePath?: string | null;
    workspaceId?: string;
    mode?: string;
    modelProviderId?: string | null;
    /** Frozen worker effort for delegated tasks; omitted ordinary children inherit their parent. */
    effort?: string;
    delegation?: { sessionId: string; anchorMessageId: string; inputId: string };
    runtimeState?: SelectionChildRequest['runtimeState'];
    capturedAt?: string;
    /** Work sessions only: admit these persisted anchors instead of the whole history. */
    backgroundMessageIds?: string[];
    backgroundSnapshotId?: string;
    confirmMissing?: boolean;
    requestId?: string;
    selection?: SelectionChildRequest['selection'];
  }): ConversationMeta;
  listChildren?(parentConversationId: string, params?: { role?: ConversationRoleFilter }): ConversationMeta[];
  updateSelectionChildDraft?(id: string, draft: { text: string; referenceIds: string[] }): { text: string; references: Record<string, unknown>[] };
  /** Internal metadata lookup; not a model-visible authorization boundary. */
  listSelectionChildren?(parentConversationId: string): (ConversationMeta & { parentConversationId: string; hasDraft: boolean })[];
  /** Internal only; authorized host supplies runtime attestation, not renderer. */
  captureInheritedBackground?(id: string, options: {
    expectedRevision: number;
    capturedAt: string;
    maxCharacters?: number;
    runtimeState: { conversationId: string; contentRevision: number; status: 'idle' | 'running'; activeMessageId?: string | null };
  }): { snapshotId: string; snapshot: InheritedBackgroundSnapshot };
  /** Internal raw read. Caller must enforce parent-child access before use. */
  readInheritedBackground?(snapshotId: string): InheritedBackgroundSnapshot;
  /** Persisted records before any streaming sidecar target; still requires runtime liveness checks. */
  getPersistedConversationHistory?(id: string): PersistedConversationHistory | null;
  /** Compact presentation cache; does not attest permissions, runtime liveness or acceptance.
   * immutableInput opts a pure callback into deeply frozen shared input.
   * immutableOutput shares deeply frozen plain derived facts; default results remain isolated copies. */
  createHistoryProjection?<T>(project: (history: PersistedConversationHistory & { createdAt?: string }) => T,
    options: { maxEntries?: number; maxBytes?: number; immutableInput?: boolean; immutableOutput: true }): (id: string) => ImmutableHistoryValue<T> | null;
  createHistoryProjection?<T>(project: (history: PersistedConversationHistory & { createdAt?: string }) => T,
    options?: { maxEntries?: number; maxBytes?: number; immutableInput?: boolean; immutableOutput?: false }): (id: string) => T | null;
  /** Current index batch; no cross-file transaction or permission/liveness attestation. */
  getPersistedConversationHistories?(ids: readonly string[]): Map<string, PersistedConversationHistory | null>;
  /** Internal canonical message guard. The host attests Bot ownership and releases after commit. */
  acquireMessageRetentionGuard?(scope: readonly string[] | { conversationId: string; workspaceId: string }): {
    histories: ReadonlyMap<string, readonly Record<string, unknown>[]>;
    delegatedSessions: ReadonlyMap<string, string> | null;
    revision: string;
    assertCurrent(): boolean;
    release(): void;
  };
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
    roles?: readonly ConversationRoleFilter[];
  }): ConversationMeta[];
  getConversation(id: string): StoredConversation | null;
  /** Index preview only. Does not read the conversation JSONL. */
  readSessionPreview?(id: string): SessionPreview | null;
  /** Index meta plus coerced preview. Does not read the conversation JSONL. */
  readSessionMeta?(id: string): ConversationMeta | null;
  /**
   * Tail window for the product get path. `full: true` reads every message and
   * is reserved for diagnostics and migration scripts.
   */
  readConversationWindow?(id: string, options?: {
    limit?: number;
    before?: string | null;
    full?: boolean;
    chunkBytes?: number;
  }): {
    meta: ConversationMeta;
    window: Record<string, unknown>[];
    cursor: string | null;
    hasMore: boolean;
  } | null;
  /** Full history for background projection. Yields between parse batches. */
  readConversationYielding?(id: string, options?: {
    yieldEvery?: number;
    yield?: () => Promise<void>;
  }): Promise<StoredConversation | null>;
  getLatestContextObservation(
    id: string,
    options?: { modelKey?: string | null },
  ): ContextAccountingObserved | null;
  createConversation(input?: {
    title?: string;
    workspacePath?: string;
    mode?: string;
    fastMode?: boolean;
    preferredExecutionIsolation?: 'none' | 'worktree';
    automationCreateContext?: AutomationCreateContext | null;
    automationOrigin?: ConversationAutomationOrigin | null;
    role?: 'project_agent' | 'work_session';
    workspaceId?: string;
  }): ConversationMeta;
  appendMessage(id: string, message: object, options?: { returnMessages?: boolean }): unknown;
  /** Worker preparation followed by a version-checked atomic commit; resolves before terminal delivery. */
  commitStreamingMessage(id: string, messageId: string, patch: Readonly<Record<string, unknown>>): Promise<{
    readonly id: string; readonly messageId: string; readonly contentRevision: number;
  }>;
  drainPendingCommits(): Promise<readonly PromiseSettledResult<unknown>[]>;
  /**
   * 标记会话已读。只推进 lastReadAt，不修改 updatedAt。
   * options.at 可显式传入水位时间；默认 now。水位只前进不回退。
   */
  markRead(id: string, options?: { at?: string }): ConversationMeta | null;
  updateMode(id: string, mode: string): unknown;
  updateFastMode(id: string, fastMode: boolean): ConversationMeta | null;
  updatePreferredExecutionIsolation(id: string, preferredExecutionIsolation: 'none' | 'worktree'): ConversationMeta | null;
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
        role?: string | null;
        workspaceId?: string | null;
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

export type SessionAvailability = 'ready' | 'rebuilding' | 'version_changed' | 'damaged';

export interface SessionPreview {
  readonly conversationId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly updatedAt: string;
  readonly contentRevision: number;
  readonly availability: SessionAvailability;
  readonly messageId?: string;
  readonly role?: 'user' | 'assistant';
  readonly kind?: string;
  readonly at?: string;
  readonly question?: Readonly<Record<string, unknown>>;
  readonly attachmentNames?: readonly string[];
  readonly countUnread?: boolean;
  readonly surfacing?: string;
}

export interface SessionWindowPage {
  readonly meta: ConversationMeta;
  readonly window: readonly Record<string, unknown>[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly diagnostic?: boolean;
  readonly sourceVersion?: string;
}

export interface SessionRevisionEvent {
  readonly conversationId: string;
  readonly contentRevision: number;
  readonly reason: 'append' | 'replace' | 'sidecar' | 'external';
  readonly workspacePath?: string | null;
  readonly writerPid?: number;
  readonly changeType?: ConversationChangeEvent['changeType'];
  readonly revision?: string;
}

export interface SessionAdapter {
  readonly kind?: string;
  listMeta(query?: ConversationListParams): ConversationMeta[] | ConversationListPage;
  getWindow(query: {
    conversationId: string;
    limit?: number;
    before?: string | null;
    full?: boolean;
  }): SessionWindowPage | null | Promise<SessionWindowPage | null>;
  append(input: { conversationId: string; message: object }): {
    meta: ConversationMeta;
    preview: SessionPreview | null;
  } | null;
  subscribeRevision(
    scope: { conversationId?: string; interval?: number },
    onRevision: (event: SessionRevisionEvent) => void,
  ): () => void;
}

export interface SessionService extends SessionAdapter {
  listMeta(query?: ConversationListParams): Promise<ConversationMeta[] | ConversationListPage>;
  getWindow(query: {
    conversationId: string;
    limit?: number;
    before?: string | null;
    full?: boolean;
  }): Promise<SessionWindowPage | null>;
  append(input: { conversationId: string; message: object }): Promise<{
    meta: ConversationMeta;
    preview: SessionPreview | null;
  } | null>;
}

export function createClassicJsonlAdapter(store: ConversationStore): SessionAdapter;
export function createBotSqliteAdapter(store: ConversationStore): SessionAdapter;
export function createSessionService(adapter: SessionAdapter): SessionService;

export function rankConversationMatch(
  meta: Pick<ConversationMeta, 'title' | 'workspacePath'> | null | undefined,
  query?: string,
  options?: { includeWorkspaceNameMatch?: boolean },
): number;
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
