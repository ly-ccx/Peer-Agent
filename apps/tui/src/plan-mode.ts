import { COLOR } from './tui-theme.ts';

export type PlanApprovalDecision = 'approve' | 'revise' | 'reject';
export type PlanStatus = 'awaiting_approval' | 'approved' | 'revising' | 'rejected' | 'goal_created';

export interface RuntimePlanTask {
  readonly taskId: string;
  readonly title: string;
}

export interface RuntimePlanSuccessCriterion {
  readonly description: string;
}

export interface RuntimePlan {
  readonly planId: string;
  readonly title: string;
  readonly goal: string;
  readonly tasks: readonly RuntimePlanTask[];
  readonly successCriteria: readonly RuntimePlanSuccessCriterion[];
}

export interface PlanSnapshot {
  readonly plan: RuntimePlan;
  readonly status: PlanStatus;
  readonly revisionRequest?: string;
}

export interface GoalExecutionRequest {
  readonly sessionId: string;
  readonly plan: RuntimePlan;
}

export interface GoalExecutionPort {
  create(request: GoalExecutionRequest): Promise<void> | void;
}

export interface PlanCoordinator {
  getSnapshot(): PlanSnapshot | null;
  subscribe(listener: (snapshot: PlanSnapshot | null) => void): () => void;
  publish(plan: RuntimePlan): PlanSnapshot;
  decide(planId: string, decision: PlanApprovalDecision): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseRuntimePlan(value: unknown): RuntimePlan | null {
  if (!isRecord(value)) return null;
  const planId = nonEmptyString(value.planId);
  const title = nonEmptyString(value.title);
  const goal = nonEmptyString(value.goal);
  if (!planId || !title || !goal || !Array.isArray(value.tasks) || value.tasks.length === 0) return null;

  const tasks = value.tasks.map((task, index) => {
    if (!isRecord(task)) return null;
    const taskTitle = nonEmptyString(task.title);
    if (!taskTitle) return null;
    return { taskId: nonEmptyString(task.taskId) ?? `task-${index + 1}`, title: taskTitle };
  });
  if (tasks.some((task) => task === null)) return null;

  const criteriaSource = Array.isArray(value.successCriteria) ? value.successCriteria : [];
  const successCriteria = criteriaSource.map((criterion) => {
    if (typeof criterion === 'string') return { description: criterion.trim() };
    if (!isRecord(criterion)) return null;
    const description = nonEmptyString(criterion.description);
    return description ? { description } : null;
  });
  if (successCriteria.some((criterion) => criterion === null)) return null;

  return {
    planId,
    title,
    goal,
    tasks: tasks as RuntimePlanTask[],
    successCriteria: successCriteria as RuntimePlanSuccessCriterion[],
  };
}

export function parseRuntimePlanText(text: string): RuntimePlan | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate) return null;
  try {
    return parseRuntimePlan(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function createPlanCoordinator(options: {
  readonly sessionId: string;
  readonly goalExecution: GoalExecutionPort;
}): PlanCoordinator {
  const listeners = new Set<(snapshot: PlanSnapshot | null) => void>();
  let snapshot: PlanSnapshot | null = null;
  const publishSnapshot = (next: PlanSnapshot | null) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    publish(plan) {
      const next = { plan, status: 'awaiting_approval' } as const;
      publishSnapshot(next);
      return next;
    },
    async decide(planId, decision) {
      if (!snapshot || snapshot.plan.planId !== planId || snapshot.status !== 'awaiting_approval') return false;
      const currentPlan = snapshot.plan;
      if (decision === 'reject') {
        publishSnapshot({ plan: currentPlan, status: 'rejected' });
        return true;
      }
      if (decision === 'revise') {
        publishSnapshot({ plan: currentPlan, status: 'revising' });
        return true;
      }
      publishSnapshot({ plan: currentPlan, status: 'approved' });
      try {
        await options.goalExecution.create({ sessionId: options.sessionId, plan: currentPlan });
        publishSnapshot({ plan: currentPlan, status: 'goal_created' });
        return true;
      } catch (error) {
        publishSnapshot({
          plan: currentPlan,
          status: 'awaiting_approval',
          revisionRequest: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}

export const PLAN_APPROVAL_OPTIONS = Object.freeze([
  { decision: 'approve', label: 'Approve and execute', shortcut: '1', color: COLOR.success },
  { decision: 'revise', label: 'Revise', shortcut: '2', color: COLOR.toolRunning },
  { decision: 'reject', label: 'Reject', shortcut: '3', color: COLOR.dangerSoft },
] as const);

export function planDecisionForKey(keyName: string, selectedIndex: number): PlanApprovalDecision | null {
  if (keyName === '1') return 'approve';
  if (keyName === '2') return 'revise';
  if (keyName === '3' || keyName === 'escape') return 'reject';
  if (keyName === 'return' || keyName === 'enter') {
    return PLAN_APPROVAL_OPTIONS[selectedIndex]?.decision ?? null;
  }
  return null;
}

export function movePlanSelection(current: number, offset: number): number {
  const length = PLAN_APPROVAL_OPTIONS.length;
  return ((current + offset) % length + length) % length;
}
