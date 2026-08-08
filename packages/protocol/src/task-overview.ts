/**
 * TaskOverview 行动权投影契约 —— Peer 2.0 阶段 0 协议层。
 *
 * 设计依据：peer-knowledge design/product/peer-2-0-gap-analysis.md §11。
 *
 * 核心命题：首页/任务/历史三页面不是第二份任务数据库，而是
 * GoalPlan / GoalRunner / Automation 三套状态机按「下一步行动权」
 * 形成的动态投影。本文件是该投影的唯一事实来源（single source of truth）。
 *
 * 治理红线（AGENTS.md）：
 * - renderer 只消费本模块输出的投影结果，不自行解析 GoalPlanStatus/
 *   AutomationRunStatus 推断行动权，不在前端维护任务状态副本。
 * - 映射规则见 §11.3：判定顺序从上到下、首个命中生效；本模块用
 *   projectGoalPlan / projectAutomationRun 两个纯函数实现该顺序。
 *
 * 输入设计：投影函数接收最小输入快照（ProjectionSnapshot），而非完整
 * GoalPlan / AutomationRun 对象——调用方（main 进程聚合层）负责从
 * 存储读出字段后组装快照，renderer 只拿到投影产物。这样契约边界清晰，
 * 且测试无需构造巨型 fixture。
 */

import type { GoalPlanStatus, GoalRunnerStatus } from './goal.ts';
import type {
  AutomationLifecycleStatus,
  AutomationRunStatus,
} from './automation.ts';

// ---------------------------------------------------------------------------
// 投影目标：行动权
// ---------------------------------------------------------------------------

/**
 * 任务的下一步行动权归属（§11.2）。
 *
 * - needs_you：阻塞点在用户（待批准 / 待授权 / 待回答 / 待决策）。
 * - peer_advancing：Peer 正在推进，用户无需介入。
 * - result_ready：结果就绪待验收（依赖 Result Package，见 §11.5 过渡期）。
 * - paused：用户或系统主动暂停，等待恢复。
 * - terminal：终态，进历史页。
 */
export type TaskActionRight =
  | 'needs_you'
  | 'peer_advancing'
  | 'result_ready'
  | 'paused'
  | 'terminal';

/**
 * 「需要你处理」内的细分桶（§11.4 决策 2），对应原型首页
 * 「需要你 · 待确认 · 等待权限」三类卡片。
 *
 * - plan_approval：待批准/确认计划（§11.3 rule 1-2）。
 * - user_input：待授权权限 / 待回答问题（rule 3-4）。
 * - decision：待决策（rule 5，Runner blocked / 预算耗尽）。
 */
export type TaskNeedsYouReason =
  | 'plan_approval'
  | 'user_input'
  | 'decision';

/** 投影来源类别：标记该任务投影来自哪套状态机。 */
export type TaskOverviewSourceKind = 'goal_plan' | 'automation';

/**
 * 用户在任务上可执行的下一步动作（§11.3「下一步行动」列）。
 * 协议层只给出动作标识，具体 IPC 由 main 进程实现。
 */
export type TaskNextAction =
  | 'approve_plan' // 批准或驳回计划
  | 'confirm_scope' // 确认目标范围（intake 未决）
  | 'grant_permission' // 授权权限
  | 'answer_question' // 回答问题
  | 'decide_blocked' // 决策：调整范围或追加预算
  | 'review_result' // 验收结果包
  | 'resume' // 继续（paused → 恢复）
  | 'enable' // 启用（Automation definition paused/disabled）
  | 'inspect' // 查看（异常态诊断）
  | 'none'; // 无需动作

// ---------------------------------------------------------------------------
// 投影产物
// ---------------------------------------------------------------------------

/**
 * 单个任务的行动权投影（首页卡片 / 任务行 / 历史行的数据契约）。
 *
 * 字段命名对齐原型：title / workspaceLabel / statusLabel / planProgress /
 * lastActiveAt / actionLabel 直接对应 UI 元素，renderer 不再二次推导。
 */
export interface TaskOverviewItem {
  /** 稳定任务身份（planId 或 automationId+runId）。 */
  readonly taskId: string;
  /** 投影来源。 */
  readonly source: TaskOverviewSourceKind;
  /** 行动权归属。 */
  readonly actionRight: TaskActionRight;
  /** needs_you 细分桶；仅 actionRight === 'needs_you' 时有值。 */
  readonly needsYouReason?: TaskNeedsYouReason;
  /** 下一步动作标识。 */
  readonly nextAction: TaskNextAction;
  /** 任务标题（GoalPlan.title 或 AutomationDefinition.name）。 */
  readonly title: string;
  /** Workspace 标签（原型卡片右上角）。 */
  readonly workspaceLabel?: string;
  /** 状态描述（原型卡片中部，如「Peer 正在验证」「等待权限」）。 */
  readonly statusLabel: string;
  /** Plan 进度「x / y」；无 Plan 概念的任务为 undefined。 */
  readonly planProgress?: { readonly completed: number; readonly total: number };
  /** 最近活跃时间（ISO 字符串）。 */
  readonly lastActiveAt?: string;
  /** 动作按钮标签（原型「处理 →」「验收 →」「继续 →」）。 */
  readonly actionLabel: string;
  /** 关联的 conversationId，用于深链跳转。 */
  readonly conversationId?: string;
}

// ---------------------------------------------------------------------------
// 投影输入：最小快照
// ---------------------------------------------------------------------------

/** GoalPlan 投影所需的最小字段快照。 */
export interface GoalPlanProjectionSnapshot {
  readonly planId: string;
  readonly status: GoalPlanStatus;
  /** Runner 实时态；Plan 未进入自驱时为 undefined。 */
  readonly runnerStatus?: GoalRunnerStatus;
  readonly title: string;
  readonly workspaceLabel?: string;
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly updatedAt?: string;
  readonly conversationId?: string;
  /**
   * 是否已完成 USER ACCEPTANCE 验收（§11.3 rule 6/16 的分界）。
   * Result Package 落地前可恒传 false（过渡期：completed 一律进
   * result_ready，由用户在 Result Review 页手动归档）。
   */
  readonly accepted?: boolean;
}

/** Automation 投影所需的最小字段快照（Definition 与 Run 联合判断）。 */
export interface AutomationProjectionSnapshot {
  readonly automationId: string;
  readonly runId?: string;
  readonly definitionStatus: AutomationLifecycleStatus;
  /** 最新一次 Run 的状态；definition 从未运行为 undefined。 */
  readonly runStatus?: AutomationRunStatus;
  readonly title: string;
  readonly workspaceLabel?: string;
  readonly updatedAt?: string;
  readonly conversationId?: string;
  /** 同 GoalPlanProjectionSnapshot.accepted。 */
  readonly accepted?: boolean;
}

// ---------------------------------------------------------------------------
// 映射规则实现（§11.3，判定顺序从上到下、首个命中生效）
// ---------------------------------------------------------------------------

interface ProjectionDecision {
  readonly actionRight: TaskActionRight;
  readonly needsYouReason?: TaskNeedsYouReason;
  readonly nextAction: TaskNextAction;
  readonly statusLabel: string;
  readonly actionLabel: string;
}

/**
 * GoalPlan 行动权投影（§11.3 rule 1-16 的 GoalPlan/Runner 分支）。
 *
 * 判定顺序（首个命中生效），Plan 态优先于 Runner 态（§11.4 决策 1）：
 *  1. plan awaiting_approval → needs_you/plan_approval
 *  2. plan drafting → needs_you/plan_approval
 *  5. runner blocked | budget_exhausted → needs_you/decision
 *  6. plan completed 且未验收 → result_ready
 *  8. plan executing → peer_advancing
 *  9. runner running/compacting/resuming/exploring → peer_advancing
 * 11. plan approved/accepted（Runner 未启动）→ peer_advancing
 * 12. plan paused → paused
 * 13. runner paused → paused
 * 14. runner idle 且 plan executing → paused（异常态，提示诊断）
 * 16. plan completed（已验收）/cancelled/failed → terminal
 *
 * 注意 rule 14 在 rule 8 之前不会命中（executing 已被 rule 8 拦截），
 * 因此实现时将 rule 14 放在 rule 8 之后、仅当 runner 显式 idle 时生效。
 */
export function projectGoalPlan(
  snapshot: GoalPlanProjectionSnapshot,
): TaskOverviewItem {
  const decision = decideGoalPlan(snapshot);
  return {
    taskId: snapshot.planId,
    source: 'goal_plan',
    actionRight: decision.actionRight,
    ...(decision.needsYouReason ? { needsYouReason: decision.needsYouReason } : {}),
    nextAction: decision.nextAction,
    title: snapshot.title,
    ...(snapshot.workspaceLabel ? { workspaceLabel: snapshot.workspaceLabel } : {}),
    statusLabel: decision.statusLabel,
    ...(snapshot.progress ? { planProgress: snapshot.progress } : {}),
    ...(snapshot.updatedAt ? { lastActiveAt: snapshot.updatedAt } : {}),
    actionLabel: decision.actionLabel,
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
  };
}

function decideGoalPlan(snapshot: GoalPlanProjectionSnapshot): ProjectionDecision {
  const { status, runnerStatus, accepted } = snapshot;

  // rule 16 first: 终态计划优先于任何 runner 残留态
  // （历史 failed/cancelled/completed 上的 runner.blocked 不得再进 needs_you）
  if (status === 'completed' && accepted !== true) {
    // rule 6: 完成且未验收 → 结果就绪
    return {
      actionRight: 'result_ready',
      nextAction: 'review_result',
      statusLabel: '等待验收',
      actionLabel: '验收 →',
    };
  }
  if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    return {
      actionRight: 'terminal',
      nextAction: 'none',
      statusLabel:
        status === 'completed' ? '已验收' : status === 'cancelled' ? '已取消' : '已失败',
      actionLabel: '查看 →',
    };
  }
  // rule 1: 计划审批门
  if (status === 'awaiting_approval') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'plan_approval',
      nextAction: 'approve_plan',
      statusLabel: '待批准计划',
      actionLabel: '批准 →',
    };
  }
  // rule 2: intake 未决
  if (status === 'drafting') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'plan_approval',
      nextAction: 'confirm_scope',
      statusLabel: '待确认目标',
      actionLabel: '确认 →',
    };
  }
  // rule 5: 仅活跃计划上的 Runner 实时求助才进 needs_you
  // （plan 必须仍在推进：executing/accepted/approved；历史僵尸 blocked 不进）
  const planStillActive =
    status === 'executing' || status === 'accepted' || status === 'approved';
  if (
    planStillActive &&
    (runnerStatus === 'blocked' || runnerStatus === 'budget_exhausted')
  ) {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'decision',
      nextAction: 'decide_blocked',
      statusLabel: runnerStatus === 'budget_exhausted' ? '预算已耗尽' : '执行受阻',
      actionLabel: '决策 →',
    };
  }
  // rule 12: 计划暂停（先于 runner 态判断，用户主动暂停优先）
  if (status === 'paused') {
    return {
      actionRight: 'paused',
      nextAction: 'resume',
      statusLabel: '已暂停',
      actionLabel: '继续 →',
    };
  }
  // rule 14: 异常态 —— runner 空闲但计划仍在 executing（Runner 崩溃/丢消息）
  if (status === 'executing' && runnerStatus === 'idle') {
    return {
      actionRight: 'paused',
      nextAction: 'inspect',
      statusLabel: '推进中断',
      actionLabel: '诊断 →',
    };
  }
  // rule 13: Runner 暂停
  if (runnerStatus === 'paused') {
    return {
      actionRight: 'paused',
      nextAction: 'resume',
      statusLabel: '已暂停',
      actionLabel: '继续 →',
    };
  }
  // rule 9: Runner 活跃中
  if (
    runnerStatus === 'running' ||
    runnerStatus === 'compacting_context' ||
    runnerStatus === 'resuming_after_compaction' ||
    runnerStatus === 'exploring'
  ) {
    return {
      actionRight: 'peer_advancing',
      nextAction: 'none',
      statusLabel: 'Peer 正在推进',
      actionLabel: '查看 →',
    };
  }
  // rule 8: 计划已批准正在推进（runner 态缺失时的兜底）
  if (status === 'executing') {
    return {
      actionRight: 'peer_advancing',
      nextAction: 'none',
      statusLabel: 'Peer 正在推进',
      actionLabel: '查看 →',
    };
  }
  // rule 11: 已批准/已接受，Runner 未启动
  if (status === 'approved' || status === 'accepted') {
    return {
      actionRight: 'peer_advancing',
      nextAction: 'none',
      statusLabel: '排队待执行',
      actionLabel: '查看 →',
    };
  }
  // 兜底：未知组合视为 peer_advancing（防御性，不阻塞首页渲染）
  return {
    actionRight: 'peer_advancing',
    nextAction: 'none',
    statusLabel: 'Peer 正在推进',
    actionLabel: '查看 →',
  };
}

/**
 * Automation 行动权投影（§11.3 rule 3-4/7/10/15/17/18，Definition 与 Run 联合判断）。
 *
 * 判定顺序（首个命中生效）：
 *  3. run waiting_permission → needs_you/user_input（授权权限）
 *  4. run waiting_user → needs_you/user_input（回答问题）
 *  7. 产品方案 A：run succeeded → terminal（定时/触发成功默认归档，不进工作台待验收）
 * 15. definition paused/disabled → paused
 * 10. run scheduled/queued/preparing/running → peer_advancing
 * 17. run 终态（succeeded/failed/cancelled/skipped/timed_out/blocked）→ terminal
 * 18. definition completed/archived → terminal
 *
 * 说明：GoalPlan 的 result_ready + 一键验收不套用到 Automation。
 * Automation 仅在 needs_you（权限/提问）时必须进工作台；成功 Run 不进「结果待验收」。
 */
export function projectAutomationRun(
  snapshot: AutomationProjectionSnapshot,
): TaskOverviewItem {
  const decision = decideAutomation(snapshot);
  return {
    taskId: snapshot.runId ?? snapshot.automationId,
    source: 'automation',
    actionRight: decision.actionRight,
    ...(decision.needsYouReason ? { needsYouReason: decision.needsYouReason } : {}),
    nextAction: decision.nextAction,
    title: snapshot.title,
    ...(snapshot.workspaceLabel ? { workspaceLabel: snapshot.workspaceLabel } : {}),
    statusLabel: decision.statusLabel,
    ...(snapshot.updatedAt ? { lastActiveAt: snapshot.updatedAt } : {}),
    actionLabel: decision.actionLabel,
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
  };
}

function decideAutomation(snapshot: AutomationProjectionSnapshot): ProjectionDecision {
  const { definitionStatus, runStatus, accepted } = snapshot;

  // rule 3: 等待权限
  if (runStatus === 'waiting_permission') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'user_input',
      nextAction: 'grant_permission',
      statusLabel: '等待权限',
      actionLabel: '授权 →',
    };
  }
  // rule 4: 等待用户回答
  if (runStatus === 'waiting_user') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'user_input',
      nextAction: 'answer_question',
      statusLabel: '等待回答',
      actionLabel: '处理 →',
    };
  }
  // rule 7（方案 A）：运行成功 → 直接终态，不进工作台「结果待验收」。
  // Goal 的一键验收闭环不适用于 Automation；成功即视为已结束/可进历史。
  if (runStatus === 'succeeded') {
    return {
      actionRight: 'terminal',
      nextAction: 'none',
      statusLabel: '已完成',
      actionLabel: '查看 →',
    };
  }
  // rule 15: 定义级暂停/禁用
  if (definitionStatus === 'paused' || definitionStatus === 'disabled') {
    return {
      actionRight: 'paused',
      nextAction: 'enable',
      statusLabel: definitionStatus === 'paused' ? '已暂停' : '已禁用',
      actionLabel: '启用 →',
    };
  }
  // rule 10: 运行推进中
  if (
    runStatus === 'scheduled' ||
    runStatus === 'queued' ||
    runStatus === 'preparing' ||
    runStatus === 'running'
  ) {
    return {
      actionRight: 'peer_advancing',
      nextAction: 'none',
      statusLabel: 'Peer 正在推进',
      actionLabel: '查看 →',
    };
  }
  // rule 17: Run 终态
  if (
    runStatus === 'succeeded' ||
    runStatus === 'failed' ||
    runStatus === 'cancelled' ||
    runStatus === 'skipped' ||
    runStatus === 'timed_out' ||
    runStatus === 'blocked'
  ) {
    return {
      actionRight: 'terminal',
      nextAction: 'none',
      statusLabel: automationTerminalLabel(runStatus),
      actionLabel: '查看 →',
    };
  }
  // rule 18: 定义级终态
  if (definitionStatus === 'completed' || definitionStatus === 'archived') {
    return {
      actionRight: 'terminal',
      nextAction: 'none',
      statusLabel: definitionStatus === 'completed' ? '已完成' : '已归档',
      actionLabel: '查看 →',
    };
  }
  // 定义 active/draft 且尚无 Run：待机调度中
  return {
    actionRight: 'peer_advancing',
    nextAction: 'none',
    statusLabel: '调度待机',
    actionLabel: '查看 →',
  };
}

function automationTerminalLabel(
  status: Exclude<AutomationRunStatus, 'scheduled' | 'queued' | 'preparing' | 'running' | 'waiting_permission' | 'waiting_user'>,
): string {
  switch (status) {
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '已失败';
    case 'cancelled':
      return '已取消';
    case 'skipped':
      return '已跳过';
    case 'timed_out':
      return '已超时';
    case 'blocked':
      return '已阻塞';
  }
}
