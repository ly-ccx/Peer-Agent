/**
 * Goal 模式协议类型 —— 见 Goal 模式设计。
 *
 * 设计要点（与提案一致）：
 * - 计划是持久化的 Evidence/artifact，采用「先规划 → 批准 → 执行」流程。
 * - 子任务（含嵌套）独立追踪完成状态，`status` 只能由 Evidence 回写。
 * - 批准 / 驳回 / 修订作为治理事实记录，复用 execution.ts 的 HumanConfirmation。
 * - 进度（progress）由子任务自底向上聚合，不可手填。
 *
 * 复用既有协议：
 * - 子任务状态复用 ExecutionStatus（execution.ts）。
 * - 批准决策复用 HumanConfirmationDecision（execution.ts）。
 */
import type {
  ExecutionStatus,
  HumanConfirmationDecision,
} from './execution.ts';

/** 计划整体状态机，见提案 §2。 */
export type GoalPlanStatus =
  | 'drafting'
  | 'awaiting_approval'
  | 'approved'
  | 'accepted'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Goal artifact 的工作流语义：Plan 审批门 vs Goal 自驱契约。 */
export type GoalWorkflowKind = 'plan_approval' | 'goal_self_driven';

/**
 * Goal/Plan 的执行准入事实。
 *
 * `intake` 是 goal 模式下的「判别前置态」：用户首发消息先落成 intake 契约，
 * Runner 在只读/问答/澄清的受限授权下判别真实意图，判定为明确目标后才升级为
 * `accepted_goal` 进入正常自驱；判定为纯问答则由上层静默移除契约。
 */
export interface GoalActivation {
  readonly kind: 'intake' | 'approval_required' | 'approved_plan' | 'accepted_goal';
  readonly sourceMessageId?: string;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  /** intake 阶段的判别结论；仅在 kind 从 intake 流转时写入，用于溯源。 */
  readonly intakeResolution?: GoalIntakeResolution;
}

/** intake 判别的三种结论。 */
export type GoalIntakeResolution =
  | 'inquiry'        // 纯问答/咨询 —— 直接回答，契约静默移除
  | 'clarifying'     // 目标模糊 —— 向用户澄清后重判
  | 'goal_confirmed'; // 明确目标 —— 升级为 accepted_goal 进入自驱

export type GoalAskUserReason =
  | 'ambiguous_goal'
  | 'product_decision'
  | 'high_risk'
  | 'irreversible'
  | 'missing_permission'
  | 'missing_credentials'
  | 'verification_conflict'
  | 'scope_drift';

/** 执行策略：权限仍由 Runtime Projection / PermissionGrant / adapter enforcement 负责。 */
export interface GoalExecutionPolicy {
  readonly autonomy: 'approval_gated' | 'self_driven';
  readonly irreversibleRequiresConfirmation: boolean;
  readonly writeScope: 'workspace_and_boundaries';
  readonly askUserOn: readonly GoalAskUserReason[];
}

/** 异常处理策略动作。rollback 的 schema 先落地，执行器可后置。 */
export type ExceptionPolicyAction = 'pause' | 'rollback' | 'skip' | 'ask_user';

/** 结构化异常处理策略（MVP 必需）。 */
export interface ExceptionPolicy {
  readonly id: string;
  /** 何种异常触发 */
  readonly trigger: string;
  /** 作用域：'plan' 或某个 taskId */
  readonly scope: 'plan' | string;
  readonly action: ExceptionPolicyAction;
  /** 回滚目标 taskId（仅 action='rollback' 时有意义） */
  readonly rollbackOf?: string;
}

/** 计划边界条件。 */
export interface GoalBoundaries {
  readonly inScope: string[];
  readonly outOfScope: string[];
}

/** 子任务（树形，支持嵌套）。 */
export interface GoalTask {
  readonly taskId: string;
  /** 同层稳定排序 */
  readonly order: number;
  readonly title: string;
  /** 子目标委派关系；历史任务可不含这些字段。 */
  readonly childPlanIds?: readonly string[];
  readonly executionMode?: 'direct' | 'delegated';
  /** 达成路径 / 步骤 */
  readonly path: string[];
  /** 依赖的 taskId（约束见提案 §4：同层或祖先链之外，禁止成环） */
  readonly dependsOn: string[];
  /** 本任务完成判定 */
  readonly acceptanceCriteria: string[];
  readonly involvedFiles: string[];
  /** 预期能力（对齐 Runtime Projection） */
  readonly capabilityHints?: string[];
  /** 子任务状态，复用 ExecutionStatus；只能由 Evidence 回写 */
  readonly status: ExecutionStatus;
  /** 完成的事实依据（Evidence id 列表） */
  readonly evidenceRefs: string[];
  readonly result?: string;
  readonly failureReason?: string;
  readonly blockedReason?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** 嵌套子任务（MVP 必需） */
  readonly subtasks?: GoalTask[];
}

/** Goal 模式的全局 Evidence 索引记录；任务完成只允许引用这里登记过的 refs。 */
export interface EvidenceIndexRecord {
  readonly evidenceRef: string;
  readonly planId?: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly toolCallId?: string;
  readonly capabilityId?: string;
  readonly toolName?: string;
  readonly createdAt: string;
  readonly artifactRefs?: readonly string[];
}

/** 批准事实（Evidence）。 */
export interface GoalApproval {
  readonly decision: HumanConfirmationDecision;
  /** 绑定 execution.ts 的 confirmationId */
  readonly confirmationId: string;
  readonly decidedBy?: string;
  readonly decidedAt: string;
  readonly feedback?: string;
}

/** 进度聚合（派生，由子任务 Evidence 聚合，不可手填）。 */
export interface GoalProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  /** 0–100 */
  readonly percent: number;
}

/**
 * Goal 运行时间账本。
 *
 * 由 store 在 plan 状态迁移时维护（不可手填）：
 * - active：runner 真正在跑的时间累计（pause / waiting_user / 人在回路 blocked 停表）
 * - wallClock：首次开始执行到终态的日历跨度（含等待）
 * 终态落盘 activeMs / wallClockMs，reload 不依赖重算。
 */
export interface GoalTiming {
  /** 首次进入 executing / runner 真正开跑；resume 不重置。 */
  readonly startedAt?: string;
  /** 进入终态 completed | failed | cancelled。 */
  readonly completedAt?: string;
  /**
   * 已累计的有效运行毫秒（不含当前未闭合 segment）。
   * pause / blocked(等人) / waiting_user / 终态时结算进账。
   */
  readonly activeAccumulatedMs: number;
  /** 当前有效 segment 起点；runner 在跑时有值，暂停/终态时清空。 */
  readonly activeSegmentStartedAt?: string;
  /** 终态墙钟毫秒：completedAt - startedAt。 */
  readonly wallClockMs?: number;
  /** 终态有效运行毫秒（含终态时未闭合 segment 的结算）。 */
  readonly activeMs?: number;
}

/** 投影后的 live / 终态口径，UI 只消费此结构。 */
export interface ProjectedGoalTiming {
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly wallClockMs?: number;
  readonly activeMs?: number;
  readonly isLive: boolean;
}

/**
 * 统一 live 与终态用时口径。
 * - 终态优先使用落盘 activeMs / wallClockMs
 * - 进行中：active = accumulated + open segment；wall = now - startedAt
 */
export function projectGoalTiming(
  timing: GoalTiming | null | undefined,
  nowMs: number = Date.now(),
): ProjectedGoalTiming | null {
  if (!timing || typeof timing !== 'object') return null;
  const startedAt = typeof timing.startedAt === 'string' && timing.startedAt.trim()
    ? timing.startedAt.trim()
    : undefined;
  if (!startedAt) return null;

  const completedAt = typeof timing.completedAt === 'string' && timing.completedAt.trim()
    ? timing.completedAt.trim()
    : undefined;
  const accumulated = Number.isFinite(timing.activeAccumulatedMs)
    ? Math.max(0, Math.floor(timing.activeAccumulatedMs))
    : 0;
  const segmentStart = typeof timing.activeSegmentStartedAt === 'string'
    && timing.activeSegmentStartedAt.trim()
    ? timing.activeSegmentStartedAt.trim()
    : undefined;

  if (completedAt) {
    const startedMs = Date.parse(startedAt);
    const completedMs = Date.parse(completedAt);
    const wallFromMarks = Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : undefined;
    const activeFromMarks = (() => {
      if (typeof timing.activeMs === 'number' && Number.isFinite(timing.activeMs)) {
        return Math.max(0, Math.floor(timing.activeMs));
      }
      let active = accumulated;
      if (segmentStart) {
        const seg = Date.parse(segmentStart);
        if (Number.isFinite(seg) && Number.isFinite(completedMs)) {
          active += Math.max(0, completedMs - seg);
        }
      }
      return active;
    })();
    return {
      startedAt,
      completedAt,
      wallClockMs: typeof timing.wallClockMs === 'number' && Number.isFinite(timing.wallClockMs)
        ? Math.max(0, Math.floor(timing.wallClockMs))
        : wallFromMarks,
      activeMs: activeFromMarks,
      isLive: false,
    };
  }

  const startedMs = Date.parse(startedAt);
  let activeMs = accumulated;
  if (segmentStart) {
    const seg = Date.parse(segmentStart);
    if (Number.isFinite(seg)) activeMs += Math.max(0, nowMs - seg);
  }
  const wallClockMs = Number.isFinite(startedMs)
    ? Math.max(0, nowMs - startedMs)
    : undefined;

  return {
    startedAt,
    wallClockMs,
    activeMs,
    isLive: true,
  };
}

/** 修订记录（来自 reject/revise 的 feedback）。 */
export interface GoalRevision {
  readonly version: number;
  readonly reason: string;
  readonly changedAt: string;
  readonly changedBy?: string;
}

/** Goal Runner 托管推进器状态。 */
export type GoalRunnerStatus =
  | 'idle'
  | 'running'
  | 'compacting_context'
  | 'resuming_after_compaction'
  | 'paused'
  | 'exploring'
  | 'blocked'
  | 'budget_exhausted'
  | 'completed'
  | 'failed';

/** Goal Runner 当前推进意图；只描述编排意图，不替代工具执行 Evidence。 */
export type GoalRunnerIntent =
  | 'execute'
  | 'verify'
  | 'explore'
  | 'synthesize'
  | 'block';

export type GoalRunnerPhase =
  | 'orient'
  | 'inspect'
  | 'plan_scaffold'
  | 'act'
  | 'verify'
  | 'repair'
  | 'synthesize'
  | 'blocked';

export interface GoalBlockerAudit {
  readonly fingerprint: string;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly reason: string;
}

/** 动态 Explorer 子 Agent 的能力边界。第一版只允许只读探索。 */
export type GoalExplorerProfile = 'readonly_explorer';

export type GoalExplorerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Runner 动态生成的 Explorer 子 Agent 请求；定义任务实例，不定义固定角色。 */
export interface GoalExplorerRequest {
  readonly explorerId: string;
  readonly planId: string;
  readonly question: string;
  readonly reason: string;
  readonly scope?: {
    readonly include?: string[];
    readonly exclude?: string[];
  };
  readonly profile: GoalExplorerProfile;
  readonly budget: {
    readonly maxToolCalls: number;
    readonly maxDurationMs: number;
  };
  readonly exitCriteria: string[];
  readonly createdAt: string;
}

export interface GoalExplorerFinding {
  readonly claim: string;
  readonly evidenceRefs: string[];
}

/** Explorer 子 Agent 的结构化报告；完成报告必须带 Evidence refs。 */
export interface GoalExplorerReport {
  readonly explorerId: string;
  readonly planId: string;
  readonly question: string;
  readonly findings: GoalExplorerFinding[];
  readonly evidenceRefs: string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly recommendedNextAction?: string;
  readonly blockedReason?: string;
}

export interface GoalExplorerRun {
  readonly explorerId: string;
  readonly status: GoalExplorerStatus;
  readonly request: GoalExplorerRequest;
  /** Evidence refs produced by this Explorer's projected tool executions. */
  readonly evidenceRefs?: string[];
  readonly report?: GoalExplorerReport;
  readonly failureReason?: string;
  /** 同一 turn 内并发派发的一批 Explorer 共享同一 batchId；用于 UI 精确统计「本轮」进度。 */
  readonly batchId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 本轮（最近一批）Explorer 并发进度；供 UI 展示「已完成 / 本轮总数」。 */
export interface GoalExplorerBatch {
  readonly batchId: string;
  /** 本批派发的 Explorer 总数（分母）。 */
  readonly total: number;
  /** 本批已进入终止态（completed/failed/cancelled）的数量（分子）。 */
  readonly done: number;
}

export interface GoalExploreQuestion {
  readonly question: string;
  readonly reason: string;
  readonly scope?: {
    readonly include?: string[];
    readonly exclude?: string[];
  };
  readonly budget?: {
    readonly maxToolCalls?: number;
    readonly maxDurationMs?: number;
  };
}

export interface GoalExplorePlan {
  readonly requiredBeforeAct: boolean;
  readonly questions: readonly GoalExploreQuestion[];
  readonly exitCriteria: readonly string[];
  readonly generatedAt: string;
}

export type GoalVerifierStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked';

export type GoalVerifierTargetKind = 'plan' | 'task' | 'success_criterion';

export interface GoalVerifierTarget {
  readonly kind: GoalVerifierTargetKind;
  readonly taskId?: string;
  readonly criterionId?: string;
}

export interface GoalVerifierIssue {
  readonly taskId?: string;
  readonly criterionId?: string;
  readonly reason: string;
  readonly evidenceRefs: string[];
}

export interface GoalVerifierReport {
  readonly passed: boolean;
  readonly failedCriteria: readonly GoalVerifierIssue[];
  readonly missingEvidence: readonly GoalVerifierIssue[];
  readonly risks: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly recommendedNextAction?: string;
}

/** Verifier 运行事实；记录验证动作与证据，不替代任务 Evidence 或 CriterionResult。 */
export interface GoalVerifierRun {
  readonly verifierRunId: string;
  readonly planId: string;
  readonly target: GoalVerifierTarget;
  readonly status: GoalVerifierStatus;
  readonly evidenceRefs: string[];
  readonly report?: GoalVerifierReport;
  readonly summary?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type GoalRunEventType =
  | 'message_routed'
  | 'goal_intake_started'
  | 'goal_created'
  | 'plan_created'
  | 'plan_revised'
  | 'step_started'
  | 'step_completed'
  | 'action_started'
  | 'action_completed'
  | 'observation_recorded'
  | 'validation_started'
  | 'validation_passed'
  | 'validation_failed'
  | 'problem_found'
  | 'user_correction'
  | 'requirement_override'
  | 'self_correction'
  | 'checkpoint_created'
  | 'network_interrupted'
  | 'goal_resumed'
  | 'goal_paused'
  | 'goal_completed';

export interface GoalRunEvent {
  readonly id: string;
  readonly goalPlanId: string;
  readonly nodeId?: string;
  readonly parentNodeId?: string;
  readonly type: GoalRunEventType;
  readonly summary: string;
  readonly payload?: Record<string, unknown>;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

/** Append-only execution ledger for Goal / Plan / Run projection. */
export interface GoalRunTrace {
  readonly activeNodeId?: string;
  readonly lastCheckpointNodeId?: string;
  readonly events: readonly GoalRunEvent[];
}

export type GoalSuccessCriterionKind =
  | 'command'
  | 'test'
  | 'file-contains'
  | 'file-exists'
  | 'manual';

export interface GoalSuccessCriterion {
  readonly id: string;
  readonly kind: GoalSuccessCriterionKind;
  readonly description: string;
  readonly command?: string;
  readonly path?: string;
  readonly expect?: string;
}

export interface GoalCriterionResult {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly evidenceRef?: string;
  readonly detail?: string;
  readonly checkedAt?: string;
}

export type GoalManualConfirmationKind = 'manual_dod';

export interface GoalManualConfirmation {
  readonly confirmationId: string;
  readonly kind: GoalManualConfirmationKind;
  readonly decision: HumanConfirmationDecision;
  readonly criterionIds: readonly string[];
  readonly decidedBy?: string;
  readonly decidedAt: string;
  readonly feedback?: string;
}

/**
 * Goal 执行检查点：跨 compaction 的权威“下一动作”真源。
 * 聊天摘要只能解释，不能替代此结构；任务完成仍必须由 Evidence 回写。
 * 详见 peer-knowledge/knowledge/architecture/24-goal-runner-context-checkpoint-and-seamless-resume.md
 */
export type GoalCheckpointStatus =
  | 'preparing'
  | 'committed'
  | 'consumed'
  | 'superseded'
  | 'invalid';

export type GoalCheckpointReason =
  | 'soft_threshold'
  | 'hard_threshold'
  | 'provider_overflow'
  | 'task_boundary'
  | 'manual_compact'
  | 'process_recovery';

export type GoalResumePolicy =
  | 'continue_same_turn'
  | 'start_recovery_turn'
  | 'verify_then_continue'
  | 'wait_for_user';

export interface GoalCheckpointProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly percent: number;
  readonly nextRunnableTaskIds: readonly string[];
}

export interface GoalCheckpointAction {
  readonly actionId: string;
  readonly kind: 'inspect' | 'edit' | 'write' | 'tool' | 'test' | 'verify' | 'decision';
  readonly summary: string;
  readonly status: 'completed' | 'failed' | 'running' | 'unknown';
  readonly target?: string;
  readonly evidenceRefs: readonly string[];
  readonly result?: string;
  readonly occurredAt?: string;
}

export interface GoalCheckpointToolCall {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly status: 'requested' | 'running' | 'completed' | 'failed' | 'unknown';
  readonly resultEvidenceRefs: readonly string[];
  readonly replayPolicy: 'never' | 'query_status' | 'safe_retry' | 'ask_user';
  readonly idempotencyKey?: string;
}

export interface GoalCheckpointFirstAction {
  readonly kind: 'tool' | 'inspect' | 'edit' | 'verify' | 'synthesize' | 'wait_user';
  readonly instruction: string;
  readonly target?: string;
  readonly successCheck: string;
  readonly requiredEvidenceRefs: readonly string[];
  readonly forbiddenUntilComplete?: readonly string[];
}

export interface GoalCheckpointBudgetSnapshot {
  readonly contextWindow: number | null;
  readonly beforeTokens: number;
  readonly targetTokens: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly checkpointTokens: number;
  readonly continuityTokens: number;
  readonly recentTailTokens: number;
  readonly keepBudgetTokens: number;
  readonly compactionCount: number;
}

export interface GoalExecutionCheckpoint {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly compactionId: string;
  readonly sequence: number;
  readonly status: GoalCheckpointStatus;
  readonly reason: GoalCheckpointReason;

  readonly planId: string;
  readonly planVersion: number;
  readonly runId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly contextEpochId?: string;
  readonly conversationRevision?: string;

  readonly currentTaskId?: string;
  readonly runnerPhase?: GoalRunnerPhase;
  readonly runnerIntent?: GoalRunnerIntent;
  readonly progress: GoalCheckpointProgress;

  readonly objectiveNow: string;
  readonly currentWork: string;
  readonly recentActions: readonly GoalCheckpointAction[];
  readonly completedSincePrevious: readonly string[];
  readonly mostImportantFact: string;
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly pendingVerifications: readonly string[];
  readonly doNotRepeat: readonly string[];
  readonly handoffNote: string;
  readonly firstAction: GoalCheckpointFirstAction;

  readonly evidenceRefs: readonly string[];
  readonly mustReadEvidenceRefs: readonly string[];
  readonly openToolCalls: readonly GoalCheckpointToolCall[];
  readonly budget: GoalCheckpointBudgetSnapshot;
  readonly resumePolicy: GoalResumePolicy;

  readonly createdAt: string;
  readonly committedAt?: string;
  readonly consumedAt?: string;
  readonly digest: string;
}

/** GoalPlan 内嵌的轻量 runner 状态；不代表工具执行事实，任务完成仍必须由 Evidence 回写。 */
export interface GoalRunnerState {
  readonly enabled: boolean;
  readonly status: GoalRunnerStatus;
  readonly intent?: GoalRunnerIntent;
  readonly phase?: GoalRunnerPhase;
  readonly currentTaskId?: string;
  /**
   * 一次逻辑自驱执行的持久化身份；跨 compaction / stream retry 不变。
   * 仅在创建新 Goal 或显式重新运行终态 Goal 时生成新值。
   */
  readonly runId?: string;
  /** 当前已提交、待消费的执行检查点；prompt 只注入这一份。 */
  readonly contextCheckpoint?: GoalExecutionCheckpoint;
  readonly lastConsumedCheckpointId?: string;
  readonly lastConsumedCheckpointSequence?: number;
  readonly compactionCount?: number;
  readonly lastCompactionAt?: string;
  /** 预算计数：Runner tick 次数，用于 maxTurns 熔断判定。 */
  readonly turnCount: number;
  /** 展示计数：模型内部对话轮次，随执行实时爬升；与 turnCount（预算）解耦，仅用于 UI 呈现。 */
  readonly roundCount: number;
  readonly toolCallCount: number;
  readonly explorerCount: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  /**
   * @deprecated 语义已弃用：不再作为「每计划累计可派发 Explorer 总数」的闸。
   * 保留字段仅为向后兼容旧持久化数据；并发上限改由 explorerConcurrency 表达，
   * 计划总数由 maxTurns 天然兜底。
   */
  readonly maxExplorers: number;
  /** 每个 turn 内 Explorer 的并发上限（并发池大小）。默认 5，硬上限 8。 */
  readonly explorerConcurrency: number;
  readonly explorers?: GoalExplorerRun[];
  /** 最近一批并发 Explorer 的进度；无进行中批次时可缺省。 */
  readonly explorerBatch?: GoalExplorerBatch;
  /** Deterministic inspect planner output for the current inspect phase. */
  readonly inspectPlan?: GoalExplorePlan;
  /** Verifier 运行历史；用于追踪验证事实，不作为任务完成的唯一事实源。 */
  readonly verifierRuns?: GoalVerifierRun[];
  readonly blockerAudit?: GoalBlockerAudit;
  readonly tokenBudget?: number;
  readonly tokenUsed?: number;
  readonly blockedReason?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

/** 计划 Artifact 定型版，见提案 §3。 */
export interface GoalPlan {
  // 身份 & 归属
  readonly planId: string;
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly agentId?: number;
  /** Workspace where the Goal was initiated and where contextual knowledge came from. */
  readonly originWorkspacePath?: string;
  /** Workspace/repository where the Goal should write and verify changes. */
  readonly targetWorkspacePath?: string;
  /** 派生目标关系；全部可选以兼容历史计划。 */
  readonly parentPlanId?: string;
  readonly sourceTaskId?: string;
  readonly rootPlanId?: string;
  readonly relationType?: 'derived';
  readonly depth?: number;
  readonly title: string;

  // 计划实质
  readonly goal: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly criterionResults: readonly GoalCriterionResult[];
  readonly manualConfirmations?: readonly GoalManualConfirmation[];
  readonly boundaries: GoalBoundaries;
  readonly exceptionPolicies: ExceptionPolicy[];
  /** 顶层汇总（来源于子任务） */
  readonly involvedFiles: string[];
  /** 拆出的子事项（树形） */
  readonly tasks: GoalTask[];

  // 状态机 & 执行准入
  readonly workflowKind?: GoalWorkflowKind;
  readonly activation?: GoalActivation;
  readonly executionPolicy?: GoalExecutionPolicy;
  readonly status: GoalPlanStatus;
  readonly approval?: GoalApproval;
  /** 由子任务聚合，派生，不可手填 */
  readonly progress: GoalProgress;
  /**
   * 运行时间账本；由 store 在状态迁移时维护，旧计划可缺省。
   * UI 请用 projectGoalTiming 统一 live / 终态口径。
   */
  readonly timing?: GoalTiming;
  /** Goal Runner 托管推进状态；旧计划可缺省。 */
  readonly runner?: GoalRunnerState;
  /** Execution/event ledger used by the Goal / Plan / Run right-panel projection. */
  readonly runTrace?: GoalRunTrace;

  // 溯源 & 治理
  readonly version: number;
  readonly revisionHistory: GoalRevision[];
  readonly evidenceRefs: string[];
  /** 对齐 system-context.ts 的 epoch */
  readonly promptContextEpochId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy?: string;
}
