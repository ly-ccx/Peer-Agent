import type { GoalPlan } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { groupTaskPlans } from './taskPlanHistory';

function GoalPlanSummary({ plan, isZh }: { readonly plan: GoalPlan; readonly isZh: boolean }) {
  const completed = plan.progress.completed;
  const total = plan.progress.total;
  return (
    <article className="task-details-plan">
      <div className="task-details-plan__heading">
        <strong>{plan.title}</strong>
        <span>{plan.status}</span>
      </div>
      <p>{plan.goal}</p>
      {total > 0 ? (
        <div className="task-details-plan__progress">
          <span>{isZh ? `${completed}/${total} 个步骤` : `${completed}/${total} steps`}</span>
          <progress max={total} value={completed} />
        </div>
      ) : null}
    </article>
  );
}

export function TaskDetailsView({
  conversationId,
  taskTitle,
  isZh,
}: {
  readonly conversationId: string;
  readonly taskTitle: string;
  readonly isZh: boolean;
}) {
  const [plans, setPlans] = useState<readonly GoalPlan[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPlans(await clientApi.goalPlansList({ conversationId }));
    } catch {
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
    return clientApi.onGoalPlansChanged((payload) => {
      if (!payload.conversationId || payload.conversationId === conversationId) void reload();
    });
  }, [conversationId, reload]);

  const grouped = useMemo(() => groupTaskPlans(plans), [plans]);

  return (
    <div className="task-details-view">
      <header className="task-details-view__header">
        <span>{isZh ? 'Task' : 'Task'}</span>
        <h2>{taskTitle}</h2>
        <p>{isZh ? 'Conversation 是这个任务的持续上下文。' : 'The Conversation is this task’s durable context.'}</p>
      </header>

      <section className="task-details-view__section">
        <h3>{isZh ? '当前目标' : 'Current goal'}</h3>
        {loading ? (
          <p className="task-details-view__muted">{isZh ? '正在读取…' : 'Loading…'}</p>
        ) : grouped.current ? (
          <GoalPlanSummary plan={grouped.current} isZh={isZh} />
        ) : (
          <div className="task-details-view__empty">
            <strong>{isZh ? '讨论中，尚无执行计划' : 'In discussion, no execution plan yet'}</strong>
            <p>{isZh ? '普通咨询和讨论不会自动创建 GoalPlan。明确实施时，计划会出现在这里。' : 'Questions and discussions do not create a GoalPlan. A plan appears here when implementation starts.'}</p>
          </div>
        )}
      </section>

      <section className="task-details-view__section">
        <h3>{isZh ? '历史目标' : 'Goal history'}</h3>
        {grouped.historical.length > 0 ? (
          <div className="task-details-view__history">
            {grouped.historical.map((plan) => (
              <GoalPlanSummary key={plan.planId} plan={plan} isZh={isZh} />
            ))}
          </div>
        ) : (
          <p className="task-details-view__muted">{isZh ? '还没有历史 GoalPlan。' : 'No previous GoalPlans.'}</p>
        )}
      </section>
    </div>
  );
}
