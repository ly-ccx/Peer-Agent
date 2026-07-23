const TERMINAL_PLAN_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export interface TuiGoalPlan {
  readonly planId: string;
  readonly title?: string;
  readonly goal?: string;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly activation?: { readonly kind?: string } | null;
  readonly runner?: { readonly status?: string } | null;
  readonly progress?: {
    readonly completed?: number;
    readonly total?: number;
    readonly percent?: number;
  } | null;
  readonly tasks?: readonly unknown[];
  readonly [key: string]: unknown;
}

function asGoalPlan(value: unknown): TuiGoalPlan | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.planId !== 'string' || !candidate.planId.trim()) return null;
  return candidate as TuiGoalPlan;
}

function isDisplayableGoalPlan(plan: TuiGoalPlan): boolean {
  return plan.status !== 'cancelled' && plan.activation?.kind !== 'intake';
}

function newestFirst(left: TuiGoalPlan, right: TuiGoalPlan): number {
  return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
}

export function displayableGoalPlans(plans: readonly unknown[]): readonly TuiGoalPlan[] {
  return plans
    .map(asGoalPlan)
    .filter((plan): plan is TuiGoalPlan => Boolean(plan && isDisplayableGoalPlan(plan)))
    .sort(newestFirst);
}

function isActive(plan: TuiGoalPlan): boolean {
  return !TERMINAL_PLAN_STATUSES.has(String(plan.status ?? ''));
}

export function selectPreferredGoalPlanId(
  plans: readonly TuiGoalPlan[],
  currentPlanId: string | null | undefined,
): string | null {
  if (currentPlanId && plans.some((plan) => plan.planId === currentPlanId)) {
    return currentPlanId;
  }
  return selectActiveGoalPlanId(plans) ?? plans[0]?.planId ?? null;
}

export function selectActiveGoalPlanId(
  plans: readonly TuiGoalPlan[],
): string | null {
  const activePlans = plans.filter(isActive);
  return (
    activePlans.find((plan) => plan.status === 'awaiting_approval') ??
    activePlans.find((plan) => plan.status === 'executing' || plan.runner?.status === 'running') ??
    activePlans[0]
  )?.planId ?? null;
}

export function filterGoalPlanHistory(
  plans: readonly TuiGoalPlan[],
  query: string,
): readonly TuiGoalPlan[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return plans;
  return plans.filter((plan) => {
    const haystack = `${plan.title ?? ''} ${plan.goal ?? ''} ${plan.status ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
