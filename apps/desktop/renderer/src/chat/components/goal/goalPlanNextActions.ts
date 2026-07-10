import type { GoalPlan } from '@peer-agent/protocol';

export type GoalPlanNextAction = 'start' | 'adjust' | 'cancel';

export interface GoalPlanNextStep {
  readonly kind: 'approval' | 'accepted_goal';
  readonly actions: readonly GoalPlanNextAction[];
}

const NEXT_ACTIONS = ['start', 'adjust', 'cancel'] as const;

/**
 * 只在计划刚创建、还没有进入执行时给出下一步入口。
 * Plan 的开始/取消继续走批准治理链；Goal 的开始进入既有 Runner。
 */
export function getGoalPlanNextStep(plan: GoalPlan): GoalPlanNextStep | null {
  if (plan.status === 'awaiting_approval') {
    return { kind: 'approval', actions: NEXT_ACTIONS };
  }
  if (
    plan.workflowKind === 'goal_self_driven'
    && plan.status === 'accepted'
    && !plan.runner?.enabled
  ) {
    return { kind: 'accepted_goal', actions: NEXT_ACTIONS };
  }
  return null;
}

export function goalPlanNextStepCopy(isZh: boolean): {
  readonly guidance: string;
  readonly start: string;
  readonly adjust: string;
  readonly cancel: string;
  readonly adjustmentMessage: string;
} {
  return isZh
    ? {
        guidance: '计划已创建。请选择下一步：开始执行、调整计划或取消计划。',
        start: '开始执行',
        adjust: '调整计划',
        cancel: '取消计划',
        adjustmentMessage: '我想调整计划。请先不要执行，询问我需要修改哪些内容。',
      }
    : {
        guidance: 'Plan created. Choose what to do next: start, adjust, or cancel.',
        start: 'Start',
        adjust: 'Adjust plan',
        cancel: 'Cancel plan',
        adjustmentMessage: 'I want to adjust the plan. Do not execute it yet; ask what I want to change.',
      };
}
