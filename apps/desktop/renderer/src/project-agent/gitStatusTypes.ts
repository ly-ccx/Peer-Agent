export interface WorkPanelGitEntry {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly conflicted: boolean;
  /** Workspace-relative; omitted for absent or out-of-scope files. */
  readonly openPath?: string;
}

export type WorkPanelGitStatus =
  | { readonly kind: 'not-git' | 'unavailable' | 'invalid-workspace'; readonly isGitRepo: false; readonly observedAt: string }
  | {
    readonly kind: 'status';
    readonly isGitRepo: true;
    readonly repoRoot: string;
    readonly branch: string | null;
    readonly headShort: string | null;
    readonly detached: boolean;
    readonly unborn: boolean;
    readonly clean: boolean | null;
    readonly filtersDisabled: boolean;
    readonly changedCount: number;
    readonly stagedCount: number;
    readonly unstagedCount: number;
    readonly untrackedCount: number;
    readonly entries: readonly WorkPanelGitEntry[];
    readonly truncated: boolean;
    readonly totalEntries: number;
    readonly observedAt: string;
  };
