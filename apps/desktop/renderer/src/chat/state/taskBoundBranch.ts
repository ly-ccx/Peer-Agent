export interface TaskDeliveryLine {
  readonly targetBranch: string | null;
  readonly taskBranch: string | null;
}

export interface ComposerBoundBranch {
  readonly label: string;
  readonly title: string;
  readonly kind: 'task-line' | 'bound-source' | 'preview-source';
  readonly value: string;
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

function formatTaskLineLabel(
  taskBranch: string,
  targetBranch: string | null,
  isZh: boolean,
): string {
  const compact = compactBranchName(taskBranch);
  if (compact && targetBranch) return `${compact} · from ${targetBranch}`;
  if (compact) return compact;
  if (targetBranch) return `from ${targetBranch}`;
  return isZh ? '隔离线' : 'isolated';
}

export function snapshotDeliveryLine(
  plan: { readonly deliveryBinding?: { readonly targetBranch?: string | null; readonly taskBranch?: string | null } | null } | null | undefined,
): TaskDeliveryLine | null {
  const targetBranch = trimBranch(plan?.deliveryBinding?.targetBranch);
  const taskBranch = trimBranch(plan?.deliveryBinding?.taskBranch);
  if (!targetBranch && !taskBranch) return null;
  return { targetBranch, taskBranch };
}

/**
 * Visible git line for the composer.
 * Prefer the recorded delivery binding; otherwise preview the workspace source
 * that attachWorkspaceHeadBinding will use (configured baseBranch, else HEAD).
 * Never invents main.
 */
export function formatComposerBoundBranch(
  input: {
    readonly delivery?: TaskDeliveryLine | null;
    readonly workspaceBaseBranch?: string | null;
    readonly currentHead?: string | null;
  },
  options?: { readonly locale?: 'zh' | 'en' },
): ComposerBoundBranch | null {
  const isZh = options?.locale !== 'en';
  const taskBranch = trimBranch(input.delivery?.taskBranch);
  const targetBranch = trimBranch(input.delivery?.targetBranch);
  if (taskBranch && targetBranch) {
    return {
      kind: 'task-line',
      label: formatTaskLineLabel(taskBranch, targetBranch, isZh),
      title: isZh
        ? `当前任务线 ${taskBranch}，从 ${targetBranch} 分叉`
        : `Task line ${taskBranch}, forked from ${targetBranch}`,
      value: taskBranch,
    };
  }
  if (taskBranch) {
    return {
      kind: 'task-line',
      label: formatTaskLineLabel(taskBranch, null, isZh),
      title: isZh ? `当前任务线 ${taskBranch}` : `Task line ${taskBranch}`,
      value: taskBranch,
    };
  }
  if (targetBranch) {
    return {
      kind: 'bound-source',
      label: targetBranch,
      title: isZh ? `已绑定源头 ${targetBranch}` : `Bound to ${targetBranch}`,
      value: targetBranch,
    };
  }
  const source = trimBranch(input.workspaceBaseBranch) || trimBranch(input.currentHead);
  if (!source) return null;
  const configured = Boolean(trimBranch(input.workspaceBaseBranch));
  return {
    kind: 'preview-source',
    label: source,
    title: configured
      ? (isZh ? `新任务将从工作区源头 ${source} 分叉` : `New tasks will fork from ${source}`)
      : (isZh ? `新任务将从当前分支 ${source} 分叉` : `New tasks will fork from the current branch ${source}`),
    value: source,
  };
}

export function formatComposerBranchOptionLabel(branch: string): string {
  return compactBranchName(branch) || branch;
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
