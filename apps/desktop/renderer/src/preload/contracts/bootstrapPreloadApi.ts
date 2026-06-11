import type {
  CapabilityManifest,
  ChatSendRequest,
  ClientBootstrap,
  ClientSessionState,
  ClientToolCall,
  ClientToolResult,
  LlmProviderConfigView,
  LlmProviderTestResult,
  LocaleCode,
  PermissionGrant,
  PromptContextEpochEventRecord,
  PromptContextEpochRecord,
  PromptSnapshotIndexEntry,
  PromptSnapshotRecord,
  RuntimeProjection,
  SkillSummary,
  WorkspaceProject,
} from '@peer-agent/protocol';

export interface PendingTask {
  readonly conversationId?: string;
  readonly prompt: string;
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
      readonly accumulatedText: string;
      readonly accumulatedThinking: string;
      readonly isStreaming: boolean;
    };

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
  readonly mcpListInstalled: () => Promise<readonly Record<string, unknown>[]>;
  readonly mcpInstall: (item: Record<string, unknown>) => Promise<unknown>;
  readonly mcpUninstall: (params: { mcpId: string | number }) => Promise<unknown>;
  readonly mcpConnectAndRegister: (params: { serverUrl: string; serverName: string }) => Promise<{ success: boolean; toolCount: number }>;
  readonly workspaceList: () => Promise<{ workspaces: readonly { path: string; name: string; addedAt: string }[]; activeWorkspace: string | null }>;
  readonly workspaceAdd: () => Promise<{ path: string; name: string; existing: boolean } | null>;
  readonly workspaceSetActive: (params: { path: string | null }) => Promise<{ activeWorkspace: string | null }>;
  readonly workspaceRemove: (params: { path: string }) => Promise<unknown>;
  readonly workspaceInfo: (params: { path: string }) => Promise<{ name: string; absolutePath: string; git?: { branch?: string; isDirty?: boolean } } | null>;
  readonly conversationsList: (params?: { workspacePath?: string | null }) => Promise<readonly { id: string; title: string; workspacePath?: string | null; messageCount: number; createdAt: string; updatedAt: string }[]>;
  readonly conversationsCreate: (params?: { title?: string; workspacePath?: string | null }) => Promise<{ id: string; title: string; messageCount: number; createdAt: string; updatedAt: string }>;
  readonly conversationsGet: (params: { id: string }) => Promise<{ id: string; title: string; messages: readonly Record<string, unknown>[]; createdAt: string; updatedAt: string } | null>;
  readonly conversationsUpdateTitle: (params: { id: string; title: string }) => Promise<unknown>;
  readonly conversationsAppendMessage: (params: { id: string; message: Record<string, unknown> & { id: string; role: string; content: string } }) => Promise<unknown>;
  readonly conversationsUpdateLastMessage: (params: { id: string; content: string }) => Promise<unknown>;
  readonly conversationsReplaceMessages: (params: { id: string; messages: readonly Record<string, unknown>[] }) => Promise<unknown>;
  readonly conversationsDelete: (params: { id: string }) => Promise<unknown>;
  readonly chatSend: (params: ChatSendRequest) => Promise<void>;
  readonly chatAbort: (params: { streamId: string }) => Promise<void>;
  readonly chatStreamReattach: (params?: { conversationId?: string }) => Promise<StreamReattachResult>;
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
  readonly onChatStreamDone: (listener: (payload: { streamId: string; usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number } }) => void) => () => void;
  readonly onChatStreamAborted: (listener: (payload: { streamId: string }) => void) => () => void;
  readonly onChatStreamUsage: (listener: (payload: { streamId: string; usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number } }) => void) => () => void;
  readonly onChatStreamToolCall: (listener: (payload: { streamId: string; tool: string; args: Record<string, unknown>; toolCallId: string }) => void) => () => void;
  readonly onChatStreamToolResult: (listener: (payload: { streamId: string; toolCallId: string; result: string }) => void) => () => void;
  readonly onChatStreamPermissionRequest: (listener: (payload: { streamId: string; call: ClientToolCall }) => void) => () => void;
  readonly onChatStreamError: (listener: (payload: { streamId: string; error: string }) => void) => () => void;
  readonly onChatCompaction: (listener: (payload: { streamId: string; stage?: 'start' | 'done' | 'idle'; method?: string; beforeTokens?: number; afterTokens?: number; oldMessageCount?: number; keptMessageCount?: number }) => void) => () => void;
  readonly llmListProviders: () => Promise<readonly LlmProviderConfigView[]>;
  readonly llmAddProvider: (config: Record<string, unknown>) => Promise<LlmProviderConfigView>;
  readonly llmUpdateProvider: (params: { id: string; [key: string]: unknown }) => Promise<LlmProviderConfigView>;
  readonly llmRemoveProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmSetDefault: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmTestConnection: (params: { id: string }) => Promise<LlmProviderTestResult>;
  readonly initialSettings: Record<string, unknown>;
  readonly getSettings: () => Promise<Record<string, unknown>>;
  readonly updateSettings: (partial: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly exportConfig: () => Promise<Record<string, unknown>>;
  readonly importConfig: () => Promise<Record<string, unknown>>;
}
