export interface TaskDeliveryLine {
  readonly targetBranch: string | null;
  readonly taskBranch: string | null;
  readonly isolated: boolean;
  /** 合回目标分支完成后，这次隔离已经结束，输入栏应回到源头。 */
  readonly delivered?: boolean;
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

export type ComposerEnvCapsuleKind = 'workspace' | 'source' | 'isolated' | 'task-line' | 'mismatch';

export interface ComposerEnvCapsule {
  readonly kind: ComposerEnvCapsuleKind;
  readonly label: string;
  readonly title: string;
  readonly isolated: boolean;
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
    readonly deliveryHandoff?: {
      readonly status?: string | null;
    } | null;
  } | null | undefined,
): TaskDeliveryLine | null {
  const binding = plan?.deliveryBinding;
  const targetBranch = trimBranch(binding?.targetBranch);
  const taskBranch = trimBranch(binding?.taskBranch);
  if (!targetBranch && !taskBranch) return null;
  const delivered = plan?.deliveryHandoff?.status === 'delivered';
  const isolated = !delivered
    && binding?.executionIsolation === 'worktree'
    && Boolean(trimBranch(binding.worktreePath));
  return {
    targetBranch,
    taskBranch,
    isolated,
    delivered,
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
    title: isZh
      ? `当前工作区 HEAD 是 ${currentHead}。这是你现在所在的工作区，不是本地/远程标记。`
      : `Workspace HEAD is ${currentHead}. This is where the workspace is now, not a local/remote marker.`,
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
      ? (isZh
        ? `新任务将从 ${source} 分叉。本地和远程分支在菜单里分组；选这里不会切换当前工作区。`
        : `New tasks will fork from ${source}. Local and remote branches are grouped in the menu; choosing this does not checkout.`)
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
      label: compact ? `Worktree · ${compact}` : 'Worktree',
      title: isZh
        ? '在独立 Worktree 目录执行，主工作区保持当前分支'
        : 'Runs in a Worktree directory; the main workspace stays on its current branch',
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
  const delivered = input.delivery?.delivered === true;

  let taskLine: ComposerTaskLine | null = null;
  if (delivered) {
    const source = targetBranch || currentHead;
    if (source) taskLine = formatSourceLine(source, input.isDraft, isZh);
  } else if (taskBranch) {
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

export const COMPOSER_ENV_ISOLATION_ON = '__composer_env_isolation_on__';
export const COMPOSER_ENV_ISOLATION_OFF = '__composer_env_isolation_off__';

/**
 * Collapsed chrome copy for “where this send writes”.
 * Next-task Worktree preference rewrites source lines (draft or bound),
 * but does not override a live task-line or write-mismatch.
 */
export function formatComposerEnvCapsule(
  chrome: ComposerGitChrome,
  options?: {
    readonly locale?: 'zh' | 'en';
    readonly preferredIsolation?: boolean;
  },
): ComposerEnvCapsule {
  const isZh = options?.locale !== 'en';
  const preferredIsolation = options?.preferredIsolation === true;
  const { workspaceHead, taskLine, writeMismatch } = chrome;

  if (taskLine?.kind === 'isolated') {
    const name = visibleBranchName(taskLine.value, taskLine.value);
    return {
      kind: 'isolated',
      isolated: true,
      label: `Worktree · ${name}`,
      title: taskLine.title,
    };
  }

  if (writeMismatch) {
    const head = workspaceHead
      ? visibleBranchName(workspaceHead.value, workspaceHead.value)
      : null;
    return {
      kind: 'mismatch',
      isolated: false,
      label: head
        ? (isZh ? `在 ${head} · 写在当前工作区` : `on ${head} · writes here`)
        : (isZh ? '写在当前工作区' : 'writes on current workspace'),
      title: writeMismatch.title,
    };
  }

  if (taskLine?.kind === 'task-line') {
    const name = visibleBranchName(taskLine.value, taskLine.value);
    return {
      kind: 'task-line',
      isolated: false,
      label: isZh ? `在 ${name}` : `on ${name}`,
      title: taskLine.title,
    };
  }

  if (taskLine?.kind === 'source') {
    const name = visibleBranchName(taskLine.value, taskLine.value);
    if (preferredIsolation) {
      return {
        kind: 'source',
        isolated: true,
        label: isZh ? `Worktree · 从 ${name}` : `Worktree · from ${name}`,
        title: isZh
          ? `下次任务将从 ${taskLine.value} 开 Worktree。合回后这次隔离会结束，这个选择只表示下一次。`
          : `The next task will fork ${taskLine.value} into a Worktree. This preference applies to the next task only.`,
      };
    }
    if (taskLine.selectable) {
      return {
        kind: 'source',
        isolated: false,
        label: isZh ? `在 ${name}` : `on ${name}`,
        title: taskLine.title,
      };
    }
    return {
      kind: 'source',
      isolated: false,
      label: isZh ? `源头 ${name}` : `from ${name}`,
      title: taskLine.title,
    };
  }

  if (workspaceHead) {
    const name = visibleBranchName(workspaceHead.value, workspaceHead.value);
    return {
      kind: 'workspace',
      isolated: false,
      label: isZh ? `在 ${name}` : `on ${name}`,
      title: workspaceHead.title,
    };
  }

  if (preferredIsolation) {
    return {
      kind: 'source',
      isolated: true,
      label: 'Worktree',
      title: isZh
        ? '下次任务将在 Worktree 里执行。合回后这次隔离会结束，这个选择只表示下一次。'
        : 'The next task will run in a Worktree. This preference applies to the next task only.',
    };
  }

  return {
    kind: 'workspace',
    isolated: false,
    label: isZh ? '当前工作区' : 'current workspace',
    title: isZh ? '继续会写在当前工作区' : 'Continuing writes on the current workspace.',
  };
}

/** Draft composer can pick a workspace source; bound sessions/task lines stay locked. */
export function canSelectComposerSourceBranch(input: {
  readonly isDraft: boolean;
  readonly delivery?: TaskDeliveryLine | null;
}): boolean {
  if (!input.isDraft) return false;
  return !trimBranch(input.delivery?.taskBranch) && !trimBranch(input.delivery?.targetBranch);
}

export function isSafeComposerBranchName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) return false;
  if (trimmed.startsWith('-') || /\s/.test(trimmed) || trimmed.includes('..') || trimmed.includes(':')) {
    return false;
  }
  return /^[A-Za-z0-9._/@~^+-]+$/.test(trimmed);
}

export const DEFAULT_COMPOSER_UPSTREAM_REMOTE = 'origin';

export function defaultComposerUpstreamSpec(localName: string): string {
  const name = localName.trim();
  return name ? `${DEFAULT_COMPOSER_UPSTREAM_REMOTE}/${name}` : `${DEFAULT_COMPOSER_UPSTREAM_REMOTE}/`;
}

export interface ComposerUpstreamSpec {
  readonly remote: string;
  readonly branch: string;
}

/** Parse "origin/feat" or "origin" into the remote + remote branch this local branch will track. */
export function parseComposerUpstreamSpec(
  raw: string | null | undefined,
  localName: string,
): ComposerUpstreamSpec | null {
  const local = trimBranch(localName);
  const trimmed = (raw ?? '').trim();
  const spec = trimmed || (local ? defaultComposerUpstreamSpec(local) : '');
  if (!spec) return null;
  const slash = spec.indexOf('/');
  const remote = slash === -1 ? spec : spec.slice(0, slash);
  const branch = (slash === -1 ? '' : spec.slice(slash + 1)) || local || '';
  if (!isSafeComposerBranchName(remote) || remote.includes('/')) return null;
  if (!isSafeComposerBranchName(branch)) return null;
  return { remote, branch };
}

/** Create-from source: current selection first, then highlighted list row, then workspace HEAD. */
export function resolveComposerCreateSourceBranch(input: {
  readonly highlighted?: string | null;
  readonly selected?: string | null;
  readonly currentHead?: string | null;
}): string | null {
  return trimBranch(input.selected)
    ?? trimBranch(input.highlighted)
    ?? trimBranch(input.currentHead);
}

export type ComposerBranchKind = 'local' | 'remote';

export interface ComposerBranchOption {
  readonly value: string;
  readonly kind: ComposerBranchKind;
}

function looksLikeRemoteBranch(name: string, remoteBranches: ReadonlySet<string>): boolean {
  if (remoteBranches.has(name)) return true;
  const slash = name.indexOf('/');
  if (slash <= 0) return false;
  const remote = name.slice(0, slash);
  if (remote === 'PeerAgent') return false;
  return [...remoteBranches].some((item) => item.startsWith(`${remote}/`)) || remote === 'origin';
}

/** Unique local/remote branches for the composer picker. Isolation UUID paths stay hidden unless already selected. */
export function buildComposerBranchOptions(input: {
  readonly branches?: readonly string[] | null;
  readonly localBranches?: readonly string[] | null;
  readonly remoteBranches?: readonly string[] | null;
  readonly selected?: string | null;
}): readonly ComposerBranchOption[] {
  const seen = new Set<string>();
  const options: ComposerBranchOption[] = [];
  const remoteSet = new Set(
    (input.remoteBranches ?? []).map((item) => trimBranch(item)).filter((item): item is string => Boolean(item)),
  );
  const push = (
    raw: string | null | undefined,
    kind: ComposerBranchKind,
    allowInternal: boolean,
  ) => {
    const next = trimBranch(raw);
    if (!next || seen.has(next)) return;
    if (next.endsWith('/HEAD')) return;
    if (!allowInternal && isInternalIsolationBranch(next)) return;
    seen.add(next);
    options.push({ value: next, kind });
  };
  const local = input.localBranches ?? (input.remoteBranches ? [] : input.branches);
  for (const branch of local ?? []) push(branch, 'local', false);
  for (const branch of input.remoteBranches ?? []) push(branch, 'remote', false);
  const selected = trimBranch(input.selected);
  if (selected && !seen.has(selected)) {
    push(selected, looksLikeRemoteBranch(selected, remoteSet) ? 'remote' : 'local', true);
  }
  return options;
}
