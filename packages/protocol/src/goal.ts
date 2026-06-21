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
