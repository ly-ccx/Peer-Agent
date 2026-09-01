import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, ReactNode, Ref } from 'react';
import type {
  ExecutionStatus,
  GoalExplorerRun,
  GoalManualConfirmation,
  GoalPlan,
  GoalRunEvent,
  GoalRunnerPhase,
  GoalRunnerState,
  GoalRunnerStatus,
  GoalSuccessCriterion,
  GoalTask,
  GoalVerifierRun,
} from '@peer-agent/protocol';
import {
  formatGoalDeliveryHandoff,
  formatGoalDeliveryHandoffLamp,
  formatGoalDeliveryRoute,
  projectGoalTiming,
} from '@peer-agent/protocol';
import { snapshotDeliveryLine, type TaskDeliveryLine } from '../state/taskBoundBranch';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { Tooltip } from '../../app/components/Tooltip';
import { clientApi } from '../../clientApi';
import { formatDuration } from '../state/format';
import { InteractionActionsContext, InteractionStreamingContext } from './thread/interactionContext';
import { useGoalPlanApproval } from './goal/useGoalPlanApproval';
import { SuccessCriteriaEditor, type SuccessCriteriaEditorHandle } from './goal/SuccessCriteriaEditor';
import { shouldShowGoalCompletionFeedback } from './goal/goalCompletionFeedback';
import {
  continueFixingMessage,
  getGoalPlanNextStep,
  goalPlanNextStepCopy,
  type GoalPlanNextAction,
} from './goal/goalPlanNextActions';
import { hasPendingGoalApproval, selectPrimaryGoalPlan, shouldDefaultExpandGoalPlan } from './goal/goalPlanExpansion';
import { orderGoalPlansByLineage } from './goal/goalPlanOrder';

function normalizeConversationId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

type GoalChangePayload = {
  reason?: string;
  type?: string;
  planId?: string | null;
  conversationId?: string | null;
  changeKind?: string | null;
  runner?: GoalPlan['runner'] | Partial<GoalRunnerState> | null;
};

function shouldRefreshForConversation(
  payload: GoalChangePayload | undefined,
  conversationId: string | null,
  plans: readonly GoalPlan[],
): boolean {
  if (!conversationId) return false;
  const eventConversationId = normalizeConversationId(payload?.conversationId);
  if (eventConversationId) return eventConversationId === conversationId;
  const planId = typeof payload?.planId === 'string' ? payload.planId : null;
  if (planId) {
    // 已有本会话列表时，仅当 planId 属于当前列表才刷新；空列表保守刷新。
    if (plans.length === 0) return true;
    return plans.some((plan) => plan.planId === planId);
  }
  // 缺 conversationId/planId：保守刷新，避免漏更新。
  return true;
}

/** Runner 展示指纹：双通道可能投递等价快照，避免重复 setState。 */
function runnerFingerprint(runner: GoalPlan['runner'] | Partial<GoalRunnerState> | null | undefined): string {
  if (!runner) return '';
  const r = runner as Record<string, unknown>;
  return [
    r.status ?? '',
    r.phase ?? '',
    r.enabled === true ? '1' : r.enabled === false ? '0' : '',
    r.roundCount ?? '',
    r.toolCallCount ?? '',
    r.intent ?? '',
    r.currentTaskId ?? '',
    r.lastTickAt ?? '',
    r.lastError ?? '',
  ].join('|');
}

function patchPlanRunner(
  plans: readonly GoalPlan[],
  planId: string | null | undefined,
  runner: GoalPlan['runner'] | Partial<GoalRunnerState> | null | undefined,
): readonly GoalPlan[] | null {
  if (!planId || !runner) return null;
  let changed = false;
  const next = plans.map((plan) => {
    if (plan.planId !== planId) return plan;
    const mergedRunner = {
      ...(plan.runner ?? {}),
      ...runner,
    } as GoalRunnerState;
    // 引用相同或关键展示字段未变：吞掉 goalPlans/goalRunner 双通道重复投递。
    if (plan.runner === mergedRunner) return plan;
    if (runnerFingerprint(plan.runner) === runnerFingerprint(mergedRunner)) return plan;
    changed = true;
    return {
      ...plan,
      runner: mergedRunner,
      updatedAt: mergedRunner.updatedAt || plan.updatedAt,
    };
  });
  return changed ? next : null;
}

function isIntakePlan(plan: GoalPlan): boolean {
  return plan.activation?.kind === 'intake';
}

function isDisplayableGoalPlan(plan: GoalPlan): boolean {
  return plan.status !== 'cancelled' && !isIntakePlan(plan);
}

/**
 * Goal 模式计划面板 —— 见 Goal 模式设计。
 *
 * 治理红线（与提案 §3/§6 一致）：
 * - 完成状态由 Evidence 自底向上聚合，面板「只读展示」进度与子任务状态，绝不提供手动打勾完成的入口。
 * - 面板允许的写操作仅限「治理事实」：批准 / 驳回（带 confirmationId 的 HumanConfirmation）。
 * - 所有持久化经 clientApi → preload → IPC → goal-plan-store，renderer 不直接碰 fs。
 *
 * 本组件从 ChatSurface 拆出，避免继续撑大巨石组件（AGENTS.md Module Design Rules）。
 */

interface GoalPlanPanelProps {
  readonly conversationId: string | null;
  readonly isZh: boolean;
  /**
   * 批准成功后回调。由 ChatSurface 注入，用于唤起 chat runtime 发起「执行轮」
   * （复用既有 submitMessage 发送路径，不另造旁路）。
   * 缺省时面板仅落库 + 刷新，不驱动执行（保持向后兼容）。
   * 见 Goal 模式设计 时序图阶段二→阶段三。
   */
  readonly onApproved?: (plan: GoalPlan) => void;
  /**
   * 方案 B（右侧常驻分栏）：展开态的计划详情 body 通过 createPortal 投影到此容器，
   * 由 ChatSurface 在主内容区右侧提供的 <aside> slot。
   * 折叠浮条（toggle）仍渲染在原位（输入框上方）。
   * 缺省（null/未注入）时回退为「就地内联展开」的旧行为，保持向后兼容与可测试性。
   */
  readonly sidePanelContainer?: HTMLElement | null;
  /**
   * 计划数量变更时通知（包括从 0 到 N、N 到 0）。
   * 用于让右侧 Workbench 切换 Goal tab 的可点状态、并在 0→N 瞬间自动展开 + 选中 Goal。
   */
  readonly onPlansCountChange?: (count: number) => void;
  /**
   * 「本会话内真正新建了计划」时触发（plans 由 0→N，且只在 goalPlans:changed 广播驱动的
   * reload 路径检测；切换会话的 load 路径只刷新基线、绝不触发）。
   * 由 ChatSurface 接住用于自动展开 Workbench 并切到 Goal tab。
   * 这样「切到一个本来就有计划的会话」不会被误判为新建而自动弹开侧栏。
   */
  readonly onGoalPlanCreated?: () => void;
  /**
   * docked 灯条被点击。当面板已迁到 Workbench 时，由上层负责展开 Workbench 并切到 Goal tab。
   */
  readonly onRequestHostFocus?: () => void;
  /**
   * 当前活动计划的交付线快照。用于输入栏展示任务线 / 隔离标记；无绑定则报 null。
   * 表达层只读，隔离真值仍以 deliveryBinding 为准。
   */
  readonly onActiveDeliveryChange?: (line: TaskDeliveryLine | null) => void;
}

function statusLabel(status: ExecutionStatus, isZh: boolean): string {
  switch (status) {
    case 'completed':
      return isZh ? '已完成' : 'Done';
    case 'running':
      return isZh ? '进行中' : 'Running';
    case 'failed':
      return isZh ? '失败' : 'Failed';
    case 'cancelled':
      return isZh ? '已取消' : 'Cancelled';
    case 'waiting_user':
      return isZh ? '阻塞' : 'Blocked';
    case 'pending':
    default:
      return isZh ? '待办' : 'Pending';
  }
}

function statusClass(status: ExecutionStatus): string {
  return `goal-task-status goal-task-status--${status}`;
}

function planExecutionStatus(status: GoalPlan['status']): ExecutionStatus {
  switch (status) {
    case 'executing':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'drafting':
    case 'awaiting_approval':
    default:
      return 'pending';
  }
}

/**
 * 计划标题展示：只信 plan.title。空/占位时不再用 goal 首句冒充标题，
 * 否则浮动条会继续显示用户原话；意图短标题由创建/修订链路写入。
 */
function derivePlanTitle(plan: GoalPlan, isZh: boolean): string {
  const title = typeof plan.title === 'string' ? plan.title.trim() : '';
  if (title && title !== '未命名任务') return title;
  return isZh ? '未命名计划' : 'Untitled plan';
}

function planStatusLabel(status: GoalPlan['status'], isZh: boolean): string {
  const zh: Record<GoalPlan['status'], string> = {
    drafting: '草拟中',
    awaiting_approval: '待批准',
    approved: '已批准',
    accepted: '已接受',
    executing: '执行中',
    paused: '已暂停',
    completed: '已完成',
    cancelled: '已取消',
    failed: '已失败',
  };
  const en: Record<GoalPlan['status'], string> = {
    drafting: 'Drafting',
    awaiting_approval: 'Awaiting approval',
    approved: 'Approved',
    accepted: 'Accepted',
    executing: 'Executing',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  return isZh ? zh[status] : en[status];
}

function safeProgress(plan: GoalPlan): GoalPlan['progress'] {
  return plan.progress ?? { total: 0, completed: 0, failed: 0, blocked: 0, percent: 0 };
}

/** 历史任务/事件可能没写 evidenceRefs；按空列表渲染，避免点开会话时读 undefined.length。 */
function safeEvidenceRefs(
  value: { readonly evidenceRefs?: readonly string[] | null } | null | undefined,
): readonly string[] {
  return Array.isArray(value?.evidenceRefs) ? value.evidenceRefs : [];
}

/** 深度优先展开任务树（含嵌套 subtasks）。 */
function collectGoalTasks(tasks: readonly GoalTask[] | undefined): GoalTask[] {
  if (!tasks || tasks.length === 0) return [];
  const out: GoalTask[] = [];
  const walk = (nodes: readonly GoalTask[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.subtasks && node.subtasks.length > 0) walk(node.subtasks);
    }
  };
  walk(tasks);
  return out;
}

function GoalTaskStatusIcon({ status }: { readonly status: ExecutionStatus }): ReactElement {
  const common = {
    className: 'goal-panel-toggle-progress-tooltip__icon-svg',
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  switch (status) {
    case 'completed':
      return (
        <svg {...common}>
          <path d="M3.5 8.2 6.4 11 12.5 4.8" />
        </svg>
      );
    case 'failed':
      return (
        <svg {...common}>
          <path d="M4.2 4.2 11.8 11.8" />
          <path d="M11.8 4.2 4.2 11.8" />
        </svg>
      );
    case 'running':
      return (
        <svg {...common} className={`${common.className} goal-panel-toggle-progress-tooltip__icon-svg--spin`}>
          <path d="M8 2.5a5.5 5.5 0 1 1-4.6 2.5" />
        </svg>
      );
    case 'waiting_user':
      return (
        <svg {...common}>
          <path d="M5.2 3.8v8.4" />
          <path d="M10.8 3.8v8.4" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...common}>
          <path d="M4 8h8" />
        </svg>
      );
    case 'pending':
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3.2" />
        </svg>
      );
  }
}

function renderGoalTasksTooltipContent(
  plan: GoalPlan,
  isZh: boolean,
): ReactNode {
  const tasks = collectGoalTasks(plan.tasks);
  if (tasks.length === 0) {
    return (
      <span className="goal-panel-toggle-progress-tooltip">
        <span className="goal-panel-toggle-progress-tooltip__icon goal-panel-toggle-progress-tooltip__icon--pending">
          <GoalTaskStatusIcon status="pending" />
        </span>
        <span className="goal-panel-toggle-progress-tooltip__title">
          {isZh ? '暂无步骤' : 'No steps'}
        </span>
      </span>
    );
  }

  return (
    <span className="goal-panel-toggle-progress-tooltip goal-panel-toggle-progress-tooltip--list">
      <span className="goal-panel-toggle-progress-tooltip__list" role="list">
        {tasks.map((task) => (
          <span
            key={task.taskId}
            className="goal-panel-toggle-progress-tooltip__row"
            role="listitem"
          >
            <span
              className={`goal-panel-toggle-progress-tooltip__icon goal-panel-toggle-progress-tooltip__icon--${task.status}`}
            >
              <GoalTaskStatusIcon status={task.status} />
            </span>
            <span className="goal-panel-toggle-progress-tooltip__title">{task.title}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Live 时钟：仅在有 open segment / 进行中 timing 时 1s 刷新。 */
function useLiveNowMs(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return nowMs;
}

function formatGoalTimingLabel(
  plan: GoalPlan,
  isZh: boolean,
  nowMs: number,
): string | null {
  const projected = projectGoalTiming(plan.timing, nowMs);
  if (!projected || typeof projected.activeMs !== 'number') return null;
  const duration = formatDuration(projected.activeMs);
  if (projected.isLive) {
    return isZh ? `运行中 · ${duration}` : `Running · ${duration}`;
  }
  return isZh ? `用时 ${duration}` : `${duration}`;
}

function explorerStatusLabel(status: GoalExplorerRun['status'], isZh: boolean): string {
  const zh: Record<GoalExplorerRun['status'], string> = {
    queued: '排队中',
    running: '探索中',
    completed: '已完成',
    failed: '已失败',
    cancelled: '已取消',
  };
  const en: Record<GoalExplorerRun['status'], string> = {
    queued: 'Queued',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return isZh ? zh[status] : en[status];
}

function verifierStatusLabel(status: GoalVerifierRun['status'], isZh: boolean): string {
  const zh: Record<GoalVerifierRun['status'], string> = {
    queued: '排队中',
    running: '复核中',
    passed: '已通过',
    failed: '未通过',
    blocked: '阻塞',
  };
  const en: Record<GoalVerifierRun['status'], string> = {
    queued: 'Queued',
    running: 'Verifying',
    passed: 'Passed',
    failed: 'Failed',
    blocked: 'Blocked',
  };
  return isZh ? zh[status] : en[status];
}

function verifierTargetLabel(verifier: GoalVerifierRun, isZh: boolean): string {
  if (verifier.target.kind === 'task') {
    return `${isZh ? '任务' : 'Task'} ${verifier.target.taskId ?? ''}`.trim();
  }
  if (verifier.target.kind === 'success_criterion') {
    return `${isZh ? '标准' : 'Criterion'} ${verifier.target.criterionId ?? ''}`.trim();
  }
  return isZh ? '计划复核' : 'Plan verification';
}

function runnerPhaseLabel(phase: GoalRunnerPhase | undefined, isZh: boolean): string {
  if (!phase) return isZh ? '未开始' : 'Not started';
  const zh: Record<GoalRunnerPhase, string> = {
    orient: '定向',
    inspect: '探查',
    plan_scaffold: '搭骨架',
    act: '执行',
    verify: '验证',
    repair: '修复',
    quality_review: '质量复核',
    synthesize: '收束',
    blocked: '阻塞',
  };
  const en: Record<GoalRunnerPhase, string> = {
    orient: 'Orient',
    inspect: 'Inspect',
    plan_scaffold: 'Plan scaffold',
    act: 'Act',
    verify: 'Verify',
    repair: 'Repair',
    quality_review: 'Quality review',
    synthesize: 'Synthesize',
    blocked: 'Blocked',
  };
  return isZh ? zh[phase] : en[phase];
}

// Runner 处于活动态时才允许 pause；非终态可 clear；暂停/阻塞/预算耗尽可 resume。
const RUNNER_ACTIVE_STATUSES: ReadonlySet<GoalRunnerStatus> = new Set([
  'running',
  'exploring',
]);
const RUNNER_RESUMABLE_STATUSES: ReadonlySet<GoalRunnerStatus> = new Set([
  'paused',
  'blocked',
  'budget_exhausted',
]);
const RUNNER_TERMINAL_STATUSES: ReadonlySet<GoalRunnerStatus> = new Set([
  'completed',
  'failed',
]);
const AUTO_CRITERION_KINDS: ReadonlySet<string> = new Set([
  'command',
  'test',
  'file-contains',
  'file-exists',
]);

function manualDodCriteria(plan: GoalPlan): GoalSuccessCriterion[] {
  return (Array.isArray(plan.successCriteria) ? plan.successCriteria : [])
    .filter((criterion): criterion is GoalSuccessCriterion => (
      !!criterion &&
      typeof criterion === 'object' &&
      typeof criterion.id === 'string' &&
      criterion.id.trim().length > 0 &&
      !AUTO_CRITERION_KINDS.has(criterion.kind)
    ));
}

function latestManualDodConfirmation(plan: GoalPlan, criterionIds: readonly string[]): GoalManualConfirmation | null {
  const expected = new Set(criterionIds);
  if (expected.size === 0) return null;
  const matches = (Array.isArray(plan.manualConfirmations) ? plan.manualConfirmations : [])
    .filter((confirmation) => confirmation.kind === 'manual_dod')
    .filter((confirmation) => {
      const ids = new Set(confirmation.criterionIds);
      for (const id of expected) {
        if (!ids.has(id)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')));
  return matches[0] ?? null;
}

function buildManualDodConfirmation(
  plan: GoalPlan,
  decision: GoalManualConfirmation['decision'],
): GoalManualConfirmation {
  const criterionIds = manualDodCriteria(plan).map((criterion) => criterion.id);
  return {
    confirmationId: `ui-manual-dod-${Date.now()}`,
    kind: 'manual_dod',
    decision,
    criterionIds,
    decidedAt: new Date().toISOString(),
  };
}

const RUN_TRACE_COLLAPSED_EVENT_COUNT = 1;

const RUN_EVENT_ISSUE_TYPES = new Set<GoalRunEvent['type']>([
  'validation_failed',
  'problem_found',
  'network_interrupted',
]);

const RUN_EVENT_CORRECTION_TYPES = new Set<GoalRunEvent['type']>([
  'user_correction',
  'requirement_override',
  'self_correction',
]);

const RUN_EVENT_VALIDATION_TYPES = new Set<GoalRunEvent['type']>([
  'validation_started',
  'validation_passed',
  'validation_failed',
]);

function runEventLabel(type: GoalRunEvent['type'], isZh: boolean): string {
  const zh: Record<GoalRunEvent['type'], string> = {
    message_routed: '收到消息',
    goal_intake_started: '判断是不是目标',
    goal_created: '目标初始化',
    plan_created: '制定计划',
    plan_revised: '调整计划',
    step_started: '开始一步',
    step_completed: '完成一步',
    action_started: '开始执行',
    action_completed: '执行完成',
    observation_recorded: '记录发现',
    validation_started: '开始检查',
    validation_passed: '检查通过',
    validation_failed: '检查没通过',
    problem_found: '发现问题',
    user_correction: '用户纠正方向',
    requirement_override: '用户更新目标',
    self_correction: '自己纠正',
    checkpoint_created: '存个进度点',
    network_interrupted: '网络断了',
    goal_resumed: '继续目标',
    goal_paused: '暂停目标',
    goal_completed: '目标完成',
  };
  const en: Record<GoalRunEvent['type'], string> = {
    message_routed: 'Message routed',
    goal_intake_started: 'Goal intake',
    goal_created: 'Goal created',
    plan_created: 'Plan created',
    plan_revised: 'Plan revised',
    step_started: 'Step started',
    step_completed: 'Step completed',
    action_started: 'Action started',
    action_completed: 'Action completed',
    observation_recorded: 'Observation',
    validation_started: 'Validation started',
    validation_passed: 'Validation passed',
    validation_failed: 'Validation failed',
    problem_found: 'Problem found',
    user_correction: 'User correction',
    requirement_override: 'Requirement override',
    self_correction: 'Self correction',
    checkpoint_created: 'Checkpoint',
    network_interrupted: 'Network interrupted',
    goal_resumed: 'Goal resumed',
    goal_paused: 'Goal paused',
    goal_completed: 'Goal completed',
  };
  return isZh ? zh[type] : en[type];
}

function runEventTone(type: GoalRunEvent['type']): string {
  if (type === 'goal_completed' || type === 'validation_passed') return 'success';
  if (type === 'checkpoint_created' || type === 'goal_resumed' || type === 'goal_paused') return 'checkpoint';
  if (RUN_EVENT_CORRECTION_TYPES.has(type)) return 'correction';
  if (RUN_EVENT_ISSUE_TYPES.has(type)) return 'issue';
  if (RUN_EVENT_VALIDATION_TYPES.has(type)) return 'validation';
  if (type === 'message_routed' || type === 'goal_intake_started' || type === 'goal_created') return 'route';
  return 'progress';
}

function formatRunEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function payloadString(event: GoalRunEvent, key: string): string | null {
  const value = event.payload?.[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function compactMeta(value: string): string {
  return value.length > 52 ? `${value.slice(0, 52)}...` : value;
}

// 事件详情里的 intent / phase 是后端下发的稳定机器码（如 follow_up、orient），
// 直接展示会中英混杂。这里给它们各一张中英对照表，按当前语言查表显示；
// 认不出的码回落为原值，保证向后兼容与新码的兜底展示。
const INTENT_VALUE_LABELS: Record<string, { zh: string; en: string }> = {
  // —— 消息路由 intent ——
  empty: { zh: '空消息', en: 'empty' },
  follow_up: { zh: '补充说明', en: 'follow-up' },
  correction: { zh: '纠正方向', en: 'correction' },
  requirement_override: { zh: '改需求', en: 'requirement override' },
  new_goal_explicit: { zh: '明确开新目标', en: 'new goal (explicit)' },
  new_goal_implicit: { zh: '疑似开新目标', en: 'new goal (implicit)' },
  pause: { zh: '暂停', en: 'pause' },
  resume: { zh: '继续', en: 'resume' },
  // —— Runner intent ——
  explore: { zh: '摸情况', en: 'explore' },
  execute: { zh: '动手做', en: 'execute' },
  verify: { zh: '检查', en: 'verify' },
  synthesize: { zh: '收尾汇总', en: 'synthesize' },
  block: { zh: '卡住了', en: 'blocked' },
};

const PHASE_VALUE_LABELS: Record<string, { zh: string; en: string }> = {
  idle: { zh: '待命', en: 'idle' },
  orient: { zh: '对齐目标', en: 'orient' },
  plan_scaffold: { zh: '搭任务框架', en: 'plan scaffold' },
  explore: { zh: '摸情况', en: 'explore' },
  inspect: { zh: '排查', en: 'inspect' },
  repair: { zh: '修复', en: 'repair' },
  synthesize: { zh: '收尾汇总', en: 'synthesize' },
  verify: { zh: '检查', en: 'verify' },
  blocked: { zh: '卡住了', en: 'blocked' },
};

function codedValueLabel(
  table: Record<string, { zh: string; en: string }>,
  value: string,
  isZh: boolean,
): string {
  const hit = table[value];
  if (hit) return isZh ? hit.zh : hit.en;
  return compactMeta(value);
}

// 事件详情文案：后端事件 payload 里带一个稳定的英文 summaryCode，前端按当前语言
// 现算这句话，动态字段（原因/消息/报错/轮次）从 payload 取。认不出 code 时回落
// 后端存的 event.summary，保证向后兼容与兜底。
type RunEventSummaryBuilder = (get: (key: string) => string | null, isZh: boolean) => string;

const RUN_EVENT_SUMMARY_BUILDERS: Record<string, RunEventSummaryBuilder> = {
  // —— 消息路由（goal-message-router）——
  msg_empty: (_g, isZh) =>
    isZh ? '收到一条空消息，已归入当前目标' : 'Received an empty message; kept it under the current goal',
  msg_new_goal_explicit: (_g, isZh) =>
    isZh ? '用户要求开一个新目标' : 'You asked to start a new goal',
  msg_paused: (g, isZh) => {
    const t = g('messageText');
    return isZh ? `已暂停当前目标${t ? `：${t}` : ''}` : `Paused the current goal${t ? `: ${t}` : ''}`;
  },
  msg_resumed: (g, isZh) => {
    const t = g('messageText');
    return isZh ? `继续当前目标${t ? `：${t}` : ''}` : `Resumed the current goal${t ? `: ${t}` : ''}`;
  },
  msg_requirement_override: (g, isZh) => {
    const t = g('messageText');
    return isZh ? `更新了目标要求${t ? `：${t}` : ''}` : `Updated the goal requirements${t ? `: ${t}` : ''}`;
  },
  msg_correction: (g, isZh) => {
    const t = g('messageText');
    return isZh ? `纠正了执行方向${t ? `：${t}` : ''}` : `Corrected the direction${t ? `: ${t}` : ''}`;
  },
  msg_follow_up: (g, isZh) => {
    const t = g('messageText');
    return isZh
      ? `补充了一句，已归入当前目标${t ? `：${t}` : ''}`
      : `Added a follow-up under the current goal${t ? `: ${t}` : ''}`;
  },
  // —— 目标/计划落库（goal-plan-store）——
  goal_intake_started: (_g, isZh) =>
    isZh ? '开始判断这是不是一个目标' : 'Checking whether this is a goal',
  goal_created: (_g, isZh) => (isZh ? '目标已建立' : 'Goal established'),
  plan_created: (_g, isZh) => (isZh ? '计划已生成' : 'Plan created'),
  plan_revised: (g, isZh) => {
    const r = g('reason');
    return isZh ? `计划有调整${r ? `：${r}` : ''}` : `Plan updated${r ? `: ${r}` : ''}`;
  },
  // —— 执行过程（goal-runner）——
  checkpoint_created: (g, isZh) => {
    const r = g('reason');
    return isZh ? `存了个进度点${r ? `：${r}` : ''}` : `Saved a checkpoint${r ? `: ${r}` : ''}`;
  },
  manual_dod_confirmation_required: (_g, isZh) =>
    isZh ? '完成前需要你手动确认验收项' : 'Manual acceptance confirmation is required before finishing',
  verifier_started: (_g, isZh) => (isZh ? '开始复核结果' : 'Verification started'),
  verifier_failed: (g, isZh) => {
    const m = g('message') || g('reason');
    return isZh ? `复核没跑成${m ? `：${m}` : ''}` : `Verification failed${m ? `: ${m}` : ''}`;
  },
  runner_started: (_g, isZh) => (isZh ? '开始自动推进目标' : 'Goal runner started'),
  runner_paused: (g, isZh) => {
    const r = g('reason');
    return isZh ? `已暂停自动推进${r ? `：${r}` : ''}` : `Goal runner paused${r ? `: ${r}` : ''}`;
  },
  runner_resumed: (_g, isZh) => (isZh ? '继续自动推进目标' : 'Goal runner resumed'),
  turn_started: (g, isZh) => {
    const n = g('turnNumber');
    return isZh ? `开始第 ${n ?? ''} 轮` : `Turn ${n ?? ''} started`;
  },
  turn_completed: (g, isZh) => {
    const n = g('turnNumber');
    return isZh ? `第 ${n ?? ''} 轮完成` : `Turn ${n ?? ''} completed`;
  },
  turn_failed: (g, isZh) => {
    const m = g('message') || g('reason');
    return isZh ? `这一轮没跑成${m ? `：${m}` : ''}` : `This turn failed${m ? `: ${m}` : ''}`;
  },
  self_correction: (g, isZh) => {
    const r = g('reason');
    return isZh ? `复核没过，回去修${r ? `：${r}` : ''}` : `Verification failed; going back to repair${r ? `: ${r}` : ''}`;
  },
  requested_user_input: (g, isZh) => {
    const r = g('reason');
    return isZh ? `需要你补充信息${r ? `：${r}` : ''}` : `Needs your input${r ? `: ${r}` : ''}`;
  },
  intake_resolved_inquiry: (_g, isZh) =>
    isZh ? '判断为一次咨询，已撤掉目标' : 'Resolved as an inquiry; goal removed',
  network_interrupted: (g, isZh) => {
    const r = g('reason');
    return isZh ? `网络断了${r ? `：${r}` : ''}` : `Network interrupted${r ? `: ${r}` : ''}`;
  },
  stream_failed: (g, isZh) => {
    const m = g('message') || g('reason');
    return isZh ? `响应流出错${m ? `：${m}` : ''}` : `Response stream failed${m ? `: ${m}` : ''}`;
  },
  runner_blocked: (g, isZh) => {
    const r = g('reason');
    return isZh ? `被卡住了${r ? `：${r}` : ''}` : `Goal runner blocked${r ? `: ${r}` : ''}`;
  },
  runner_stopped_failed: (_g, isZh) =>
    isZh ? '目标已是失败状态，停止推进' : 'Goal runner stopped because the goal already failed',
  runner_failed: (g, isZh) => {
    const m = g('message') || g('reason');
    return isZh ? `推进失败${m ? `：${m}` : ''}` : `Goal runner failed${m ? `: ${m}` : ''}`;
  },
  goal_completed: (_g, isZh) =>
    isZh ? '复核通过，目标完成' : 'Verification passed; goal completed',
  no_progress: (_g, isZh) =>
    isZh ? '连续几轮没进展，先停下来' : 'No progress for several turns; paused',
  scope_drift: (g, isZh) => {
    const r = g('reason');
    return isZh ? `发现跑偏了${r ? `：${r}` : ''}` : `Scope drift detected${r ? `: ${r}` : ''}`;
  },
  validation_passed: (_g, isZh) => (isZh ? '复核通过' : 'Verification passed'),
  validation_failed: (g, isZh) => {
    const r = g('reason');
    return isZh ? `复核没通过${r ? `：${r}` : ''}` : `Verification failed${r ? `: ${r}` : ''}`;
  },
};

function runEventSummary(event: GoalRunEvent, isZh: boolean): string {
  const code = payloadString(event, 'summaryCode');
  if (code) {
    const builder = RUN_EVENT_SUMMARY_BUILDERS[code];
    if (builder) {
      const text = builder((key) => payloadString(event, key), isZh).trim();
      if (text) return text;
    }
  }
  // 认不出 code：回落后端存的 summary，保证兜底与向后兼容。
  return event.summary;
}

function runEventMetaItems(event: GoalRunEvent, isZh: boolean): string[] {
  const items: string[] = [];
  const nodeId = event.nodeId || payloadString(event, 'checkpointNodeId');
  const turnNumber = payloadString(event, 'turnNumber');
  const phase = payloadString(event, 'phase') || payloadString(event, 'previousPhase');
  const intent = payloadString(event, 'intent');
  const reason = payloadString(event, 'reason');

  if (nodeId) items.push(`${isZh ? '节点' : 'node'} ${compactMeta(nodeId)}`);
  if (turnNumber) items.push(`${isZh ? '轮次' : 'turn'} ${turnNumber}`);
  if (phase) items.push(`${isZh ? '阶段' : 'phase'} ${codedValueLabel(PHASE_VALUE_LABELS, phase, isZh)}`);
  if (intent) items.push(`${isZh ? '意图' : 'intent'} ${codedValueLabel(INTENT_VALUE_LABELS, intent, isZh)}`);
  if (reason) items.push(`${isZh ? '原因' : 'reason'} ${compactMeta(reason)}`);
  const evidenceRefs = safeEvidenceRefs(event);
  if (evidenceRefs.length > 0) {
    items.push(isZh ? `证据 ×${evidenceRefs.length}` : `evidence ×${evidenceRefs.length}`);
  }
  return items;
}

function criterionKindLabel(kind: GoalSuccessCriterion['kind'], isZh: boolean): string {
  const zh: Record<GoalSuccessCriterion['kind'], string> = {
    command: '命令',
    test: '测试',
    'file-contains': '文件内容',
    'file-exists': '文件存在',
    manual: '人工确认',
  };
  const en: Record<GoalSuccessCriterion['kind'], string> = {
    command: 'Command',
    test: 'Test',
    'file-contains': 'File contains',
    'file-exists': 'File exists',
    manual: 'Manual',
  };
  return isZh ? zh[kind] : en[kind];
}

function GoalContractSection({
  plan,
  isZh,
  editorRef,
}: {
  plan: GoalPlan;
  isZh: boolean;
  editorRef?: Ref<SuccessCriteriaEditorHandle>;
}): ReactElement {
  const criteria = Array.isArray(plan.successCriteria) ? plan.successCriteria : [];
  const results = new Map(
    (Array.isArray(plan.criterionResults) ? plan.criterionResults : [])
      .map((result) => [result.criterionId, result] as const),
  );
  const inScopeCount = Array.isArray(plan.boundaries?.inScope) ? plan.boundaries.inScope.length : 0;
  const outOfScopeCount = Array.isArray(plan.boundaries?.outOfScope) ? plan.boundaries.outOfScope.length : 0;
  const editable = plan.status === 'awaiting_approval';

  return (
    <section className="goal-projection goal-projection--goal" aria-label={isZh ? '目标契约' : 'Goal contract'}>
      <div className="goal-projection-head">
        <div className="goal-projection-title-wrap">
          <span className="goal-projection-kicker">{isZh ? '目标' : 'Goal'}</span>
          <span className="goal-projection-title">{isZh ? '当前目标契约' : 'Current contract'}</span>
        </div>
        <span className="goal-projection-meta">
          {isZh ? `标准 ${criteria.length}` : `${criteria.length} criteria`}
        </span>
      </div>
      {plan.goal ? (
        <div className="goal-plan-goal goal-contract-current">
          <p className="goal-contract-text goal-contract-text--current">{plan.goal}</p>
        </div>
      ) : (
        <p className="goal-contract-text goal-contract-text--empty">
          {isZh ? '尚未写入目标描述' : 'No goal description recorded yet'}
        </p>
      )}
      {editable ? (
        <SuccessCriteriaEditor ref={editorRef} plan={plan} isZh={isZh} />
      ) : criteria.length > 0 ? (
        <ul className="goal-criteria-list">
          {criteria.map((criterion) => {
            const result = results.get(criterion.id);
            return (
              <li key={criterion.id} className="goal-criterion-item">
                <span className="goal-criterion-kind">{criterionKindLabel(criterion.kind, isZh)}</span>
                <span className="goal-criterion-text">{criterion.description}</span>
                {result ? (
                  <span className={`goal-criterion-result goal-criterion-result--${result.passed ? 'passed' : 'failed'}`}>
                    {result.passed ? (isZh ? '已通过' : 'Passed') : (isZh ? '未通过' : 'Failed')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {inScopeCount > 0 || outOfScopeCount > 0 ? (
        <div className="goal-boundary-meta">
          {inScopeCount > 0 ? (
            <span>{isZh ? `范围内 ${inScopeCount}` : `in scope ${inScopeCount}`}</span>
          ) : null}
          {outOfScopeCount > 0 ? (
            <span>{isZh ? `范围外 ${outOfScopeCount}` : `out of scope ${outOfScopeCount}`}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PlanProjectionSection({
  plan,
  progress,
  tasks,
  tasksExpanded,
  onToggleTasks,
  isZh,
}: {
  plan: GoalPlan;
  progress: GoalPlan['progress'];
  tasks: readonly GoalTask[];
  tasksExpanded: boolean;
  onToggleTasks: () => void;
  isZh: boolean;
}): ReactElement {
  return (
    <section className="goal-projection goal-projection--plan" aria-label={isZh ? '任务计划' : 'Task plan'}>
      <div className="goal-projection-head">
        <div className="goal-projection-title-wrap">
          <span className="goal-projection-kicker">{isZh ? '计划' : 'Plan'}</span>
          <span className="goal-projection-title">{isZh ? '任务拆解与进度' : 'Tasks and progress'}</span>
        </div>
        <span className="goal-projection-meta">
          {isZh ? `任务 ${tasks.length}` : `${tasks.length} tasks`}
        </span>
      </div>
      {/* 进度条即「展开/收起子任务」的开关：点它切换下方 goal-task-list 显隐。 */}
      <button
        type="button"
        className={`goal-plan-progress${tasksExpanded ? ' goal-plan-progress--open' : ''}`}
        onClick={onToggleTasks}
        aria-expanded={tasksExpanded}
        aria-label={isZh ? '展开或收起子任务' : 'Toggle subtasks'}
      >
        <span
          className="goal-plan-progress-track"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className={`goal-plan-progress-bar${plan.status === 'executing' ? ' goal-plan-progress-bar--executing' : ''}`}
            style={{ backgroundSize: `${progress.percent}% 100%` }}
          />
        </span>
        <span className="goal-plan-progress-text">
          {isZh
            ? `${progress.completed}/${progress.total} 完成`
            : `${progress.completed}/${progress.total} done`}
          {progress.failed > 0 ? (isZh ? `，${progress.failed} 失败` : `, ${progress.failed} failed`) : ''}
          {progress.blocked > 0 ? (isZh ? `，${progress.blocked} 阻塞` : `, ${progress.blocked} blocked`) : ''}
        </span>
        <span className="goal-plan-progress-caret" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {tasksExpanded ? (
        tasks.length > 0 ? (
          <ul className="goal-task-list">
            {tasks.map((task) => (
              <TaskNode
                key={task.taskId}
                task={task}
                depth={0}
                isZh={isZh}
              />
            ))}
          </ul>
        ) : (
          <div className="goal-plan-empty-tasks">{isZh ? '尚无拆解的子任务' : 'No tasks yet'}</div>
        )
      ) : null}
    </section>
  );
}

function RunTraceItem({ event, isZh }: { event: GoalRunEvent; isZh: boolean }): ReactElement {
  const metaItems = runEventMetaItems(event, isZh);
  return (
    <li className={`goal-run-event goal-run-event--${runEventTone(event.type)}`}>
      <span className="goal-run-event-rail" aria-hidden="true" />
      <div className="goal-run-event-body">
        <div className="goal-run-event-head">
          <span className="goal-run-event-type">{runEventLabel(event.type, isZh)}</span>
          <time className="goal-run-event-time" dateTime={event.createdAt}>
            {formatRunEventTime(event.createdAt)}
          </time>
        </div>
        <div className="goal-run-event-summary">{runEventSummary(event, isZh)}</div>
        {metaItems.length > 0 ? (
          <div className="goal-run-event-meta">
            {metaItems.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function RunTraceSection({ plan, isZh }: { plan: GoalPlan; isZh: boolean }): ReactElement {
  const events = Array.isArray(plan.runTrace?.events) ? plan.runTrace.events : [];
  const [showAll, setShowAll] = useState(false);
  // 时间线按「最新在最上面」展示：先取最近 N 条，再整体反转为倒序。
  const recentEvents = showAll ? events : events.slice(-RUN_TRACE_COLLAPSED_EVENT_COUNT);
  const visibleEvents = recentEvents.slice().reverse();
  const hiddenCount = events.length - visibleEvents.length;
  const validationCount = events.filter((event) => RUN_EVENT_VALIDATION_TYPES.has(event.type)).length;
  const issueCount = events.filter((event) => RUN_EVENT_ISSUE_TYPES.has(event.type)).length;
  const correctionCount = events.filter((event) => RUN_EVENT_CORRECTION_TYPES.has(event.type)).length;
  const checkpoint = plan.runTrace?.lastCheckpointNodeId || null;

  return (
    <section className="goal-projection goal-projection--run" aria-label={isZh ? '执行流程' : 'Run trace'}>
      <div className="goal-projection-head">
        <div className="goal-projection-title-wrap">
          <span className="goal-projection-kicker">{isZh ? '执行' : 'Run'}</span>
          <span className="goal-projection-title">{isZh ? '执行流程与检查点' : 'Trace and checkpoints'}</span>
        </div>
        <span className="goal-projection-meta">
          {isZh
            ? `${events.length} 步 · 验证 ${validationCount} · 问题 ${issueCount}`
            : `${events.length} events · ${validationCount} validations · ${issueCount} issues`}
        </span>
      </div>
      {checkpoint || correctionCount > 0 ? (
        <div className="goal-run-trace-summary">
          {checkpoint ? (
            <span>{isZh ? `最近检查点：${checkpoint}` : `latest checkpoint: ${checkpoint}`}</span>
          ) : null}
          {correctionCount > 0 ? (
            <span>{isZh ? `纠偏 ${correctionCount}` : `corrections ${correctionCount}`}</span>
          ) : null}
        </div>
      ) : null}
      {events.length === 0 ? (
        <div className="goal-run-empty">
          {isZh ? '尚未记录执行事件' : 'No run events recorded yet'}
        </div>
      ) : (
        <>
          <ol className="goal-run-trace-list">
            {hiddenCount > 0 && !showAll ? (
              <li className="goal-run-event-note">
                {isZh ? `已折叠前 ${hiddenCount} 步` : `${hiddenCount} earlier event${hiddenCount === 1 ? '' : 's'} hidden`}
              </li>
            ) : null}
            {visibleEvents.map((event) => (
              <RunTraceItem key={event.id} event={event} isZh={isZh} />
            ))}
          </ol>
          {events.length > RUN_TRACE_COLLAPSED_EVENT_COUNT ? (
            <button
              type="button"
              className="goal-run-trace-toggle"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? isZh ? '只看最近流程' : 'Show recent only'
                : isZh ? `展开全部 ${events.length} 步` : `Show all ${events.length} events`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function TaskNode({
  task,
  depth,
  isZh,
}: {
  task: GoalTask;
  depth: number;
  isZh: boolean;
}): ReactElement {
  const evidenceRefs = safeEvidenceRefs(task);
  const hasEvidence = evidenceRefs.length > 0;
  const [expanded, setExpanded] = useState(false);
  const evidenceCount = evidenceRefs.length;
  const summaryText = task.failureReason
    ? task.failureReason
    : task.blockedReason
      ? task.blockedReason
      : task.status === 'completed' && hasEvidence
        ? isZh
          ? `证据 ${evidenceCount} 条`
          : `${evidenceCount} evidence`
        : null;
  const canExpand =
    !!task.failureReason ||
    !!task.blockedReason ||
    (task.status === 'completed' && hasEvidence) ||
    (task.subtasks?.length ?? 0) > 0;
  return (
    <li
      className={`goal-task goal-task--card${expanded ? ' goal-task--expanded' : ''}`}
      style={{ marginInlineStart: depth * 12 }}
      data-goal-task-id={task.taskId}
      tabIndex={-1}
    >
      <button
        type="button"
        className="goal-task-head"
        onClick={() => canExpand && setExpanded((v) => !v)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        <span className={statusClass(task.status)} aria-label={statusLabel(task.status, isZh)}>
          {statusLabel(task.status, isZh)}
        </span>
        <span className="goal-task-title">{task.title}</span>
        {canExpand ? (
          <span className="goal-task-caret" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </span>
        ) : null}
      </button>
      {summaryText ? (
        <div
          className={`goal-task-summary${
            task.failureReason ? ' goal-task-summary--error' : task.blockedReason ? ' goal-task-summary--warn' : ''
          }`}
        >
          {summaryText}
        </div>
      ) : null}
      {expanded ? (
        <div className="goal-task-detail-wrap">
          {task.failureReason ? (
            <div className="goal-task-detail goal-task-detail--error">{task.failureReason}</div>
          ) : null}
          {task.blockedReason ? (
            <div className="goal-task-detail goal-task-detail--warn">{task.blockedReason}</div>
          ) : null}
          {hasEvidence ? (
            <div className="goal-task-detail">
              <div className="goal-task-detail-label">{isZh ? '证据' : 'Evidence'}</div>
              <ul className="goal-task-evidence-list">
                {evidenceRefs.map((ref) => (
                  <li key={ref} className="goal-task-evidence-item">{ref}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {task.subtasks && task.subtasks.length > 0 ? (
        <ul className="goal-task-children">
          {task.subtasks.map((child) => (
            <TaskNode
              key={child.taskId}
              task={child}
              depth={depth + 1}
              isZh={isZh}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// Runner 托管状态区：展示状态/计数/控制按钮/Explorer 列表。
// 只读表达 main 侧 runner 状态，所有控制经回调 → clientApi → IPC，renderer 不直接执行本地能力。
function RunnerSection({
  plan,
  runner,
  busy,
  isZh,
  onControl,
  onManualConfirm,
}: {
  plan: GoalPlan;
  runner: GoalRunnerState;
  busy: boolean;
  isZh: boolean;
  onControl: (plan: GoalPlan, action: 'pause' | 'resume' | 'clear') => void | Promise<void>;
  onManualConfirm: (
    plan: GoalPlan,
    decision: GoalManualConfirmation['decision'],
  ) => void | Promise<void>;
}): ReactElement {
  const explorers = Array.isArray(runner.explorers) ? runner.explorers : [];
  const verifierRuns = Array.isArray(runner.verifierRuns) ? runner.verifierRuns : [];
  const latestVerifier = verifierRuns
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] ?? null;
  const manualCriteria = manualDodCriteria(plan);
  const manualCriterionIds = manualCriteria.map((criterion) => criterion.id);
  const manualConfirmation = latestManualDodConfirmation(plan, manualCriterionIds);
  const needsManualDodConfirmation =
    runner.status === 'blocked' &&
    runner.blockedReason === 'manual_dod_confirmation_required' &&
    manualCriteria.length > 0 &&
    manualConfirmation?.decision !== 'approve';
  const canPause = RUNNER_ACTIVE_STATUSES.has(runner.status);
  const canResume = RUNNER_RESUMABLE_STATUSES.has(runner.status) && !needsManualDodConfirmation;
  const isTerminal = RUNNER_TERMINAL_STATUSES.has(runner.status);
  const showAttention = runner.status === 'blocked' || runner.status === 'budget_exhausted';
  const phaseLabel = runnerPhaseLabel(runner.phase, isZh);

  return (
    <div className={`goal-runner goal-runner--${runner.status}`}>
      {showAttention && runner.blockedReason ? (
        <div className="goal-runner-status-strip goal-runner-status-strip--blocker">
          <div className="goal-runner-status-main">
            <span className="goal-runner-status-kicker">{isZh ? 'Goal 阻塞' : 'Goal blocker'}</span>
            <span className="goal-runner-status-text">{runner.blockedReason}</span>
          </div>
          {runner.blockerAudit ? (
            <span className="goal-runner-status-meta">
              {isZh
                ? `重复 ${runner.blockerAudit.occurrences} 次`
                : `${runner.blockerAudit.occurrences} occurrence${runner.blockerAudit.occurrences === 1 ? '' : 's'}`}
            </span>
          ) : null}
        </div>
      ) : null}
      {runner.lastError ? (
        <div className="goal-runner-status-strip goal-runner-status-strip--error">
          <div className="goal-runner-status-main">
            <span className="goal-runner-status-kicker">{isZh ? 'Runner 错误' : 'Runner error'}</span>
            <span className="goal-runner-status-text">{runner.lastError}</span>
          </div>
        </div>
      ) : null}
      {latestVerifier ? (
        <div className={`goal-runner-status-strip goal-runner-status-strip--verifier goal-runner-status-strip--${latestVerifier.status}`}>
          <div className="goal-runner-status-main">
            <span className="goal-runner-status-kicker">{isZh ? 'Verifier 复核' : 'Verifier'}</span>
            <span className="goal-runner-status-text">
              {verifierStatusLabel(latestVerifier.status, isZh)} · {verifierTargetLabel(latestVerifier, isZh)}
            </span>
          </div>
          <span className="goal-runner-status-meta">
            {isZh
              ? `证据 ×${latestVerifier.evidenceRefs?.length ?? 0}`
              : `evidence ×${latestVerifier.evidenceRefs?.length ?? 0}`}
          </span>
        </div>
      ) : null}
      {needsManualDodConfirmation ? (
        <div className="goal-manual-dod">
          <div className="goal-manual-dod-head">
            <span className="goal-manual-dod-title">
              {isZh ? '完成前人工确认' : 'Manual completion check'}
            </span>
            <span className="goal-manual-dod-count">
              {isZh ? `标准 ×${manualCriteria.length}` : `criteria ×${manualCriteria.length}`}
            </span>
          </div>
          <ul className="goal-manual-dod-list">
            {manualCriteria.map((criterion) => (
              <li key={criterion.id}>{criterion.description}</li>
            ))}
          </ul>
          {manualConfirmation ? (
            <div className="goal-manual-dod-note">
              {isZh ? '已记录需要调整，Runner 将保持阻塞。' : 'Needs-changes feedback recorded; runner remains blocked.'}
            </div>
          ) : (
            <div className="goal-manual-dod-actions">
              <button
                type="button"
                className="goal-runner-btn goal-runner-btn--primary"
                disabled={busy}
                onClick={() => void onManualConfirm(plan, 'approve')}
              >
                {isZh ? '确认已达成' : 'Confirm done'}
              </button>
              <button
                type="button"
                className="goal-runner-btn goal-runner-btn--ghost"
                disabled={busy}
                onClick={() => void onManualConfirm(plan, 'revise')}
              >
                {isZh ? '需要调整' : 'Needs changes'}
              </button>
            </div>
          )}
        </div>
      ) : null}
      <div className="goal-runner-bar">
        <div className="goal-runner-meta">
          <span className={`goal-runner-phase goal-runner-phase--${runner.phase ?? 'unknown'}`}>
            {isZh ? `阶段：${phaseLabel}` : `Phase: ${phaseLabel}`}
          </span>
          <span className="goal-runner-counters">
            {(() => {
              const base = isZh
                ? `轮次 ${runner.roundCount} · 工具 ${runner.toolCallCount}`
                : `turns ${runner.roundCount} · tools ${runner.toolCallCount}`;
              // 并发模型：优先展示「本轮」进度（explorerBatch = 最近一批并发 Explorer 的
              // 已完成/总数）；无进行中批次时回退为累计已派发数（无分母）。
              const batch = runner.explorerBatch;
              const explore = batch && batch.total > 0
                ? isZh
                  ? ` · 探索 ${batch.done}/${batch.total}`
                  : ` · explorers ${batch.done}/${batch.total}`
                : runner.explorerCount > 0
                  ? isZh
                    ? ` · 探索 ×${runner.explorerCount}`
                    : ` · explorers ×${runner.explorerCount}`
                  : '';
              return `${base}${explore}`;
            })()}
          </span>
        </div>
        <div className="goal-runner-actions">
          {canPause ? (
          <button
            type="button"
            className="goal-runner-btn"
            disabled={busy}
            onClick={() => void onControl(plan, 'pause')}
          >
            {isZh ? '暂停' : 'Pause'}
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="goal-runner-btn goal-runner-btn--primary"
            disabled={busy}
            onClick={() => void onControl(plan, 'resume')}
          >
            {isZh ? '继续' : 'Resume'}
          </button>
        ) : null}
        {!isTerminal ? (
          <button
            type="button"
            className="goal-runner-btn goal-runner-btn--ghost"
            disabled={busy}
            onClick={() => void onControl(plan, 'clear')}
          >
            {isZh ? '清除' : 'Clear'}
          </button>
        ) : null}
        </div>
      </div>
      {explorers.length > 0 ? (
        <details className="goal-runner-explorers">
          <summary>
            {isZh ? `Explorer 子任务 ×${explorers.length}` : `Explorers ×${explorers.length}`}
          </summary>
          <ul className="goal-runner-explorer-list">
            {explorers.map((explorer) => (
              <ExplorerItem key={explorer.explorerId} explorer={explorer} isZh={isZh} />
            ))}
          </ul>
        </details>
      ) : null}
      {verifierRuns.length > 0 ? (
        <details className="goal-runner-verifiers">
          <summary>
            {isZh ? `Verifier 复核 ×${verifierRuns.length}` : `Verifiers ×${verifierRuns.length}`}
          </summary>
          <ul className="goal-runner-verifier-list">
            {verifierRuns.map((verifier) => (
              <VerifierItem key={verifier.verifierRunId} verifier={verifier} isZh={isZh} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function VerifierItem({
  verifier,
  isZh,
}: {
  verifier: GoalVerifierRun;
  isZh: boolean;
}): ReactElement {
  const evidenceRefs = verifier.evidenceRefs ?? [];
  const issueCount =
    (verifier.report?.failedCriteria?.length ?? 0) +
    (verifier.report?.missingEvidence?.length ?? 0);
  const summary = verifier.failureReason || verifier.summary || verifier.report?.recommendedNextAction || '';
  return (
    <li className={`goal-runner-verifier goal-runner-verifier--${verifier.status}`}>
      <div className="goal-runner-verifier-row">
        <span className={`goal-runner-verifier-status goal-runner-verifier-status--${verifier.status}`}>
          {verifierStatusLabel(verifier.status, isZh)}
        </span>
        <span className="goal-runner-verifier-target">
          {verifierTargetLabel(verifier, isZh)}
        </span>
      </div>
      <div className="goal-runner-verifier-detail">
        {evidenceRefs.length > 0 ? (
          <span title={evidenceRefs.join(', ')}>
            {isZh ? `证据 ×${evidenceRefs.length}` : `evidence ×${evidenceRefs.length}`}
          </span>
        ) : null}
        {issueCount > 0 ? (
          <span>{isZh ? `问题 ×${issueCount}` : `issues ×${issueCount}`}</span>
        ) : null}
        {summary ? <span className="goal-runner-verifier-summary">{summary}</span> : null}
      </div>
    </li>
  );
}

function ExplorerItem({
  explorer,
  isZh,
}: {
  explorer: GoalExplorerRun;
  isZh: boolean;
}): ReactElement {
  const report = explorer.report;
  const evidenceRefs = report?.evidenceRefs ?? [];
  return (
    <li className={`goal-runner-explorer goal-runner-explorer--${explorer.status}`}>
      <div className="goal-runner-explorer-row">
        <span className={`goal-runner-explorer-status goal-runner-explorer-status--${explorer.status}`}>
          {explorerStatusLabel(explorer.status, isZh)}
        </span>
        <span className="goal-runner-explorer-question">{explorer.request.question}</span>
      </div>
      {report ? (
        <div className="goal-runner-explorer-detail">
          <span className="goal-runner-explorer-confidence">
            {isZh ? `置信度：${report.confidence}` : `confidence: ${report.confidence}`}
          </span>
          {evidenceRefs.length > 0 ? (
            <span className="goal-runner-explorer-evidence" title={evidenceRefs.join(', ')}>
              {isZh ? `证据 ×${evidenceRefs.length}` : `evidence ×${evidenceRefs.length}`}
            </span>
          ) : null}
        </div>
      ) : null}
      {explorer.failureReason ? (
        <div className="goal-runner-explorer-detail goal-runner-explorer-detail--error">
          {explorer.failureReason}
        </div>
      ) : null}
    </li>
  );
}

function hasDeliveryTarget(plan: GoalPlan): boolean {
  const binding = plan.deliveryBinding;
  if (!binding?.targetBranch || !binding.targetBranchSource) return false;
  if (plan.activation?.kind === 'intake') return false;
  return Boolean(binding.targetWorkspacePath || plan.targetWorkspacePath);
}

function isIsolatedPlan(plan: GoalPlan): boolean {
  return plan.deliveryBinding?.executionIsolation === 'worktree'
    && Boolean(plan.deliveryBinding.worktreePath?.trim());
}

function hasTaskLine(plan: GoalPlan): boolean {
  return Boolean(plan.deliveryBinding?.taskBranch?.trim() || plan.deliveryBinding?.worktreePath?.trim());
}

function compactBranchName(value?: string | null): string | undefined {
  const branch = typeof value === 'string' ? value.trim() : '';
  if (!branch) return undefined;
  return branch.replace(/^PeerAgent\//, '') || branch;
}

function mergeDestination(plan: GoalPlan, isZh: boolean): string {
  return compactBranchName(plan.deliveryHandoff?.targetBranch)
    ?? compactBranchName(plan.deliveryBinding?.targetBranch)
    ?? (isZh ? '源头' : 'source');
}

function isPlanArchivedToSource(plan: GoalPlan): boolean {
  return plan.deliveryHandoff?.status === 'delivered';
}

async function confirmDiscardAfterStop(
  confirm: (options: {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    tone?: 'default' | 'danger';
  }) => Promise<boolean>,
  plan: GoalPlan,
  isZh: boolean,
): Promise<void> {
  if (!hasTaskLine(plan)) return;
  const ok = await confirm({
    title: isZh ? '删除这条线？' : 'Discard this line?',
    message: isZh
      ? '推进已经停了。也可以继续删除隔离目录和未合入的任务分支；已合入的提交不会被抹掉。'
      : 'Advancing has stopped. You can also remove the isolated worktree and any unmerged task branch. Merged commits stay.',
    confirmText: isZh ? '删除这条线' : 'Discard line',
    cancelText: isZh ? '只停推进' : 'Stop only',
    tone: 'danger',
  });
  if (!ok) return;
  await clientApi.goalPlansDiscardLine({ planId: plan.planId, deleteBranch: true });
}

function isolateReasonCopy(reason: string | undefined, isZh: boolean): string {
  switch (reason) {
    case 'task_checkout_dirty':
      return isZh
        ? '任务分支正被主工作区占用，且还有未提交改动。先提交或收拾干净再隔离。'
        : 'The task branch is checked out in the main workspace with uncommitted changes.';
    case 'switch_base_failed':
      return isZh ? '无法切回源头分支，隔离没有继续。' : 'Could not switch back to the source branch.';
    case 'worktree_add_failed':
      return isZh ? '创建隔离目录失败。' : 'Failed to create the isolated worktree.';
    case 'workspace_unusable':
      return isZh ? '目标仓库现在不可用。' : 'The target repository is not usable right now.';
    case 'terminal':
      return isZh ? '已经结束的任务不能再升级为隔离线。' : 'A finished task cannot be isolated.';
    case 'no_delivery_target':
      return isZh ? '这条任务还没有绑定交付目标。' : 'This task has no delivery target yet.';
    default:
      return isZh ? '隔离没有完成。' : 'Isolation did not finish.';
  }
}

interface CompactApprovalBarProps {
  readonly plan: GoalPlan;
  readonly isZh: boolean;
  readonly busy: boolean;
  readonly isStreaming: boolean;
  readonly onNextAction: (plan: GoalPlan, action: GoalPlanNextAction) => void | Promise<void>;
}

/** The chat-bottom approval surface deliberately stays to one compact row. */
function CompactApprovalBar({
  plan,
  isZh,
  busy,
  isStreaming,
  onNextAction,
}: CompactApprovalBarProps): ReactElement {
  const progress = safeProgress(plan);
  const title = derivePlanTitle(plan, isZh);
  const nextStepCopy = goalPlanNextStepCopy(isZh);

  return (
    <div className="goal-plan-compact-approval" role="status" data-goal-plan-compact-approval>
      <span className="goal-plan-compact-approval-status">{isZh ? '待审批' : 'Pending'}</span>
      <span className="goal-plan-compact-approval-title" title={title}>{title}</span>
      <span className="goal-plan-compact-approval-progress">{`${progress.completed}/${progress.total}`}</span>
      <div className="goal-plan-compact-approval-actions">
        {(['start', 'adjust', 'cancel'] as const).map((action) => (
          <button
            key={action}
            type="button"
            className={`goal-plan-compact-approval-action goal-plan-compact-approval-action--${action}`}
            disabled={busy || isStreaming}
            title={isStreaming ? (isZh ? '请等待本轮输出结束后再操作' : 'Wait until this turn finishes') : undefined}
            onClick={() => void onNextAction(plan, action)}
          >
            {nextStepCopy[action]}
          </button>
        ))}
      </div>
    </div>
  );
}

interface PlanCardProps {
  readonly plan: GoalPlan;
  readonly defaultExpanded: boolean;
  readonly isZh: boolean;
  readonly isStreaming: boolean;
  readonly busy: boolean;
  readonly isMain?: boolean;
  readonly onNextAction: (plan: GoalPlan, action: GoalPlanNextAction) => void | Promise<void>;
  readonly criteriaEditorRef?: Ref<SuccessCriteriaEditorHandle>;
  readonly onRunnerControl: (plan: GoalPlan, action: 'pause' | 'resume' | 'clear') => void | Promise<void>;
  readonly onManualConfirm: (
    plan: GoalPlan,
    decision: GoalManualConfirmation['decision'],
  ) => void | Promise<void>;
}

const PlanCard = memo(function PlanCard({
  plan,
  defaultExpanded,
  isZh,
  isStreaming,
  busy,
  isMain,
  onNextAction,
  criteriaEditorRef,
  onRunnerControl,
  onManualConfirm,
}: PlanCardProps): ReactElement {
  // 所有等待用户决定的计划（含 Goal 模式的 accepted）都要强制展开，
  // 使聊天底部的浮条本身成为可直接操作的审批入口。
  const awaitingLock = hasPendingGoalApproval([plan]);
  // 主卡（当前计划）永远展开；待审批计划同样强制展开。两者都隐藏 caret、禁用折叠。
  const lockedOpen = awaitingLock || !!isMain;
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded || lockedOpen);
  const effectiveExpanded = lockedOpen || expanded;
  // 子任务明细默认展开：主卡进入时直接展示 goal-task-list，
  // 点进度条可手动收起。
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const nextStep = getGoalPlanNextStep(plan);
  const nextStepCopy = goalPlanNextStepCopy(isZh);
  const progress = safeProgress(plan);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const title = derivePlanTitle(plan, isZh);
  const deliveryRoute = formatGoalDeliveryRoute(plan, { locale: isZh ? 'zh' : 'en' });
  const deliveryHandoffLabel = formatGoalDeliveryHandoff(plan, { locale: isZh ? 'zh' : 'en' });
  const lampHandoff = formatGoalDeliveryHandoffLamp(plan, { locale: isZh ? 'zh' : 'en' });
  const mergeDest = mergeDestination(plan, isZh);
  const taskLineName = compactBranchName(plan.deliveryBinding?.taskBranch) ?? title;
  const isolated = isIsolatedPlan(plan);
  // ADR 68：合回路线图只对隔离计划画——非隔离（direct）计划没有合回动作，
  // 画「任务线 → 发版线」会暗示一个不存在的合并。
  const showMergeRoute = isolated;
  const handoffStatus = plan.deliveryHandoff?.status;
  const qualityReviewPending = plan.deliveryHandoff?.stoppedReason === 'quality_review_pending';
  const canMergeIntoSource = isolated
    && plan.status === 'completed'
    && handoffStatus !== 'delivered'
    && handoffStatus !== 'delivering'
    && !qualityReviewPending;
  const confirm = useConfirm();
  const [lineBusy, setLineBusy] = useState(false);
  const [lineError, setLineError] = useState<string | null>(null);
  const canIsolate = hasDeliveryTarget(plan)
    && !isolated
    && plan.status !== 'completed'
    && plan.status !== 'cancelled'
    && plan.status !== 'failed';
  const canOpenSite = hasDeliveryTarget(plan) || isolated;
  const canDiscardLine = hasTaskLine(plan) && plan.status !== 'executing';
  const lineDisabled = busy || isStreaming || lineBusy;

  const isolateLine = useCallback(async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const result = await clientApi.goalPlansIsolate({ planId: plan.planId });
      if (result && result.ok === false) {
        setLineError(isolateReasonCopy(result.reason, isZh));
      }
    } catch (error) {
      setLineError(error instanceof Error ? error.message : String(error));
    } finally {
      setLineBusy(false);
    }
  }, [isZh, plan.planId]);

  const openSite = useCallback(async (mode: 'reveal' | 'editor') => {
    setLineError(null);
    try {
      const result = await clientApi.goalPlansOpenSite({ planId: plan.planId, mode });
      if (result && result.ok === false) {
        setLineError(isZh ? '打不开这条任务的现场。' : 'Could not open the task site.');
      }
    } catch (error) {
      setLineError(error instanceof Error ? error.message : String(error));
    }
  }, [isZh, plan.planId]);

  const discardLine = useCallback(async () => {
    const ok = await confirm({
      title: isZh ? '删除这条线' : 'Discard this line',
      message: isZh
        ? '将删除隔离目录；若任务分支还没合入，也会删掉本地分支。已合入的提交不会被抹掉。'
        : 'This removes the isolated worktree and, if it is still unmerged, the local task branch. Merged commits stay.',
      confirmText: isZh ? '删除这条线' : 'Discard line',
      cancelText: isZh ? '再想想' : 'Keep it',
      tone: 'danger',
    });
    if (!ok) return;
    setLineBusy(true);
    setLineError(null);
    try {
      const result = await clientApi.goalPlansDiscardLine({ planId: plan.planId, deleteBranch: true });
      if (result && result.ok === false) {
        setLineError(isolateReasonCopy(result.reason, isZh));
      }
    } catch (error) {
      setLineError(error instanceof Error ? error.message : String(error));
    } finally {
      setLineBusy(false);
    }
  }, [confirm, isZh, plan.planId]);

  const mergeIntoSource = useCallback(async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const next = await clientApi.goalPlansRetryHandoff({ planId: plan.planId });
      const reason = next && typeof next === 'object'
        ? formatGoalDeliveryHandoff(next, { locale: isZh ? 'zh' : 'en' })
        : null;
      const stopped = next && typeof next === 'object'
        && next.deliveryHandoff?.status === 'stopped';
      if (stopped && reason) setLineError(reason);
    } catch (error) {
      setLineError(error instanceof Error ? error.message : String(error));
    } finally {
      setLineBusy(false);
    }
  }, [isZh, plan.planId]);
  const timingLive = Boolean(
    plan.timing?.startedAt
    && !plan.timing?.completedAt
    && (plan.status === 'executing' || plan.status === 'paused' || Boolean(plan.timing?.activeSegmentStartedAt)),
  );
  const nowMs = useLiveNowMs(timingLive);
  const elapsedLabel = formatGoalTimingLabel(plan, isZh, nowMs);

  return (
    <section
      className={`goal-plan-card${effectiveExpanded ? ' goal-plan-card--expanded' : ''}${isMain ? ' goal-plan-card--main' : ''}`}
      data-goal-plan-id={plan.planId}
      tabIndex={-1}
    >
      <header className="goal-plan-head">
        <button
          type="button"
          className="goal-plan-head-toggle"
          onClick={() => {
            if (lockedOpen) return;
            setExpanded((v) => !v);
          }}
          disabled={lockedOpen}
          aria-expanded={effectiveExpanded}
          title={awaitingLock ? (isZh ? '有待批准，需先处理' : 'Pending approval — resolve first') : undefined}
        >
          <span className={`goal-plan-status goal-plan-status--${plan.status}`}>
            {planStatusLabel(plan.status, isZh)}
          </span>
          <span className="goal-plan-title">{title}</span>
          {elapsedLabel ? (
            <span
              className={`goal-plan-head-timing${timingLive ? ' goal-plan-head-timing--live' : ''}`}
              title={timingLive
                ? (isZh ? '有效运行时间（暂停/等人时停表）' : 'Active runtime (pauses while waiting)')
                : (isZh ? '有效运行用时' : 'Active runtime')}
            >
              {elapsedLabel}
            </span>
          ) : null}
          {lampHandoff ? (
            <span className="goal-plan-head-handoff">{lampHandoff}</span>
          ) : (
            <span className="goal-plan-head-progress">
              {`${progress.completed}/${progress.total}`}
            </span>
          )}
          {lockedOpen ? null : (
            <span className="goal-plan-head-caret" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          )}
        </button>
        {nextStep ? (
          <div className="goal-plan-actions goal-plan-actions--inline" data-goal-plan-next-actions>
            {nextStep.actions.map((action) => (
              <button
                key={action}
                type="button"
                className={`goal-plan-action goal-plan-action--${action}`}
                disabled={busy || isStreaming}
                title={isStreaming ? (isZh ? '请等待本轮输出结束后再操作' : 'Wait until this turn finishes') : undefined}
                onClick={() => void onNextAction(plan, action)}
              >
                {nextStepCopy[action]}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {effectiveExpanded ? (
        <div className="goal-plan-body">
          {showMergeRoute ? (
            <div
              className={`goal-plan-merge-route${
                plan.deliveryHandoff?.status === 'stopped'
                  ? ' is-blocked'
                  : plan.deliveryHandoff?.status === 'delivered'
                    ? ' is-ok'
                    : ''
              }`}
            >
              <span className="goal-plan-merge-node">
                <span className="goal-plan-merge-k">{isZh ? '任务线' : 'Task line'}</span>
                <span className="goal-plan-merge-v">{taskLineName}</span>
              </span>
              <span className="goal-plan-merge-arrow" aria-hidden="true">
                {plan.deliveryHandoff?.status === 'stopped' ? '↛' : '→'}
              </span>
              <span className="goal-plan-merge-node">
                <span className="goal-plan-merge-k">{isZh ? '发版线' : 'Source line'}</span>
                <span className="goal-plan-merge-v">{mergeDest}</span>
              </span>
            </div>
          ) : deliveryRoute ? (
            <p className="goal-plan-delivery-route">{deliveryRoute}</p>
          ) : null}
          {deliveryHandoffLabel || canMergeIntoSource ? (
            <div className="goal-plan-delivery-handoff-row">
              {deliveryHandoffLabel ? (
                <p className="goal-plan-delivery-handoff">{deliveryHandoffLabel}</p>
              ) : lampHandoff ? (
                <p className="goal-plan-delivery-handoff">{lampHandoff}</p>
              ) : null}
              {qualityReviewPending ? (
                <button
                  type="button"
                  className="goal-plan-delivery-retry"
                  disabled={lineDisabled || isStreaming}
                  onClick={() => void onNextAction(plan, 'continue-fix')}
                >
                  {isZh ? '继续修' : 'Continue fixing'}
                </button>
              ) : canMergeIntoSource ? (
                <button
                  type="button"
                  className="goal-plan-delivery-retry"
                  disabled={lineDisabled}
                  onClick={() => void mergeIntoSource()}
                >
                  {handoffStatus === 'stopped'
                    ? (isZh ? `再试一次，合并进 ${mergeDest}` : `Retry merge into ${mergeDest}`)
                    : (isZh ? `合并进 ${mergeDest}` : `Merge into ${mergeDest}`)}
                </button>
              ) : null}
            </div>
          ) : null}
          {canIsolate || canOpenSite || canDiscardLine ? (
            <div className="goal-plan-delivery-actions">
              {canIsolate ? (
                <button
                  type="button"
                  className="goal-plan-delivery-action"
                  disabled={lineDisabled}
                  onClick={() => void isolateLine()}
                >
                  {isZh ? '隔离执行' : 'Isolate'}
                </button>
              ) : null}
              {canOpenSite ? (
                <>
                  <button
                    type="button"
                    className="goal-plan-delivery-action"
                    disabled={lineDisabled}
                    onClick={() => void openSite('reveal')}
                  >
                    {isZh ? '打开现场' : 'Reveal site'}
                  </button>
                  <button
                    type="button"
                    className="goal-plan-delivery-action"
                    disabled={lineDisabled}
                    onClick={() => void openSite('editor')}
                  >
                    {isZh ? '在编辑器打开' : 'Open in editor'}
                  </button>
                </>
              ) : null}
              {canDiscardLine ? (
                <button
                  type="button"
                  className="goal-plan-delivery-action goal-plan-delivery-action--danger"
                  disabled={lineDisabled}
                  onClick={() => void discardLine()}
                >
                  {isZh ? '删除这条线' : 'Discard line'}
                </button>
              ) : null}
            </div>
          ) : null}
          {lineError ? <p className="goal-plan-delivery-error">{lineError}</p> : null}
          {nextStep ? (
            <div className="goal-plan-next-guidance" role="status">
              {nextStepCopy.guidance}
            </div>
          ) : null}
          <GoalContractSection plan={plan} isZh={isZh} editorRef={criteriaEditorRef} />
          <PlanProjectionSection
            plan={plan}
            progress={progress}
            tasks={tasks}
            tasksExpanded={tasksExpanded}
            onToggleTasks={() => setTasksExpanded((v) => !v)}
            isZh={isZh}
          />
          <RunTraceSection plan={plan} isZh={isZh} />
          {plan.runner && plan.runner.enabled ? (
            <RunnerSection
              plan={plan}
              runner={plan.runner}
              busy={busy}
              isZh={isZh}
              onControl={onRunnerControl}
              onManualConfirm={onManualConfirm}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

// 重档过渡的卸载延迟（毫秒），必须与 CSS token --za-motion-medium 对齐（见
// chat-surface.css 的 .chat-side-panel 过渡时长）。收起时 body 先随收缩动画播完
// 再卸载，避免「内容瞬间消失、空壳再慢慢缩」的割裂感。
const GOAL_PANEL_MOTION_MS = 200;

export function GoalPlanPanel({ conversationId, isZh, onApproved, sidePanelContainer, onPlansCountChange, onGoalPlanCreated, onRequestHostFocus, onActiveDeliveryChange }: GoalPlanPanelProps): ReactElement | null {
  const confirm = useConfirm();
  const [plans, setPlans] = useState<readonly GoalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    if (onPlansCountChange) onPlansCountChange(plans.length);
  }, [plans.length, onPlansCountChange]);

  // 「真正新建计划」检测基线：记录上一次已知的本会话计划数。
  // - load（切换会话）路径：只把基线刷成新会话的真实数量，绝不触发 onGoalPlanCreated；
  // - reload（goalPlans:changed 广播）路径：若基线为 0 且新数量 > 0，判定为本会话内真正新建，触发一次。
  // 切换会话时一并重置为 0（见下方 load effect），避免跨会话的脏基线导致误判。
  const prevPlanCountRef = useRef<number>(0);
  const criteriaEditorsRef = useRef(new Map<string, SuccessCriteriaEditorHandle>());
  const bindCriteriaEditor = useCallback((planId: string): Ref<SuccessCriteriaEditorHandle> => (
    (handle) => {
      if (handle) criteriaEditorsRef.current.set(planId, handle);
      else criteriaEditorsRef.current.delete(planId);
    }
  ), []);

  // 重档过渡：bodyMounted 控制右栏 body 是否仍挂载（收起时延迟卸载，让收缩动画播完）；
  // closing 标记正处于收起动画中，用于给 body 加退场样式、给右栏容器加 data-closing 提前收宽。
  const [bodyMounted, setBodyMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  // 本轮助手输出（streaming）期间，禁用「批准并执行 / 驳回」这两个治理事实写操作：
  // 计划一落库面板就出现，但本轮 AI 会话尚未结束，此时点批准会被运行时丢弃（见 0004 提案）。
  // action / streaming 拆开：GoalPlanPanel 消费 action 时不因 token 流式帧重渲染。
  const interactionActions = useContext(InteractionActionsContext);
  const interactionStreaming = useContext(InteractionStreamingContext);
  const isStreaming = interactionStreaming?.isStreaming ?? false;

  const normalizedConversationId = useMemo(
    () => normalizeConversationId(conversationId),
    [conversationId],
  );

  // 合并并发 reload：广播连发时复用 in-flight，并在结束后补一次最新拉取。
  const reloadInFlightRef = useRef<Promise<void> | null>(null);
  const reloadQueuedRef = useRef(false);
  const reloadRequestIdRef = useRef(0);
  const plansRef = useRef(plans);
  plansRef.current = plans;

  const reload = useCallback(async (options: { silent?: boolean; mode?: 'silent' | 'visible' } = {}) => {
    const silent = options.mode === 'silent' || options.silent === true;
    if (normalizedConversationId === null) {
      setPlans([]);
      prevPlanCountRef.current = 0;
      setLoading(false);
      setError(null);
      return;
    }

    if (reloadInFlightRef.current) {
      reloadQueuedRef.current = true;
      await reloadInFlightRef.current;
      return;
    }

    const requestId = ++reloadRequestIdRef.current;
    // 仅首屏/切会话可见 loading；广播驱动的静默刷新不展示「刷新中…」。
    if (!silent) {
      setLoading(true);
      setError(null);
    }

    const task = (async () => {
      try {
        const result = await clientApi.goalPlansList({ conversationId: normalizedConversationId });
        if (requestId !== reloadRequestIdRef.current) return;
        const scopedResult = result.filter(
          (plan) => normalizeConversationId(plan.conversationId) === normalizedConversationId
            && isDisplayableGoalPlan(plan),
        );
        // 仅 reload（广播驱动，同一会话内的实时变更）路径检测「真正新建」：
        // 新数量 > 基线 → 本会话内新建了计划（含同会话第 2/3/N 个），触发一次自动展开。
        // 切换会话由下方 load effect 处理（只刷基线、不触发），故这里不会被切会话误触。
        if (silent && scopedResult.length > prevPlanCountRef.current) {
          onGoalPlanCreated?.();
        }
        prevPlanCountRef.current = scopedResult.length;
        setPlans(scopedResult);
      } catch (err) {
        if (requestId !== reloadRequestIdRef.current) return;
        // 静默刷新失败不打断现有面板；仅非静默路径写 error。
        if (!silent) {
          setError(err instanceof Error ? err.message : isZh ? '加载计划失败' : 'Failed to load plans');
        }
      } finally {
        if (requestId === reloadRequestIdRef.current && !silent) {
          setLoading(false);
        }
      }
    })();

    reloadInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (reloadInFlightRef.current === task) reloadInFlightRef.current = null;
      if (reloadQueuedRef.current) {
        reloadQueuedRef.current = false;
        void reload({ mode: 'silent' });
      }
    }
  }, [normalizedConversationId, isZh, onGoalPlanCreated]);

  useEffect(() => {
    let cancelled = false;

    // 切换会话：先把基线重置为 0，避免上一个会话的脏基线影响判断；
    // 加载完成后只把基线刷成新会话的真实数量，绝不触发 onGoalPlanCreated。
    // 这是「切到一个本来就有计划的会话不自动弹开侧栏」的关键所在。
    prevPlanCountRef.current = 0;
    reloadRequestIdRef.current += 1;
    const load = async () => {
      if (normalizedConversationId === null) {
        setPlans([]);
        prevPlanCountRef.current = 0;
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await clientApi.goalPlansList({ conversationId: normalizedConversationId });
        if (cancelled) return;
        const scopedResult = result.filter(
          (plan) => normalizeConversationId(plan.conversationId) === normalizedConversationId
            && isDisplayableGoalPlan(plan),
        );
        // load 路径只刷新基线，不触发新建回调（切换会话不应被视为「新建计划」）。
        prevPlanCountRef.current = scopedResult.length;
        setPlans(scopedResult);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : isZh ? '加载计划失败' : 'Failed to load plans');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [normalizedConversationId, isZh]);

  // 实时同步：任一写路径（IPC 或 AI 工具 goal_create_plan/goal_update_task 等）
  // 改动计划后，main 广播 'goalPlans:changed'；此处订阅并静默重拉。
  // 会话过滤 + runner-progress 本地 patch，避免无关会话全量 list 与「刷新中…」。
  useEffect(() => {
    const unsubscribe = clientApi.onGoalPlansChanged((payload) => {
      if (!shouldRefreshForConversation(payload, normalizedConversationId, plansRef.current)) {
        return;
      }
      if (payload?.changeKind === 'runner-progress') {
        const patched = patchPlanRunner(
          plansRef.current,
          payload.planId,
          payload.runner,
        );
        if (patched) {
          setPlans(patched);
          return;
        }
        // 无本地目标 plan 时退回静默全量（例如新建后首个 progress 事件）。
      }
      void reload({ mode: 'silent' });
    });
    return unsubscribe;
  }, [normalizedConversationId, reload]);

  // Runner 每个 tick 改动 plan.runner 后，main 同样广播 'goalRunner:changed'；
  // runner 状态内嵌在 plan 内，这里据此刷新；进度优先本地 patch。
  useEffect(() => {
    const unsubscribe = clientApi.onGoalRunnerChanged((payload) => {
      if (!shouldRefreshForConversation(payload, normalizedConversationId, plansRef.current)) {
        return;
      }
      if (payload?.changeKind === 'runner-progress' || payload?.runner) {
        const patched = patchPlanRunner(
          plansRef.current,
          payload.planId,
          (payload.runner) ?? null,
        );
        if (patched) {
          setPlans(patched);
          return;
        }
      }
      // 结构/状态跃迁或缺 runner 时静默全量。
      void reload({ mode: 'silent' });
    });
    return unsubscribe;
  }, [normalizedConversationId, reload]);

  // Runner 控制：pause/resume/clear。renderer 不直接执行本地能力，
  // 全部经 clientApi → preload → IPC → goalRunner（main），再由广播驱动 reload。
  const controlRunner = useCallback(
    async (plan: GoalPlan, action: 'pause' | 'resume' | 'clear') => {
      setBusyPlanId(plan.planId);
      setError(null);
      try {
        if (action === 'pause') {
          await clientApi.goalRunnerPause({ planId: plan.planId });
        } else if (action === 'resume') {
          await clientApi.goalRunnerResume({ planId: plan.planId });
        } else {
          await clientApi.goalRunnerClear({ planId: plan.planId });
          await confirmDiscardAfterStop(confirm, plan, isZh);
        }
        await reload({ mode: 'silent' });
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [confirm, reload, isZh],
  );

  const recordManualDodConfirmation = useCallback(
    async (plan: GoalPlan, decision: GoalManualConfirmation['decision']) => {
      setBusyPlanId(plan.planId);
      setError(null);
      try {
        await clientApi.goalPlansRecordManualConfirmation({
          planId: plan.planId,
          confirmation: buildManualDodConfirmation(plan, decision),
        });
        if (decision === 'approve') {
          await clientApi.goalRunnerResume({
            planId: plan.planId,
            options: { intent: 'verify', phase: 'verify' },
          });
        }
        await reload({ mode: 'silent' });
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [reload, isZh],
  );

  // 批准 / 驳回收敛到共享 hook（单一事实源）：右侧面板与聊天侧批准卡共用同一条
  // goalPlansApprove（带 confirmationId 的二元治理事实）链路，状态经 goalPlans:changed
  // 广播互相消解。见 Goal 模式运行时闸门设计。
  const handleApprovalSettled = useCallback(async () => {
    await reload({ mode: 'silent' });
  }, [reload]);

  const {
    busyPlanId: approvalBusyPlanId,
    error: approvalError,
    decide,
  } = useGoalPlanApproval({
    isZh,
    onApproved,
    onSettled: handleApprovalSettled,
  });

  const handleNextAction = useCallback(
    async (plan: GoalPlan, action: GoalPlanNextAction) => {
      if (action === 'continue-fix') {
        interactionActions?.onSelectOption(continueFixingMessage(plan.planId, isZh));
        onRequestHostFocus?.();
        return;
      }
      if (action === 'adjust') {
        interactionActions?.onSelectOption(goalPlanNextStepCopy(isZh).adjustmentMessage);
        onRequestHostFocus?.();
        return;
      }
      if (plan.status === 'awaiting_approval') {
        const saved = await criteriaEditorsRef.current.get(plan.planId)?.flush();
        if (saved === false) return;
        await decide(plan, action === 'start' ? 'approve' : 'reject');
        return;
      }

      setBusyPlanId(plan.planId);
      setError(null);
      try {
        if (action === 'start') {
          await clientApi.goalRunnerStart({ planId: plan.planId, options: { intent: 'execute' } });
        } else {
          // 与工作台一致：clear 才会真正停 runner / 后续流式，不能只写 cancelled 状态。
          await clientApi.goalRunnerClear({ planId: plan.planId });
          await confirmDiscardAfterStop(confirm, plan, isZh);
        }
        await reload({ mode: 'silent' });
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [confirm, decide, interactionActions, isZh, onRequestHostFocus, reload],
  );

  // 渲染态合并：批准/驳回的 busy/error 来自共享 hook，runner 控制（pause/resume/clear）
  // 仍用面板自身的 busyPlanId/error。任一来源 busy 即视为该计划 busy。
  const effectiveBusyPlanId = approvalBusyPlanId ?? busyPlanId;
  const effectiveError = approvalError ?? error;

  // 推到右侧 Workbench Goal slot 后，折叠/展开由 Workbench tab 接管，
  // 面板内容始终视为展开（无 docked toggle 形态）。
  const dockedToWorkbench = !!sidePanelContainer;
  // B：有待批准计划时强制展开且不可手动收起，确保「批准并执行/驳回」按钮永远可见；
  // 折叠仅对「无待批准（全部已批准/执行中/完成）」的情况生效。
  const lockedOpen = hasPendingGoalApproval(plans);
  const expanded = dockedToWorkbench
    ? true
    : lockedOpen
      ? true
      : manualCollapsed === null
        ? false
        : !manualCollapsed;

  // 重档过渡（延迟卸载）：展开 → 立即挂载 body 并清除 closing；收起 → 先标记 closing
  // 触发收缩动画，GOAL_PANEL_MOTION_MS 后再真正卸载 body。
  // 注意：此 effect 必须在任何 early-return 之前，保证 Hook 调用顺序稳定（React Hooks 规则）。
  useEffect(() => {
    if (expanded) {
      setClosing(false);
      setBodyMounted(true);
      return undefined;
    }
    if (!bodyMounted) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setBodyMounted(false);
      setClosing(false);
    }, GOAL_PANEL_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, bodyMounted]);

  // 把 closing 状态写到右栏容器（portal 宿主）上，让它在 body 卸载前就开始收宽，
  // 消除「内容瞬间消失、空壳再慢慢缩」的割裂感。仅在注入了 sidePanelContainer 时生效。
  useEffect(() => {
    if (!sidePanelContainer) return undefined;
    if (closing) {
      sidePanelContainer.setAttribute('data-closing', 'true');
    } else {
      sidePanelContainer.removeAttribute('data-closing');
    }
    return undefined;
  }, [closing, sidePanelContainer]);

  const planViewModel = useMemo(() => {
    const activePlan =
      plans.find((plan) => plan.status === 'awaiting_approval') ??
      plans.find((plan) => plan.status === 'executing') ??
      plans[0] ??
      null;
    const mainPlan = selectPrimaryGoalPlan(plans);
    const listPlans = mainPlan ? plans.filter((plan) => plan.planId !== mainPlan.planId) : plans;
    // 历史清单按父子链推导顺序，但渲染为完全对齐的平铺列表，不做层级缩进。
    const orderedListPlans = orderGoalPlansByLineage(listPlans);
    return { activePlan, mainPlan, listPlans, orderedListPlans };
  }, [plans]);

  useEffect(() => {
    onActiveDeliveryChange?.(snapshotDeliveryLine(planViewModel.activePlan));
  }, [onActiveDeliveryChange, planViewModel.activePlan]);

  // 面板位于输入框上方：没有计划时不占位，直接隐藏。
  if (plans.length === 0) {
    return null;
  }
  const { activePlan, mainPlan, listPlans, orderedListPlans } = planViewModel;
  const activeProgress = activePlan ? safeProgress(activePlan) : null;
  const hasUnarchivedHint = Boolean(
    activePlan
    && isPlanArchivedToSource(activePlan)
    && plans.some((plan) => plan.planId !== activePlan.planId && !isPlanArchivedToSource(plan)),
  );
  // A：折叠态浮条「执行中」时给根节点附加状态 class，驱动边缘流动光效（见 goal-panel.css）。
  // 仅当存在执行中的计划、且面板处于折叠态（浮条形态）时启用，避免展开后内部已有进度动效叠加干扰。
  const hasExecutingPlan = plans.some((plan) => plan.status === 'executing');
  const dockedExecuting = hasExecutingPlan && !expanded;
  // A：折叠态浮条「完成」标志只反馈正式 Goal 的执行完成。
  // intake 草稿即使已收束为 completed，也不代表用户目标已执行完成，因此不展示完成视觉。
  // 注意优先级：执行中 / 待批准会压过完成态（dockedExecuting 与 lockedOpen 优先），
  // 避免「一个完成、另一个仍在跑」时误显示完成。
  const hasAwaitingPlan = hasPendingGoalApproval(plans);
  const hasCompletedFormalGoal = plans.some(shouldShowGoalCompletionFeedback);
  const dockedCompleted =
    hasCompletedFormalGoal && !hasExecutingPlan && !hasAwaitingPlan && !expanded;

  return (
    <div
      className={`goal-panel goal-panel--docked${expanded ? ' goal-panel--expanded' : ''}${
        dockedExecuting ? ' goal-panel--executing' : ''
      }${dockedCompleted ? ' goal-panel--completed' : ''}${
        dockedToWorkbench ? ' goal-panel--hosted' : ''
      }${hasPendingGoalApproval(plans) ? ' goal-panel--approval-inline' : ''
      }`}
    >
      {(() => {
        // 整条折叠灯条 hover 显示该 goal 全部步骤；点击仍走 button 展开/收起。
        const goalTasksTooltipContent =
          (dockedToWorkbench || !expanded) && activePlan
            ? renderGoalTasksTooltipContent(activePlan, isZh)
            : null;
        const activeTaskList = activePlan ? collectGoalTasks(activePlan.tasks) : [];
        const goalTasksAriaLabel =
          activeTaskList.length > 0
            ? activeTaskList
                .map((task) => `${statusLabel(task.status, isZh)}: ${task.title}`)
                .join('; ')
            : (isZh ? '暂无步骤' : 'No steps');
        const toggleButton = (
          <button
            type="button"
            className="goal-panel-toggle"
            aria-expanded={dockedToWorkbench ? undefined : expanded}
            disabled={lockedOpen && !dockedToWorkbench}
            aria-label={goalTasksTooltipContent ? goalTasksAriaLabel : undefined}
            title={
              // 有步骤 tooltip 时不再用原生 title，避免两套提示打架。
              goalTasksTooltipContent
                ? undefined
                : dockedToWorkbench
                  ? (isZh ? '在工作台中查看' : 'View in workbench')
                  : lockedOpen
                    ? (isZh ? '有待批准计划，需先处理' : 'Pending approval — resolve first')
                    : undefined
            }
            onClick={() => {
              if (dockedToWorkbench) {
                onRequestHostFocus?.();
                return;
              }
              if (lockedOpen) return;
              setManualCollapsed(expanded);
            }}
          >
            {activePlan ? (
              <span className="goal-panel-toggle-active">
                {activePlan.status === 'executing' ? (
                  <span className="goal-panel-toggle-active-dot" aria-hidden="true" />
                ) : dockedCompleted ? (
                  <span
                    className="goal-panel-toggle-active-check"
                    aria-label={isZh ? '已完成' : 'Completed'}
                    role="img"
                  >
                    ✓
                  </span>
                ) : null}
                <span className="goal-panel-toggle-active-title">{derivePlanTitle(activePlan, isZh)}</span>
                {(() => {
                  const lampHandoff = formatGoalDeliveryHandoffLamp(activePlan, {
                    locale: isZh ? 'zh' : 'en',
                  });
                  if (lampHandoff) {
                    return (
                      <span className="goal-panel-toggle-active-handoff">
                        {lampHandoff}
                      </span>
                    );
                  }
                  return activeProgress ? (
                    <span className="goal-panel-toggle-active-progress">
                      {`${activeProgress.completed}/${activeProgress.total}`}
                    </span>
                  ) : null;
                })()}
                {hasUnarchivedHint ? (
                  <span className="goal-panel-toggle-active-handoff">
                    {isZh ? '有未归档' : 'Unarchived remaining'}
                  </span>
                ) : null}
              </span>
            ) : null}
            {lockedOpen && !dockedToWorkbench ? null : (
              <span className="goal-panel-toggle-caret" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </span>
            )}
          </button>
        );
        return goalTasksTooltipContent ? (
          <Tooltip content={goalTasksTooltipContent} placement="top">
            {toggleButton}
          </Tooltip>
        ) : (
          toggleButton
        );
      })()}
      {!bodyMounted ? null : (() => {
        const body = (
      <div className={`goal-panel-body${closing ? ' goal-panel-body--closing' : ''}`}>
      {effectiveError ? <div className="goal-panel-error">{effectiveError}</div> : null}
      {/* 主卡 = mainPlan（仅待批准 / 执行中）才置顶强制展开。
          没有进行中的计划时 mainPlan 为 null，不钉主卡，全部计划进入下方折叠清单。 */}
      {mainPlan ? (
        <PlanCard
          key={mainPlan.planId}
          plan={mainPlan}
          defaultExpanded
          isMain
          isZh={isZh}
          isStreaming={isStreaming}
          busy={effectiveBusyPlanId === mainPlan.planId}
          onNextAction={handleNextAction}
          criteriaEditorRef={bindCriteriaEditor(mainPlan.planId)}
          onRunnerControl={controlRunner}
          onManualConfirm={recordManualDodConfirmation}
        />
      ) : null}
      {listPlans.length > 0 ? (
        <div className="goal-plan-history">
          <div className="goal-plan-history-title">
            {mainPlan
              ? isZh
                ? `历史计划 ${listPlans.length}`
                : `History ${listPlans.length}`
              : isZh
                ? `目标计划 ${listPlans.length}`
                : `Plans ${listPlans.length}`}
          </div>
          {orderedListPlans.map((plan) => (
            <PlanCard
              key={plan.planId}
              plan={plan}
              defaultExpanded={shouldDefaultExpandGoalPlan(plan)}
              isZh={isZh}
              isStreaming={isStreaming}
              busy={effectiveBusyPlanId === plan.planId}
              onNextAction={handleNextAction}
              criteriaEditorRef={bindCriteriaEditor(plan.planId)}
              onRunnerControl={controlRunner}
              onManualConfirm={recordManualDodConfirmation}
            />
          ))}
        </div>
      ) : null}
      </div>
        );
        // 右侧始终承载完整计划详情；待审批时，聊天底部只渲染一行紧凑摘要和三个决策按钮。
        if (sidePanelContainer && hasPendingGoalApproval(plans) && mainPlan) {
          return (
            <>
              <CompactApprovalBar
                plan={mainPlan}
                isZh={isZh}
                busy={effectiveBusyPlanId === mainPlan.planId}
                isStreaming={isStreaming}
                onNextAction={handleNextAction}
              />
              {createPortal(body, sidePanelContainer)}
            </>
          );
        }
        return sidePanelContainer ? createPortal(body, sidePanelContainer) : body;
      })()}
    </div>
  );
}
