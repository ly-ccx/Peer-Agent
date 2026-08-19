import type { GoalPlan } from '@peer-agent/protocol';

/**
 * 把每条目标线的衍生轮次排在父计划之后，同级顺序保持稳定。
 * 只产出顺序，不产出层级：清单渲染为完全对齐的平铺列表。
 */
export function orderGoalPlansByLineage(plans: readonly GoalPlan[]): GoalPlan[] {
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

  const ordered: GoalPlan[] = [];
  const visited = new Set<string>();
  const visit = (plan: GoalPlan) => {
    if (visited.has(plan.planId)) return;
    visited.add(plan.planId);
    ordered.push(plan);
    for (const child of childrenByParent.get(plan.planId) ?? []) visit(child);
  };

  for (const root of roots) visit(root);
  // Preserve malformed/cyclic historical records instead of hiding them.
  for (const plan of plans) visit(plan);
  return ordered;
}
