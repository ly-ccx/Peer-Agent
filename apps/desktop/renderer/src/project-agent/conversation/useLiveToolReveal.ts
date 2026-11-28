import { useEffect, useRef, useState } from 'react';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { activeToolRevealPlan } from '../state/liveReplyStatusState';

/**
 * Delays revealing transient running-tool UI (status caption and avatar `working` mood)
 * until a tool has remained active past `SLOW_TOOL_REVEAL_DELAY_MS`.
 */
export function useLiveToolReveal(activity: ProjectAgentActivity | undefined): boolean {
  const [, setTick] = useState(0);
  const seenRef = useRef<{ toolId: string | null; atMs: number }>({ toolId: null, atMs: 0 });
  const nowMs = Date.now();
  const initialPlan = activeToolRevealPlan(activity, nowMs);
  let firstSeenAtMs: number | undefined;
  if (initialPlan.toolId) {
    if (seenRef.current.toolId !== initialPlan.toolId) {
      seenRef.current = { toolId: initialPlan.toolId, atMs: nowMs };
    }
    firstSeenAtMs = seenRef.current.atMs;
  } else if (seenRef.current.toolId !== null) {
    seenRef.current = { toolId: null, atMs: 0 };
  }
  const plan = activeToolRevealPlan(activity, nowMs, firstSeenAtMs);

  useEffect(() => {
    if (plan.waitMs <= 0 || !plan.toolId) return undefined;
    const timer = window.setTimeout(() => {
      setTick(value => value + 1);
    }, plan.waitMs);
    return () => window.clearTimeout(timer);
  }, [plan.toolId, plan.waitMs]);

  return plan.revealActiveTool;
}
