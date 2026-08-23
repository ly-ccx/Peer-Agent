import { useCallback, useEffect, useRef, useState } from 'react';

import { clientApi } from '../../clientApi';

export interface WorkspaceGitState {
  readonly ok: boolean;
  readonly current: string | null;
  readonly branches: readonly string[];
}

function normalizeWorkspaceGit(result: {
  readonly ok?: boolean;
  readonly current?: string | null;
  readonly branches?: readonly string[];
} | null | undefined): WorkspaceGitState {
  const isGit = result?.ok === true;
  const branches = Array.isArray(result?.branches)
    ? result.branches.filter((branch): branch is string => typeof branch === 'string' && Boolean(branch.trim()))
    : [];
  return {
    ok: isGit,
    current: typeof result?.current === 'string' && result.current.trim() ? result.current.trim() : null,
    branches,
  };
}

function sameWorkspaceGit(left: WorkspaceGitState | null, right: WorkspaceGitState): boolean {
  if (!left) return false;
  if (left.ok !== right.ok || left.current !== right.current) return false;
  if (left.branches.length !== right.branches.length) return false;
  return left.branches.every((branch, index) => branch === right.branches[index]);
}

/**
 * Composer 绑定分支用的工作区 Git HEAD。
 * 路径变化、窗口重新可见、以及本轮结束后都重读，避免同窗口 checkout 后仍显示旧分支。
 */
export function useWorkspaceGit(
  workspacePath: string | null | undefined,
  options: { readonly refreshWhenIdle?: boolean } = {},
): {
  readonly workspaceGit: WorkspaceGitState | null;
  readonly workspaceIsGit: boolean | null;
} {
  const [workspaceGit, setWorkspaceGit] = useState<WorkspaceGitState | null>(null);
  const requestIdRef = useRef(0);
  const refreshWhenIdle = options.refreshWhenIdle === true;

  const loadWorkspaceGit = useCallback((path: string, { clear }: { clear: boolean }) => {
    if (typeof clientApi.gitListBranches !== 'function') {
      setWorkspaceGit({ ok: false, current: null, branches: [] });
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
          sameWorkspaceGit(current, { ok: false, current: null, branches: [] })
            ? current
            : { ok: false, current: null, branches: [] }
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

  return {
    workspaceGit,
    workspaceIsGit: workspaceGit == null ? null : workspaceGit.ok,
  };
}
