/**
 * exec 无 TTY 的 Goal Runner 驱动 —— 让 `peer exec "任务"` 单次调用闭环。
 *
 * 背景：exec 的一次 `controller.send()` 里模型可能通过 goal 工具创建了 GoalPlan
 * （`goal_create_plan`），但 send() 结束后进程即退出，没有任何东西像 Desktop/TUI
 * 那样在计划 accepted 后 kick 共享 Goal Runner，于是计划停在 `0/N · accepted`。
 *
 * 本模块在 exec 进程内补上「驱动装置」：
 * 1. send() 前后对比 conversation 的计划列表，识别本轮新建的计划；
 * 2. 若存在非终态的新计划，创建共享 Goal Runner（与 TUI 同一套 adapter）接管；
 * 3. 等待 Runner 泵把计划推进到终态（completed/failed/cancelled）或人工停止态
 *    （waiting_user/blocked/paused/budget_exhausted）；
 * 4. 把停止语义映射为 CLI 退出码与结构化 JSON 报告（cli-output.ts 的 goal 字段）。
 *
 * 权限、manual DoD、drift 等闸门全部保留原语义：本模块只做「等待 + 映射」，
 * 绝不代答/放行。需要人工介入时以非零退出码 + 原因清单退出。
 */

import { createTuiSharedGoalRunner } from './goal-runner-adapter.ts';
import type { ExecGoalStopReport } from './cli-output.ts';

/** 计划级终态：进程等待到这里即可返回。 */
const TERMINAL_PLAN_STATUSES = new Set(['completed', 'cancelled', 'failed']);
/** Runner 停止态：需要人工介入，exec 无法继续自驱。 */
const STOPPED_RUNNER_STATUSES = new Set(['paused', 'blocked', 'budget_exhausted']);

/** 默认等待上限：防止泵卡死时 exec 永不退出（用户仍可用 Ctrl+C）。 */
const DEFAULT_DRIVE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecGoalDriveOptions {
  /** TUI chat controller（已满足 Runner 所需的 runGoalTurn/runExplorer/runVerifier 面）。 */
  readonly chat: Parameters<typeof createTuiSharedGoalRunner>[0]['chat'];
  /** exec 会话的 goal bridge（共享 store + 工具）。 */
  readonly bridge: Parameters<typeof createTuiSharedGoalRunner>[0]['bridge'];
  /** 本 exec 进程承载的 conversationId。 */
  readonly getConversationId: () => string | undefined;
  /** send() 之前该 conversation 已存在的 planId 集合。 */
  readonly planIdsBefore: ReadonlySet<string>;
  /** 等待超时（毫秒），默认 30 分钟。 */
  readonly timeoutMs?: number;
  /** 日志器，默认静默。 */
  readonly log?: (message: string) => void;
}

export interface ExecGoalDriveOutcome {
  /** 是否有新计划被创建且被 exec 接管（false = 无 goal，行为与旧版完全一致）。 */
  readonly drove: boolean;
  /** 最终退出码语义。 */
  readonly exitKind: 'ok' | 'cancelled' | 'goal_failed' | 'waiting_user';
  /** 结构化停止报告（JSON 输出用）。 */
  readonly report: ExecGoalStopReport | null;
}

function planProgress(plan: any): { completed: number; total: number } | null {
  const progress = plan?.progress;
  if (progress && typeof progress === 'object') {
    const completed = Number(progress.completed);
    const total = Number(progress.total);
    if (Number.isFinite(completed) && Number.isFinite(total)) return { completed, total };
  }
  // meta 视图可能不带 progress：从任务列表统计（与 store 的叶子语义一致）。
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (tasks.length === 0) return null;
  const completed = tasks.filter((t: any) => t?.status === 'completed').length;
  return { completed, total: tasks.length };
}

function manualDodCriterionIds(plan: any): readonly string[] {
  // Runner 的 blockForManualDodConfirmation 把待确认 manual 标准写进 gate 语义；
  // 计划侧的 manualConfirmations 记录已确认项，待确认 = manual 标准 - 已确认。
  const criteria = Array.isArray(plan?.successCriteria) ? plan.successCriteria : [];
  const confirmed = new Set(
    (Array.isArray(plan?.manualConfirmations) ? plan.manualConfirmations : [])
      .map((entry: any) => entry?.criterionId)
      .filter((id: unknown): id is string => typeof id === 'string'),
  );
  return criteria
    .filter((criterion: any) => criterion?.id && criterion?.kind === 'manual' && !confirmed.has(criterion.id))
    .map((criterion: any) => criterion.id as string);
}

function waitingQuestionOf(plan: any): string | null {
  const request = plan?.runner?.requestedInput;
  if (request && typeof request === 'object' && typeof request.question === 'string' && request.question.trim()) {
    return request.question.trim();
  }
  return null;
}

function buildStopReport(planId: string, plan: any): ExecGoalStopReport {
  const runner = plan?.runner ?? null;
  return {
    planId,
    planStatus: typeof plan?.status === 'string' ? plan.status : null,
    runnerStatus: typeof runner?.status === 'string' ? runner.status : null,
    exitReason: typeof runner?.blockedReason === 'string' && runner.blockedReason
      ? runner.blockedReason
      : waitingQuestionOf(plan) ? 'requested_user_input' : null,
    blockedReason: typeof runner?.blockedReason === 'string' ? runner.blockedReason : null,
    waitingQuestion: waitingQuestionOf(plan),
    pendingManualDoD: manualDodCriterionIds(plan),
    progress: planProgress(plan),
  };
}

function classify(plan: any): ExecGoalDriveOutcome['exitKind'] {
  const status = plan?.status;
  const runnerStatus = plan?.runner?.status;
  // Runner 停止态优先：manual DoD 确认路径下计划状态可能已是 completed，但 runner
  // blocked（manual_dod_confirmation_required）——人工闸门未过不得算 ok。
  if (STOPPED_RUNNER_STATUSES.has(runnerStatus) || runnerStatus === 'waiting_user') {
    if (status === 'cancelled') return 'cancelled';
    return 'waiting_user';
  }
  if (status === 'completed') return 'ok';
  if (status === 'cancelled') return 'cancelled';
  // 非终态 + 待确认 manual DoD：等待人工验收，不是失败。
  if (manualDodCriterionIds(plan).length > 0) return 'waiting_user';
  if (status === 'failed') return 'goal_failed';
  // 非终态 + Runner 停止：人工介入路径。
  return 'waiting_user';
}

/**
 * 驱动本轮新建的 GoalPlan 到终态/停止态。
 *
 * 契约：
 * - 只有 send() 期间新创建的计划会被接管；恢复既有计划（--goal）不在本模块范围。
 * - 同一时刻只驱动一个计划（exec 是单任务进程）；若出现多个新计划，取最新创建的一个，
 *   其余保持原状由交互端接管。
 * - 任何 Runner 侧异常都映射为 waiting_user 退出（宁可让人看一眼，也不静默假完成）。
 */
export async function driveNewGoalPlansToSettled(options: ExecGoalDriveOptions): Promise<ExecGoalDriveOutcome> {
  const { bridge, chat, getConversationId, planIdsBefore } = options;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;

  const conversationId = getConversationId();
  if (!conversationId) return { drove: false, exitKind: 'ok', report: null };

  const plans = bridge.listPlansByConversation(conversationId) ?? [];
  // 本轮新建的计划（含已在 send() 轮内跑到终态的——那正是自驱最快的形态）。
  const newPlans = plans.filter((plan: any) => {
    const planId = typeof plan?.planId === 'string' ? plan.planId : null;
    return planId && !planIdsBefore.has(planId);
  });
  if (newPlans.length === 0) return { drove: false, exitKind: 'ok', report: null };

  // 已到终态的新计划：无需驱动，直接分类汇报（send() 轮内即完成的快路径）。
  const settled = newPlans.filter((plan: any) => TERMINAL_PLAN_STATUSES.has(plan?.status));
  if (settled.length > 0) {
    const target = settled.reduce((latest: any, plan: any) => (
      String(plan?.updatedAt ?? '') > String(latest?.updatedAt ?? '') ? plan : latest
    ));
    // meta 视图不带 tasks/progress：取全量计划构建报告。
    const full = bridge.getPlan(target.planId) ?? target;
    return { drove: true, exitKind: classify(full), report: buildStopReport(target.planId, full) };
  }

  // 取 updatedAt 最新的计划作为驱动对象。
  const target = newPlans.reduce((latest: any, plan: any) => (
    String(plan?.updatedAt ?? '') > String(latest?.updatedAt ?? '') ? plan : latest
  ));
  const planId = target.planId as string;
  log(`[exec-goal] new plan ${planId} detected; attaching shared goal runner`);

  let runner: ReturnType<typeof createTuiSharedGoalRunner> | null = null;
  try {
    runner = createTuiSharedGoalRunner({
      bridge,
      chat,
      getConversationId,
      // autoStart 交给本模块显式控制：send() 已结束，不存在「等 intake turn 收尾」的竞态。
      autoStart: false,
    });
  } catch (error) {
    log(`[exec-goal] runner create failed: ${error instanceof Error ? error.message : String(error)}`);
    const plan = bridge.getPlan(planId);
    return { drove: true, exitKind: 'waiting_user', report: buildStopReport(planId, plan) };
  }

  const settleDeadline = Date.now() + timeoutMs;
  try {
    // accepted/executing 计划：显式 kick 一次泵。已停止的计划（waiting_user 等）
    // 说明模型在 send() 轮内已触发人工路径，直接进入等待分类即可。
    const initial = bridge.getPlan(planId);
    const initialRunnerStatus = initial?.runner?.status;
    const startable = initial?.status === 'accepted' || initial?.status === 'executing';
    if (startable && (!initialRunnerStatus || ['idle', 'paused'].includes(initialRunnerStatus))) {
      await runner.start(planId);
    }

    // 等待终态或停止态。
    for (;;) {
      const plan = bridge.getPlan(planId);
      const planStatus = plan?.status;
      const runnerStatus = plan?.runner?.status;
      if (TERMINAL_PLAN_STATUSES.has(planStatus)) break;
      if (STOPPED_RUNNER_STATUSES.has(runnerStatus)) break;
      if (runnerStatus === 'waiting_user') break;
      if (Date.now() >= settleDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // 泵可能仍在跑最后一轮；等它排空，避免进程退出时截断写盘。
    try {
      await Promise.race([
        runner.waitForIdle(planId),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // waitForIdle 失败不影响分类：store 状态已足够。
    }

    const plan = bridge.getPlan(planId);
    const exitKind = classify(plan);
    return { drove: true, exitKind, report: buildStopReport(planId, plan) };
  } finally {
    // adapter 无 stop：autoStart=false 时它未注册任何 store 订阅，
    // waitForIdle 已在上方等待排空，这里无需额外清理。
  }
}

/** 供 cli-exec 在 send() 之前采集计划基线。 */
export function collectPlanIds(bridge: { listPlansByConversation(id: string | null | undefined): readonly any[] }, conversationId: string | undefined): ReadonlySet<string> {
  if (!conversationId) return new Set();
  const ids = new Set<string>();
  for (const plan of bridge.listPlansByConversation(conversationId) ?? []) {
    if (typeof plan?.planId === 'string') ids.add(plan.planId);
  }
  return ids;
}
