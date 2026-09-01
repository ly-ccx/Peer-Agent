/** 工作区路径缩略：/Users/x/... 或 /home/x/... -> ~/... */
export function abbreviateWorkspacePath(absPath: string): string {
  const match = absPath.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (match) return `~${match[1] || ''}`;
  return absPath;
}

/** Pin / 跨工作区列表用的短工作区名：路径最后一段。 */
export function workspaceLabelFromPath(workspacePath?: string | null): string | null {
  if (!workspacePath) return null;
  const normalized = workspacePath.replace(/[/\\]+$/, '');
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || null;
}
