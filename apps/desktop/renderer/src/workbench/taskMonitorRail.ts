import type { ManagedShellTask, TaskOverviewItem } from '@peer-agent/protocol';
import {
  backgroundTaskList,
  backgroundTaskStatus,
} from './backgroundTaskPresentation.ts';
import { isActiveRun, orderBackgroundRuns } from './backgroundRuntimeState.ts';
import {
  projectTaskOverviewArtifacts,
  type TaskArtifactProjection,
} from '../app/pages/taskOverviewArtifacts.ts';

/**
 * 任务监控栏（Task Monitor Rail）投影 —— 只读。
 *
 * 治理边界（AGENTS.md / peer-knowledge design/product/task-context-rail.md）：
 * - 本模块只做「已有权威事实 → 展示行」的投影，不产生新的事实来源；
 *   所有事实仍来自 main 进程的 Runtime 快照与 taskOverview:list。
 * - 环境信息属于会话监控栏：分支、工作区与运行位置都从现有 git / workspace 事实投影；
 *   composer 环境胶囊仍作为输入区的紧凑入口保留，两者共享事实而非互相替代。
 * - 后台任务区是**会话作用域的合并视图**：把 Runtime 快照里本会话的后台运行
 *   合并进来，行内直接展开既有 BackgroundRunDetails 详情（停止等写操作复用
 *   Provider 的同一 stops 链路），不再跳去 ChatHeader 弹层。
 * - 产出区必须复用 projectTaskOverviewArtifacts 的过滤规则，不得放宽
 *   （tool-result:// / local-shell-artifact:// / goal-plan:// 等治理 ref 永不展示）。
 */

export interface TaskMonitorEnvironmentRow {
  readonly id: 'current-head' | 'source' | 'workspace' | 'location';
  readonly icon: 'branch' | 'folder' | 'device';
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

/** 环境信息：当前工作区 HEAD 与任务源头分行，不把两者拼成一条。 */
export function projectTaskMonitorEnvironment(input: {
  readonly workspacePath: string | null;
  readonly currentHead?: string | null;
  readonly sourceBranch?: string | null;
  readonly isGit: boolean | null;
  readonly isZh: boolean;
}): readonly TaskMonitorEnvironmentRow[] {
  const rows: TaskMonitorEnvironmentRow[] = [];
  const currentHead = input.currentHead?.trim() ?? '';
  const sourceBranch = input.sourceBranch?.trim() ?? '';
  if (input.isGit === true && currentHead) {
    rows.push({
      id: 'current-head',
      icon: 'branch',
      label: input.isZh ? '当前分支' : 'Current branch',
      value: currentHead,
    });
  }
  if (input.isGit === true && sourceBranch) {
    rows.push({
      id: 'source',
      icon: 'branch',
      label: input.isZh ? '起始分支' : 'Starting branch',
      value: sourceBranch,
    });
  }

  if (input.workspacePath) {
    rows.push({
      id: 'workspace',
      icon: 'folder',
      label: input.isZh ? '工作区' : 'Workspace',
      value: pathTailLabel(input.workspacePath),
      detail: input.workspacePath,
    });
    rows.push({
      id: 'location',
      icon: 'device',
      label: input.isZh ? '运行位置' : 'Runs on',
      value: input.isZh ? '本地' : 'Local',
    });
  }

  return rows;
}

export interface TaskMonitorRunRow {
  readonly taskId: string;
  readonly command: string;
  readonly cwdLabel: string;
  readonly statusLabel: string;
  readonly active: boolean;
  /** 失败/超时的运行提升排位权重（监控语义：异常优先被看见）。 */
  readonly failed: boolean;
}

export interface TaskMonitorRailProjection {
  readonly runs: readonly TaskMonitorRunRow[];
  readonly artifacts: TaskArtifactProjection;
}

/** 末段路径标签：与 BackgroundRunDetails 的 cwd 呈现保持一致（只取最后一段）。 */
export function pathTailLabel(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
}

function emptyArtifactProjection(): TaskArtifactProjection {
  return { groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0 };
}

/**
 * 后台任务投影：**按会话作用域合并**。
 *
 * 与 ChatHeader 的全局后台运行入口语义不同：那里是跨会话的全局管理面，
 * 这里只回答「本任务的会话起了哪些后台运行」。因此这不是第二个全局管理面，
 * 而是同一份 Runtime 快照在会话作用域下的监控视图；写操作仍走 Provider 的
 * 同一 stops 链路（单一 poller、单一请求状态）。
 */
export function projectTaskMonitorRuns(
  tasks: readonly ManagedShellTask[] | null | undefined,
  conversationId: string | null,
  isZh: boolean,
): readonly TaskMonitorRunRow[] {
  if (!conversationId || !tasks) return [];
  const scoped = backgroundTaskList(tasks, { sourceConversation: conversationId });
  return orderBackgroundRuns(scoped.filter(isActiveRun)).map((task) => ({
    taskId: task.taskId,
    command: task.command?.trim() || task.description?.trim() || task.taskId,
    cwdLabel: pathTailLabel(task.cwd),
    statusLabel: backgroundTaskStatus(task, isZh),
    active: isActiveRun(task),
    failed: task.status === 'failed' || task.timedOut === true,
  }));
}

/**
 * 产出投影：复用任务总览的产物投影（含治理 ref 过滤与每类展示上限）。
 * 传入的 item 必须是本会话的那一条；找不到时返回空投影，不报错。
 */
export function projectTaskMonitorArtifacts(
  item: TaskOverviewItem | null | undefined,
): TaskArtifactProjection {
  if (!item) return emptyArtifactProjection();
  try {
    return projectTaskOverviewArtifacts(item);
  } catch {
    // 投影失败不得让整栏不可用：产出区降级为空，其余分区继续展示。
    return emptyArtifactProjection();
  }
}

/**
 * 从会话作用域的 taskOverview 列表里挑出「本会话那一条」。
 *
 * 为什么不能只比 taskId === conversationId：`TaskOverviewItem.taskId` 是
 * **稳定投影身份**，取值可能是 conversationId、planId 或 automationId+runId
 * （见 protocol/src/task-overview.ts 的字段注释）。且聚合器对「有活跃计划的会话」
 * 只推 plan 投影、并用 `projectedPlanConversationIds` 跳过同会话的 conversation 投影
 * （task-overview-aggregator.mjs），所以长任务会话里 taskId 往往正是 planId。
 *
 * 因此匹配条件取并集：`taskId === conversationId`（纯会话投影）或
 * `item.conversationId === conversationId`（goal_plan / automation 投影的深链字段）。
 * 多条命中时优先有产物的一条，让产出区尽量非空。
 */

/**
 * 右栏「任务进度」卡的主文案，与底部浮条对齐：
 * 计划名 + 当前步骤。overview 投影没有 runner 相位，所以活动句里
 * 只有底部浮条能算出的「正在验证 / 正在恢复上下文」这里不重复编造，
 * 只展示投影里已经有的计划名和当前步骤。
 * 没有计划名时回落到粗粒度 statusLabel（会话、自动化等非计划条目）。
 */
export function taskMonitorProgressHeadline(
  item: Pick<TaskOverviewItem, 'title' | 'currentGoalTitle' | 'statusLabel'>,
): string {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const step = typeof item.currentGoalTitle === 'string' ? item.currentGoalTitle.trim() : '';
  const named = title !== '' && title !== '未命名任务' && title !== 'Untitled plan';
  if (named && step && step !== title) return `${title} · ${step}`;
  if (named) return title;
  if (step) return step;
  return item.statusLabel;
}

export function selectConversationTaskOverviewItem(
  items: readonly TaskOverviewItem[] | null | undefined,
  conversationId: string | null,
): TaskOverviewItem | null {
  if (!conversationId || !items || items.length === 0) return null;
  const matches = items.filter((item) => (
    item.taskId === conversationId || item.conversationId === conversationId
  ));
  if (matches.length === 0) return null;
  // 产物挂在 planSteps[].artifacts 上（见 protocol/task-overview.ts）。
  const withArtifacts = matches.find(
    (item) => (item.planSteps ?? []).some((step) => (step.artifacts?.length ?? 0) > 0),
  );
  return withArtifacts ?? matches[0]!;
}
