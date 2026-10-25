import { countDiffLineStats, groupDiffByFile } from './file-preview/diffLines.ts';

export function resourceDiffFiles(text: string) {
  return text.split(/(?=^diff --git )/m).filter(part => part.trim()).map((raw, index) => {
    const file = groupDiffByFile(raw)[0];
    return { key: file?.path || `comparison:${index}`, path: file?.path ?? '', raw,
      binary: /^Binary files |^GIT binary patch/m.test(raw), removed: /^deleted file mode /m.test(raw),
      ...countDiffLineStats(file?.lines ?? []) };
  });
}

/** Host records supply task provenance. Missing facts never become a guessed HEAD/main comparison. */
export function taskComparisonBinding(session: unknown, plan: unknown, workspaceId: string, sessionId: string) {
  if (!session || typeof session !== 'object' || !plan || typeof plan !== 'object') return null;
  const detail = session as { sessionId?: string; workspaceId?: string; report?: { planId?: string } };
  const goal = plan as { planId?: string; delegationOrigin?: { workspaceId?: string; sessionId?: string };
    baseCommit?: string; deliveryBinding?: { baseCommit?: string; worktreePath?: string; targetWorkspacePath?: string; executionIsolation?: string } };
  if (detail.sessionId !== sessionId || detail.workspaceId !== workspaceId || detail.report?.planId !== goal.planId
    || goal.delegationOrigin?.workspaceId !== workspaceId || goal.delegationOrigin.sessionId !== sessionId) return null;
  const binding = goal.deliveryBinding;
  if (binding?.executionIsolation === 'worktree' && !binding.worktreePath) return null;
  const root = binding?.worktreePath || binding?.targetWorkspacePath;
  const base = binding?.baseCommit || goal.baseCommit;
  if (!root || !/^(?:\/|[a-z]:[\\/])/i.test(root) || !base || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base)) return null;
  return { root, base, isolated: binding?.executionIsolation === 'worktree' };
}

export function comparisonReadError(status: string | undefined, detail: string | undefined, isZh: boolean) {
  const key = detail && ['scope_denied', 'permission_denied', 'workspace_unavailable', 'revision_unavailable'].includes(detail) ? detail : status;
  const labels: Record<string, readonly [string, string]> = {
    not_git_repo: ['此来源不是 Git 仓库。', 'This source is not a Git repository.'],
    invalid_ref: ['比较引用无效或已不可用，请检查起点和终点。', 'A comparison revision is invalid or unavailable. Check both ends.'],
    revision_unavailable: ['比较所需的提交已不可用。', 'A required commit is unavailable.'],
    scope_denied: ['此比较来源超出当前允许的范围。', 'This comparison is outside the permitted scope.'],
    permission_denied: ['没有读取此比较来源的权限。', 'Reading this comparison is not permitted.'],
    workspace_unavailable: ['此比较来源当前不可用。', 'This comparison source is unavailable.'],
  };
  return labels[key ?? '']?.[isZh ? 0 : 1] ?? (isZh ? '未能完整读取比较，请缩小范围或重试。' : 'The comparison could not be read completely. Narrow the range or retry.');
}
