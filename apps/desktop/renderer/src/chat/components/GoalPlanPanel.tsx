import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { ExecutionStatus, GoalPlan, GoalTask } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

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

export function GoalPlanPanel({ conversationId, isZh }: GoalPlanPanelProps): ReactElement | null {
  const [plans, setPlans] = useState<readonly GoalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  const numericConversationId = useMemo(() => {
    if (conversationId === null) return undefined;
    const parsed = Number(conversationId);
    return Number.isFinite(parsed) ? parsed : undefined;
  }, [conversationId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await clientApi.goalPlansList(
        numericConversationId === undefined ? undefined : { conversationId: numericConversationId },
      );
      setPlans(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : isZh ? '加载计划失败' : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, [numericConversationId, isZh]);

  useEffect(() => {
    void reload();
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
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [reload, isZh],
  );

  if (loading && plans.length === 0) {
    return (
      <div className="goal-panel goal-panel--empty">
        {isZh ? '正在加载计划…' : 'Loading plans…'}
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="goal-panel goal-panel--empty">
        {error ? (
          <span className="goal-panel-error">{error}</span>
        ) : (
          <span>{isZh ? '当前会话还没有目标计划。发送消息开始规划。' : 'No goal plan yet. Send a message to start planning.'}</span>
        )}
      </div>
    );
  }

  return (
    <div className="goal-panel">
      {error ? <div className="goal-panel-error">{error}</div> : null}
      {plans.map((plan) => {
        const canDecide = plan.status === 'awaiting_approval';
        const busy = busyPlanId === plan.planId;
        const progress = safeProgress(plan);
        const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
        return (
          <section key={plan.planId} className="goal-plan-card">
            <header className="goal-plan-head">
              <div className="goal-plan-title">{plan.title || (isZh ? '未命名计划' : 'Untitled plan')}</div>
              <span className={`goal-plan-status goal-plan-status--${plan.status}`}>
                {planStatusLabel(plan.status, isZh)}
              </span>
            </header>
            {plan.goal ? <p className="goal-plan-goal">{plan.goal}</p> : null}
            <div className="goal-plan-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="goal-plan-progress-bar" style={{ width: `${progress.percent}%` }} />
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
            {canDecide ? (
              <footer className="goal-plan-actions">
                <button type="button" className="goal-plan-approve" disabled={busy} onClick={() => void decide(plan, 'approve')}>
                  {isZh ? '批准并执行' : 'Approve & run'}
                </button>
                <button type="button" className="goal-plan-reject" disabled={busy} onClick={() => void decide(plan, 'reject')}>
                  {isZh ? '驳回' : 'Reject'}
                </button>
              </footer>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
