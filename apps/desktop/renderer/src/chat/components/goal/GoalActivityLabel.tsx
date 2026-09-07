import { useContext } from 'react';
import type { GoalPlan } from '@peer-agent/protocol';
import { InteractionStreamingContext } from '../thread/interactionContext';
import { goalActivity } from './goalActivity';

/** Conversation liveness is presentation evidence, never permission to resume a plan. */
export function GoalActivityLabel({ plan, isZh }: { plan: GoalPlan; isZh: boolean }) {
  const streaming = useContext(InteractionStreamingContext)?.isStreaming === true;
  const label = goalActivity(plan, isZh, streaming);
  return <span className="goal-panel-current-activity" role="status" title={label}>{label}</span>;
}
