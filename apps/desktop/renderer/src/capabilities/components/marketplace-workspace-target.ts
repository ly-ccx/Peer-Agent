export type WorkspaceDirectory = {
  readonly workspaces: readonly {
    readonly path: string;
    readonly name: string;
  }[];
  readonly activeWorkspace: string | null;
};

export type MarketplaceWorkspaceTarget = {
  readonly name: string;
  readonly path: string;
  readonly optionLabel: string;
  readonly installPath: string;
  readonly isActive: boolean;
};

function normalizedPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function basename(value: string): string {
  const normalized = normalizedPath(value);
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
}

export function getMarketplaceWorkspaceTargets(
  directory: WorkspaceDirectory | null | undefined,
): readonly MarketplaceWorkspaceTarget[] {
  const activePath = directory?.activeWorkspace?.trim() ?? '';
  const normalizedActivePath = normalizedPath(activePath);
  return (directory?.workspaces ?? [])
    .filter((workspace) => workspace.path.trim().length > 0)
    .map((workspace) => {
      const workspacePath = workspace.path.trim();
      const normalizedWorkspacePath = normalizedPath(workspacePath);
      const name = workspace.name.trim() || basename(workspacePath) || workspacePath;
      const isActive = normalizedWorkspacePath === normalizedActivePath;
      return {
        name,
        path: workspacePath,
        optionLabel: isActive ? `${name}（当前）` : name,
        installPath: `${normalizedWorkspacePath}/skills/`,
        isActive,
      };
    });
}

export function getMarketplaceWorkspaceTarget(
  directory: WorkspaceDirectory | null | undefined,
  selectedPath?: string | null,
): MarketplaceWorkspaceTarget | null {
  const targets = getMarketplaceWorkspaceTargets(directory);
  const requestedPath = normalizedPath(selectedPath?.trim() || directory?.activeWorkspace?.trim() || '');
  return targets.find((target) => normalizedPath(target.path) === requestedPath) ?? targets[0] ?? null;
}
