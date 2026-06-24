import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement } from 'react';
import type {
  ExecutionStatus,
  GoalExplorerRun,
  GoalPlan,
  GoalRunnerState,
  GoalRunnerStatus,
  GoalTask,
} from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { InteractionContext } from './thread/interactionContext';

function normalizeConversationId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
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
   * docked 灯条被点击。当面板已迁到 Workbench 时，由上层负责展开 Workbench 并切到 Goal tab。
   */
  readonly onRequestHostFocus?: () => void;
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

/**
 * 计划标题兜底：goal_create_plan 的 title 多数情况下模型不传（为空字符串），
 * 但 goal 通常有内容。此处用 goal 的首句/截断派生一个可读标题，
 * 避免所有计划都显示「未命名计划」。仅 title 与 goal 均为空时才回退占位文案。
 */
function derivePlanTitle(plan: GoalPlan, isZh: boolean): string {
  const title = typeof plan.title === 'string' ? plan.title.trim() : '';
  if (title) return title;
  const goal = typeof plan.goal === 'string' ? plan.goal.trim() : '';
  if (goal) {
    const firstLine = goal.split(/\r?\n/)[0]?.trim() ?? '';
    const source = firstLine || goal;
    return source.length > 40 ? `${source.slice(0, 40)}…` : source;
  }
  return isZh ? '未命名计划' : 'Untitled plan';
}

function planStatusLabel(status: GoalPlan['status'], isZh: boolean): string {
  const zh: Record<GoalPlan['status'], string> = {
    drafting: '草拟中',
    awaiting_approval: '待批准',
    approved: '已批准',
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

// Runner 状态文案；只表达托管编排状态，不代表工具执行 Evidence。
function runnerStatusLabel(status: GoalRunnerStatus, isZh: boolean): string {
  const zh: Record<GoalRunnerStatus, string> = {
    idle: '空闲',
    running: '推进中',
    paused: '已暂停',
    exploring: '探索中',
    blocked: '已阻塞',
    budget_exhausted: '预算耗尽',
    completed: '已完成',
    failed: '已失败',
  };
  const en: Record<GoalRunnerStatus, string> = {
    idle: 'Idle',
    running: 'Running',
    paused: 'Paused',
    exploring: 'Exploring',
    blocked: 'Blocked',
    budget_exhausted: 'Budget exhausted',
    completed: 'Completed',
    failed: 'Failed',
  };
  return isZh ? zh[status] : en[status];
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

function TaskNode({ task, depth, isZh }: { task: GoalTask; depth: number; isZh: boolean }): ReactElement {
  const hasEvidence = task.evidenceRefs.length > 0;
  const [expanded, setExpanded] = useState(false);
  const evidenceCount = task.evidenceRefs.length;
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
                {task.evidenceRefs.map((ref) => (
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
            <TaskNode key={child.taskId} task={child} depth={depth + 1} isZh={isZh} />
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
}: {
  plan: GoalPlan;
  runner: GoalRunnerState;
  busy: boolean;
  isZh: boolean;
  onControl: (plan: GoalPlan, action: 'pause' | 'resume' | 'clear') => void | Promise<void>;
}): ReactElement {
  const explorers = Array.isArray(runner.explorers) ? runner.explorers : [];
  const canPause = RUNNER_ACTIVE_STATUSES.has(runner.status);
  const canResume = RUNNER_RESUMABLE_STATUSES.has(runner.status);
  const isTerminal = RUNNER_TERMINAL_STATUSES.has(runner.status);
  const showAttention = runner.status === 'blocked' || runner.status === 'budget_exhausted';

  return (
    <div className={`goal-runner goal-runner--${runner.status}`}>
      <div className="goal-runner-head">
        <span className={`goal-runner-status goal-runner-status--${runner.status}`}>
          {runnerStatusLabel(runner.status, isZh)}
        </span>
        <span className="goal-runner-counters">
          {isZh
            ? `轮次 ${runner.turnCount} · 工具 ${runner.toolCallCount} · 探索 ${runner.explorerCount}/${runner.maxExplorers}`
            : `turns ${runner.turnCount} · tools ${runner.toolCallCount} · explorers ${runner.explorerCount}/${runner.maxExplorers}`}
        </span>
      </div>
      {showAttention && runner.blockedReason ? (
        <div className="goal-runner-attention">{runner.blockedReason}</div>
      ) : null}
      {runner.lastError ? (
        <div className="goal-runner-attention goal-runner-attention--error">{runner.lastError}</div>
      ) : null}
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
    </div>
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

interface PlanCardProps {
  readonly plan: GoalPlan;
  readonly defaultExpanded: boolean;
  readonly isZh: boolean;
  readonly isStreaming: boolean;
  readonly busy: boolean;
  readonly isMain?: boolean;
  readonly onDecide: (plan: GoalPlan, decision: 'approve' | 'reject') => void | Promise<void>;
  readonly onRunnerControl: (plan: GoalPlan, action: 'pause' | 'resume' | 'clear') => void | Promise<void>;
}

function PlanCard({ plan, defaultExpanded, isZh, isStreaming, busy, isMain, onDecide, onRunnerControl }: PlanCardProps): ReactElement {
  // 待批准计划强制展开，确保「批准 / 驳回」按钮永远可见。
  const awaitingLock = plan.status === 'awaiting_approval';
  // 主卡（当前计划）永远展开；待批准计划同样强制展开。两者都隐藏 caret、禁用折叠。
  const lockedOpen = awaitingLock || !!isMain;
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded || lockedOpen);
  const effectiveExpanded = lockedOpen || expanded;
  // 子任务明细默认收起：主卡进入时只显示「标题 + 描述 + 进度条」，
  // 点进度条才展开 goal-task-list。
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const canDecide = plan.status === 'awaiting_approval';
  const progress = safeProgress(plan);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const title = derivePlanTitle(plan, isZh);

  return (
    <section
      className={`goal-plan-card${effectiveExpanded ? ' goal-plan-card--expanded' : ''}${isMain ? ' goal-plan-card--main' : ''}`}
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
          <span className="goal-plan-head-progress">
            {`${progress.completed}/${progress.total}`}
          </span>
          {lockedOpen ? null : (
            <span className="goal-plan-head-caret" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          )}
        </button>
        {canDecide ? (
          <div className="goal-plan-actions goal-plan-actions--inline">
            <button
              type="button"
              className="goal-plan-approve"
              disabled={busy || isStreaming}
              title={isStreaming ? (isZh ? '请等待本轮输出结束后再批准' : 'Wait until this turn finishes before approving') : undefined}
              onClick={() => void onDecide(plan, 'approve')}
            >
              {isZh ? '批准并执行' : 'Approve & run'}
            </button>
            <button
              type="button"
              className="goal-plan-reject"
              disabled={busy || isStreaming}
              title={isStreaming ? (isZh ? '请等待本轮输出结束后再操作' : 'Wait until this turn finishes') : undefined}
              onClick={() => void onDecide(plan, 'reject')}
            >
              {isZh ? '驳回' : 'Reject'}
            </button>
          </div>
        ) : null}
      </header>
      {effectiveExpanded ? (
        <div className="goal-plan-body">
          {/* 排序：标题(header) → 描述(默认可见) → 进度条(可点击开关) → 子任务清单(默认收起) → Runner。 */}
          {plan.goal ? (
            <div className="goal-plan-goal-block">
              <p className="goal-plan-goal">{plan.goal}</p>
            </div>
          ) : null}
          {/* 进度条即「展开/收起子任务」的开关：点它切换下方 goal-task-list 显隐。 */}
          <button
            type="button"
            className={`goal-plan-progress${tasksExpanded ? ' goal-plan-progress--open' : ''}`}
            onClick={() => setTasksExpanded((v) => !v)}
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
                  <TaskNode key={task.taskId} task={task} depth={0} isZh={isZh} />
                ))}
              </ul>
            ) : (
              <div className="goal-plan-empty-tasks">{isZh ? '尚无拆解的子任务' : 'No tasks yet'}</div>
            )
          ) : null}
          {plan.runner && plan.runner.enabled ? (
            <RunnerSection
              plan={plan}
              runner={plan.runner}
              busy={busy}
              isZh={isZh}
              onControl={onRunnerControl}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// 重档过渡的卸载延迟（毫秒），必须与 CSS token --za-motion-medium 对齐（见
// chat-surface.css 的 .chat-side-panel 过渡时长）。收起时 body 先随收缩动画播完
// 再卸载，避免「内容瞬间消失、空壳再慢慢缩」的割裂感。
const GOAL_PANEL_MOTION_MS = 200;

export function GoalPlanPanel({ conversationId, isZh, onApproved, sidePanelContainer, onPlansCountChange, onRequestHostFocus }: GoalPlanPanelProps): ReactElement | null {
  const [plans, setPlans] = useState<readonly GoalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    if (onPlansCountChange) onPlansCountChange(plans.length);
  }, [plans.length, onPlansCountChange]);

  // 重档过渡：bodyMounted 控制右栏 body 是否仍挂载（收起时延迟卸载，让收缩动画播完）；
  // closing 标记正处于收起动画中，用于给 body 加退场样式、给右栏容器加 data-closing 提前收宽。
  const [bodyMounted, setBodyMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  // 本轮助手输出（streaming）期间，禁用「批准并执行 / 驳回」这两个治理事实写操作：
  // 计划一落库面板就出现，但本轮 AI 会话尚未结束，此时点批准会被运行时丢弃（见 0004 提案）。
  // 复用既有 InteractionContext（GoalPlanPanel 渲染在该 Provider 内），不新增 prop 透传。
  const interaction = useContext(InteractionContext);
  const isStreaming = interaction?.isStreaming ?? false;

  const normalizedConversationId = useMemo(
    () => normalizeConversationId(conversationId),
    [conversationId],
  );

  const reload = useCallback(async () => {
    if (normalizedConversationId === null) {
      setPlans([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await clientApi.goalPlansList({ conversationId: normalizedConversationId });
      const scopedResult = result.filter(
        (plan) => normalizeConversationId(plan.conversationId) === normalizedConversationId
          && plan.status !== 'cancelled',
      );
      setPlans(scopedResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : isZh ? '加载计划失败' : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, [normalizedConversationId, isZh]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (normalizedConversationId === null) {
        setPlans([]);
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
            && plan.status !== 'cancelled',
        );
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

  // 实时同步：任一写路径（IPC 或 AI 工具 goal_create_plan/goal_update_task）改动计划后，
  // main 会广播 'goalPlans:changed'，这里据此重拉，无需用户切换会话/重挂载面板。
  // 修复 bug：goal 模式下 AI 创建计划后面板不刷新、需切走再切回才显示。
  useEffect(() => {
    const unsubscribe = clientApi.onGoalPlansChanged(() => {
      void reload();
    });
    return unsubscribe;
  }, [reload]);

  // Runner 每个 tick 改动 plan.runner 后，main 同样广播 'goalRunner:changed'；
  // runner 状态内嵌在 plan 内，这里据此重拉，托管状态实时反映在面板而不刷进聊天流。
  useEffect(() => {
    const unsubscribe = clientApi.onGoalRunnerChanged(() => {
      void reload();
    });
    return unsubscribe;
  }, [reload]);

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
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [reload, isZh],
  );

  const decide = useCallback(
    async (plan: GoalPlan, decision: 'approve' | 'reject') => {
      setBusyPlanId(plan.planId);
      setError(null);
      try {
        await clientApi.goalPlansApprove({
          planId: plan.planId,
          approval: {
            decision,
            // 治理事实：confirmationId 绑定一次人工确认。此处用前端生成的占位，
            // 真正的执行链路会以运行时 HumanConfirmation 的 id 覆盖。
            confirmationId: `ui-${Date.now()}`,
            decidedAt: new Date().toISOString(),
          },
        });
        await reload();
        // 批准成功后唤起 chat runtime 发起「执行轮」。落库（治理事实）与执行驱动分离：
        // store 已记录 GoalApproval Evidence，这里再通过回调进入既有发送路径开始执行。
        // 见 Goal 模式设计 阶段二→阶段三。
        if (decision === 'approve') {
          onApproved?.(plan);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [reload, isZh, onApproved],
  );

  const pendingCount = plans.filter((plan) => plan.status === 'awaiting_approval').length;
  // 推到右侧 Workbench Goal slot 后，折叠/展开由 Workbench tab 接管，
  // 面板内容始终视为展开（无 docked toggle 形态）。
  const dockedToWorkbench = !!sidePanelContainer;
  // B：有待批准计划时强制展开且不可手动收起，确保「批准并执行/驳回」按钮永远可见；
  // 折叠仅对「无待批准（全部已批准/执行中/完成）」的情况生效。
  const lockedOpen = pendingCount > 0;
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

  // 面板位于输入框上方：没有计划时不占位，直接隐藏。
  if (plans.length === 0) {
    return null;
  }
  const refreshing = loading ? (isZh ? ' · 刷新中…' : ' · refreshing…') : '';
  // A：折叠态也要有信息密度——挑一个「活跃计划」（优先待批准，其次执行中，再次第一个），
  // 在 header 上直接显示它的标题与 X/Y 迷你进度，避免「很长却什么都没有」。
  const activePlan =
    plans.find((plan) => plan.status === 'awaiting_approval') ??
    plans.find((plan) => plan.status === 'executing') ??
    plans[0] ??
    null;
  const activeProgress = activePlan ? safeProgress(activePlan) : null;
  // 主卡 = 仅「待批准 / 执行中」的计划才置顶强制展开；没有进行中的计划时为 null，
  // 此时不再把第一个（可能已完成）计划钉在顶部，全部计划进入下方折叠清单。
  const mainPlan =
    plans.find((plan) => plan.status === 'awaiting_approval') ??
    plans.find((plan) => plan.status === 'executing') ??
    null;
  // 清单计划 = 除主卡外的其余计划，保持原顺序；mainPlan 为 null 时即全部计划。
  const listPlans = mainPlan ? plans.filter((plan) => plan.planId !== mainPlan.planId) : plans;
  // A：折叠态浮条「执行中」时给根节点附加状态 class，驱动边缘流动光效（见 goal-panel.css）。
  // 仅当存在执行中的计划、且面板处于折叠态（浮条形态）时启用，避免展开后内部已有进度动效叠加干扰。
  const hasExecutingPlan = plans.some((plan) => plan.status === 'executing');
  const dockedExecuting = hasExecutingPlan && !expanded;
  // A：折叠态浮条「完成」标志——当不存在执行中 / 待批准的计划，且至少有一个计划已完成时，
  // 视为整体处于「完成态」，给浮条停止扫光并显示静态完成视觉（完成色描边 + 对勾）。
  // 注意优先级：执行中 / 待批准会压过完成态（dockedExecuting 与 lockedOpen 优先），
  // 避免「一个完成、另一个仍在跑」时误显示完成。
  const hasAwaitingPlan = plans.some((plan) => plan.status === 'awaiting_approval');
  const hasCompletedPlan = plans.some((plan) => plan.status === 'completed');
  const dockedCompleted =
    hasCompletedPlan && !hasExecutingPlan && !hasAwaitingPlan && !expanded;
  const summary = isZh
    ? `${plans.length} 个目标计划${pendingCount > 0 ? ` · ${pendingCount} 待批准` : ''}${refreshing}`
    : `${plans.length} goal plan${plans.length > 1 ? 's' : ''}${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}${refreshing}`;

  return (
    <div
      className={`goal-panel goal-panel--docked${expanded ? ' goal-panel--expanded' : ''}${
        dockedExecuting ? ' goal-panel--executing' : ''
      }${dockedCompleted ? ' goal-panel--completed' : ''}${
        dockedToWorkbench ? ' goal-panel--hosted' : ''
      }`}
    >
      <button
        type="button"
        className="goal-panel-toggle"
        aria-expanded={dockedToWorkbench ? undefined : expanded}
        disabled={lockedOpen && !dockedToWorkbench}
        title={
          dockedToWorkbench
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
        <span className="goal-panel-toggle-label">{isZh ? '目标计划' : 'Goal plans'}</span>
        <span className="goal-panel-toggle-summary">{summary}</span>
        {pendingCount > 0 ? <span className="goal-panel-toggle-badge">{pendingCount}</span> : null}
        {(dockedToWorkbench || !expanded) && activePlan ? (
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
            {activeProgress ? (
              <span className="goal-panel-toggle-active-progress">
                {`${activeProgress.completed}/${activeProgress.total}`}
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
      {!bodyMounted ? null : (() => {
        const body = (
      <div className={`goal-panel-body${closing ? ' goal-panel-body--closing' : ''}`}>
      {error ? <div className="goal-panel-error">{error}</div> : null}
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
          busy={busyPlanId === mainPlan.planId}
          onDecide={decide}
          onRunnerControl={controlRunner}
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
          {listPlans.map((plan) => (
            <PlanCard
              key={plan.planId}
              plan={plan}
              defaultExpanded={false}
              isZh={isZh}
              isStreaming={isStreaming}
              busy={busyPlanId === plan.planId}
              onDecide={decide}
              onRunnerControl={controlRunner}
            />
          ))}
        </div>
      ) : null}
      </div>
        );
        // 方案 B：注入了右栏容器则 portal 投影到主内容区右侧常驻分栏；
        // 未注入（如单测/旧路径）回退为就地内联展开，保持向后兼容。
        return sidePanelContainer ? createPortal(body, sidePanelContainer) : body;
      })()}
    </div>
  );
}
