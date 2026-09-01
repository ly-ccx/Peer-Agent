import { useCallback, useEffect, useRef, useState } from 'react';

import { clientApi } from '../../clientApi';

export interface WorkspaceGitState {
  readonly ok: boolean;
  readonly current: string | null;
  readonly branches: readonly string[];
  readonly localBranches: readonly string[];
  readonly remoteBranches: readonly string[];
}

function normalizeBranchList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((branch): branch is string => typeof branch === 'string' && Boolean(branch.trim()));
}

function sameBranchList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((branch, index) => branch === right[index]);
}

function normalizeWorkspaceGit(result: {
  readonly ok?: boolean;
  readonly current?: string | null;
  readonly branches?: readonly string[];
  readonly localBranches?: readonly string[];
  readonly remoteBranches?: readonly string[];
} | null | undefined): WorkspaceGitState {
  const isGit = result?.ok === true;
  const localBranches = normalizeBranchList(result?.localBranches);
  const remoteBranches = normalizeBranchList(result?.remoteBranches);
  const branches = normalizeBranchList(result?.branches);
  return {
    ok: isGit,
    current: typeof result?.current === 'string' && result.current.trim() ? result.current.trim() : null,
    branches: branches.length > 0 ? branches : [...new Set([...localBranches, ...remoteBranches])],
    localBranches,
    remoteBranches,
  };
}

function sameWorkspaceGit(left: WorkspaceGitState | null, right: WorkspaceGitState): boolean {
  if (!left) return false;
  if (left.ok !== right.ok || left.current !== right.current) return false;
  return sameBranchList(left.branches, right.branches)
    && sameBranchList(left.localBranches, right.localBranches)
    && sameBranchList(left.remoteBranches, right.remoteBranches);
}

/**
 * Composer 工作区层用的 Git HEAD。
 * 路径变化、窗口重新可见、以及本轮结束后都重读，避免同窗口 checkout 后仍显示旧分支。
 */
export function useWorkspaceGit(
  workspacePath: string | null | undefined,
  options: { readonly refreshWhenIdle?: boolean } = {},
): {
  readonly workspaceGit: WorkspaceGitState | null;
  readonly workspaceIsGit: boolean | null;
  readonly refreshWorkspaceGit: () => void;
} {
  const [workspaceGit, setWorkspaceGit] = useState<WorkspaceGitState | null>(null);
  const requestIdRef = useRef(0);
  const refreshWhenIdle = options.refreshWhenIdle === true;

  const loadWorkspaceGit = useCallback((path: string, { clear }: { clear: boolean }) => {
    if (typeof clientApi.gitListBranches !== 'function') {
      setWorkspaceGit({ ok: false, current: null, branches: [], localBranches: [], remoteBranches: [] });
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (clear) setWorkspaceGit(null);
    void clientApi.gitListBranches({ workspaceRoot: path })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        const next = normalizeWorkspaceGit(result);
        setWorkspaceGit((current) => (sameWorkspaceGit(current, next) ? current : next));
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setWorkspaceGit((current) => (
          sameWorkspaceGit(current, { ok: false, current: null, branches: [], localBranches: [], remoteBranches: [] })
            ? current
            : { ok: false, current: null, branches: [], localBranches: [], remoteBranches: [] }
        ));
      });
  }, []);

  useEffect(() => {
    if (!workspacePath) {
      requestIdRef.current += 1;
      setWorkspaceGit(null);
      return;
    }
    loadWorkspaceGit(workspacePath, { clear: true });
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadWorkspaceGit, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return undefined;
    const refresh = () => {
      if (document.hidden) return;
      loadWorkspaceGit(workspacePath, { clear: false });
    };
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadWorkspaceGit, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !refreshWhenIdle) return;
    loadWorkspaceGit(workspacePath, { clear: false });
  }, [loadWorkspaceGit, refreshWhenIdle, workspacePath]);

  const refreshWorkspaceGit = useCallback(() => {
    if (!workspacePath) return;
    loadWorkspaceGit(workspacePath, { clear: false });
  }, [loadWorkspaceGit, workspacePath]);

  return {
    workspaceGit,
    workspaceIsGit: workspaceGit == null ? null : workspaceGit.ok,
    refreshWorkspaceGit,
  };
}
