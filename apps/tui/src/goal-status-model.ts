import type { RuntimeGoalSnapshot } from '@peer-agent/runtime-sdk';

import { GOAL_CHROME } from './tui-theme.ts';

export type GoalStatusLayoutMode = 'side-panel' | 'compact-summary';

export interface GoalStatusTaskView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly detail?: string;
}

export interface GoalStatusViewModel {
  readonly title: string;
  readonly status: string;
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
  readonly currentTask?: GoalStatusTaskView;
  readonly tasks: readonly GoalStatusTaskView[];
  readonly blockedReason?: string;
}

interface SharedGoalTask {
  readonly taskId?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly failureReason?: unknown;
  readonly blockedReason?: unknown;
}

interface SharedGoalPlan {
  readonly title?: unknown;
  readonly goal?: unknown;
  readonly status?: unknown;
  readonly progress?: unknown;
  readonly tasks?: unknown;
}

const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting_user', 'blocked', 'failed']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function taskView(task: SharedGoalTask, index: number): GoalStatusTaskView {
  return {
    id: text(task.taskId) ?? `task-${index + 1}`,
    title: text(task.title) ?? `Task ${index + 1}`,
    status: text(task.status) ?? 'pending',
    detail: text(task.blockedReason) ?? text(task.failureReason) ?? text(task.result),
  };
}

function progress(tasks: readonly GoalStatusTaskView[], value: unknown) {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const total = typeof record?.total === 'number' ? record.total : tasks.length;
  const completed = typeof record?.completed === 'number'
    ? record.completed
    : tasks.filter((task) => task.status === 'completed').length;
  const percent = typeof record?.percent === 'number'
    ? record.percent
    : total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, percent };
}

export function goalStatusLayout(columns: number): {
  readonly mode: GoalStatusLayoutMode;
  readonly panelWidth: number;
} {
  if (columns >= 120) {
    return { mode: 'side-panel', panelWidth: Math.min(42, Math.max(34, Math.floor(columns * 0.3))) };
  }
  return { mode: 'compact-summary', panelWidth: 0 };
}

export function goalStatusFromRuntime(goal: RuntimeGoalSnapshot): GoalStatusViewModel {
  const tasks = goal.tasks.map((task, index) => ({
    id: task.taskId || `task-${index + 1}`,
    title: task.title,
    status: task.status,
    detail: task.reason,
  }));
  const counts = progress(tasks, undefined);
  const currentTask = tasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status))
    ?? tasks.find((task) => task.status === 'pending');
  return {
    title: goal.title,
    status: goal.status,
    ...counts,
    currentTask,
    tasks,
    blockedReason: currentTask && ['blocked', 'failed', 'waiting_user'].includes(currentTask.status)
      ? currentTask.detail
      : undefined,
  };
}

export function goalStatusFromSharedPlan(value: unknown): GoalStatusViewModel | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as SharedGoalPlan;
  const rawTasks = Array.isArray(plan.tasks) ? plan.tasks as SharedGoalTask[] : [];
  const tasks = rawTasks.map(taskView);
  const counts = progress(tasks, plan.progress);
  const currentTask = tasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status))
    ?? tasks.find((task) => task.status === 'pending');
  return {
    title: text(plan.title) ?? text(plan.goal) ?? 'Goal',
    status: text(plan.status) ?? 'unknown',
    ...counts,
    currentTask,
    tasks,
    blockedReason: currentTask && ['blocked', 'failed', 'waiting_user'].includes(currentTask.status)
      ? currentTask.detail
      : undefined,
  };
}

export function goalTaskGlyph(status: string): string {
  if (status === 'completed') return GOAL_CHROME.glyphCompleted;
  if (status === 'running' || status === 'executing') return GOAL_CHROME.glyphRunning;
  if (status === 'failed' || status === 'blocked' || status === 'waiting_user') return GOAL_CHROME.glyphFailed;
  if (status === 'cancelled') return GOAL_CHROME.glyphCancelled;
  return GOAL_CHROME.glyphPending;
}

export type GoalStatusTone = 'success' | 'danger' | 'accent' | 'muted';

export function goalStatusTone(status: string): GoalStatusTone {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'blocked' || status === 'waiting_user') return 'danger';
  if (status === 'running' || status === 'executing') return 'accent';
  return 'muted';
}

export function goalProgressTrack(percent: number, width = 4): string {
  const cols = Math.max(1, Math.floor(width));
  const filled = Math.round(cols * Math.max(0, Math.min(100, percent)) / 100);
  return `${'━'.repeat(filled)}${'─'.repeat(cols - filled)}`;
}

export interface GoalCompactSummaryView {
  readonly glyph: string;
  readonly tone: GoalStatusTone;
  readonly title: string;
  readonly progressTrack: string;
  readonly progressCount: string;
  readonly missionLabel?: string;
}

export function goalCompactSummaryView(
  view: GoalStatusViewModel,
  options: { readonly missionPosition?: number; readonly totalPlans?: number } = {},
): GoalCompactSummaryView {
  const totalPlans = options.totalPlans ?? 1;
  const missionPosition = options.missionPosition ?? 1;
  const liveStatus = view.currentTask?.status ?? view.status;
  return {
    glyph: goalTaskGlyph(liveStatus),
    tone: goalStatusTone(liveStatus),
    title: view.currentTask?.title ?? view.title,
    progressTrack: goalProgressTrack(view.percent),
    progressCount: `${view.completed}/${view.total}`,
    missionLabel: totalPlans > 1 ? `${missionPosition}/${totalPlans}` : undefined,
  };
}
