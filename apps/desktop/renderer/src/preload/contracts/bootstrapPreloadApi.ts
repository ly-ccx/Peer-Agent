import type {
  CapabilityManifest,
  ChatSendRequest,
  ClientBootstrap,
  ClientSessionState,
  ClientToolCall,
  ClientToolResult,
  ExecutionStatus,
  GoalApproval,
  GoalPlan,
  GoalPlanStatus,
  LlmModelListResult,
  LlmChannelDescriptor,
  LlmProviderConfigView,
  LlmProviderTestResult,
  LocalMcpServerUpsertRequest,
  LocalMcpServerView,
  LocaleCode,
  McpConnectionTestResult,
  McpCredentialMetadataView,
  McpCredentialPutRequest,
  McpManifestRefreshResult,
  PermissionGrant,
  PromptContextEpochEventRecord,
  PromptContextEpochRecord,
  PromptSnapshotIndexEntry,
  PromptSnapshotRecord,
  RuntimeProjection,
  SkillSummary,
  WorkspaceProject,
} from '@peer-agent/protocol';

/**
 * ADR 21: 会话锚定的任务续传记录(v2)。
 * - sessionId:中断时所在的会话 id。恢复时必须切回该会话才自动续发,
 *   避免把待办错误地塞进新建/其他会话。
 * - task:重启后要在该会话自动发出的指令。
 * - effort:可选的思考强度(low/default/high/xhigh),保持中断时的设定。
 *
 * 旧的 v1 形状(顶层 `prompt`、无 sessionId)已废弃;store 通过版本号丢弃旧记录。
 */
export interface PendingTask {
  readonly sessionId: string;
  readonly task: string;
  readonly reason?: string;
  readonly effort?: string;
  readonly [key: string]: unknown;
}

/**
 * ADR 22: 流式重连结果。renderer 重载后询问 main "当前有无活跃流"。
 * - null:无活跃流,renderer 正常初始化。
 * - 快照对象:取回已累积文本接回 UI(不重发、不打断后端正在进行的推理)。
 *
 * 形状与 llm-chat-service.reattach() 的真实返回严格对齐:命中返回快照,
 * 未命中返回 null。consumer(ChatSurface)依据 isStreaming/streamId 判定。
 */
export type StreamReattachResult =
  | null
  | {
      readonly streamId: string;
      readonly conversationId: string | null;
      readonly startedAt?: number | null;
      readonly accumulatedText: string;
      readonly accumulatedThinking: string;
      readonly segments?: readonly (
        | { readonly type: 'text'; readonly content?: string }
        | { readonly type: 'thinking'; readonly content?: string }
        | {
            readonly type: 'tool-call';
            readonly tool?: string;
            readonly displayName?: string | null;
            readonly args?: Record<string, unknown>;
            readonly result?: string;
            readonly toolCallId?: string;
          }
      )[];
      readonly isStreaming: boolean;
    };

/**
 * ADR 23: 会话累计用量(lifetime usage)。
 * 存于 index meta,独立于消息 jsonl,因此压缩(replaceMessages)不影响它。
 * 反映本次会话从创建至今的累计 token 用量,用于右下角计费与缓存命中率显示。
 */
export interface LifetimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * ADR 27: 活跃流投影(带工作区维度)。
 * - conversationId:正在运行的会话 id。
 * - workspacePath:该流发起时所属的工作区(发起时快照,切换工作区不改变);
 *   无工作区上下文时为 null。
 * 让 renderer 能派生"哪些工作区有运行中的流",使跨工作区运行可见而非静默丢失。
 */
export interface ActiveStreamProjection {
  readonly conversationId: string;
  readonly workspacePath: string | null;
}

export interface BootstrapPreloadApi {
  readonly getBootstrap: () => Promise<ClientBootstrap>;
  readonly getClientSession: () => Promise<ClientSessionState>;
  readonly listCapabilities: () => Promise<readonly CapabilityManifest[]>;
  readonly listProjects: () => Promise<readonly WorkspaceProject[]>;
  readonly getRuntimeProjection: () => Promise<RuntimeProjection>;
  readonly setLocale: (locale: LocaleCode) => Promise<ClientSessionState>;
  readonly approveLocalAction: (
    toolCallId: string,
    options?: { duration?: PermissionGrant['duration']; scope?: string }
  ) => Promise<PermissionGrant>;
  readonly denyLocalAction: (toolCallId: string) => Promise<PermissionGrant>;
  readonly executeClientToolCall: (
    call: ClientToolCall,
    grant?: PermissionGrant
  ) => Promise<{
    readonly call: ClientToolCall;
    readonly grant: PermissionGrant;
    readonly result: ClientToolResult;
  }>;
  readonly runHealthCheck: (toolCallId: string) => Promise<ClientToolResult>;
  readonly listShellTasks: () => Promise<readonly Record<string, unknown>[]>;
  readonly stopActiveShellTask: () => Promise<Record<string, unknown>>;
  readonly stopShellTask: (taskId: string) => Promise<Record<string, unknown>>;
  readonly listShellPermissionRules: () => Promise<readonly Record<string, unknown>[]>;
  readonly addShellPermissionRule: (rule: Record<string, unknown>) => Promise<readonly Record<string, unknown>[]>;
  readonly listSkills: () => Promise<readonly SkillSummary[]>;
  readonly refreshSkills: () => Promise<readonly SkillSummary[]>;
  readonly uploadSkill: (zipBase64: string) => Promise<SkillSummary | null>;
  readonly enableSkill: (skillId: string) => Promise<readonly SkillSummary[]>;
  readonly disableSkill: (skillId: string) => Promise<readonly SkillSummary[]>;
  readonly mcpListInstalled: () => Promise<readonly LocalMcpServerView[]>;
  readonly mcpListCapabilities: () => Promise<readonly CapabilityManifest[]>;
  readonly mcpListCredentials: () => Promise<readonly McpCredentialMetadataView[]>;
  readonly mcpPutCredential: (item: McpCredentialPutRequest) => Promise<McpCredentialMetadataView>;
  readonly mcpDeleteCredential: (params: { credentialRef: string } | string) => Promise<{ deleted: boolean; credentialRef: string }>;
  readonly mcpInstall: (item: LocalMcpServerUpsertRequest) => Promise<LocalMcpServerView>;
  readonly mcpUpsertServer: (item: LocalMcpServerUpsertRequest) => Promise<LocalMcpServerView>;
  readonly mcpUninstall: (params: { mcpId?: string | number; serverId?: string | number }) => Promise<unknown>;
  readonly mcpSetEnabled: (params: { mcpId?: string | number; serverId?: string | number; enabled: boolean }) => Promise<unknown>;
  readonly mcpSetToolVisibility: (params: { mcpId?: string | number; serverId?: string | number; toolName: string; visible: boolean }) => Promise<unknown>;
  readonly mcpTestConnection: (params: Record<string, unknown>) => Promise<McpConnectionTestResult>;
  readonly mcpRefreshManifest: (params: { mcpId?: string | number; serverId?: string | number }) => Promise<McpManifestRefreshResult>;
  readonly mcpReadResource: (params: { mcpId?: string | number; serverId?: string | number; uri: string }) => Promise<unknown>;
  readonly mcpGetPrompt: (params: { mcpId?: string | number; serverId?: string | number; name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  readonly mcpConnectAndRegister: (params: { serverUrl: string; serverName: string }) => Promise<{ success: boolean; toolCount: number }>;
  readonly workspaceList: () => Promise<{ workspaces: readonly { path: string; name: string; addedAt: string }[]; activeWorkspace: string | null }>;
  readonly workspaceEnsureDefault: () => Promise<{ path: string; name: string; created: boolean }>;
  readonly workspaceAdd: () => Promise<{ path: string; name: string; existing: boolean } | null>;
  readonly workspaceSetActive: (params: { path: string | null }) => Promise<{ activeWorkspace: string | null }>;
  readonly workspaceRemove: (params: { path: string }) => Promise<unknown>;
  readonly workspaceInfo: (params: { path: string }) => Promise<{ name: string; absolutePath: string; git?: { branch?: string; isDirty?: boolean } } | null>;
  readonly conversationsList: (params?: { workspacePath?: string | null; status?: 'active' | 'archived' | readonly ('active' | 'archived')[] }) => Promise<readonly { id: string; title: string; workspacePath?: string | null; mode?: string; status?: 'active' | 'archived'; archivedAt?: string | null; messageCount: number; createdAt: string; updatedAt: string }[]>;
  readonly conversationsCreate: (params?: { title?: string; workspacePath?: string | null; mode?: string }) => Promise<{ id: string; title: string; mode?: string; status?: 'active' | 'archived'; archivedAt?: string | null; messageCount: number; createdAt: string; updatedAt: string }>;
  readonly conversationsGet: (params: { id: string }) => Promise<{ id: string; title: string; mode?: string; status?: 'active' | 'archived'; archivedAt?: string | null; messages: readonly Record<string, unknown>[]; createdAt: string; updatedAt: string; lifetimeUsage?: LifetimeUsage } | null>;
  readonly conversationsUpdateTitle: (params: { id: string; title: string }) => Promise<unknown>;
  // 对话模式按会话持久化在会话 meta 上（chat / goal）。模式真值仍经 chatSend → IPC →
  // mode-source 进入 System Context 的 L6_MODE_REMINDER；此处仅负责「每会话存哪」。
  readonly conversationsUpdateMode: (params: { id: string; mode: string }) => Promise<unknown>;
  readonly conversationsAppendMessage: (params: { id: string; message: Record<string, unknown> & { id: string; role: string; content: string } }) => Promise<unknown>;
  readonly conversationsUpdateLastMessage: (params: { id: string; content: string }) => Promise<unknown>;
  readonly conversationsReplaceMessages: (params: { id: string; messages: readonly Record<string, unknown>[] }) => Promise<unknown>;
  readonly conversationsArchive: (params: { id: string }) => Promise<unknown>;
  readonly conversationsRestore: (params: { id: string }) => Promise<unknown>;
  readonly conversationsAutoArchive: (params: { before: string; excludeIds?: readonly string[] }) => Promise<{ archivedIds: readonly string[]; archivedCount: number }>;
  readonly conversationsDelete: (params: { id: string }) => Promise<unknown>;
  readonly conversationsAddUsage: (params: {
    id: string;
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheWriteTokens?: number;
      cacheReadTokens?: number;
    };
  }) => Promise<LifetimeUsage>;
  // Goal 模式计划（见 Goal 模式设计）。
  // 完成状态由 Evidence 自底向上聚合，渲染层只读展示 + 治理操作（批准/驳回/修订），不可手填进度。
  readonly goalPlansList: (params?: { conversationId?: string }) => Promise<readonly GoalPlan[]>;
  readonly goalPlansGet: (params: { planId: string }) => Promise<GoalPlan | null>;
  readonly goalPlansCreate: (params: { draft: Partial<GoalPlan> }) => Promise<GoalPlan>;
  readonly goalPlansRevise: (params: {
    planId: string;
    patch: Partial<GoalPlan>;
    reason: string;
    changedBy?: string;
  }) => Promise<GoalPlan>;
  readonly goalPlansApprove: (params: { planId: string; approval: GoalApproval }) => Promise<GoalPlan>;
  readonly goalPlansSetStatus: (params: { planId: string; status: GoalPlanStatus }) => Promise<GoalPlan>;
  readonly goalPlansRecordTaskEvidence: (params: {
    planId: string;
    taskId: string;
    change: { status?: ExecutionStatus; evidenceRefs?: string[]; result?: string; failureReason?: string; blockedReason?: string };
  }) => Promise<GoalPlan>;
  readonly goalPlansDelete: (params: { planId: string }) => Promise<readonly GoalPlan[]>;
  // 任一写路径（IPC 或 AI 工具）改动计划后由 main 推送，renderer 据此实时重拉，
  // 无需切换会话/重挂载。reason: 'persist'（创建/修订/审批/状态/证据）或 'delete'。
  readonly onGoalPlansChanged: (
    listener: (payload: { reason: string; planId: string | null }) => void,
  ) => () => void;
  readonly chatSend: (params: ChatSendRequest) => Promise<void>;
  readonly chatAbort: (params: { streamId: string }) => Promise<void>;
  readonly chatStreamReattach: (params?: { conversationId?: string }) => Promise<StreamReattachResult>;
  // 全局活跃流查询:挂载时拉取当前正在运行的会话 id 列表(不依赖切入某个会话)。
  readonly chatStreamListActive: () => Promise<{
    conversationIds: readonly string[];
    // ADR 27: 带工作区维度的活跃流投影(与 conversationIds 并列,后者保留兼容)。
    streams: readonly ActiveStreamProjection[];
  }>;
  readonly restartHost: (options?: { hostDir?: string; port?: number; pendingTask?: PendingTask }) => Promise<unknown>;
  readonly writePendingTask: (task: PendingTask) => Promise<unknown>;
  readonly consumePendingTask: () => Promise<PendingTask | null>;
  readonly peekPendingTask: () => Promise<PendingTask | null>;
  readonly clearPendingTask: () => Promise<boolean>;
  readonly chatCompact: (params: { conversationId: string; streamId: string }) => Promise<{ compacted: boolean; notification?: { method: string; beforeTokens: number; afterTokens: number; oldMessageCount: number; keptMessageCount: number } }>;
  readonly promptSnapshotsList: (params?: { limit?: number }) => Promise<readonly PromptSnapshotIndexEntry[]>;
  readonly promptSnapshotsGet: (params: { id: string }) => Promise<PromptSnapshotRecord | null>;
  readonly promptContextEpochsList: (params?: { limit?: number }) => Promise<readonly PromptContextEpochRecord[]>;
  readonly promptContextEpochEvents: (params?: {
    limit?: number;
    conversationId?: string | null;
    contextEpochId?: string;
  }) => Promise<readonly PromptContextEpochEventRecord[]>;
  readonly promptContextEpochChain: (params?: {
    limit?: number;
    conversationId?: string | null;
    contextEpochId?: string;
  }) => Promise<readonly PromptContextEpochRecord[]>;
  readonly onChatStreamDelta: (listener: (payload: { streamId: string; content: string }) => void) => () => void;
  readonly onChatStreamThinking: (listener: (payload: { streamId: string; content: string }) => void) => () => void;
  readonly onChatStreamDone: (listener: (payload: {
    streamId: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number };
    lifetimeUsage?: LifetimeUsage;
  }) => void) => () => void;
  readonly onChatStreamAborted: (listener: (payload: { streamId: string }) => void) => () => void;
  readonly onChatStreamUsage: (listener: (payload: { streamId: string; usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number } }) => void) => () => void;
  readonly onChatStreamToolCall: (listener: (payload: { streamId: string; tool: string; displayName?: string | null; args: Record<string, unknown>; toolCallId: string }) => void) => () => void;
  // 流式工具参数进度(Codex 式实时体感)。仅是 provider 流式提示,不替代 Tool Result / Evidence。
  readonly onChatStreamToolProgress: (listener: (payload: { streamId: string; toolCallId: string; tool: string; path: string | null; receivedChars: number; receivedLines: number }) => void) => () => void;
  readonly onChatStreamToolResult: (listener: (payload: { streamId: string; toolCallId: string; result: string }) => void) => () => void;
  readonly onChatStreamPermissionRequest: (listener: (payload: { streamId: string; call: ClientToolCall }) => void) => () => void;
  readonly onChatStreamError: (listener: (payload: {
    streamId: string;
    error: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number };
    lifetimeUsage?: LifetimeUsage;
  }) => void) => () => void;
  readonly onChatStreamProviderRecovery: (listener: (payload: {
    streamId: string;
    fromProviderId?: string;
    fromProvider?: string;
    toProviderId?: string;
    toProvider?: string;
    reason?: string;
    attempt?: number;
  }) => void) => () => void;
  readonly onChatStreamConnectionRecovery: (listener: (payload: {
    streamId: string;
    provider?: string;
    model?: string;
    status?: 'retrying' | 'recovered';
    fromConnection?: string;
    toConnection?: string;
    connection?: string;
    attempt?: number;
    maxRetries?: number;
    delayMs?: number;
    reason?: string;
  }) => void) => () => void;
  readonly onChatCompaction: (listener: (payload: { streamId: string; stage?: 'start' | 'progress' | 'done' | 'idle'; percent?: number; receivedChars?: number; estimatedTotalChars?: number; method?: string; beforeTokens?: number; afterTokens?: number; oldMessageCount?: number; keptMessageCount?: number }) => void) => () => void;
  // 全局活跃流变更广播:main 在任一会话开始/结束流式时推送最新运行中的会话 id 列表。
  readonly onChatActiveStreamsChanged: (listener: (payload: {
    conversationIds: readonly string[];
    // ADR 27: 带工作区维度的活跃流投影(与 conversationIds 并列,后者保留兼容)。
    streams: readonly ActiveStreamProjection[];
  }) => void) => () => void;
  // 窗口全屏状态变更广播。fullscreen 为窗口当前是否处于原生全屏的权威事实，
  // 渲染层据此收掉为 macOS 交通灯预留的顶部留白。
  readonly onWindowFullscreenChanged: (
    listener: (payload: { fullscreen: boolean }) => void,
  ) => () => void;
  readonly llmListProviders: () => Promise<readonly LlmProviderConfigView[]>;
  readonly llmListChannels: () => Promise<readonly LlmChannelDescriptor[]>;
  readonly llmAddProvider: (config: Record<string, unknown>) => Promise<LlmProviderConfigView>;
  readonly llmUpdateProvider: (params: { id: string; [key: string]: unknown }) => Promise<LlmProviderConfigView>;
  readonly llmRemoveProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmSetDefault: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmTestConnection: (params: { id: string }) => Promise<LlmProviderTestResult>;
  // ADR 28: 启动 ChatGPT 订阅 OAuth 登录(browser 模式)。
  // 链路契约:"先登录、成功后才落盘"。
  // - { id }   : 对已存在的订阅 provider 重新登录(刷新 token)。
  // - { draft }: 新建订阅。登录成功后才创建 provider;失败/取消不写入任何配置。
  // 成功返回更新/新建后的脱敏视图。
  readonly llmOAuthStart: (
    params: { id: string; draft?: undefined } | { id?: undefined; draft: Record<string, unknown> },
  ) => Promise<
    { success: true; provider: LlmProviderConfigView } | { success: false; error: string }
  >;
  readonly llmOAuthCancel: () => Promise<{ success: boolean }>;
  // ADR 28(方案 B): 列出订阅可用模型(远程拉取,失败回退内置清单)。
  readonly llmListModels: (params: { id: string }) => Promise<LlmModelListResult>;
  readonly initialSettings: Record<string, unknown>;
  readonly getSettings: () => Promise<Record<string, unknown>>;
  readonly updateSettings: (partial: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly exportConfig: () => Promise<Record<string, unknown>>;
  readonly importConfig: () => Promise<Record<string, unknown>>;
}
