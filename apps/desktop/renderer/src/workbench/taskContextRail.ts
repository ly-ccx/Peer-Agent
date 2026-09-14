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
 * 任务上下文栏（Task Context Rail）投影 —— 只读。
 *
 * 治理边界（AGENTS.md / peer-knowledge design/product/task-context-rail.md）：
 * - 本模块只做「已有权威事实 → 展示行」的投影，不产生新的事实来源；
 *   所有事实仍来自 main 进程的 Runtime 快照、taskOverview:list 与 git IPC。
 * - 后台运行区是**投影**，不是第二个管理面：参考 bd9fd0b4 把后台运行管理收敛到
 *   ChatHeader 的决定，本栏不提供停止/重跑等写操作，点击行交由既有详情视图处理。
 * - 产出区必须复用 projectTaskOverviewArtifacts 的过滤规则，不得放宽
 *   （tool-result:// / local-shell-artifact:// / goal-plan:// 等治理 ref 永不展示）。
 */

/** 环境信息行：值本身可点击打开对应详情，故带 openTarget 描述跳转意图而非回调。 */
export type TaskContextEnvironmentTarget = 'branch' | 'workspace' | null;

export interface TaskContextEnvironmentRow {
  readonly id: 'branch' | 'workspace' | 'location';
  /** 行首图标语义（UI 层按此选图标，不解析文案）。 */
  readonly icon: 'branch' | 'folder' | 'device';
  readonly label: string;
  readonly value: string;
  /** 完整值（如绝对路径），用于 title 提示；与 value 相同时省略。 */
  readonly detail?: string;
  readonly openTarget: TaskContextEnvironmentTarget;
}

export interface TaskContextEnvironmentInput {
  readonly workspacePath: string | null;
  /** null = 未知/读取中；false = 明确不是 git 仓库。 */
  readonly workspaceIsGit: boolean | null;
  readonly currentBranch: string | null;
}

export interface TaskContextRunRow {
  readonly taskId: string;
  readonly command: string;
  readonly cwdLabel: string;
  readonly statusLabel: string;
  readonly active: boolean;
}

export interface TaskContextRailProjection {
  readonly environment: readonly TaskContextEnvironmentRow[];
  readonly runs: readonly TaskContextRunRow[];
  readonly artifacts: TaskArtifactProjection;
  readonly artifactError: string | null;
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
 * 环境信息投影。缺数据时返回空数组，由 UI 决定是否渲染分区——
 * 不写占位文案（对齐 Qoder 空分区行为，见设计文档 §2.2）。
 */
export function projectTaskContextEnvironment(
  input: TaskContextEnvironmentInput,
  isZh: boolean,
): readonly TaskContextEnvironmentRow[] {
  const rows: TaskContextEnvironmentRow[] = [];
  const workspacePath = typeof input.workspacePath === 'string' && input.workspacePath.trim()
    ? input.workspacePath.trim()
    : null;

  // 分支：只有明确是 git 仓库且读到分支名才展示。读取中或非仓库时不编造值。
  if (input.workspaceIsGit === true && input.currentBranch) {
    rows.push({
      id: 'branch',
      icon: 'branch',
      label: isZh ? '分支' : 'Branch',
      value: input.currentBranch,
      openTarget: 'branch',
    });
  } else if (input.workspaceIsGit === false) {
    rows.push({
      id: 'branch',
      icon: 'branch',
      label: isZh ? '分支' : 'Branch',
      value: isZh ? '非 git 仓库' : 'Not a git repo',
      openTarget: null,
    });
  }

  if (workspacePath) {
    rows.push({
      id: 'workspace',
      icon: 'folder',
      label: isZh ? '工作区' : 'Workspace',
      value: pathTailLabel(workspacePath),
      detail: workspacePath,
      openTarget: 'workspace',
    });
  }

  // 运行位置：桌面端能力执行固定发生在本机（端云能力代理：本地负责能力与执行）。
  if (workspacePath) {
    rows.push({
      id: 'location',
      icon: 'device',
      label: isZh ? '运行位置' : 'Runs on',
      value: isZh ? '本地' : 'Local',
      openTarget: null,
    });
  }

  return rows;
}

/**
 * 后台进程投影：**按会话作用域过滤**。
 *
 * 与 ChatHeader 的全局后台运行入口语义不同：那里是跨会话的全局管理面，
 * 这里只回答「本任务的会话起了哪些后台运行」。因此这不是重复的管理面，
 * 而是同一份 Runtime 快照在会话作用域下的只读视图。
 */
export function projectTaskContextRuns(
  tasks: readonly ManagedShellTask[] | null | undefined,
  conversationId: string | null,
  isZh: boolean,
): readonly TaskContextRunRow[] {
  if (!conversationId || !tasks) return [];
  const scoped = backgroundTaskList(tasks, { sourceConversation: conversationId });
  return orderBackgroundRuns(scoped).map((task) => ({
    taskId: task.taskId,
    command: task.description?.trim() || task.command || task.taskId,
    cwdLabel: pathTailLabel(task.cwd),
    statusLabel: backgroundTaskStatus(task, isZh),
    active: isActiveRun(task),
  }));
}

/**
 * 产出投影：复用任务总览的产物投影（含治理 ref 过滤与每类展示上限）。
 * 传入的 item 必须是本会话的那一条；找不到时返回空投影，不报错。
 */
export function projectTaskContextArtifacts(
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
