export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_user';

export type HumanConfirmationDecision = 'approve' | 'reject' | 'revise';

export type HumanConfirmationTiming =
  | 'before_tool'
  | 'after_tool'
  | 'before_dispatch'
  | 'checkpoint';

export interface HumanConfirmationStep {
  readonly step?: number;
  readonly title?: string;
  readonly description?: string;
}

export interface PendingHumanConfirmation {
  readonly confirmationId: string;
  readonly executionUuid: string;
  readonly title?: string;
  readonly message?: string;
  readonly timing?: HumanConfirmationTiming;
  readonly step?: HumanConfirmationStep;
  readonly exposedContext?: Record<string, unknown>;
  readonly status?: 'pending';
}

export interface ResolvedHumanConfirmation {
  readonly confirmationId: string;
  readonly executionUuid: string;
  readonly decision: HumanConfirmationDecision;
  readonly feedback?: string;
  readonly resolvedAt: string;
  readonly status: 'resolved';
}

export interface MessageSender {
  readonly id: number;
  readonly name: string;
  readonly type: 'siliconEmployee' | 'agent';
  readonly depth: number;
  readonly orgRole?: string;
  readonly parentId?: number;
  readonly parentMessageUuid?: string;
  readonly dispatchSessionId?: string;
  readonly rootSessionId?: string;
  readonly description?: string;
}

export interface DispatchSubtask {
  readonly assigneeId: number;
  readonly name: string;
  readonly instruction: string;
  readonly orgRole?: string;
  readonly description?: string;
}

export interface PendingDispatch {
  readonly sessionId: string;
  readonly subtasks: readonly DispatchSubtask[];
  readonly reason?: string;
  readonly sender: MessageSender;
  readonly dispatcherName?: string;
}

export interface PendingDispatchResult {
  readonly pending: boolean;
  readonly sessionId?: string;
  readonly subtasks?: readonly DispatchSubtask[];
  readonly reason?: string;
  readonly sender?: MessageSender;
  readonly dispatcherName?: string;
}

export interface DispatchConfirmResult {
  readonly success: boolean;
  readonly note?: string;
  readonly [key: string]: unknown;
}

export interface ThinkingBlock {
  readonly iteration: number;
  readonly content: string;
  readonly toolCalls?: readonly {
    readonly toolId: string;
    readonly toolName: string;
    readonly status: 'running' | 'completed' | 'error';
  }[];
}

export interface SkillStep {
  readonly step: number;
  readonly title: string;
  readonly status: 'pending' | 'running' | 'completed' | 'error';
  readonly durationMs?: number;
  readonly thinkingBlocks?: readonly ThinkingBlock[];
  readonly outputSummary?: string;
  readonly outputData?: unknown;
  readonly collapsed?: boolean;
  readonly nestedSkills?: readonly NestedSkill[];
}

export interface NestedSkill {
  readonly skillId: string;
  readonly skillName: string;
  readonly runId?: string;
  readonly depth: number;
  readonly steps: readonly SkillStep[];
  readonly status: 'running' | 'completed' | 'error';
}

/**
 * Client local tool 调度生命周期阶段。
 *
 * 对应后端 cbu-xiaoer-node-service/src/service/aiChat/runtime/ClientToolEventTypes.ts
 * CLIENT_TOOL_EVENT_NAMES 的状态机投影：
 *   dispatching → acked → (waiting_user_consent →) running → (stdout/stderr) → result_received
 * result_received 落到 completed/failed/denied/timeout/cancelled 之一终态。
 */
export type ClientToolStatus =
  | 'dispatching'
  | 'acked'
  | 'waiting_user_consent'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'timeout'
  | 'cancelled';

export interface ToolCard {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly displayName: string;
  readonly status: 'running' | 'completed' | 'error' | 'warning';
  readonly inputArguments?: unknown;
  readonly inputArgumentsSource?: string;
  readonly inputArgumentsNote?: string;
  readonly executionUuid?: string;
  readonly durationMs?: number;
  readonly steps: readonly SkillStep[];
  readonly resultContent?: string;
  readonly resultSummary?: string;
  readonly errorCount?: number;
  readonly warningCount?: number;
  readonly collapsed?: boolean;
  /**
   * 仅当 tool card 对应 client local tool 时填充。能力 ID（如 local.shell.exec），
   * 作为稳定 key 给渲染层做工具名 i18n —— displayName 是后端注入的固定文案，
   * 不能直接翻译；按 capabilityId 映射才能跟界面 locale 一致。
   */
  readonly capabilityId?: string;
  /**
   * 仅当 tool card 对应 client local tool 时填充。表示后端 suspension 状态机
   * 的最新阶段；status 字段仍按 ToolCard 通用语义聚合给 UI 用。
   */
  readonly clientToolStatus?: ClientToolStatus;
  /** Client local tool 流式 stdout 累积；断线丢失不补，由 evidence 兜底。 */
  readonly stdout?: string;
  /** Client local tool 流式 stderr 累积；断线丢失不补，由 evidence 兜底。 */
  readonly stderr?: string;
}

export interface IterationNode {
  readonly iteration: number;
  readonly label?: string;
  readonly thinkingContent: string;
  readonly toolCards: readonly ToolCard[];
  readonly status: 'thinking' | 'tool_calling' | 'completed';
  /** 该轮所属 execution。与 iteration 组成复合 key，区分本地工具 pause-resume 后
   *  序号重置的不同 execution（防塌缩 + forwardByRun 重放幂等）。 */
  readonly executionUuid?: string;
}

export interface ThinkingProcess {
  readonly expanded: boolean;
  readonly iterations: readonly IterationNode[];
  readonly maxIterations: number;
  readonly toolCount: number;
  readonly totalDurationMs?: number;
  readonly totalIterations?: number;
  readonly totalToolCalls?: number;
  readonly loopDetected?: boolean;
  readonly estimatedDurationMs?: number;
  readonly processUuid?: string;
  readonly executionUuid?: string;
  readonly status: 'running' | 'completed' | 'error' | 'waiting' | 'waiting_user';
  readonly pendingHumanConfirmation?: PendingHumanConfirmation;
}

export interface ExecutionStatusSnapshot {
  readonly executionUuid: string;
  readonly status: ExecutionStatus;
  readonly progress?: number;
  readonly currentStep?: string;
  readonly pendingConfirmation?: PendingHumanConfirmation;
  readonly lastHeartbeatAt?: number;
  readonly checkpoint?: {
    readonly iteration: number;
    readonly messageCount: number;
    readonly toolCallCount: number;
    readonly phase: 'running' | 'completed' | 'failed';
    readonly savedAt: number;
  };
}

export interface ExecutionCotSnapshot {
  readonly executionUuid: string;
  readonly status: ExecutionStatus;
  readonly events: readonly {
    readonly id?: number;
    readonly event: string;
    readonly data: unknown;
    readonly timestamp?: number;
  }[];
}

export interface ExecutionDetailData {
  readonly executionUuid?: string;
  readonly status?: ExecutionStatus | string;
  readonly progress?: number;
  readonly currentStep?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface ExecutionResultData {
  readonly executionUuid?: string;
  readonly status?: ExecutionStatus | string;
  readonly result?: unknown;
  readonly resultType?: string;
  readonly error?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface ExecutionSourceTraceData {
  readonly executionUuid?: string;
  readonly step?: number;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly matches?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface ExecutionListData {
  readonly list?: readonly ExecutionDetailData[];
  readonly items?: readonly ExecutionDetailData[];
  readonly total?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly [key: string]: unknown;
}

export interface RelatedShadowExecutionListData {
  readonly list?: readonly ExecutionDetailData[];
  readonly items?: readonly ExecutionDetailData[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface ExecutionCancelResult {
  readonly success: boolean;
  readonly signalSent?: boolean;
  readonly [key: string]: unknown;
}
