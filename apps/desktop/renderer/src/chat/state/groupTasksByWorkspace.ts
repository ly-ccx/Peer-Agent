export interface WorkspaceBucket {
  readonly path: string;
}

export function groupTasksByWorkspace<T extends { workspacePath?: string | null }>(
  workspaces: readonly WorkspaceBucket[],
  conversations: readonly T[],
): { readonly byPath: ReadonlyMap<string, readonly T[]>; readonly unassigned: readonly T[] } {
  const byPath = new Map<string, T[]>();
  for (const workspace of workspaces) {
    byPath.set(workspace.path, []);
  }
  const unassigned: T[] = [];
  for (const conversation of conversations) {
    const key = conversation.workspacePath ?? '';
    const bucket = key ? byPath.get(key) : undefined;
    if (bucket) bucket.push(conversation);
    else unassigned.push(conversation);
  }
  return { byPath, unassigned };
}
