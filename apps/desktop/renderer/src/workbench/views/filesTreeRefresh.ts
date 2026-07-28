/**
 * Files 树刷新/监听的纯逻辑：
 * - 收集需要重读的目录（根 + 已展开）
 * - 目录重载后裁剪已消失子树的缓存
 * - 合并待刷新路径（debounce 批处理）
 *
 * 不触碰 IPC / React；便于单测。
 */

/** 去掉路径末尾分隔符。 */
export function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

/** 统一为正斜杠，便于前缀比较。 */
export function toForward(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 规范化比较键：去尾 sep + 正斜杠。 */
export function pathKey(p: string): string {
  return toForward(stripTrailingSep(p));
}

/** child 是否为 parent 的子孙路径（不含 parent 自身）。 */
export function isDescendantPath(parent: string, child: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(child);
  if (!p || !c || p === c) return false;
  return c.startsWith(`${p}/`);
}

/**
 * 手动刷新 / 全量同步时需要重读的目录：
 * 根目录 + 所有已展开目录（去重，保序：根优先，其余按插入序）。
 */
export function collectDirPathsToRefresh(
  rootPath: string | null | undefined,
  expanded: Iterable<string>,
): string[] {
  if (!rootPath) return [];
  const root = stripTrailingSep(rootPath);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const abs = stripTrailingSep(raw);
    if (!abs) return;
    const key = pathKey(abs);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(abs);
  };
  push(root);
  for (const p of expanded) push(p);
  return out;
}

/** 轻量 watch 的目录集合：与刷新集合一致（只盯根 + 已展开）。 */
export function collectWatchDirPaths(
  rootPath: string | null | undefined,
  expanded: Iterable<string>,
): string[] {
  return collectDirPathsToRefresh(rootPath, expanded);
}

/**
 * 把一次目录变更并入待刷新集合。
 * eventDir 为被 watch 的目录绝对路径（fs.watch 回调侧应传 watched dir，而非文件名）。
 */
export function mergePendingRefreshPaths(
  pending: ReadonlySet<string>,
  eventDir: string,
): Set<string> {
  const next = new Set(pending);
  const abs = stripTrailingSep(eventDir);
  if (abs) next.add(abs);
  return next;
}

export interface DirEntryLike {
  readonly absPath: string;
  readonly isDir: boolean;
}

export interface TreeCacheState<TEntry extends DirEntryLike = DirEntryLike> {
  readonly children: ReadonlyMap<string, readonly TEntry[]>;
  readonly expanded: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
  readonly selected: string | null;
}

/**
 * 父目录重载后：删除「曾是直接子目录、现已不存在」的整棵子树缓存，
 * 并更新 parent 的 children 列表。
 */
export function pruneAfterDirReload<TEntry extends DirEntryLike>(
  parentAbsPath: string,
  nextDirectChildren: readonly TEntry[],
  state: TreeCacheState<TEntry>,
): TreeCacheState<TEntry> {
  const parent = stripTrailingSep(parentAbsPath);
  const parentKey = pathKey(parent);

  const nextChildren = new Map(state.children);
  const nextExpanded = new Set(state.expanded);
  const nextLoading = new Set(state.loading);
  let nextSelected = state.selected;

  const oldDirect = state.children.get(parent) ?? state.children.get(parentKey) ?? [];
  // 兼容 key 可能是不同 sep 形式：用 pathKey 对齐查找
  let oldList = oldDirect;
  if (oldList.length === 0) {
    for (const [k, v] of state.children) {
      if (pathKey(k) === parentKey) {
        oldList = v;
        break;
      }
    }
  }

  const newDirectDirKeys = new Set(
    nextDirectChildren.filter((e) => e.isDir).map((e) => pathKey(e.absPath)),
  );

  const removedDirKeys: string[] = [];
  for (const entry of oldList) {
    if (!entry.isDir) continue;
    const k = pathKey(entry.absPath);
    if (!newDirectDirKeys.has(k)) removedDirKeys.push(k);
  }

  const shouldDrop = (raw: string): boolean => {
    const k = pathKey(raw);
    for (const removed of removedDirKeys) {
      if (k === removed || k.startsWith(`${removed}/`)) return true;
    }
    return false;
  };

  for (const key of [...nextChildren.keys()]) {
    if (shouldDrop(key)) nextChildren.delete(key);
  }
  for (const key of [...nextExpanded]) {
    if (shouldDrop(key)) nextExpanded.delete(key);
  }
  for (const key of [...nextLoading]) {
    if (shouldDrop(key)) nextLoading.delete(key);
  }
  if (nextSelected && shouldDrop(nextSelected)) {
    nextSelected = null;
  }

  // 写入新列表：优先用调用方传入的 parent abs 原样做 key（与 FilesView 一致）
  nextChildren.set(parent, nextDirectChildren);
  // 清掉同路径不同 sep 的旧 key，避免双份
  for (const key of [...nextChildren.keys()]) {
    if (key !== parent && pathKey(key) === parentKey) nextChildren.delete(key);
  }

  return {
    children: nextChildren,
    expanded: nextExpanded,
    loading: nextLoading,
    selected: nextSelected,
  };
}
