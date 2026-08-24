export type TaskGoalHistoryStatus =
  | 'archived'
  | 'ready'
  | 'running'
  | 'failed'
  | 'paused'
  | 'waiting'
  | 'other';

export interface GoalHistoryTaskLike {
  readonly title?: string;
  readonly status?: string;
  readonly involvedFiles?: readonly string[];
  readonly subtasks?: readonly GoalHistoryTaskLike[];
}

export interface GoalHistoryCriterionLike {
  readonly id: string;
  readonly description?: string;
}

export interface GoalHistoryResultLike {
  readonly criterionId: string;
  readonly passed?: boolean;
}

export interface GoalHistoryPlanLike {
  readonly planId: string;
  readonly title?: string;
  readonly goal?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly resultAcceptance?: { readonly acceptedAt?: string | null };
  readonly successCriteria?: readonly GoalHistoryCriterionLike[];
  readonly criterionResults?: readonly GoalHistoryResultLike[];
  readonly involvedFiles?: readonly string[];
  readonly tasks?: readonly GoalHistoryTaskLike[];
  readonly deliveryBinding?: {
    readonly targetWorkspacePath?: string;
    readonly baseCommit?: string;
    readonly taskBranch?: string;
  };
  readonly targetWorkspacePath?: string;
  readonly baseCommit?: string;
}

export interface TaskGoalHistoryEntry {
  readonly planId: string;
  readonly title: string;
  readonly outcome: string;
  readonly files: readonly string[];
  readonly status: TaskGoalHistoryStatus;
  readonly isCurrent: boolean;
}

export interface GoalDiffRange {
  readonly workspaceRoot: string | null;
  readonly fromRef: string | null;
  readonly toRef: string | null;
}

function trimText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function walkFiles(task: GoalHistoryTaskLike, into: Set<string>): void {
  for (const file of task.involvedFiles ?? []) {
    const path = trimText(file);
    if (path) into.add(path);
  }
  for (const child of task.subtasks ?? []) walkFiles(child, into);
}

function walkCompletedTitles(task: GoalHistoryTaskLike, into: string[]): void {
  const title = trimText(task.title);
  if (task.status === 'completed' && title) into.push(title);
  for (const child of task.subtasks ?? []) walkCompletedTitles(child, into);
}

export function collectGoalFilePaths(plan: GoalHistoryPlanLike): readonly string[] {
  const files = new Set<string>();
  for (const file of plan.involvedFiles ?? []) {
    const path = trimText(file);
    if (path) files.add(path);
  }
  for (const task of plan.tasks ?? []) walkFiles(task, files);
  return [...files];
}

export function summarizeGoalOutcome(plan: GoalHistoryPlanLike): string {
  const results = new Map(
    (plan.criterionResults ?? [])
      .filter((result) => result?.criterionId)
      .map((result) => [result.criterionId, result] as const),
  );
  const passed = (plan.successCriteria ?? [])
    .filter((criterion) => results.get(criterion.id)?.passed === true)
    .map((criterion) => trimText(criterion.description))
    .filter(Boolean);
  if (passed.length > 0) return passed.join('；');
  const titles: string[] = [];
  for (const task of plan.tasks ?? []) walkCompletedTitles(task, titles);
  if (titles.length > 0) return titles.join('；');
  return trimText(plan.goal);
}

export function classifyGoalHistoryStatus(plan: GoalHistoryPlanLike): TaskGoalHistoryStatus {
  if (trimText(plan.resultAcceptance?.acceptedAt)) return 'archived';
  switch (plan.status) {
    case 'completed':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'awaiting_approval':
      return 'waiting';
    case 'executing':
    case 'accepted':
    case 'approved':
      return 'running';
    default:
      return 'other';
  }
}

export function goalHistoryStatusLabel(status: TaskGoalHistoryStatus, isZh: boolean): string {
  if (isZh) {
    if (status === 'archived') return '已归档';
    if (status === 'ready') return '待验收';
    if (status === 'running') return '进行中';
    if (status === 'failed') return '失败';
    if (status === 'paused') return '已暂停';
    if (status === 'waiting') return '待批准';
    return '目标';
  }
  if (status === 'archived') return 'Archived';
  if (status === 'ready') return 'Ready';
  if (status === 'running') return 'In progress';
  if (status === 'failed') return 'Failed';
  if (status === 'paused') return 'Paused';
  if (status === 'waiting') return 'Awaiting approval';
  return 'Goal';
}

export function goalDiffRange(plan: GoalHistoryPlanLike): GoalDiffRange {
  return {
    workspaceRoot: trimText(plan.deliveryBinding?.targetWorkspacePath)
      || trimText(plan.targetWorkspacePath)
      || null,
    fromRef: trimText(plan.deliveryBinding?.baseCommit) || trimText(plan.baseCommit) || null,
    toRef: trimText(plan.deliveryBinding?.taskBranch) || null,
  };
}

/**
 * 一条任务上做过的目标：跳过未开跑的 drafting，按创建时间排。
 * 完成项优先用已通过的成功标准，其次已完成子任务，再退回 goal 文本。
 */
export function projectTaskGoalHistory(
  plans: readonly GoalHistoryPlanLike[],
  currentPlanId: string | null | undefined,
): readonly TaskGoalHistoryEntry[] {
  const byId = new Map<string, GoalHistoryPlanLike>();
  for (const plan of plans) {
    if (!plan?.planId) continue;
    if (plan.status === 'drafting' && plan.planId !== currentPlanId) continue;
    byId.set(plan.planId, plan);
  }
  return [...byId.values()]
    .sort((left, right) => {
      const byTime = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
      return byTime !== 0 ? byTime : left.planId.localeCompare(right.planId);
    })
    .map((plan) => ({
      planId: plan.planId,
      title: trimText(plan.title) || trimText(plan.goal) || plan.planId,
      outcome: summarizeGoalOutcome(plan),
      files: collectGoalFilePaths(plan),
      status: classifyGoalHistoryStatus(plan),
      isCurrent: plan.planId === currentPlanId,
    }));
}
