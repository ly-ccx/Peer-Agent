/** ADR106: bounded repository observations; never arbitrary commands. */
export const LOCAL_GIT_CAPABILITY = 'local.git.query' as const;
export const LOCAL_GIT_TOOL = 'git_query' as const;
export type GitReadOperation = 'snapshot' | 'status' | 'log';
export interface GitReadQuery {
  readonly path: string;
  readonly operation?: GitReadOperation;
  readonly limit?: number;
}
export interface GitReadObservation {
  readonly repositoryPath: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly configurationSources: readonly string[];
  readonly operation: GitReadOperation;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly unborn: boolean;
  readonly origin: readonly string[];
  readonly consistent: boolean;
  readonly atomic: false;
  readonly status?: {
    readonly clean: boolean | null;
    readonly submoduleCount: number;
    readonly submodulesInspected: false;
    readonly filtersDisabled: boolean;
    readonly changed: number;
    readonly untracked: number;
    readonly entries: readonly { readonly index: string; readonly worktree: string; readonly path: string; readonly from?: string }[];
    readonly truncated: boolean;
  };
  readonly commits: readonly { readonly hash: string; readonly committedAt: string; readonly subject: string }[];
}
