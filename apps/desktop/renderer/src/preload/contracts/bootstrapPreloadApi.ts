import type { RuntimeSdkEvent } from '@peer-agent/runtime-sdk';
import type {
  CapabilityManifest,
  ChatSendRequest,
  ChatStartTaskRequest,
  ChatStartTaskResult,
  ClientBootstrap,
  ClientSessionState,
  ClientToolCall,
  ClientToolResult,
  ContextAccountingSnapshot,
  ExecutionStatus,
  GoalApproval,
  GoalManualConfirmation,
  GoalPlan,
  GoalPlanStatus,
  AutomationBootstrapResult,
  AutomationCreateContext,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationEvent,
  AutomationProposalAction,
  AutomationProposalActionResult,
  AutomationRun,
  AutomationRunListInput,
  AutomationRunNowInput,
  AutomationSummary,
  AutomationUpdateInput,
  LlmModelListResult,
  LlmModelFetchRequest,
  LlmModelInfo,
  LlmChannelDescriptor,
  LlmServiceTemplateDescriptor,
  LlmProviderConfigView,
  LlmProviderTestResult, LlmSubscriptionQuota,
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
  SkillDetail,
  SkillSummary,
  AvailableSkillSummary,
  SkillLinkResult,
  SkillMarketplaceCatalog,
  SkillMarketplaceEntry,
  SkillMarketplaceInstallResult,
  SkillHubInstallRequest,
  SkillHubMarketplacePage,
  SkillHubMarketplaceQuery,
  SkillHubSyncStatus,
  TaskOverviewItem,
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

export type BrowserSessionImportPreflightCheck = {
  readonly id: string;
  readonly status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly action?: 'open_full_disk_access' | 'install_browser' | 'none';
  readonly path?: string;
};

export type BrowserSessionImportPreflight = {
  readonly ok: boolean;
  readonly ready?: boolean;
  readonly blocked?: boolean;
  readonly checks: readonly BrowserSessionImportPreflightCheck[];
  readonly openFullDiskAccessSupported?: boolean;
  readonly guidance?: { readonly fullDiskAccess?: string };
  readonly error?: string;
  readonly dragTarget?: {
    readonly ok: boolean;
    readonly appPath?: string;
    readonly displayName?: string;
    readonly kind?: string;
    readonly isPackagedApp?: boolean;
    readonly iconDataUrl?: string | null;
    readonly error?: string;
  };
};

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
        | { readonly type: 'thinking'; readonly content?: string; readonly kind?: 'summary' | 'reasoning' }
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
  /** Per-model split of the lifetime totals, keyed by modelProviderId (ADR 23 byModel). */
  readonly byModel?: Readonly<Record<string, LifetimeModelUsage>>;
}

/** One model slice inside LifetimeUsage.byModel (conversation ledger). */
export interface LifetimeModelUsage {
  readonly modelProviderId: string;
  readonly model?: string;
  readonly providerName?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedCostUsd: number;
  readonly requestCount: number;
}

/** 跨会话用量汇总（精简使用统计页，对应 main `usage:stats`）。 */
export interface UsageStatsTokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

export interface UsageStatsGroupRow extends UsageStatsTokenTotals {
  readonly key: string;
  readonly label: string;
  readonly providerId?: string | null;
  readonly providerName?: string;
  readonly model?: string;
  readonly conversationCount: number;
  readonly estimatedCostUsd: number | null;
  readonly hasPricing: boolean;
}

export interface UsageStatsSnapshot {
  readonly generatedAt: string;
  readonly totals: UsageStatsTokenTotals & {
    readonly conversationCount: number;
    readonly pricedConversationCount: number;
    readonly estimatedCostUsd: number | null;
  };
  readonly byProvider: readonly UsageStatsGroupRow[];
  readonly byModel: readonly UsageStatsGroupRow[];
  readonly notes: {
    readonly unpricedConversationCount: number;
    readonly missingProviderCount: number;
    readonly pricingUnit: string;
    readonly scope: string;
  };
}

/** 请求日志按天聚合（Token 热力图 / 趋势，对应 main `usage:daily`）。 */
export type UsageDailyRange = '7d' | '1m' | '3m' | '6m' | '1y';

export interface UsageDailyDay {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly requestCount: number;
  readonly estimatedCostUsd: number | null;
}

export interface UsageDailySnapshot {
  readonly range: UsageDailyRange;
  readonly startDate: string;
  readonly endDate: string;
  readonly source: string;
  readonly days: readonly UsageDailyDay[];
  readonly totals: {
    readonly totalTokens: number;
    readonly requestCount: number;
    readonly pricedRequestCount: number;
    readonly estimatedCostUsd: number | null;
    readonly maxTokens: number;
    readonly dayCount: number;
    readonly activeDayCount: number;
  };
  readonly notes: {
    readonly emptyLog: boolean;
    readonly scope: string;
  };
}

/** 请求日志按天详情（点击热力图/日条某一天后的下钻，对应 main `usage:day`）。 */
export interface UsageDayModelRow {
  readonly key: string;
  readonly label: string;
  readonly modelProviderId: string | null;
  readonly providerName: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly requestCount: number;
  readonly estimatedCostUsd: number | null;
}

export interface UsageDayHourBucket {
  readonly hour: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly requestCount: number;
}

export interface UsageDaySnapshot {
  readonly date: string | null;
  readonly source: string;
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
    readonly requestCount: number;
    readonly pricedRequestCount: number;
    readonly estimatedCostUsd: number | null;
    readonly modelCount: number;
    readonly activeHourCount: number;
    readonly maxHourTokens: number;
  };
  readonly byModel: readonly UsageDayModelRow[];
  readonly hours: readonly UsageDayHourBucket[];
  readonly notes: {
    readonly emptyDay: boolean;
    readonly scope: string;
  };
}

/**
 * ADR 27: 活跃流投影(带工作区维度)。
 * - conversationId:正在运行的会话 id。
 * - workspacePath / originWorkspacePath:会话发起工作区(origin 快照,切换工作区不改变);
 *   Goal target / execution workspace 不进入此投影,避免绿点打到代码仓而非知识库。
 *   无工作区上下文时为 null。
 * 让 renderer 能派生"哪些工作区有运行中的流",使跨工作区运行可见而非静默丢失。
 */
export interface ActiveStreamProjection {
  readonly conversationId: string;
  readonly streamId: string;
  readonly workspacePath: string | null;
  readonly originWorkspacePath?: string | null;
}

export type QuickChatPopoverKind = 'workspace' | 'model' | 'effort' | 'mode' | 'access';

export interface QuickChatPopoverItem {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  /** Optional menu group title (e.g. model provider name → submenu). */
  readonly group?: string;
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
  /**
   * 用系统默认方式打开指定文件/目录（点击聊天消息中的文件路径时调用）。
   * - absPath 必须是绝对路径；相对路径需调用方先基于 workspacePath 解析。
   * - 可选 workspaceRoot 用于越界校验：目标必须位于该根目录内。
   * - 主进程优先 shell.openPath，失败回退 showItemInFolder。
   */
  readonly openPath: (
    absPath: string,
    workspaceRoot?: string,
    options?: {
      /** 'self'（默认）打开 absPath 本身；'parent' 打开其所在目录。 */
      readonly target?: 'self' | 'parent';
      /** 'auto'（默认）系统默认程序；'editor' 指定编辑器；'reveal' 在文件管理器中定位。 */
      readonly mode?: 'auto' | 'editor' | 'reveal';
      /** mode='editor' 时生效；省略则由主进程用记住的默认编辑器。 */
      readonly editorId?: string;
    },
  ) => Promise<{
    readonly ok: boolean;
    readonly fallback?: string;
    readonly reason?: string;
    readonly message?: string;
    readonly kind?: 'file' | 'directory';
    readonly mode?: 'editor' | 'reveal';
    readonly editorId?: string;
    readonly path?: string;
  }>;
  /**
   * 本机可用的编辑器候选 + 当前生效的默认值。
   * - defaultEditorId 一定是 editors 中真实存在的项；若记住的编辑器已被卸载则回退候选首项。
   * - stale=true 表示此前记住的 stored 已不可用，UI 可据此提示。
   */
  readonly listEditors: () => Promise<{
    readonly editors: readonly {
      readonly id: string;
      readonly name: string;
      readonly bundleId?: string | null;
      /** 本机 App 真实图标（data URL）；读失败为 null，UI 不得用字符冒充。 */
      readonly iconDataUrl?: string | null;
    }[];
    readonly defaultEditorId: string | null;
    readonly stored: string | null;
    readonly stale: boolean;
  }>;
  /** 记住默认编辑器；只接受本机真实可用的 editorId。 */
  readonly setDefaultEditor: (
    editorId: string,
  ) => Promise<{ readonly ok: boolean; readonly editorId?: string; readonly reason?: string }>;
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
  readonly gitDiffRange: (params: {
    readonly workspaceRoot: string;
    readonly fromRef: string;
    readonly toRef?: string;
  }) => Promise<{
    readonly ok: boolean;
    readonly status: 'ok' | 'no_changes' | 'not_git_repo' | 'invalid_ref' | 'error';
    readonly diffText: string;
    readonly error?: string;
    readonly fromRef?: string;
    readonly toRef?: string | null;
  }>;
  readonly gitListBranches: (params: {
    readonly workspaceRoot: string;
  }) => Promise<{
    readonly ok: boolean;
    readonly branches: readonly string[];
    readonly current: string | null;
    readonly repoRoot?: string;
    readonly error?: string;
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
   * 按需读取本地图片为 dataUrl，供聊天气泡缩略图/放大预览。
   * ADR 59：会话存储不内联整图；仅在用户可见预览时临时加载。
   */
  readonly readImageDataUrl: (
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
      | 'unsupported_type'
      | 'invalid_path'
      | 'error';
    readonly dataUrl: string;
    readonly mimeType?: string;
    readonly size?: number;
    readonly path?: string;
    readonly resolvedFrom?: string;
    readonly error?: string;
  }>;
  /**
   * 在已存在父目录下新建文件。默认写空内容；不覆盖已有文件。
   * status：ok / already_exists / not_found / not_dir / invalid_path / error。
   */
  readonly writeFile: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
    content?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly status:
      | 'ok'
      | 'already_exists'
      | 'not_found'
      | 'not_dir'
      | 'invalid_path'
      | 'error';
    readonly path?: string;
    readonly resolvedFrom?: string;
    readonly error?: string;
  }>;
  /**
   * 在已存在父目录下新建文件夹。不覆盖已有路径。
   * status：ok / already_exists / not_found / not_dir / invalid_path / error。
   */
  readonly mkdir: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly status:
      | 'ok'
      | 'already_exists'
      | 'not_found'
      | 'not_dir'
      | 'invalid_path'
      | 'error';
    readonly path?: string;
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
   * Composer @ 菜单用的工作区文件搜索：只扫当前 workspace，尊重忽略目录，
   * 返回相对路径，不读文件内容。
   */
  readonly searchWorkspaceFiles?: (
    workspacePath: string,
    query?: string,
    limit?: number,
  ) => Promise<{
    readonly ok: boolean;
    readonly status: 'ok' | 'not_found' | 'not_dir' | 'invalid_path' | 'error';
    readonly files: readonly {
      readonly relPath: string;
      readonly name: string;
      readonly kind: 'file' | 'directory';
    }[];
    readonly workspacePath?: string;
    readonly error?: string;
  }>;
  /**
   * 同步文件树轻量监听目录集合（根 + 已展开）。传空数组清空。
   * main 侧按 webContents 维护 fs.watch，不递归整仓。
   */
  readonly watchDirs: (
    paths: readonly string[],
    workspaceRoot?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly watching?: readonly string[];
  }>;
  /** 订阅目录变更；返回 unsubscribe。payload: { dirPath } */
  readonly onFsDirChanged: (
    callback: (payload: { readonly dirPath?: string }) => void,
  ) => () => void;
  /**
   * 内嵌浏览器控制句柄注册 —— 见 ADR 40 / 46。
   * renderer 同时上报 conversationId + browserTabId；main 按会话解析活跃网页标签，
   * 供 Agent 的 browser_* 工具经 webContents.fromId 精确操控。
   */
  readonly registerBrowserWebContents: (registration: {
    readonly webContentsId: number;
    readonly conversationId: string | null;
    readonly browserTabId: string;
    readonly active: boolean;
    readonly claimForeground?: boolean;
    readonly url?: string;
    readonly title?: string;
  }) => Promise<{
    readonly ok: boolean;
    readonly webContentsId?: number;
    readonly conversationId?: string | null;
    readonly browserTabId?: string;
    readonly error?: string;
  }>;
  readonly onBrowserPanelRevealRequest: (listener: (request: {
    readonly requestId: string;
    readonly conversationId: string;
    readonly focus: boolean;
    readonly sessionPolicy: 'reuse-or-create';
  }) => void) => () => void;
  readonly acknowledgeBrowserPanelReveal: (payload: {
    readonly requestId: string;
    readonly conversationId: string;
    readonly ok: boolean;
    readonly status?: 'opened' | 'activated' | 'already_active';
    readonly sessionId?: string;
    readonly focused?: boolean;
    readonly error?: string;
  }) => Promise<boolean>;
  readonly unregisterBrowserWebContents: (registration: {
    readonly webContentsId: number;
    readonly conversationId: string | null;
    readonly browserTabId: string;
  }) => Promise<{ readonly ok: boolean; readonly cleared: boolean }>;
  /** 清除 peer-browser 分区中当前 origin 的站点数据（不含密码库）。 */
  readonly clearBrowserSiteData: (url: string) => Promise<{
    readonly ok: boolean;
    readonly origin?: string;
    readonly error?: string;
  }>;
  /** 截取指定 webContents 页面为 PNG 并保存；savePath 可选。 */
  readonly captureBrowserPage: (
    webContentsId: number,
    savePath?: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly path?: string;
    readonly bytes?: number;
    readonly error?: string;
  }>;
  /** 列出可导入会话的浏览器 Profile（无 Cookie value）。 */
  readonly listBrowserSessionSources: () => Promise<{
    readonly ok: boolean;
    readonly sources?: readonly {
      readonly adapterId: string;
      readonly browserName: string;
      readonly bundleId: string;
      readonly profiles: readonly {
        readonly profileId: string;
        readonly displayName: string;
        readonly directory: string;
        readonly hasCookieDb: boolean;
      }[];
    }[];
    readonly error?: string;
    readonly preflight?: BrowserSessionImportPreflight;
  }>;
  /** 导入前权限/环境自检清单。 */
  
  /**
   * Agent 启动必需权限快照（macOS Full Disk Access 等）。
   * 与站点会话导入 preflight 解耦，不绑死 Chrome。
   */
  readonly getStartupOsPermissions: () => Promise<{
    readonly ok: boolean;
    readonly blocked?: boolean;
    readonly platform?: string;
    readonly checks?: readonly {
      readonly id: string;
      readonly status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info';
      readonly title: string;
      readonly detail: string;
      readonly action?: 'open_full_disk_access' | 'none';
      readonly path?: string;
    }[];
    readonly required?: readonly {
      readonly id: string;
      readonly status: string;
      readonly title: string;
      readonly detail: string;
      readonly action?: string;
      readonly path?: string;
    }[];
    readonly openFullDiskAccessSupported?: boolean;
    readonly guidance?: { readonly fullDiskAccess?: string };
    readonly error?: string;
    readonly dragTarget?: {
      readonly ok: boolean;
      readonly appPath?: string;
      readonly displayName?: string;
      readonly kind?: string;
      readonly isPackagedApp?: boolean;
      readonly iconDataUrl?: string | null;
      readonly error?: string;
    };
  }>;
  readonly getBrowserSessionImportPreflight: () => Promise<BrowserSessionImportPreflight>;
  /** 打开 macOS 完全磁盘访问权限设置页，并弹出设置下方的拖拽浮窗。 */
  readonly openFullDiskAccessSettings: (payload?: {
    readonly isZh?: boolean;
  }) => Promise<{
    readonly ok: boolean;
    readonly url?: string;
    readonly error?: string;
    readonly dragFloat?: {
      readonly ok?: boolean;
      readonly appPath?: string;
      readonly displayName?: string;
      readonly error?: string;
    };
  }>;
  /** 获取可拖到“完全磁盘访问”列表的 App 路径与图标。 */
  readonly getAppDragTarget: () => Promise<{
    readonly ok: boolean;
    readonly appPath?: string;
    readonly displayName?: string;
    readonly kind?: string;
    readonly isPackagedApp?: boolean;
    readonly iconDataUrl?: string | null;
    readonly error?: string;
  }>;
  /**
   * 开始拖拽 App 到系统设置。
   * 必须在 dragstart 中同步调用（底层 ipc send + startDrag）。
   */
  readonly hideFdaDragFloat?: () => { readonly ok?: boolean; readonly error?: string };
  readonly startAppDrag: (payload?: { readonly appPath?: string }) => void;
  /** 扫描 Profile 站点聚合（无 Cookie value）。 */
  readonly listBrowserSessionSites: (profileId: string) => Promise<{
    readonly ok: boolean;
    readonly profileId?: string;
    readonly browserName?: string;
    readonly displayName?: string;
    readonly sites?: readonly {
      readonly registrableDomain: string;
      readonly cookieCount: number;
      readonly hostCount: number;
      readonly hosts: readonly string[];
    }[];
    readonly totalCookies?: number;
    readonly error?: string;
  }>;
  /** 导入选定站点 Cookie（不含密码）到 peer-browser 分区。 */
  readonly importBrowserSiteSession: (payload: {
    readonly profileId: string;
    readonly registrableDomains: readonly string[];
    readonly includeSubdomains?: boolean;
  }) => Promise<{
    readonly ok: boolean;
    readonly status?: string;
    readonly added?: number;
    readonly failed?: number;
    readonly stats?: Record<string, unknown>;
    readonly error?: string;
  }>;
  /** Password manager：列表仅 meta。 */
  readonly listPasswordVaultEntries: (origin?: string) => Promise<{
    readonly ok: boolean;
    readonly entries?: readonly {
      readonly id: string;
      readonly origin: string;
      readonly username: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly lastUsedAt?: string;
    }[];
    readonly error?: string;
  }>;
  readonly upsertPasswordVaultEntry: (payload: {
    readonly id?: string;
    readonly origin: string;
    readonly username: string;
    readonly password: string;
  }) => Promise<{
    readonly ok: boolean;
    readonly entry?: {
      readonly id: string;
      readonly origin: string;
      readonly username: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    };
    readonly error?: string;
  }>;
  readonly deletePasswordVaultEntry: (id: string) => Promise<{
    readonly ok: boolean;
    readonly error?: string;
  }>;
  readonly revealPasswordVaultEntry: (id: string) => Promise<{
    readonly ok: boolean;
    readonly id?: string;
    readonly origin?: string;
    readonly username?: string;
    readonly password?: string;
    readonly error?: string;
  }>;
  readonly fillPasswordVaultEntry: (payload: {
    readonly id: string;
    readonly webContentsId: number;
    readonly fillUsername?: boolean;
  }) => Promise<{
    readonly ok: boolean;
    readonly filledUsername?: boolean;
    readonly error?: string;
  }>;
  readonly listShellTasks: () => Promise<readonly Record<string, unknown>[]>;
  readonly stopActiveShellTask: () => Promise<Record<string, unknown>>;
  readonly stopShellTask: (taskId: string) => Promise<Record<string, unknown>>;
  readonly listShellPermissionRules: () => Promise<readonly Record<string, unknown>[]>;
  readonly addShellPermissionRule: (rule: Record<string, unknown>) => Promise<readonly Record<string, unknown>[]>;
  readonly listSkills: () => Promise<readonly SkillSummary[]>;
  readonly getSkillDetail: (skillId: string) => Promise<SkillDetail | null>;
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
  /**
   * 卸载用户安装的 Skill：
   * - userData/skills 实装目录：删除
   * - 借用软链：仅取消链接
   * - workspace Skill：拒绝删除源文件
   */
  readonly uninstallSkill: (skillId: string) => Promise<SkillLinkResult>;
  readonly listMarketplaceSkills: () => Promise<SkillMarketplaceCatalog>;
  readonly getMarketplaceSkillDetail: (catalogId: string) => Promise<SkillMarketplaceEntry | null>;
  readonly installMarketplaceSkill: (catalogId: string) => Promise<SkillMarketplaceInstallResult>;
  readonly querySkillHubSkills: (query?: SkillHubMarketplaceQuery) => Promise<SkillHubMarketplacePage>;
  readonly getSkillHubSkillDetail: (identity: Omit<SkillHubInstallRequest, 'version'>) => Promise<Record<string, unknown>>;
  readonly getSkillHubSyncStatus: () => Promise<SkillHubSyncStatus>;
  readonly syncSkillHubSkills: (options?: { readonly maxPages?: number }) => Promise<SkillHubSyncStatus>;
  readonly installSkillHubSkill: (identity: SkillHubInstallRequest) => Promise<SkillMarketplaceInstallResult>;
  readonly listSkillHubCategories: () => Promise<readonly import('@peer-agent/protocol').SkillHubCategory[]>;
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
  readonly workspaceList: () => Promise<{
    workspaces: readonly {
      path: string;
      name: string;
      addedAt: string;
      linkedFolders?: readonly { path: string; name: string }[];
      baseBranch?: string;
    }[];
    activeWorkspace: string | null;
  }>;
  readonly quickChatHide: () => Promise<{ ok: true }>;
  readonly quickChatSetTaskCardVisible: (visible: boolean) => Promise<{ ok: boolean }>;
  readonly quickChatSetContentHeight: (height: number) => Promise<{ ok: boolean; height: number }>;
  readonly quickChatShowPopover: (payload: QuickChatPopoverState & { anchorRect: QuickChatPopoverAnchorRect }) => Promise<{ ok: boolean }>;
  readonly quickChatHidePopover: () => Promise<{ ok: true }>;
  readonly quickChatSelectPopoverValue: (value: string) => Promise<{ ok: boolean }>;
  readonly quickChatSubmit: (params: { conversationId: string; workspacePath: string; openMainWindow: boolean; streamId: string }) => Promise<{ ok: true }>;
  readonly onQuickChatShown: (listener: () => void) => () => void;
  readonly onQuickChatPopoverState: (listener: (payload: QuickChatPopoverState) => void) => () => void;
  readonly onQuickChatPopoverSelected: (listener: (payload: { kind: QuickChatPopoverKind; value: string }) => void) => () => void;
  readonly onQuickChatPopoverClosed: (listener: () => void) => () => void;
  readonly workspaceEnsureDefault: () => Promise<{ path: string; name: string; created: boolean }>;
  readonly workspacePreviewDefault: () => Promise<{ path: string; name: string; exists: boolean }>;
  readonly workspaceAdd: () => Promise<{ path: string; name: string; existing: boolean } | null>;
  readonly workspaceSetActive: (params: { path: string | null }) => Promise<{ activeWorkspace: string | null }>;
  readonly workspaceRemove: (params: { path: string }) => Promise<unknown>;
  readonly workspaceUpdate: (params: {
    path: string;
    name?: string;
    linkedFolders?: readonly { path: string; name?: string }[];
    baseBranch?: string | null;
  }) => Promise<{ ok: boolean; reason?: string; workspace?: unknown }>;
  readonly workspaceAddLinkedFolder: (params: { path: string }) => Promise<{
    ok: boolean;
    reason?: string;
    existing?: boolean;
    workspace?: unknown;
    path?: string;
    name?: string;
  }>;
  readonly workspaceRemoveLinkedFolder: (params: {
    path: string;
    folderPath: string;
  }) => Promise<{ ok: boolean; reason?: string; workspace?: unknown }>;
  readonly workspaceSetPrimary: (params: {
    path: string;
    folderPath: string;
  }) => Promise<{ ok: boolean; reason?: string; workspace?: unknown }>;
  readonly workspaceInfo: (params: { path: string }) => Promise<{ name: string; absolutePath: string; git?: { branch?: string; isDirty?: boolean } } | null>;
  readonly usageGetStats: () => Promise<UsageStatsSnapshot>;
  readonly usageGetDaily: (params?: { range?: UsageDailyRange }) => Promise<UsageDailySnapshot>;
  readonly usageGetDay: (params: { date: string }) => Promise<UsageDaySnapshot>;
  readonly conversationsList: (params?: {
    workspacePath?: string | null;
    status?: 'active' | 'archived' | readonly ('active' | 'archived')[];
    limit?: number;
    cursor?: string | null;
    paginated?: boolean;
    includeMessageCount?: boolean;
  }) => Promise<
    | readonly { id: string; title: string; workspacePath?: string | null; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messageCount: number; createdAt: string; updatedAt: string }[]
    | { items: readonly { id: string; title: string; workspacePath?: string | null; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messageCount: number; createdAt: string; updatedAt: string }[]; nextCursor: string | null; hasMore: boolean; total: number }
  >;
    readonly conversationsSearch: (params?: {
    query?: string;
    status?: 'active' | 'archived' | readonly ('active' | 'archived')[];
    workspacePath?: string | null;
    limit?: number;
    includeWorkspaceNameMatch?: boolean;
  }) => Promise<readonly {
    id: string;
    title: string;
    workspacePath?: string | null;
    mode?: string;
    effort?: string;
    modelProviderId?: string | null;
    status?: 'active' | 'archived';
    archivedAt?: string | null;
    pinnedAt?: string | null;
    pinnedOrder?: number | null;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    lifetimeUsage?: unknown;
  }[]>;
readonly conversationsCreate: (params?: { title?: string; workspacePath?: string | null; mode?: string }) => Promise<{ id: string; title: string; mode?: string; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messageCount: number; createdAt: string; updatedAt: string }>;
  readonly conversationsGet: (params: { id: string }) => Promise<{ id: string; title: string; mode?: string; fastMode?: boolean; effort?: string; modelProviderId?: string | null; status?: 'active' | 'archived'; archivedAt?: string | null; pinnedAt?: string | null; pinnedOrder?: number | null; messages: readonly Record<string, unknown>[]; createdAt: string; updatedAt: string; lifetimeUsage?: LifetimeUsage; contextSnapshot?: ContextAccountingSnapshot | null; automationCreateContext?: AutomationCreateContext | null } | null>;
  readonly onConversationsChanged: (listener: (event: { conversationId: string; workspacePath: string | null; changeType: 'created' | 'messages-updated' | 'metadata-updated' | 'deleted'; revision: string; writerPid: number; changedAt: string }) => void) => () => void;
  readonly onWorkspacesChanged: (listener: (event: { workspacePath: string }) => void) => () => void;
  readonly conversationsUpdateTitle: (params: { id: string; title: string }) => Promise<unknown>;
  // 对话模式按会话持久化在会话 meta 上（chat / goal）。模式真值仍经 chatSend / IPC
  // 进入 mode-source，再写入 System Context 的 L6_MODE_REMINDER；此处仅负责「每会话存哪」。
  readonly conversationsUpdateMode: (params: { id: string; mode: string }) => Promise<unknown>;
  readonly conversationsUpdateFastMode: (params: { id: string; fastMode: boolean }) => Promise<unknown>;
  // 会话级模型 + 思考模式绑定（随会话持久化，同 mode 范式）。effort/modelProviderId
  // 各自独立写入：用户可只切模型不切思考档，或反之。modelProviderId 为 null 表示回退
  // 到全局默认 provider。provider 被删/失效时由发送层 orderProviderCandidates 自动回退。
  readonly conversationsUpdateModelEffort: (params: { id: string; effort?: string; modelProviderId?: string | null }) => Promise<unknown>;
  readonly conversationsAppendMessage: (params: { id: string; message: Record<string, unknown> & { id: string; role: string; content: string } }) => Promise<unknown>;
  readonly conversationsUpdateLastMessage: (params: { id: string; content: string }) => Promise<unknown>;
  readonly conversationsReplaceMessages: (params: { id: string; messages: readonly Record<string, unknown>[]; allowEmpty?: boolean }) => Promise<unknown>;
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
  readonly automationsBootstrap: () => Promise<AutomationBootstrapResult>;
  readonly automationsList: (params?: { workspacePath?: string; statuses?: string[]; query?: string }) => Promise<readonly AutomationSummary[]>;
  readonly automationsGet: (params: { automationId: string }) => Promise<AutomationDefinition | null>;
  readonly automationsCreate: (params: AutomationCreateInput) => Promise<AutomationDefinition>;
  readonly automationsUpdate: (params: AutomationUpdateInput) => Promise<AutomationDefinition>;
  readonly automationRunsList: (params: AutomationRunListInput) => Promise<readonly AutomationRun[]>;
  readonly automationRunsGet: (params: { runId: string }) => Promise<AutomationRun | null>;
  readonly automationsRunNow: (params: AutomationRunNowInput) => Promise<AutomationRun>;
  readonly automationRunsRetry: (params: { runId: string }) => Promise<AutomationRun>;
  readonly automationRunsCancel: (params: { runId: string }) => Promise<AutomationRun>;
  readonly automationsSetRuntimePaused: (params: { paused: boolean }) => Promise<AutomationBootstrapResult['runtime']>;
  readonly automationProposalAct: (params: {
    conversationId: string;
    proposalId: string;
    fingerprint: string;
    action: AutomationProposalAction;
  }) => Promise<AutomationProposalActionResult>;
  readonly onAutomationsChanged: (listener: (event: AutomationEvent) => void) => () => void;
  readonly onAutomationOpenRun: (listener: (event: { automationId: string; runId: string; conversationId?: number | null }) => void) => () => void;
  // Goal 模式计划（见 Goal 模式设计）。
  // 完成状态由 Evidence 自底向上聚合，渲染层只读展示 + 治理操作（批准/驳回/修订），不可手填进度。
  readonly goalPlansList: (params?: { conversationId?: string }) => Promise<readonly GoalPlan[]>;
  readonly taskOverviewList: (params?: {
    workspacePath?: string | null;
    conversationId?: string;
    includeTerminal?: boolean;
    activeWithinMs?: number;
    limit?: number;
  }) => Promise<readonly TaskOverviewItem[]>;
  readonly taskOverviewMarkRead: (params: {
    conversationIds: readonly string[];
  }) => Promise<{ markedCount: number }>;
  readonly goalPlansAwaitingCounts: () => Promise<Record<string, number>>;
  readonly goalPlansGet: (params: { planId: string }) => Promise<GoalPlan | null>;
  readonly goalPlansCreate: (params: { draft: Partial<GoalPlan> }) => Promise<GoalPlan>;
  readonly goalPlansRevise: (params: {
    planId: string;
    patch: Partial<GoalPlan>;
    reason: string;
    changedBy?: string;
  }) => Promise<GoalPlan>;
  readonly goalPlansRetryHandoff: (params: { planId: string }) => Promise<GoalPlan | null>;
  readonly goalPlansApprove: (params: { planId: string; approval: GoalApproval }) => Promise<GoalPlan>;
  readonly goalPlansSetStatus: (params: { planId: string; status: GoalPlanStatus }) => Promise<GoalPlan>;
  /**
   * 待验收点「继续讨论」：验收未通过，重开同一 plan（completed → executing + waiting_user）。
   */
  readonly goalPlansMarkRequestedUserInput: (params: {
    planId: string;
    runnerPatch?: Record<string, unknown>;
  }) => Promise<GoalPlan | null>;
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
  // conversationId / changeKind 用于会话域过滤与分级刷新（runner-progress 可本地 patch）。
  readonly onGoalPlansChanged: (
    listener: (payload: {
      reason: string;
      planId: string | null;
      conversationId?: string | null;
      changeKind?: string | null;
      /** runner-progress 时附带最新 runner，便于 UI 本地 patch */
      runner?: GoalPlan['runner'] | null;
    }) => void,
  ) => () => void;
  readonly onTaskOverviewChanged: (
    listener: (payload: { reason?: string }) => void,
  ) => () => void;
  readonly onGoalRunnerChanged: (
    listener: (payload: {
      type?: string;
      planId?: string | null;
      conversationId?: string | null;
      changeKind?: string | null;
      runner?: GoalPlan['runner'] | null;
      [key: string]: unknown;
    }) => void,
  ) => () => void;
  readonly chatSend: (params: ChatSendRequest) => Promise<void>;
  readonly chatStartTask: (params: ChatStartTaskRequest) => Promise<ChatStartTaskResult>;
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
  // 按会话查询当前压缩态（切会话恢复横幅用）。压缩态真值在主进程登记表，渲染层只表达。
  // running: compacting=true; failed: compacting=false + phase='failed' with explainable detail.
  readonly chatCompactionGet: (params: { conversationId: string }) => Promise<
    | {
        compacting: true;
        streamId: string;
        percent: number | null;
        manual: boolean;
      }
    | {
        compacting: false;
        phase: 'failed';
        streamId: string;
        manual?: boolean;
        errorCode?: string;
        message?: string;
        failedAt?: number;
        budget?: Record<string, unknown> | null;
      }
    | null
  >;
  // restored 重投影(21 号文档 13.3):快照缺失/跨宿主时由 Runtime 按完整成分重算占用并回写共享快照。
  readonly chatContextRestored?: (params: {
    conversationId: string;
    modelProviderId?: string | null;
  }) => Promise<ContextAccountingSnapshot | null>;
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
  readonly onChatStreamThinking: (listener: (payload: {
    streamId: string;
    content: string;
    /** OpenAI Responses: summary vs reasoning_text; omit for legacy/unknown. */
    kind?: 'summary' | 'reasoning';
  }) => void) => () => void;
  readonly onChatStreamDone: (listener: (payload: {
    streamId: string;
    conversationId?: string;
    reason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number };
    lifetimeUsage?: LifetimeUsage;
    contextAccounting?: ContextAccountingSnapshot;
  }) => void) => () => void;
  readonly onChatStreamAborted: (listener: (payload: { streamId: string; conversationId?: string }) => void) => () => void;
  readonly onChatStreamUsage: (listener: (payload: { streamId: string; usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number } }) => void) => () => void;
  readonly onChatStreamToolCall: (listener: (payload: { streamId: string; tool: string; displayName?: string | null; args: Record<string, unknown>; toolCallId: string; startedAtMs?: number }) => void) => () => void;
  // 流式工具参数进度(Codex 式实时体感)。仅是 provider 流式提示,不替代 Tool Result / Evidence。
  readonly onChatStreamToolProgress: (listener: (payload: { streamId: string; toolCallId: string; tool: string; path: string | null; receivedChars: number; receivedLines: number }) => void) => () => void;
  readonly onChatStreamToolResult: (listener: (payload: { streamId: string; toolCallId: string; result: string; startedAtMs?: number; endedAtMs?: number; durationMs?: number }) => void) => () => void;
  readonly onChatStreamPermissionRequest: (listener: (payload: { streamId: string; call: ClientToolCall }) => void) => () => void;
  readonly onChatStreamError: (listener: (payload: {
    streamId: string;
    conversationId?: string;
    error: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number };
    lifetimeUsage?: LifetimeUsage;
  }) => void) => () => void;
  /** 弱提示（如非 vision 模型剥离图片），不中断发送。 */
  readonly onChatStreamNotice: (listener: (payload: {
    streamId: string;
    code?: string;
    message?: string;
    imageCount?: number;
  }) => void) => () => void;
  readonly onChatStreamProviderRecovery: (listener: (payload: {
    streamId: string;
    conversationId: string;
    fromProviderId?: string;
    fromProvider?: string;
    toProviderId?: string;
    toProvider?: string;
    reason?: string;
    attempt?: number;
  }) => void) => () => void;
  readonly onChatStreamConnectionRecovery: (listener: (payload: {
    streamId: string;
    conversationId: string;
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
  readonly onChatCompaction: (listener: (payload: {
    conversationId: string;
    streamId: string;
    stage?: 'start' | 'progress' | 'done' | 'failed' | 'idle';
    percent?: number;
    receivedChars?: number;
    estimatedTotalChars?: number;
    progressStage?: 'preparing' | 'summarizing' | 'retrying' | 'fallback';
    attempt?: number;
    maxAttempts?: number;
    inputTokenBudget?: number;
    method?: string;
    beforeTokens?: number;
    afterTokens?: number;
    oldMessageCount?: number;
    keptMessageCount?: number;
    microcompacted?: boolean;
    errorCode?: string;
    message?: string;
  }) => void) => () => void;
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
  /** 设置页渠道列表，包含没有模型的渠道连接。 */
  readonly llmListProviderGroups: () => Promise<readonly LlmProviderConfigView[]>;
  readonly llmListProviders: () => Promise<readonly LlmProviderConfigView[]>;
  /**
   * 旧聊天列表 IPC 的兼容别名。与 llmListProviders 一样只返回已配置模型，
   * 不再把远程或本机目录虚拟展开进表达层。
   */
  readonly llmListChatProviders: () => Promise<readonly LlmProviderConfigView[]>;
  readonly llmListChannels: () => Promise<readonly LlmChannelDescriptor[]>;
  readonly llmListServiceTemplates: () => Promise<readonly LlmServiceTemplateDescriptor[]>;
  readonly llmAddProvider: (config: Record<string, unknown>) => Promise<LlmProviderConfigView>;
  readonly llmUpdateProvider: (params: { id: string; [key: string]: unknown }) => Promise<LlmProviderConfigView>;
  // 复制一个已有 provider（订阅类型不支持），返回复制后的完整列表。
  readonly llmDuplicateProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmDuplicateModel: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  // B-2 在已有 provider 组内新增一个模型：凭证继承自组内首条，无需重填 apiKey。返回完整列表。
  readonly llmAddModel: (params: { groupId: string; [key: string]: unknown }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmRemoveProvider: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  // B-2 删除整个 provider 组（同 groupId 的全部模型）。返回删除后的完整列表。
  readonly llmRemoveGroup: (params: { groupId: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmSetDefault: (params: { id: string }) => Promise<readonly LlmProviderConfigView[]>;
  readonly llmTestConnection: (params: { id: string }) => Promise<LlmProviderTestResult>;
  readonly llmComplete: (params: { id: string; prompt: string; maxTokens?: number }) => Promise<{
    readonly success: boolean;
    readonly text?: string;
    readonly error?: string;
    readonly model?: string;
    readonly providerId?: string;
    readonly latencyMs?: number;
  }>;
  readonly llmGetSubscriptionQuota: (params: { id: string; force?: boolean }) => Promise<LlmSubscriptionQuota>;
  // ADR 28: 启动 ChatGPT 订阅 OAuth 登录(browser 模式)。
  // 链路契约:"先登录、成功后才落盘"。
  // - { id }   : 对已存在的订阅 provider 重新登录(刷新 token)。
  // - { draft }: 新建订阅。登录成功后才创建 provider;失败/取消不写入任何配置。
  // 成功返回更新/新建后的脱敏视图。
  readonly llmOAuthStart: (
    params: { id: string; draft?: undefined } | { id?: undefined; draft: Record<string, unknown> },
  ) => Promise<
    { success: true; provider: LlmProviderConfigView; models?: readonly LlmModelInfo[] | null } | { success: false; error: string }
  >;
  readonly llmOAuthOpenPending: () => Promise<{ success: boolean; error?: string }>;
  readonly llmOAuthCancel: () => Promise<{ success: boolean }>;
  readonly onLlmOAuthPending: (listener: (payload: {
    verificationUrl: string;
    userCode: string;
    expiresAt: string;
  }) => void) => () => void;
  readonly onLlmOAuthAuthorized: (listener: () => void) => () => void;
  /** 静默 OAuth 刷新完成且确有凭证被更新时触发；渲染层应增量刷新渠道列表。 */
  readonly onLlmOAuthRefreshed: (listener: (payload: {
    reason: string;
    refreshed: number;
  }) => void) => () => void;
  // ADR 28(方案 B): 列出订阅可用模型(远程拉取,失败回退内置清单)。
  readonly llmListModels: (params: { id: string }) => Promise<LlmModelListResult>;
  // 用表单临时配置(未落盘)直接拉模型,供"添加渠道"弹窗预览/多选。
  readonly llmFetchModels: (params: LlmModelFetchRequest) => Promise<LlmModelListResult>;
  readonly initialSettings: Record<string, unknown>;
  readonly getSettings: () => Promise<Record<string, unknown>>;
  readonly updateSettings: (partial: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly onAppearanceChanged: (listener: (appearance: unknown) => void) => () => void;
  readonly getShortcutStatus: () => Promise<{
    quickChat: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    newTask: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    appshot: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
  }>;
  readonly updateShortcut: (
    action: 'quickChat' | 'newTask' | 'appshot',
    accelerator: string,
  ) => Promise<{
    success?: boolean;
    error?: string | null;
    quickChat: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    newTask: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    appshot: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
  }>;
  readonly resetShortcut: (action?: 'quickChat' | 'newTask' | 'appshot') => Promise<{
    success?: boolean;
    error?: string | null;
    quickChat: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    newTask: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
    appshot: { configured: string; active: string | null; registered: boolean; error: string | null; isDefault: boolean };
  }>;
  // ── Appshots（P0a：ADR 59，用户手势捕获前台窗口）──
  readonly appshotCapture: () => Promise<{
    ok: boolean;
    code?: string;
    detail?: string;
    delivery?: { conversationId: string; created: boolean; messageId: string };
  }>;
  readonly appshotPermissionStatus: () => Promise<{
    ok: boolean;
    status: string;
    canCapture: boolean;
    hintKey: string;
  }>;
  readonly appshotOpenScreenSettings: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  readonly exportConfig: () => Promise<Record<string, unknown>>;
  readonly importConfig: () => Promise<Record<string, unknown>>;
  /** 打开应用关于页的白名单外链（源仓库 / 反馈 / 发布说明）。Renderer 只传 kind。 */
  readonly openProductLink: (kind: 'github' | 'feedback' | 'releaseNotes') => Promise<{
    readonly ok: boolean;
    readonly url?: string;
    readonly reason?: string;
  }>;
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
    planId?: string | null;
    messageId?: string | null;
    attentionVersion?: number | null;
    source?: string;
  }) => void) => () => void;
  /** 菜单栏托盘：New Chat。 */
  readonly onTrayNewChat: (listener: (payload?: { source?: string }) => void) => () => void;
  /** 菜单栏托盘：More → 聚焦主窗会话列表。 */
  readonly onTrayMore: (listener: (payload?: { source?: string }) => void) => () => void;
  /** 上报主窗口当前前台会话，供任务系统通知做同会话抑制。 */
  readonly setActiveConversation: (payload: {
    conversationId: string | null;
    planId?: string | null;
  }) => Promise<{ ok: boolean; conversationId: string | null }>;
  readonly onRuntimeEvent: (listener: (payload: RuntimeSdkEvent) => void) => () => void;
}
