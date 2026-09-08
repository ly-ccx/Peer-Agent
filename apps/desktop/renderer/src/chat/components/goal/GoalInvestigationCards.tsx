import { useEffect, useState } from 'react';
import type { GoalPlan } from '@peer-agent/protocol';
import { goalInvestigation, investigationHidden } from './goalInvestigation';
import '../../styles/goal-investigation.css';

export function GoalInvestigation({ plan, isZh }: { plan: GoalPlan; isZh: boolean }) {
  const view = goalInvestigation(plan);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setDismissed(null);
    if (!view.successful) return;
    const timer = window.setTimeout(() => setDismissed(view.key), 1800);
    return () => window.clearTimeout(timer);
  }, [view.key, view.successful]);
  const labels = isZh
    ? { queued: '排队中', running: '调查中', completed: '已返回', failed: '失败', cancelled: '已取消', paused: '已暂停' }
    : { queued: 'Queued', running: 'Investigating', completed: 'Returned', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
  if (!view.items.length) return null;
  const hidden = investigationHidden(view.key, view.successful, dismissed);
  const description = view.items.map(item => `${item.question}: ${labels[item.status]}`).join('; ');
  return (
    <div className="goal-investigation" data-hidden={hidden} aria-hidden={hidden}>
      <div className="goal-investigation-cards" key={view.key} role="status" aria-label={description} title={description}>
        {view.items.slice(0, 2).map(item => (
          <span className="goal-investigation-card" data-status={item.status} key={item.id} title={`${item.question}\n${item.detail}`}>
            <span className="goal-investigation-signal" aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'failed' ? '!' : item.status === 'paused' ? 'Ⅱ' : item.status === 'cancelled' ? '−' : '•'}</span>
            <span className="goal-investigation-question">{item.question}</span>
            <small>{labels[item.status]}</small>
          </span>
        ))}
        {view.items.length > 2 && <span className="goal-investigation-more">{isZh ? `另 ${view.items.length - 2} 项` : `+${view.items.length - 2} more`}</span>}
      </div>
    </div>
  );
}
