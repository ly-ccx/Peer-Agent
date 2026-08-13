/** 工作区路径缩略：/Users/x/... 或 /home/x/... -> ~/... */
export function abbreviateWorkspacePath(absPath: string): string {
  const match = absPath.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (match) return `~${match[1] || ''}`;
  return absPath;
}
