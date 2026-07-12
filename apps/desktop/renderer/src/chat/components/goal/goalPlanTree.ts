import type { GoalPlan } from '@peer-agent/protocol';

export interface GoalPlanTreeRow {
  readonly plan: GoalPlan;
  readonly depth: number;
}

/** Orders plans by their persisted parent relationship while keeping sibling order stable. */
export function buildGoalPlanTreeRows(plans: readonly GoalPlan[]): GoalPlanTreeRow[] {
  const plansById = new Map(plans.map((plan) => [plan.planId, plan]));
  const childrenByParent = new Map<string, GoalPlan[]>();
  const roots: GoalPlan[] = [];

  for (const plan of plans) {
    if (plan.parentPlanId && plansById.has(plan.parentPlanId) && plan.parentPlanId !== plan.planId) {
      const siblings = childrenByParent.get(plan.parentPlanId) ?? [];
      siblings.push(plan);
      childrenByParent.set(plan.parentPlanId, siblings);
    } else {
      roots.push(plan);
    }
  }

  const rows: GoalPlanTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (plan: GoalPlan, depth: number) => {
    if (visited.has(plan.planId)) return;
    visited.add(plan.planId);
    rows.push({ plan, depth });
    for (const child of childrenByParent.get(plan.planId) ?? []) visit(child, depth + 1);
  };

  for (const root of roots) visit(root, 0);
  // Preserve malformed/cyclic historical records instead of hiding them.
  for (const plan of plans) visit(plan, 0);
  return rows;
}

export function goalPlanTreeDepth(plan: GoalPlan, plansById: ReadonlyMap<string, GoalPlan>): number {
  let depth = 0;
  let current = plan;
  const visited = new Set<string>([plan.planId]);
  while (current.parentPlanId) {
    const parent = plansById.get(current.parentPlanId);
    if (!parent || visited.has(parent.planId)) break;
    visited.add(parent.planId);
    depth += 1;
    current = parent;
  }
  return depth;
}
