export type WorkingPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface WorkingPlanStepView {
  readonly title: string;
  readonly status: WorkingPlanStepStatus;
  readonly check?: string;
  readonly note?: string;
}

export interface WorkingPlanView {
  readonly epoch: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly summary?: string;
  readonly invariants?: readonly string[];
  readonly completed: number;
  readonly total: number;
  readonly blocked: number;
  readonly steps: readonly WorkingPlanStepView[];
}
