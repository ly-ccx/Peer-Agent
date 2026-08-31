import type { GoalPlan } from '@peer-agent/protocol';

export type GoalPlanNextAction = 'start' | 'adjust' | 'cancel' | 'continue-fix';

export interface GoalPlanNextStep {
  readonly kind: 'approval';
  readonly actions: readonly GoalPlanNextAction[];
}

const NEXT_ACTIONS = ['start', 'adjust', 'cancel'] as const;

/**
 * 只有 Plan 审批流需要用户选择下一步。Goal 创建后会自动交给 Runner，
 * 不应渲染“待审批/开始执行”入口来暗示还需要一次人工授权。
 */
export function getGoalPlanNextStep(plan: GoalPlan): GoalPlanNextStep | null {
  return plan.status === 'awaiting_approval'
    ? { kind: 'approval', actions: NEXT_ACTIONS }
    : null;
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

/** 「继续修」发出的用户消息必须带上这条 Goal 的 planId，对话才能对上要修哪一条。 */
export function continueFixingMessage(planId: string, isZh: boolean): string {
  const id = planId.trim();
  return isZh
    ? `继续修这条 Goal（planId=${id}）。质量自检还没过线，请对照缺的检查补上后再合回。`
    : `Continue fixing this Goal (planId=${id}). Quality review has not passed; finish the missing checks, then merge.`;
}
