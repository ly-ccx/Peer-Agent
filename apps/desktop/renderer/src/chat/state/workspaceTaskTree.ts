export const UNASSIGNED_WORKSPACE_KEY = '__unassigned__';

export type WorkspaceTreeToggles = {
  readonly expanded: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
};

export function emptyWorkspaceTreeToggles(): WorkspaceTreeToggles {
  return { expanded: new Set(), collapsed: new Set() };
}

export function isWorkspaceTaskTreeOpen(input: {
  readonly path: string;
  readonly toggles: WorkspaceTreeToggles;
  readonly activeWorkspace: string | null;
  readonly focusedWorkspace: string | null;
}): boolean {
  if (input.toggles.collapsed.has(input.path)) return false;
  const autoOpen =
    input.path === input.activeWorkspace || input.path === input.focusedWorkspace;
  // Sticky expand: a previously opened group stays open when focus moves.
  return autoOpen || input.toggles.expanded.has(input.path);
}

/** Chevron flips this group only. Other groups stay as they are. */
export function nextWorkspaceTreeToggles(
  current: WorkspaceTreeToggles,
  path: string,
  currentlyOpen: boolean,
): WorkspaceTreeToggles {
  const expanded = new Set(current.expanded);
  const collapsed = new Set(current.collapsed);
  if (currentlyOpen) {
    expanded.delete(path);
    collapsed.add(path);
  } else {
    collapsed.delete(path);
    expanded.add(path);
  }
  return { expanded, collapsed };
}

/** Force-open this workspace. Other already-open groups stay open. */
export function openWorkspaceTreeToggles(
  current: WorkspaceTreeToggles,
  path: string,
): WorkspaceTreeToggles {
  if (current.expanded.has(path) && !current.collapsed.has(path)) return current;
  const expanded = new Set(current.expanded);
  const collapsed = new Set(current.collapsed);
  expanded.add(path);
  collapsed.delete(path);
  return { expanded, collapsed };
}

/** 点整行：当前且已展开则折叠，否则展开。未归属没有激活语义，开着再点就收。 */
export function nextWorkspaceRowClickToggles(input: {
  readonly current: WorkspaceTreeToggles;
  readonly path: string;
  readonly activeWorkspace: string | null;
  readonly focusedWorkspace: string | null;
}): WorkspaceTreeToggles {
  const currentlyOpen = isWorkspaceTaskTreeOpen({
    path: input.path,
    toggles: input.current,
    activeWorkspace: input.activeWorkspace,
    focusedWorkspace: input.focusedWorkspace,
  });
  const isCurrent =
    input.path === input.activeWorkspace || input.path === UNASSIGNED_WORKSPACE_KEY;
  if (currentlyOpen && isCurrent) {
    return nextWorkspaceTreeToggles(input.current, input.path, true);
  }
  return openWorkspaceTreeToggles(input.current, input.path);
}

/**
 * Remember currently auto-open groups so they stay open after focus moves.
 * Does not override a chevron collapse.
 */
export function rememberOpenWorkspaceTrees(
  current: WorkspaceTreeToggles,
  paths: readonly (string | null)[],
): WorkspaceTreeToggles {
  const expanded = new Set(current.expanded);
  let changed = false;
  for (const path of paths) {
    if (!path || current.collapsed.has(path) || expanded.has(path)) continue;
    expanded.add(path);
    changed = true;
  }
  return changed ? { expanded, collapsed: current.collapsed } : current;
}
