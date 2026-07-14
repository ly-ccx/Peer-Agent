import type { RuntimeSdkEvent } from '@peer-agent/runtime-sdk';
import type {
  CapabilityManifest,
  ChatSendRequest,
  ClientBootstrap,
  ClientSessionState,
  ClientToolCall,
  ClientToolResult,
  ExecutionStatus,
  GoalApproval,
  GoalManualConfirmation,
  GoalPlan,
  GoalPlanStatus,
  LlmModelListResult,
  LlmModelFetchRequest,
  LlmChannelDescriptor,
  LlmProviderConfigView,
  LlmProviderTestResult,
  LocalMcpServerUpsertRequest,
  LocalMcpServerView,
  LocaleCode,
  McpConnectionProbeResult,
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
  AvailableSkillSummary,
  SkillLinkResult,
  UpdateChannelPreference,
  UpdaterEvent,
  UpdaterStatus,
  WorkspaceProject,
} from '@peer-agent/protocol';

/**
 * ADR 21: 会话锚定的任务续传记录(v2)。
 * - sessionId:中断时所在的会话 id。恢复时必须切回该会话才自动续发,
 *   避免把待办错误地塞进新建/其他会话。
 * - task:重启后要在该会话自动发出的指令。
 * - effort:可选的思考强度(low/default/high/xhigh/max),保持中断时的设定。
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
      // 方案 3：流终结后保留的终态快照字段。isStreaming=false 时表示这是一条
      // 已结束的轮次（切回回放用）；terminalStatus 区分 done/error/aborted，
      // interrupted 标记是否异常中断，usage/lifetimeUsage 为终态用量快照。
      readonly terminalStatus?: 'done' | 'error' | 'aborted' | null;
      readonly interrupted?: boolean;
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly cacheReadTokens?: number;
      } | null;
      readonly lifetimeUsage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly cacheReadTokens?: number;
      } | null;
    };

export interface GoalRunnerStateView {
  readonly planId: string;
  readonly planStatus: GoalPlanStatus;
  readonly runner: GoalPlan['runner'] | null;
}

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

export type QuickChatPopoverKind = 'workspace' | 'model' | 'effort' | 'mode' | 'access';

export interface QuickChatPopoverItem {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export interface QuickChatPopoverState {
  readonly kind: QuickChatPopoverKind;
  readonly items: readonly QuickChatPopoverItem[];
  readonly selectedValue: string;
}

export interface QuickChatPopoverAnchorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  /**
   * 用系统默认方式打开指定文件/目录（点击聊天消息中的文件路径时调用）。
   * - absPath 必须是绝对路径；相对路径需调用方先基于 workspacePath 解析。
   * - 可选 workspaceRoot 用于越界校验：目标必须位于该根目录内。
   * - 主进程优先 shell.openPath，失败回退 showItemInFolder。
   */
  readonly openPath: (
    absPath: string,
    workspaceRoot?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly fallback?: string;
    readonly reason?: string;
    readonly message?: string;
  }>;
  /**
   * 计算并返回指定文件的 git diff（点击聊天消息中的文件路径时，在 Workbench 的 Diff 视图展示）。
   * - absPath 必须是绝对路径；workspaceRoot 为 git 仓库根（不传则用 absPath 所在目录推断）。
   * - status 表示 diff 来源/状态：modified（工作区改动）、staged（已暂存）、last_commit（回退到上一次提交对比）、
   *   untracked（未跟踪文件，全量新增）、no_changes（无改动）、not_git_repo / not_found / invalid_path / error（异常）。
   * - diffText 为统一 diff 文本（unified diff）；异常或无改动时为空串。
   */
  readonly gitDiff: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly status:
      | 'modified'
      | 'staged'
      | 'last_commit'
      | 'untracked'
      | 'no_changes'
      | 'not_git_repo'
      | 'not_found'
      | 'invalid_path'
      | 'error';
    readonly diffText: string;
    readonly error?: string;
    /**
     * 当 absPath 在当前 workspace 找不到、但通过 relPath 在其他已知 workspace 命中时，
     * 标注实际命中的仓库根目录，便于在 UI 上提示「已在其他仓库找到该文件」。
     */
    readonly resolvedFrom?: string;
  }>;
  /**
   * 校验给定路径是否对应磁盘上真实存在的文件，供渲染层判断聊天消息中的「路径样式文本」
   * 是否为真实文件引用（而非 git 分支名/仓库名/版本号等）。
   * - absPath 必须是绝对路径；在当前 workspace 找不到时，会用 relPath 在其他已知 workspace 回退查找。
   * - resolvedFrom 标注实际命中的 workspace（跨仓库引用场景）。
   */
  readonly fileExists: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
  ) => Promise<{ readonly exists: boolean; readonly isDir?: boolean; readonly resolvedFrom?: string }>;
  /**
   * 读取指定文件的完整文本内容，供 Workbench 的 Diff 视图「文件内容」分段查看。
   * - absPath 必须是绝对路径；在当前 workspace 找不到时，会用 relPath 在其他已知 workspace 回退查找。
   * - status：ok（读取成功）、not_found（不存在）、not_file（是目录等非普通文件）、too_large（超过 2MB 上限）、
   *   binary（检测到二进制内容，不预览）、invalid_path / error（异常）。
   * - content 为 UTF-8 文本（仅 status=ok 时有内容，其余为空串）；size 为字节数；resolvedFrom 标注跨仓库命中的仓库根。
   */
  readonly readFile: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly status:
      | 'ok'
      | 'not_found'
      | 'not_file'
      | 'too_large'
      | 'binary'
      | 'invalid_path'
      | 'error';
    readonly content: string;
    readonly size?: number;
    readonly resolvedFrom?: string;
    readonly error?: string;
  }>;
  /**
   * 列出指定目录的单层子条目，供 Workbench「文件」视图的文件树懒加载/逐层展开。
   * - absPath 必须是绝对目录路径；在当前 workspace 找不到时，会用 relPath 在其他已知 workspace 回退查找。
   * - status：ok（成功）、not_found（不存在）、not_dir（非目录）、invalid_path / error（异常）。
   * - entries 按「目录在前、同类按名称不区分大小写」排序；隐藏点文件一并返回，由调用方决定是否显示。
   * - resolvedFrom 标注跨仓库命中的仓库根。
   */
  readonly readDir: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly status: 'ok' | 'not_found' | 'not_dir' | 'invalid_path' | 'error';
    readonly entries: readonly {
      readonly name: string;
      readonly isDir: boolean;
      readonly absPath: string;
    }[];
    readonly resolvedFrom?: string;
    readonly error?: string;
  }>;
  /**
   * 内嵌浏览器（Workbench「浏览器」面板 <webview>）控制句柄注册 —— 见 ADR 40。
   * renderer 在 webview `dom-ready` 后上报其 `getWebContentsId()`，main 记下当前
   * 活跃句柄，供 Agent 的 browser_* 工具经 webContents.fromId 直接操控。
   */
  readonly registerBrowserWebContents: (
    webContentsId: number,
    url?: string,
    title?: string,
  ) => Promise<{ readonly ok: boolean; readonly webContentsId?: number; readonly error?: string }>;
  readonly unregisterBrowserWebContents: (
    webContentsId: number,
  ) => Promise<{ readonly ok: boolean; readonly cleared: boolean }>;
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
  /** 列出 a1 公共仓等借用来源中的可借技能（含 linked 标记）。 */
  readonly listAvailableSkills: () => Promise<readonly AvailableSkillSummary[]>;
  /** 在本地 userData/skills 下建软链，借用指定来源技能。 */
  readonly linkSkill: (skillId: string) => Promise<SkillLinkResult>;
  /** 解除借用：仅删除本地软链，不影响来源目录。 */
  readonly unlinkSkill: (skillId: string) => Promise<SkillLinkResult>;
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
  readonly mcpStartOAuth: (params: { mcpId?: string | number; serverId?: string | number }) => Promise<McpConnectionProbeResult & { readonly success: boolean; readonly toolCount: number; readonly oauth?: 'authorized' | 'connected' }>;
  readonly mcpFinishOAuth: (params: { mcpId?: string | number; serverId?: string | number; authorizationCode: string }) => Promise<{ ok: boolean }>;
  readonly mcpReadResource: (params: { mcpId?: string | number; serverId?: string | number; uri: string }) => Promise<unknown>;
  readonly mcpGetPrompt: (params: { mcpId?: string | number; serverId?: string | number; name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  readonly mcpConnectAndRegister: (params: { serverUrl: string; serverName: string }) => Promise<McpConnectionProbeResult & { readonly success: boolean; readonly toolCount: number }>;
  readonly workspaceList: () => Promise<{ workspaces: readonly { path: string; name: string; addedAt: string }[]; activeWorkspace: string | null }>;
  readonly quickChatHide: () => Promise<{ ok: true }>;
  readonly quickChatSetTaskCardVisible: (visible: boolean) => Promise<{ ok: boolean }>;
  readonly quickChatShowPopover: (payload: QuickChatPopoverState & { anchorRect: QuickChatPopoverAnchorRect }) => Promise<{ ok: boolean }>;
  readonly quickChatHidePopover: () => Promise<{ ok: true }>;
  readonly quickChatSelectPopoverValue: (value: string) => Promise<{ ok: boolean }>;
  readonly quickChatSubmit: (params: { conversationId: string; workspacePath: string; openMainWindow: boolean; streamId: string }) => Promise<{ ok: true }>;
  readonly onQuickChatShown: (listener: () => void) => () => void;
  readonly onQuickChatPopoverState: (listener: (payload: QuickChatPopoverState) => void) => () => void;
  readonly onQuickChatPopoverSelected: (listener: (payload: { kind: QuickChatPopoverKind; value: string }) => void) => () => void;
  readonly onQuickChatPopoverClosed: (listener: () => void) => () => void;
  readonly workspaceEnsureDefault: () => Promise<{ path: string; name: string; created: boolean }>;
  readonly workspaceAdd: () => Promise<{ path: string; name: string; existing: boolean } | null>;
  readonly workspaceSetActive: (params: { path: string | null }) => Promise<{ activeWorkspace: string | null }>;
  readonly workspaceRemove: (params: { path: string }) => Promise<unknown>;
  readonly workspaceInfo: (params: { path: string }) => Promise<{ name: string; absolutePath: string; git?: { branch?: string; isDirty?: boolean } } | null>;
  readonly conversationsList: (params?: { workspacePath?: string | null; status?: 'active' | 'archived' | readonly ('active' | 'archived')[] }) => Promise<readonly { id: string; title: string; workspacePath?: string | null; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messageCount: number; createdAt: string; updatedAt: string }[]>;
  readonly conversationsCreate: (params?: { title?: string; workspacePath?: string | null; mode?: string }) => Promise<{ id: string; title: string; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messageCount: number; createdAt: string; updatedAt: string }>;
  readonly conversationsGet: (params: { id: string }) => Promise<{ id: string; title: string; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messages: readonly Record<string, unknown>[]; createdAt: string; updatedAt: string; lifetimeUsage?: LifetimeUsage } | null>;
  readonly conversationsUpdateTitle: (params: { id: string; title: string }) => Promise<unknown>;
  // 对话模式按会话持久化在会话 meta 上（chat / goal）。模式真值仍经 chatSend → IPC →
  // mode-source 进入 System Context 的 L6_MODE_REMINDER；此处仅负责「每会话存哪」。
  readonly conversationsUpdateMode: (params: { id: string; mode: string }) => Promise<unknown>;
  // 会话级模型 + 思考模式绑定（随会话持久化，同 mode 范式）。effort/modelProviderId
  // 各自独立写入：用户可只切模型不切思考档，或反之。modelProviderId 为 null 表示回退
  // 到全局默认 provider。provider 被删/失效时由发送层 orderProviderCandidates 自动回退。
  readonly conversationsUpdateModelEffort: (params: { id: string; effort?: string; modelProviderId?: string | null }) => Promise<unknown>;
  readonly conversationsAppendMessage: (params: { id: string; message: Record<string, unknown> & { id: string; role: string; content: string } }) => Promise<unknown>;
  readonly conversationsUpdateLastMessage: (params: { id: string; content: string }) => Promise<unknown>;
  readonly conversationsReplaceMessages: (params: { id: string; messages: readonly Record<string, unknown>[] }) => Promise<unknown>;
  readonly conversationsArchive: (params: { id: string }) => Promise<unknown>;
  readonly conversationsRestore: (params: { id: string }) => Promise<unknown>;
  readonly conversationsPin: (params: { id: string }) => Promise<unknown>;
  readonly conversationsUnpin: (params: { id: string }) => Promise<unknown>;
  readonly conversationsReorderPinned: (params: { ids: readonly string[] }) => Promise<unknown>;
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
  readonly goalPlansRecordManualConfirmation: (params: {
    planId: string;
    confirmation: GoalManualConfirmation;
  }) => Promise<GoalPlan>;
  readonly goalRunnerGetState: (params: { planId: string }) => Promise<GoalRunnerStateView | null>;
  readonly goalRunnerStart: (params: { planId: string; options?: Record<string, unknown> }) => Promise<GoalRunnerStateView | null>;
  readonly goalRunnerPause: (params: { planId: string }) => Promise<GoalRunnerStateView | null>;
  readonly goalRunnerResume: (params: { planId: string; options?: Record<string, unknown> }) => Promise<GoalRunnerStateView | null>;
  readonly goalRunnerClear: (params: { planId: string }) => Promise<GoalRunnerStateView | null>;
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
  readonly onGoalRunnerChanged: (
    listener: (payload: { type?: string; planId?: string | null; [key: string]: unknown }) => void,
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
  readonly chatCompact: (params: { conversationId: string; streamId: string }) => Promise<{ compacted: boolean; notification?: { method: string; beforeTokens: number; afterTokens: number; oldMessageCount: number; keptMessageCount: number; contextTokens?: number; contextWindow?: number | null } }>;
  // 按会话查询当前压缩态（切会话恢复横幅用）。压缩态真值在主进程登记表，渲染层只表达。
  readonly chatCompactionGet: (params: { conversationId: string }) => Promise<{ compacting: true; streamId: string; percent: number | null; manual: boolean } | null>;
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
    // 口径统一：主进程随回合结束下发的权威上下文用量快照（与压缩触发同口径）。
    // contextTokens 用于进度条对齐；compactionSuggested 表示已达阈值、应在回合结束后自动压缩。
    contextTokens?: number;
    contextWindow?: number;
    compactionSuggested?: boolean;
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
  readonly onChatCompaction: (listener: (payload: { conversationId: string; streamId: string; stage?: 'start' | 'progress' | 'done' | 'idle'; percent?: number; receivedChars?: number; estimatedTotalChars?: number; method?: string; beforeTokens?: number; afterTokens?: number; oldMessageCount?: number; keptMessageCount?: number; contextTokens?: number; contextWindow?: number | null }) => void) => () => void;
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
  /**
   * 聊天模型菜单专用列表：Qoder 本机记录已按目录展开成多条虚拟模型记录
   * （复合 id=groupId::modelId，共享同一凭证）。设置页请用 llmListProviders（纯真实记录）。
   */
  readonly llmListChatProviders: () => Promise<readonly LlmProviderConfigView[]>;
  readonly llmListChannels: () => Promise<readonly LlmChannelDescriptor[]>;
  readonly llmAddProvider: (config: Record<string, unknown>) => Promise<LlmProviderConfigView>;
  readonly llmUpdateProvider: (params: { id: string; [key: string]: unknown }) => Promise<LlmProviderConfigView>;
  // 复制一个已有 provider（订阅类型不支持），返回复制后的完整列表。
  readonly llmDuplicateProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  // B-2 在已有 provider 组内新增一个模型：凭证继承自组内首条，无需重填 apiKey。返回完整列表。
  readonly llmAddModel: (params: { groupId: string; [key: string]: unknown }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmRemoveProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  // B-2 删除整个 provider 组（同 groupId 的全部模型）。返回删除后的完整列表。
  readonly llmRemoveGroup: (params: { groupId: string }) => Promise<readonly LlmProviderConfigView[]>;
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
  // 用表单临时配置(未落盘)直接拉模型,供"添加渠道"弹窗预览/多选。
  readonly llmFetchModels: (params: LlmModelFetchRequest) => Promise<LlmModelListResult>;
  readonly initialSettings: Record<string, unknown>;
  readonly getSettings: () => Promise<Record<string, unknown>>;
  readonly updateSettings: (partial: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly onAppearanceChanged: (listener: (appearance: unknown) => void) => () => void;
  readonly getShortcutStatus: () => Promise<{ quickChat: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean } }>;
  readonly updateShortcut: (accelerator: string) => Promise<{ success: boolean; error: string | null }>;
  readonly resetShortcut: () => Promise<{ success: boolean; error: string | null }>;
  readonly exportConfig: () => Promise<Record<string, unknown>>;
  readonly importConfig: () => Promise<Record<string, unknown>>;
  // ── Updater ──（主进程负责能力，渲染层只表达）
  readonly updaterGetStatus: () => Promise<UpdaterStatus>;
  readonly updaterCheck: () => Promise<UpdaterStatus>;
  readonly updaterDownload: () => Promise<UpdaterStatus>;
  readonly updaterInstall: () => Promise<void>;
  /** mac 自管下载完成后打开 dmg 安装包（phase='ready-to-open' 时调用）。 */
  readonly updaterOpenInstaller: () => Promise<UpdaterStatus>;
  /** 兜底：打开当前版本的 GitHub Release 页面（mac 下载失败时调用）。 */
  readonly updaterOpenReleasePage: () => Promise<UpdaterStatus>;
  readonly updaterSetChannel: (preference: UpdateChannelPreference) => Promise<UpdaterStatus>;
  readonly onUpdaterEvent: (listener: (payload: UpdaterEvent) => void) => () => void;
  readonly onQuickChatConversationCreated: (listener: (payload: {
    conversationId: string;
    workspacePath: string;
  }) => void) => () => void;
  readonly onQuickChatOpenConversation: (listener: (payload: {
    conversationId: string;
    workspacePath: string;
  }) => void) => () => void;
  readonly onRuntimeEvent: (listener: (payload: RuntimeSdkEvent) => void) => () => void;
}
