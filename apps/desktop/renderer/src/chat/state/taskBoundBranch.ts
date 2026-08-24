export interface TaskDeliveryLine {
  readonly targetBranch: string | null;
  readonly taskBranch: string | null;
  readonly isolated: boolean;
}

export type ComposerTaskLineKind = 'source' | 'task-line' | 'isolated';

export interface ComposerWorkspaceHead {
  readonly label: string;
  readonly title: string;
  readonly value: string;
}

export interface ComposerTaskLine {
  readonly kind: ComposerTaskLineKind;
  readonly label: string;
  readonly title: string;
  readonly value: string;
  readonly selectable: boolean;
}

export interface ComposerWriteMismatch {
  readonly label: string;
  readonly title: string;
}

export interface ComposerGitChrome {
  readonly workspaceHead: ComposerWorkspaceHead | null;
  readonly taskLine: ComposerTaskLine | null;
  readonly writeMismatch: ComposerWriteMismatch | null;
}

function trimBranch(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

/** Machine isolation refs (automation/run UUIDs) are not the human task name. */
export function isInternalIsolationBranch(branch: string): boolean {
  const value = branch.trim();
  return /\/automation-[^/]+\/run-/.test(value)
    || value.startsWith('PeerAgent/automation-');
}

function compactBranchName(branch: string): string {
  const value = branch.trim();
  if (isInternalIsolationBranch(value)) return '';
  return value.replace(/^PeerAgent\//, '');
}

export function formatComposerBranchOptionLabel(branch: string): string {
  return compactBranchName(branch) || branch;
}

export function sameComposerBranchRef(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = trimBranch(left);
  const b = trimBranch(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const compactA = compactBranchName(a);
  const compactB = compactBranchName(b);
  return Boolean(compactA && compactB && compactA === compactB);
}

function visibleBranchName(branch: string, fallback: string): string {
  return compactBranchName(branch) || fallback;
}

export function snapshotDeliveryLine(
  plan: {
    readonly deliveryBinding?: {
      readonly targetBranch?: string | null;
      readonly taskBranch?: string | null;
      readonly executionIsolation?: string | null;
      readonly worktreePath?: string | null;
    } | null;
  } | null | undefined,
): TaskDeliveryLine | null {
  const binding = plan?.deliveryBinding;
  const targetBranch = trimBranch(binding?.targetBranch);
  const taskBranch = trimBranch(binding?.taskBranch);
  if (!targetBranch && !taskBranch) return null;
  return {
    targetBranch,
    taskBranch,
    isolated: binding?.executionIsolation === 'worktree' && Boolean(trimBranch(binding.worktreePath)),
  };
}

function formatWorkspaceHead(
  currentHead: string,
  isZh: boolean,
): ComposerWorkspaceHead {
  const compact = visibleBranchName(currentHead, currentHead);
  return {
    value: currentHead,
    label: isZh ? `在 ${compact}` : `on ${compact}`,
    title: isZh ? `当前工作区在 ${currentHead}` : `Workspace is on ${currentHead}`,
  };
}

function formatSourceLine(
  source: string,
  selectable: boolean,
  isZh: boolean,
): ComposerTaskLine {
  const compact = visibleBranchName(source, source);
  return {
    kind: 'source',
    value: source,
    selectable,
    label: isZh ? `源头 ${compact}` : `from ${compact}`,
    title: selectable
      ? (isZh ? `新任务将从 ${source} 分叉` : `New tasks will fork from ${source}`)
      : (isZh ? `这条任务从 ${source} 分叉` : `This task forks from ${source}`),
  };
}

function formatRecordedTaskLine(
  taskBranch: string,
  isolated: boolean,
  isZh: boolean,
): ComposerTaskLine {
  const compact = compactBranchName(taskBranch);
  if (isolated) {
    return {
      kind: 'isolated',
      value: taskBranch,
      selectable: false,
      label: compact
        ? (isZh ? `隔离 · ${compact}` : `isolated · ${compact}`)
        : (isZh ? '隔离' : 'isolated'),
      title: isZh
        ? '在独立目录执行，主工作区保持当前分支'
        : 'Runs in an isolated directory; the main workspace stays on its current branch',
    };
  }
  return {
    kind: 'task-line',
    value: taskBranch,
    selectable: false,
    label: compact
      ? (isZh ? `任务线 ${compact}` : `task line ${compact}`)
      : (isZh ? '隔离线' : 'isolated'),
    title: isZh ? `这条任务记在 ${taskBranch}` : `This task is recorded on ${taskBranch}`,
  };
}

/**
 * 底栏 / 顶栏 Git 表达：工作区 HEAD 与任务线拆开。
 * 切会话不切分支；未隔离且 HEAD 对不上任务线时，只提示继续会写在当前工作区。
 */
export function planComposerGitChrome(
  input: {
    readonly delivery?: TaskDeliveryLine | null;
    readonly workspaceBaseBranch?: string | null;
    readonly currentHead?: string | null;
    readonly isDraft: boolean;
    readonly deliveryKnown?: boolean;
  },
  options?: { readonly locale?: 'zh' | 'en' },
): ComposerGitChrome {
  const isZh = options?.locale !== 'en';
  const currentHead = trimBranch(input.currentHead);
  const workspaceHead = currentHead ? formatWorkspaceHead(currentHead, isZh) : null;
  const deliveryKnown = input.deliveryKnown !== false;
  const taskBranch = trimBranch(input.delivery?.taskBranch);
  const targetBranch = trimBranch(input.delivery?.targetBranch);
  const isolated = input.delivery?.isolated === true;

  let taskLine: ComposerTaskLine | null = null;
  if (taskBranch) {
    taskLine = formatRecordedTaskLine(taskBranch, isolated, isZh);
  } else if (targetBranch) {
    taskLine = formatSourceLine(targetBranch, false, isZh);
  } else if (input.isDraft) {
    const source = trimBranch(input.workspaceBaseBranch) || currentHead;
    if (source) taskLine = formatSourceLine(source, true, isZh);
  } else if (!deliveryKnown) {
    taskLine = null;
  }

  const writeMismatch = (
    taskLine?.kind === 'task-line'
    && currentHead
    && taskBranch
    && !sameComposerBranchRef(currentHead, taskBranch)
  )
    ? {
      label: isZh ? '写在当前工作区' : 'writes on current workspace',
      title: isZh
        ? `工作区在 ${currentHead}，继续会写在当前工作区`
        : `Workspace is on ${currentHead}; continuing writes there.`,
    }
    : null;

  return { workspaceHead, taskLine, writeMismatch };
}

/** Draft composer can pick a workspace source; bound sessions/task lines stay locked. */
export function canSelectComposerSourceBranch(input: {
  readonly isDraft: boolean;
  readonly delivery?: TaskDeliveryLine | null;
}): boolean {
  if (!input.isDraft) return false;
  return !trimBranch(input.delivery?.taskBranch) && !trimBranch(input.delivery?.targetBranch);
}

/** Unique local branches for the composer picker. Isolation UUID paths stay hidden unless already selected. */
export function buildComposerBranchOptions(input: {
  readonly branches?: readonly string[] | null;
  readonly selected?: string | null;
}): readonly string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const push = (raw: string | null | undefined, allowInternal: boolean) => {
    const next = trimBranch(raw);
    if (!next || seen.has(next)) return;
    if (!allowInternal && isInternalIsolationBranch(next)) return;
    seen.add(next);
    options.push(next);
  };
  for (const branch of input.branches ?? []) push(branch, false);
  push(input.selected, true);
  return options;
}
