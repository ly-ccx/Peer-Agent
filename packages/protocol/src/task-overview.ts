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

import type { GoalPlanStatus, GoalRunnerStatus, GoalTiming } from './goal.ts';
import { projectGoalTiming } from './goal.ts';
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

/** 投影来源类别：标记该任务投影来自哪套事实来源。 */
export type TaskOverviewSourceKind =
  | 'conversation'
  | 'goal_plan'
  | 'automation'
  /** Peer 开启并仍可观察的后台 shell 线程。 */
  | 'shell_background';

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
  | 'continue_task' // 回到原 Conversation 继续讨论
  | 'open_background_thread' // 打开右侧后台线程面板
  | 'none'; // 无需动作

// ---------------------------------------------------------------------------
// 投影产物
// ---------------------------------------------------------------------------

/**
 * 单个任务的行动权投影（首页卡片 / 任务行 / 历史行的数据契约）。
 *
 * 字段命名对齐原型：title / workspaceLabel / statusLabel / planProgress /
 * planSteps / lastActiveAt / actionLabel 直接对应 UI 元素，renderer 不再二次推导。
 */

/**
 * GoalPlan 投影步骤（叶子任务）。
 * status 与 GoalTask.status / ExecutionStatus 字面量对齐。
 */
export type TaskOverviewPlanStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_user';

export interface TaskOverviewPlanStep {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskOverviewPlanStepStatus;
  /** 当前 Runner 正在推进的步骤。 */
  readonly current?: boolean;
}

export interface TaskOverviewItem {
  /** 稳定投影身份（conversationId、planId 或 automationId+runId）。 */
  readonly taskId: string;
  /** 投影来源。 */
  readonly source: TaskOverviewSourceKind;
  /** 行动权归属。 */
  readonly actionRight: TaskActionRight;
  /** needs_you 细分桶；仅 actionRight === 'needs_you' 时有值。 */
  readonly needsYouReason?: TaskNeedsYouReason;
  /** 下一步动作标识。 */
  readonly nextAction: TaskNextAction;
  /** 用户可见任务名。有活跃 GoalPlan 时必须是 plan.title，不得用用户原话。 */
  readonly title: string;
  /** 当前步骤标题（非 plan 名）；无步骤时省略。UI 渲染为「当前：…」，禁止「当前目标 · 确认语」。 */
  readonly currentGoalTitle?: string;
  /** Workspace 标签（原型卡片右上角）。 */
  readonly workspaceLabel?: string;
  /** 状态描述（原型卡片中部，如「Peer 正在验证」「等待权限」）。 */
  readonly statusLabel: string;
  /** 执行异常的可展示原因；仅异常/暂停投影存在，不承载控制状态。 */
  readonly issueDetail?: string;
  /** Plan 进度「x / y」；无 Plan 概念的任务为 undefined。 */
  readonly planProgress?: { readonly completed: number; readonly total: number };
  /**
   * GoalPlan 叶子步骤列表（标题 + 状态 + 当前标记）。
   * 供「Peer 正在推进」等卡片展示具体步骤，而不仅是 x/y 计数。
   */
  readonly planSteps?: readonly TaskOverviewPlanStep[];
  /** 最近活跃时间（ISO 字符串）。 */
  readonly lastActiveAt?: string;
  /**
   * 任务完成时间（ISO 字符串）。
   * GoalPlan：优先 GoalTiming.completedAt；终态缺省时回落 updatedAt。
   * 结果待验收卡片用它展示「何时完成」，与 lastActiveAt（最近活跃）语义分离。
   */
  readonly completedAt?: string;
  /**
   * 有效运行时长（毫秒）。
   * GoalPlan 来自 timing 投影（activeMs）；缺 timing 时省略。
   * UI 负责格式化为「3m12s」等，不在协议层落展示字符串。
   */
  readonly durationMs?: number;
  /**
   * 任务所用模型的用户可见标签（如 grok-4.5）。
   * 来源：会话级 model / modelProviderId 绑定；无绑定时省略。
   */
  readonly modelLabel?: string;
  /**
   * 提供商展示标签（如 xai / openai）。
   * 来源：modelProviderId 的 group 段；无绑定时省略。
   */
  readonly providerLabel?: string;
  /** 动作按钮标签（原型「处理 →」「验收 →」「继续 →」）。 */
  readonly actionLabel: string;
  /** 关联的 conversationId，用于深链跳转。 */
  readonly conversationId?: string;
}

// ---------------------------------------------------------------------------
// 投影输入：最小快照
// ---------------------------------------------------------------------------

/** GoalPlan 投影所需的最小字段快照。 */
export interface ConversationProjectionSnapshot {
  readonly conversationId: string;
  readonly title: string;
  readonly workspaceLabel?: string;
  readonly updatedAt?: string;
  /**
   * 用户已读水位（ISO）。首页「正在讨论」只投影未读沟通：
   * 无 lastReadAt，或 updatedAt > lastReadAt。
   */
  readonly lastReadAt?: string | null;
  /** 会话绑定模型标签；无绑定时省略。 */
  readonly modelLabel?: string;
  /** 提供商标签；无绑定时省略。 */
  readonly providerLabel?: string;
}

export interface GoalPlanProjectionSnapshot {
  readonly planId: string;
  readonly status: GoalPlanStatus;
  /** Runner 实时态；Plan 未进入自驱时为 undefined。 */
  readonly runnerStatus?: GoalRunnerStatus;
  /** Runner 上存在尚未被 resume 消费的网络/流式中断事实。 */
  readonly interrupted?: boolean;
  /** 持久化中断事实中的用户可展示原因。 */
  readonly interruptionReason?: string;
  readonly title: string;
  readonly workspaceLabel?: string;
  readonly progress?: { readonly completed: number; readonly total: number };
  /** 叶子步骤投影；无任务树时省略。 */
  readonly planSteps?: readonly TaskOverviewPlanStep[];
  readonly updatedAt?: string;
  readonly conversationId?: string;
  /**
   * GoalPlan.timing 原样透传；投影层用 projectGoalTiming 计算 durationMs。
   * 调用方不预计算，避免 main 与 protocol 各算一遍。
   */
  readonly timing?: GoalTiming;
  /**
   * 会话模型绑定投影出的展示标签（如 grok-4.5）。
   * 由聚合层从 conversation.model / modelProviderId 解析后写入。
   */
  readonly modelLabel?: string;
  /**
   * 提供商展示标签（如 xai）。
   * 由聚合层从 modelProviderId 的 group 段解析后写入。
   */
  readonly providerLabel?: string;
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

/**
 * 后台 shell 线程投影所需的最小字段快照。
 * 来源：runtime shell task manager（listShellTasks）。
 */
export interface ShellBackgroundProjectionSnapshot {
  readonly taskId: string;
  readonly command: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | string;
  readonly workspaceLabel?: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
  readonly toolCallId?: string;
  readonly conversationId?: string;
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

/** Conversation → 无计划讨论态（工作台动线 §15）。 */
/**
 * 会话是否对首页「正在讨论」可见（未读）。
 * - 无 updatedAt：不可见
 * - 无 lastReadAt：视为未读（兼容旧数据；打开后写入水位）
 * - updatedAt > lastReadAt：未读
 */
export function isConversationUnreadForDiscussion(
  snapshot: Pick<ConversationProjectionSnapshot, 'updatedAt' | 'lastReadAt'>,
): boolean {
  const updatedAt =
    typeof snapshot.updatedAt === 'string' && snapshot.updatedAt.trim()
      ? snapshot.updatedAt.trim()
      : '';
  if (!updatedAt) return false;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  const lastReadAt =
    typeof snapshot.lastReadAt === 'string' && snapshot.lastReadAt.trim()
      ? snapshot.lastReadAt.trim()
      : '';
  if (!lastReadAt) return true;
  const readMs = Date.parse(lastReadAt);
  if (!Number.isFinite(readMs)) return true;
  return updatedMs > readMs;
}

export function projectConversation(
  snapshot: ConversationProjectionSnapshot,
): TaskOverviewItem {
  const modelLabel =
    typeof snapshot.modelLabel === 'string' && snapshot.modelLabel.trim()
      ? snapshot.modelLabel.trim()
      : undefined;
  const providerLabel =
    typeof snapshot.providerLabel === 'string' && snapshot.providerLabel.trim()
      ? snapshot.providerLabel.trim()
      : undefined;
  const unread = isConversationUnreadForDiscussion(snapshot);
  return {
    taskId: snapshot.conversationId,
    source: 'conversation',
    actionRight: 'paused',
    nextAction: 'continue_task',
    title: snapshot.title,
    ...(snapshot.workspaceLabel ? { workspaceLabel: snapshot.workspaceLabel } : {}),
    // 已读水位只改变状态，不应把会话从历史投影中删除。
    statusLabel: unread ? '有未读' : '已读',
    ...(snapshot.updatedAt ? { lastActiveAt: snapshot.updatedAt } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    actionLabel: '打开',
    conversationId: snapshot.conversationId,
  };
}

/**
 * GoalPlan 行动权投影（§11.3 rule 1-16 的 GoalPlan/Runner 分支）。
 *
 * 判定顺序（首个命中生效），Plan 态优先于 Runner 态（§11.4 决策 1）：
 *  1. plan awaiting_approval → needs_you/plan_approval
 *  2. plan drafting → needs_you/plan_approval
 *  4. runner waiting_user → needs_you/user_input
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
  options?: { readonly nowMs?: number },
): TaskOverviewItem {
  const decision = decideGoalPlan(snapshot);
  const projectedTiming = projectGoalTiming(snapshot.timing, options?.nowMs);
  const durationMs =
    typeof projectedTiming?.activeMs === 'number' && Number.isFinite(projectedTiming.activeMs)
      ? Math.max(0, Math.floor(projectedTiming.activeMs))
      : undefined;
  const modelLabel =
    typeof snapshot.modelLabel === 'string' && snapshot.modelLabel.trim()
      ? snapshot.modelLabel.trim()
      : undefined;
  const providerLabel =
    typeof snapshot.providerLabel === 'string' && snapshot.providerLabel.trim()
      ? snapshot.providerLabel.trim()
      : undefined;
  // 完成时间：优先 timing.completedAt；终态计划缺省时回落 updatedAt，供待验收卡片展示。
  const completedAtFromTiming =
    typeof projectedTiming?.completedAt === 'string' && projectedTiming.completedAt
      ? projectedTiming.completedAt
      : typeof snapshot.timing?.completedAt === 'string' && snapshot.timing.completedAt.trim()
        ? snapshot.timing.completedAt.trim()
        : undefined;
  const isTerminalPlan =
    snapshot.status === 'completed'
    || snapshot.status === 'failed'
    || snapshot.status === 'cancelled';
  const completedAt =
    completedAtFromTiming
    ?? (isTerminalPlan && typeof snapshot.updatedAt === 'string' && snapshot.updatedAt.trim()
      ? snapshot.updatedAt.trim()
      : undefined);
  return {
    taskId: snapshot.planId,
    source: 'goal_plan',
    actionRight: decision.actionRight,
    ...(decision.needsYouReason ? { needsYouReason: decision.needsYouReason } : {}),
    nextAction: decision.nextAction,
    title: snapshot.title,
    ...(snapshot.workspaceLabel ? { workspaceLabel: snapshot.workspaceLabel } : {}),
    statusLabel: decision.statusLabel,
    ...(decision.actionRight === 'paused' && snapshot.interruptionReason
      ? { issueDetail: snapshot.interruptionReason }
      : {}),
    ...(snapshot.progress ? { planProgress: snapshot.progress } : {}),
    ...(snapshot.planSteps && snapshot.planSteps.length > 0
      ? { planSteps: snapshot.planSteps }
      : {}),
    ...(snapshot.updatedAt ? { lastActiveAt: snapshot.updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    actionLabel: decision.actionLabel,
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
  };
}

function decideGoalPlan(snapshot: GoalPlanProjectionSnapshot): ProjectionDecision {
  const { status, runnerStatus, interrupted, accepted } = snapshot;

  // 未消费的网络/流式中断是当前行动权事实，优先于 completed/result_ready。
  // 用户显式 resume 后 store 会原子清除此事实，再按正常计划状态投影。
  if (interrupted === true) {
    return {
      actionRight: 'paused',
      nextAction: 'resume',
      statusLabel: '执行中断',
      actionLabel: '继续 →',
    };
  }

  // request_user_input 是明确的当前行动权事实。即使旧记录或竞态窗口里
  // plan 已先写成 completed，只要 Runner 仍在 waiting_user，就必须先让用户回答，
  // 不能把尚未消费的问题误投影成结果待验收。
  if (status === 'completed' && runnerStatus === 'waiting_user') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'user_input',
      nextAction: 'answer_question',
      statusLabel: '等待你的选择',
      actionLabel: '回答 →',
    };
  }

  // rule 16 first: 其他终态计划优先于 runner 残留态
  // （历史 failed/cancelled/completed 上的 runner.blocked 不得再进 needs_you）
  if (status === 'completed' && accepted !== true) {
    // rule 6: 完成且未验收 → 结果就绪
    return {
      actionRight: 'result_ready',
      nextAction: 'review_result',
      statusLabel: '待用户验收',
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
  const planStillActive =
    status === 'executing' || status === 'accepted' || status === 'approved';
  // rule 4: Runner 已明确把行动权交给用户，不再展示为“Peer 正在推进”。
  if (planStillActive && runnerStatus === 'waiting_user') {
    return {
      actionRight: 'needs_you',
      needsYouReason: 'user_input',
      nextAction: 'answer_question',
      statusLabel: '等待你的选择',
      actionLabel: '回答 →',
    };
  }
  // rule 5: 仅活跃计划上的 Runner 实时求助才进 needs_you
  // （plan 必须仍在推进：executing/accepted/approved；历史僵尸 blocked 不进）
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

/**
 * 后台 shell 线程 → 工作台「Peer 正在推进」卡片。
 * 运行中进 peer_advancing；已结束但短暂可观察时仍投影为 terminal，供右侧面板回看。
 */
export function projectShellBackgroundTask(
  snapshot: ShellBackgroundProjectionSnapshot,
): TaskOverviewItem {
  const command = String(snapshot.command ?? '').trim() || '后台 shell 任务';
  const title = command.length > 72 ? `${command.slice(0, 71)}…` : command;
  const status = String(snapshot.status ?? '').trim().toLowerCase();
  const running = status === 'running' || status === '';
  const lastActiveAt =
    (typeof snapshot.completedAt === 'string' && snapshot.completedAt) ||
    (typeof snapshot.startedAt === 'string' && snapshot.startedAt) ||
    undefined;

  return {
    taskId: `shell:${snapshot.taskId}`,
    source: 'shell_background',
    actionRight: running ? 'peer_advancing' : 'terminal',
    nextAction: 'open_background_thread',
    title,
    ...(snapshot.workspaceLabel ? { workspaceLabel: snapshot.workspaceLabel } : {}),
    statusLabel: running ? '后台线程运行中' : shellBackgroundTerminalLabel(status),
    ...(lastActiveAt ? { lastActiveAt } : {}),
    actionLabel: running ? '查看线程 →' : '查看 →',
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
  };
}

function shellBackgroundTerminalLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '后台线程已完成';
    case 'failed':
      return '后台线程失败';
    case 'cancelled':
      return '后台线程已停止';
    case 'timed_out':
      return '后台线程超时';
    default:
      return '后台线程';
  }
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
  // rule 17: Run 终态（succeeded 已在 rule 7 提前 return）
  if (
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
