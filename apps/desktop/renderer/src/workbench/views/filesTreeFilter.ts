export interface FilterableEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly absPath: string;
}

/**
 * 按名称筛选当前可见的一层条目。
 * - 空查询：原样返回
 * - 目录：名称命中则保留；未命中但子树可能命中时也保留（需调用方继续展开）
 * - 文件：仅名称命中时保留
 *
 * 注意：当前文件树是懒加载，调用方只对已缓存 children 做本地过滤。
 */
export function filterVisibleEntries<T extends FilterableEntry>(
  entries: readonly T[],
  query: string,
  childrenOf?: (entry: T) => readonly FilterableEntry[] | undefined,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;

  return entries.filter((entry) => {
    const nameHit = entry.name.toLowerCase().includes(needle);
    if (nameHit) return true;
    if (!entry.isDir || !childrenOf) return false;
    const kids = childrenOf(entry);
    if (!kids || kids.length === 0) return false;
    return filterVisibleEntries(kids, needle, (child) => {
      // childrenOf only needs to work for known DirEntry shape; for nested we reuse same map lookup by absPath if provided.
      return childrenOf(child as T);
    }).length > 0;
  });
}

export function sanitizeNewEntryName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name === '.' || name === '..') return null;
  if (/[\\/]/.test(name)) return null;
  return name;
}
