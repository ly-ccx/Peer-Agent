export interface QuickChatWorkspaceIdentity {
  readonly name: string;
  readonly path: string;
  readonly accentIndex: number;
}

export function getQuickChatWorkspaceIdentity(workspacePath: string): QuickChatWorkspaceIdentity {
  const normalizedPath = workspacePath.trim().replace(/[\\/]+$/, '');
  const name = normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) || '未命名工作区';
  let hash = 0;
  for (const character of normalizedPath) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return {
    name,
    path: normalizedPath || workspacePath,
    accentIndex: hash % 6,
  };
}
