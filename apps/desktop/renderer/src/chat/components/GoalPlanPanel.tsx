import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { ExecutionStatus, GoalPlan, GoalTask } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

function normalizeConversationId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Goal 模式计划面板 —— 见 docs/proposals/0002-goal-mode.md。
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
   * 见 docs/proposals/0002-goal-mode.md 时序图阶段二→阶段三。
   */
  readonly onApproved?: (plan: GoalPlan) => void;
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

function TaskNode({ task, depth, isZh }: { task: GoalTask; depth: number; isZh: boolean }): ReactElement {
  const hasEvidence = task.evidenceRefs.length > 0;
  return (
    <li className="goal-task" style={{ marginInlineStart: depth * 16 }}>
      <div className="goal-task-row">
        <span className={statusClass(task.status)} aria-label={statusLabel(task.status, isZh)}>
          {statusLabel(task.status, isZh)}
        </span>
        <span className="goal-task-title">{task.title}</span>
        {/* 完成状态以 Evidence 为准：仅当任务 completed 时提示其证据数量，面板不提供手动勾选 */}
        {task.status === 'completed' && hasEvidence ? (
          <span className="goal-task-evidence" title={task.evidenceRefs.join(', ')}>
            {isZh ? `证据 ×${task.evidenceRefs.length}` : `evidence ×${task.evidenceRefs.length}`}
          </span>
        ) : null}
      </div>
      {task.failureReason ? (
        <div className="goal-task-detail goal-task-detail--error">{task.failureReason}</div>
      ) : null}
      {task.blockedReason ? (
        <div className="goal-task-detail goal-task-detail--warn">{task.blockedReason}</div>
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

export function GoalPlanPanel({ conversationId, isZh, onApproved }: GoalPlanPanelProps): ReactElement | null {
  const [plans, setPlans] = useState<readonly GoalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

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
        // 见 docs/proposals/0002-goal-mode.md 阶段二→阶段三。
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

  // 面板位于输入框上方：没有计划时不占位，直接隐藏。
  if (plans.length === 0) {
    return null;
  }

  const pendingCount = plans.filter((plan) => plan.status === 'awaiting_approval').length;
  // B：有待批准计划时强制展开且不可手动收起，确保「批准并执行/驳回」按钮永远可见；
  // 折叠仅对「无待批准（全部已批准/执行中/完成）」的情况生效。
  const lockedOpen = pendingCount > 0;
  const expanded = lockedOpen ? true : manualCollapsed === null ? false : !manualCollapsed;
  const refreshing = loading ? (isZh ? ' · 刷新中…' : ' · refreshing…') : '';
  // A：折叠态也要有信息密度——挑一个「活跃计划」（优先待批准，其次执行中，再次第一个），
  // 在 header 上直接显示它的标题与 X/Y 迷你进度，避免「很长却什么都没有」。
  const activePlan =
    plans.find((plan) => plan.status === 'awaiting_approval') ??
    plans.find((plan) => plan.status === 'executing') ??
    plans[0] ??
    null;
  const activeProgress = activePlan ? safeProgress(activePlan) : null;
  const summary = isZh
    ? `${plans.length} 个目标计划${pendingCount > 0 ? ` · ${pendingCount} 待批准` : ''}${refreshing}`
    : `${plans.length} goal plan${plans.length > 1 ? 's' : ''}${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}${refreshing}`;

  return (
    <div className={`goal-panel goal-panel--docked${expanded ? ' goal-panel--expanded' : ''}`}>
      <button
        type="button"
        className="goal-panel-toggle"
        aria-expanded={expanded}
        disabled={lockedOpen}
        title={lockedOpen ? (isZh ? '有待批准计划，需先处理' : 'Pending approval — resolve first') : undefined}
        onClick={() => {
          if (lockedOpen) return;
          setManualCollapsed(expanded);
        }}
      >
        <span className="goal-panel-toggle-label">{isZh ? '目标计划' : 'Goal plans'}</span>
        <span className="goal-panel-toggle-summary">{summary}</span>
        {pendingCount > 0 ? <span className="goal-panel-toggle-badge">{pendingCount}</span> : null}
        {!expanded && activePlan ? (
          <span className="goal-panel-toggle-active">
            <span className="goal-panel-toggle-active-title">{derivePlanTitle(activePlan, isZh)}</span>
            {activeProgress ? (
              <span className="goal-panel-toggle-active-progress">
                {`${activeProgress.completed}/${activeProgress.total}`}
              </span>
            ) : null}
          </span>
        ) : null}
        {lockedOpen ? null : (
          <span className="goal-panel-toggle-caret" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
        )}
      </button>
      {!expanded ? null : (
      <div className="goal-panel-body">
      {error ? <div className="goal-panel-error">{error}</div> : null}
      {plans.map((plan) => {
        const canDecide = plan.status === 'awaiting_approval';
        const busy = busyPlanId === plan.planId;
        const progress = safeProgress(plan);
        const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
        return (
          <section key={plan.planId} className="goal-plan-card">
            <header className="goal-plan-head">
              {/* 状态徽章放标题左侧（最前），作为该计划的状态前缀。 */}
              <span className={`goal-plan-status goal-plan-status--${plan.status}`}>
                {planStatusLabel(plan.status, isZh)}
              </span>
              <div className="goal-plan-title">{derivePlanTitle(plan, isZh)}</div>
              {/* 批准/驳回放在 header 右侧；按钮尺寸与状态徽章对齐（小号 chip 风格），
                  避免按钮被任务列表挤到卡片底部看不到。
                  治理事实写操作（带 confirmationId 的 HumanConfirmation）仅在 awaiting_approval 时出现。 */}
              {canDecide ? (
                <div className="goal-plan-actions goal-plan-actions--inline">
                  <button type="button" className="goal-plan-approve" disabled={busy} onClick={() => void decide(plan, 'approve')}>
                    {isZh ? '批准并执行' : 'Approve & run'}
                  </button>
                  <button type="button" className="goal-plan-reject" disabled={busy} onClick={() => void decide(plan, 'reject')}>
                    {isZh ? '驳回' : 'Reject'}
                  </button>
                </div>
              ) : null}
            </header>
            {plan.goal ? <p className="goal-plan-goal">{plan.goal}</p> : null}
            <div className="goal-plan-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="goal-plan-progress-bar" style={{ backgroundSize: `${progress.percent}% 100%` }} />
              <span className="goal-plan-progress-text">
                {isZh
                  ? `${progress.completed}/${progress.total} 完成`
                  : `${progress.completed}/${progress.total} done`}
                {progress.failed > 0 ? (isZh ? `，${progress.failed} 失败` : `, ${progress.failed} failed`) : ''}
                {progress.blocked > 0 ? (isZh ? `，${progress.blocked} 阻塞` : `, ${progress.blocked} blocked`) : ''}
              </span>
            </div>
            {tasks.length > 0 ? (
              <ul className="goal-task-list">
                {tasks.map((task) => (
                  <TaskNode key={task.taskId} task={task} depth={0} isZh={isZh} />
                ))}
              </ul>
            ) : (
              <div className="goal-plan-empty-tasks">{isZh ? '尚无拆解的子任务' : 'No tasks yet'}</div>
            )}
          </section>
        );
      })}
      </div>
      )}
    </div>
  );
}
