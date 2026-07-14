export type RuntimeGoalStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RuntimeGoalTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface RuntimeGoalTaskInput {
  readonly taskId: string;
  readonly title: string;
}

export interface RuntimeGoalSuccessCriterion {
  readonly description: string;
}

export interface RuntimeGoalTaskSnapshot extends RuntimeGoalTaskInput {
  readonly status: RuntimeGoalTaskStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly reason?: string;
  readonly evidenceRefs: readonly string[];
}

export interface RuntimeGoalSnapshot {
  readonly goalId: string;
  readonly sourcePlanId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: RuntimeGoalStatus;
  readonly tasks: readonly RuntimeGoalTaskSnapshot[];
  readonly successCriteria: readonly RuntimeGoalSuccessCriterion[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface RuntimeGoalCreateOptions {
  readonly goalId: string;
  readonly sourcePlanId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly goal: string;
  readonly tasks: readonly RuntimeGoalTaskInput[];
  readonly successCriteria?: readonly RuntimeGoalSuccessCriterion[];
}

export type RuntimeGoalTaskExecutionResult =
  | { readonly status: 'completed'; readonly evidenceRefs: readonly string[] }
  | { readonly status: 'blocked'; readonly reason: string; readonly evidenceRefs?: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string; readonly evidenceRefs?: readonly string[] };

export interface RuntimeGoalTaskExecutionContext {
  readonly goalId: string;
  readonly sourcePlanId: string;
  readonly sessionId: string;
  readonly taskIndex: number;
  readonly signal: AbortSignal;
}

export type RuntimeGoalTaskExecutor = (
  task: RuntimeGoalTaskInput,
  context: RuntimeGoalTaskExecutionContext,
) => Promise<RuntimeGoalTaskExecutionResult>;

export interface RuntimeGoalControllerOptions {
  readonly executeTask: RuntimeGoalTaskExecutor;
  readonly now?: () => string;
  readonly onChange?: (snapshot: RuntimeGoalSnapshot) => void;
}

export interface RuntimeGoalController {
  create(options: RuntimeGoalCreateOptions): RuntimeGoalSnapshot;
  start(goalId: string): Promise<RuntimeGoalSnapshot>;
  pause(goalId: string): RuntimeGoalSnapshot;
  resume(goalId: string): Promise<RuntimeGoalSnapshot>;
  cancel(goalId: string, reason?: string): RuntimeGoalSnapshot;
  get(goalId: string): RuntimeGoalSnapshot | null;
  list(): readonly RuntimeGoalSnapshot[];
  subscribe(listener: (snapshot: RuntimeGoalSnapshot) => void): () => void;
}
