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
  | 'executing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

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

/** GoalPlan 内嵌的轻量 runner 状态；不代表工具执行事实，任务完成仍必须由 Evidence 回写。 */
export interface GoalRunnerState {
  readonly enabled: boolean;
  readonly status: GoalRunnerStatus;
  readonly intent?: GoalRunnerIntent;
  readonly currentTaskId?: string;
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
  readonly title: string;

  // 计划实质
  readonly goal: string;
  readonly successCriteria: string[];
  readonly boundaries: GoalBoundaries;
  readonly exceptionPolicies: ExceptionPolicy[];
  /** 顶层汇总（来源于子任务） */
  readonly involvedFiles: string[];
  /** 拆出的子事项（树形） */
  readonly tasks: GoalTask[];

  // 状态机 & 批准
  readonly status: GoalPlanStatus;
  readonly approval?: GoalApproval;
  /** 由子任务聚合，派生，不可手填 */
  readonly progress: GoalProgress;
  /** Goal Runner 托管推进状态；旧计划可缺省。 */
  readonly runner?: GoalRunnerState;

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
