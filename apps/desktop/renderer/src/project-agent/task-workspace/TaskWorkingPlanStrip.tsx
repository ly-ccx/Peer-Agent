import { useId, useState } from 'react';
import type { WorkingPlanStepStatus, WorkingPlanView } from '@peer-agent/protocol';
import { PeerIcon, type PeerIconName } from '../../ui/icons';
import '../styles/task-working-plan-strip.css';

const stepIcons: Record<WorkingPlanStepStatus, PeerIconName> = {
  pending: 'circle',
  in_progress: 'loader',
  completed: 'check',
  blocked: 'warning',
};

export function TaskWorkingPlanStrip({ workingPlan, isZh }: {
  readonly workingPlan?: WorkingPlanView;
  readonly isZh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (!workingPlan || workingPlan.steps.length === 0) return null;

  const active = workingPlan.steps.find(step => step.status === 'in_progress');
  const { blocked, completed, total } = workingPlan;
  const waiting = total - completed - blocked;
  const preview = active?.title ?? (blocked > 0
    ? (isZh ? `${blocked} 项受阻` : `${blocked} blocked`)
    : waiting > 0
      ? (isZh ? `${waiting} 项待处理` : `${waiting} pending`)
      : (isZh ? '全部步骤已收尾' : 'All steps closed'));
  const statuses = isZh
    ? { pending: '待处理', in_progress: '进行中', completed: '已完成', blocked: '受阻' }
    : { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', blocked: 'Blocked' };
  const toggleLabel = expanded
    ? (isZh ? '收起工作计划' : 'Collapse working plan')
    : (isZh ? '展开工作计划' : 'Expand working plan');

  return (
    <section className="bot-working-plan" aria-label={isZh ? '工作计划' : 'Working plan'}>
      <div className="bot-working-plan-strip">
        <span className="bot-working-plan-count" aria-label={isZh ? `已完成 ${completed} 项，共 ${total} 项` : `${completed} of ${total} steps completed`}>
          {completed}/{total}
        </span>
        <span className="bot-working-plan-preview" title={preview}>{preview}</span>
        <button
          className="bot-working-plan-toggle"
          type="button"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(open => !open)}
        >
          <PeerIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
      </div>
      <div id={detailsId} className="bot-working-plan-details" hidden={!expanded}>
        {expanded ? (
          <>
            <ol className="bot-working-plan-steps" role="list">
              {workingPlan.steps.map((step, index) => (
                <li key={index}>
                  <PeerIcon name={stepIcons[step.status]} size={14} role="img" aria-hidden={false} aria-label={statuses[step.status]} />
                  <div>
                    <div>{step.title}</div>
                    {step.check ? <small>{isZh ? '验证' : 'Check'} · {step.check}</small> : null}
                    {step.note ? <small>{isZh ? '备注' : 'Note'} · {step.note}</small> : null}
                  </div>
                </li>
              ))}
            </ol>
            {workingPlan.invariants?.length ? (
              <div className="bot-working-plan-invariants">
                <span>{isZh ? '执行约束' : 'Invariants'}</span>
                <ul>{workingPlan.invariants.map((invariant, index) => <li key={index}>{invariant}</li>)}</ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
