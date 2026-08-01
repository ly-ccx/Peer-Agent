import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { clientApi } from '../../clientApi';
import { useWorkbench } from '../WorkbenchContext';
import {
  collectDirPathsToRefresh,
  collectWatchDirPaths,
  mergePendingRefreshPaths,
  pruneAfterDirReload,
  stripTrailingSep,
} from './filesTreeRefresh';
import { getFileVisualKind, type FileVisualKind } from './filesTreePresentation';

interface FilesViewProps {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly absPath: string;
}

/** 统一为正斜杠，便于做前缀/分段比较（不改变 IPC 调用所用的原始 absPath）。 */
function toForward(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 取路径最后一段作为展示名。 */
function baseName(p: string): string {
  const norm = stripTrailingSep(toForward(p));
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1);
}

const ICON_PROPS = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function FileTreeIcon({ kind, open = false }: { readonly kind: FileVisualKind; readonly open?: boolean }) {
  let paths: ReactNode;
  switch (kind) {
    case 'folder':
      paths = open ? (
        <path d="M2.7 7.1h14.6l-1.55 7.55a1.5 1.5 0 0 1-1.47 1.2H4.7a1.5 1.5 0 0 1-1.47-1.2L2.7 7.1Zm.8 0V5.65a1.5 1.5 0 0 1 1.5-1.5h3l1.6 1.7h5.4a1.5 1.5 0 0 1 1.5 1.25" />
      ) : (
        <path d="M2.75 5.8a1.5 1.5 0 0 1 1.5-1.5h3.4l1.55 1.75h6.55a1.5 1.5 0 0 1 1.5 1.5v6.65a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V5.8Z" />
      );
      break;
    case 'markdown':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M6.3 13v-3l1.45 1.8L9.2 10v3m1.55-3 1.5 3 1.5-3m-3 2h3" /></>;
      break;
    case 'code':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8.4 10 6.8 11.6l1.6 1.6m3.2-3.2 1.6 1.6-1.6 1.6" /></>;
      break;
    case 'style':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M7 10.2c1.7-1 4.3-1 6 0m-5.3 2c1.25-.7 3.35-.7 4.6 0M9 14.2c.55-.3 1.45-.3 2 0" /></>;
      break;
    case 'config':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M7 10h6M7 13h6M9 9v2m3 1v2" /></>;
      break;
    case 'image':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M6.5 14l2.3-2.7 1.65 1.65 1.3-1.35 1.75 2.4M7.5 8.8h.01" /></>;
      break;
    case 'archive':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8.5 5.1h2M8.5 7.2h2m-2 2.1h2m-2 2.1h2v3h-2z" /></>;
      break;
    case 'git':
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8 9.2v4.9m0-3.6 3.5 2v-3M8 9.2h.01m0 4.9h.01m3.5-4.9h.01" /></>;
      break;
    default:
      paths = <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4" /></>;
  }

  return <svg {...ICON_PROPS} className="workbench-tree-file-icon">{paths}</svg>;
}

function RefreshIcon() {
  return <svg {...ICON_PROPS} viewBox="0 0 20 20"><path d="M15.8 7.1A6.25 6.25 0 1 0 16 12M15.8 7.1V3.8m0 3.3h-3.3" /></svg>;
}

/**
 * 计算从根目录到目标目录（含两端）的祖先链：[root, root/a, root/a/b, …, target]。
 * target 不在 root 之下时返回 null（如跨 workspace 引用，当前树无法展示）。
 */
function buildChain(root: string, target: string): string[] | null {
  const r = toForward(stripTrailingSep(root));
  const t = toForward(stripTrailingSep(target));
  if (t === r) return [r];
  if (!t.startsWith(`${r}/`)) return null;
  const segs = t.slice(r.length + 1).split('/').filter(Boolean);
  const chain = [r];
  let cur = r;
  for (const seg of segs) {
    cur = `${cur}/${seg}`;
    chain.push(cur);
  }
  return chain;
}

interface TreeNodeProps {
  readonly entry: DirEntry;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly children: ReadonlyMap<string, readonly DirEntry[]>;
  readonly loading: ReadonlySet<string>;
  readonly selected: string | null;
  readonly isZh: boolean;
  readonly onToggleDir: (absPath: string) => void;
  readonly onOpenFile: (entry: DirEntry) => void;
  readonly rootAction?: ReactNode;
}

function TreeNode({
  entry,
  depth,
  expanded,
  children,
  loading,
  selected,
  isZh,
  onToggleDir,
  onOpenFile,
  rootAction,
}: TreeNodeProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const key = toForward(stripTrailingSep(entry.absPath));
  const isSelected = selected != null && toForward(stripTrailingSep(selected)) === key;
  const isOpen = entry.isDir && expanded.has(entry.absPath);
  const isLoading = entry.isDir && loading.has(entry.absPath);
  const kids = entry.isDir ? children.get(entry.absPath) : undefined;
  const visualKind = getFileVisualKind(entry.name, entry.isDir);

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  const handleActivate = () => {
    if (entry.isDir) onToggleDir(entry.absPath);
    else onOpenFile(entry);
  };

  return (
    <div className="workbench-tree-node">
      <div
        ref={rowRef}
        className="workbench-tree-row"
        data-selected={isSelected}
        data-dir={entry.isDir}
        role="treeitem"
        aria-expanded={entry.isDir ? isOpen : undefined}
        tabIndex={0}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={entry.absPath}
        onClick={handleActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleActivate();
          }
        }}
      >
        <span
          className={`workbench-tree-twisty${entry.isDir ? ' workbench-tree-twisty--dir' : ''}`}
          data-open={isOpen}
          aria-hidden
        >
          {entry.isDir ? '›' : ''}
        </span>
        <span className="workbench-tree-icon" data-kind={visualKind} data-open={isOpen}>
          <FileTreeIcon kind={visualKind} open={isOpen} />
        </span>
        <span className="workbench-tree-name">{entry.name}</span>
        {depth === 0 && rootAction ? <span className="workbench-tree-actions">{rootAction}</span> : null}
      </div>
      {isOpen ? (
        <div className="workbench-tree-children" role="group">
          {isLoading && !kids ? (
            <div
              className="workbench-tree-hint"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              {isZh ? '加载中…' : 'Loading…'}
            </div>
          ) : kids && kids.length === 0 ? (
            <div
              className="workbench-tree-hint"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              {isZh ? '空目录' : 'Empty'}
            </div>
          ) : kids ? (
            kids.map((child) => (
              <TreeNode
                key={child.absPath}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                children={children}
                loading={loading}
                selected={selected}
                isZh={isZh}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const WATCH_DEBOUNCE_MS = 200;

export function FilesView({ isZh, workspacePath }: FilesViewProps) {
  const { filesTarget, openFile: openWorkbenchFile } = useWorkbench();
  const rootPath = workspacePath ? stripTrailingSep(workspacePath) : null;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<ReadonlyMap<string, readonly DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 子节点缓存的 ref 镜像：reveal 串行展开链路时读取最新缓存，避免闭包过期。
  const childrenRef = useRef<Map<string, readonly DirEntry[]>>(new Map());
  const expandedRef = useRef<ReadonlySet<string>>(new Set());
  const loadingRef = useRef<ReadonlySet<string>>(new Set());
  const selectedRef = useRef<string | null>(null);
  const pendingRefreshRef = useRef<Set<string>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  expandedRef.current = expanded;
  loadingRef.current = loading;
  selectedRef.current = selected;

  const applyReloadResult = useCallback((absPath: string, entries: readonly DirEntry[]) => {
    const pruned = pruneAfterDirReload(absPath, entries, {
      children: childrenRef.current,
      expanded: expandedRef.current,
      loading: loadingRef.current,
      selected: selectedRef.current,
    });
    childrenRef.current = new Map(pruned.children);
    setChildren(new Map(pruned.children));
    setExpanded(new Set(pruned.expanded));
    setLoading(new Set(pruned.loading));
    setSelected(pruned.selected);
  }, []);

  // 列目录并写入缓存；默认命中缓存。force 时绕过缓存并裁剪消失子树。
  const loadDir = useCallback(
    async (absPath: string, options?: { force?: boolean }): Promise<readonly DirEntry[]> => {
      if (!options?.force) {
        const cached = childrenRef.current.get(absPath);
        if (cached) return cached;
      }
      setLoading((prev) => {
        const next = new Set(prev);
        next.add(absPath);
        return next;
      });
      let entries: readonly DirEntry[] = [];
      try {
        const res = await clientApi.readDir(absPath, workspacePath ?? undefined);
        entries = res && res.ok ? res.entries.map((e) => ({ ...e })) : [];
      } catch {
        entries = [];
      }
      if (options?.force) {
        applyReloadResult(absPath, entries);
      } else {
        childrenRef.current.set(absPath, entries);
        setChildren(new Map(childrenRef.current));
      }
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(absPath);
        return next;
      });
      return entries;
    },
    [workspacePath, applyReloadResult],
  );

  const refreshAllExpanded = useCallback(async () => {
    if (!rootPath) return;
    const paths = collectDirPathsToRefresh(rootPath, expandedRef.current);
    setRefreshing(true);
    try {
      for (const dir of paths) {
        // eslint-disable-next-line no-await-in-loop
        await loadDir(dir, { force: true });
      }
    } finally {
      setRefreshing(false);
    }
  }, [rootPath, loadDir]);

  const flushPendingRefreshes = useCallback(async () => {
    const batch = [...pendingRefreshRef.current];
    pendingRefreshRef.current = new Set();
    for (const dir of batch) {
      // eslint-disable-next-line no-await-in-loop
      await loadDir(dir, { force: true });
    }
  }, [loadDir]);

  const scheduleDirRefresh = useCallback(
    (dirPath: string) => {
      pendingRefreshRef.current = mergePendingRefreshPaths(pendingRefreshRef.current, dirPath);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void flushPendingRefreshes();
      }, WATCH_DEBOUNCE_MS);
    },
    [flushPendingRefreshes],
  );

  const toggleDir = useCallback(
    (absPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(absPath)) {
          next.delete(absPath);
        } else {
          next.add(absPath);
          void loadDir(absPath);
        }
        return next;
      });
    },
    [loadDir],
  );

  const openFile = useCallback(
    (entry: DirEntry) => {
      openWorkbenchFile(entry.absPath, workspacePath ?? undefined);
    },
    [openWorkbenchFile, workspacePath],
  );

  // 工作目录变化：重置缓存并展开根目录。
  useEffect(() => {
    childrenRef.current = new Map();
    setChildren(new Map());
    setLoading(new Set());
    setSelected(null);
    pendingRefreshRef.current = new Set();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (!rootPath) {
      setExpanded(new Set());
      return;
    }
    setExpanded(new Set([rootPath]));
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  // 响应「文件夹 chip 点击」：展开根→目标的整条链路并高亮目标目录。
  useEffect(() => {
    if (!filesTarget || !rootPath) return;
    let cancelled = false;
    const target = stripTrailingSep(filesTarget.absPath);
    const chain = buildChain(rootPath, target);
    if (!chain) {
      // 目标不在当前树根之下（如跨 workspace），无法在本树展开，仅尝试高亮。
      setSelected(target);
      return;
    }
    void (async () => {
      for (const dir of chain) {
        if (cancelled) return;
        // eslint-disable-next-line no-await-in-loop
        await loadDir(dir);
      }
      if (cancelled) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const dir of chain) next.add(dir);
        return next;
      });
      setSelected(target);
    })();
    return () => {
      cancelled = true;
    };
  }, [filesTarget?.nonce, rootPath, loadDir]);

  // 轻量 watch：只监听根 + 已展开目录；事件 debounce 后只重读受影响目录。
  useEffect(() => {
    if (!rootPath) {
      void clientApi.watchDirs?.([], workspacePath ?? undefined).catch(() => {});
      return;
    }
    const paths = collectWatchDirPaths(rootPath, expanded);
    void clientApi.watchDirs?.(paths, workspacePath ?? undefined).catch(() => {});
  }, [rootPath, expanded, workspacePath]);

  useEffect(() => {
    if (typeof clientApi.onFsDirChanged !== 'function') return undefined;
    const unsubscribe = clientApi.onFsDirChanged((payload) => {
      const dir = typeof payload?.dirPath === 'string' ? payload.dirPath : '';
      if (!dir) return;
      // 只响应当前树关心的目录（根或已展开）
      const watched = new Set(
        collectWatchDirPaths(rootPath, expandedRef.current).map((p) =>
          toForward(stripTrailingSep(p)),
        ),
      );
      if (!watched.has(toForward(stripTrailingSep(dir)))) return;
      scheduleDirRefresh(dir);
    });
    return () => {
      unsubscribe?.();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [rootPath, scheduleDirRefresh]);

  // 卸载时清空 main 侧 watchers
  useEffect(() => {
    return () => {
      void clientApi.watchDirs?.([], workspacePath ?? undefined).catch(() => {});
    };
  }, [workspacePath]);

  if (!rootPath) {
    return (
      <div className="workbench-empty">
        <div className="workbench-empty-title">{isZh ? '文件' : 'Files'}</div>
        <p className="workbench-empty-hint">
          {isZh
            ? '当前会话没有工作目录，无法展示文件树。'
            : 'No working directory for this session yet.'}
        </p>
      </div>
    );
  }

  const rootEntry: DirEntry = {
    name: baseName(rootPath) || rootPath,
    isDir: true,
    absPath: rootPath,
  };

  return (
    <div className="workbench-files">
      <div className="workbench-tree" role="tree" aria-label={isZh ? '文件树' : 'File tree'}>
        <TreeNode
          entry={rootEntry}
          depth={0}
          expanded={expanded}
          children={children}
          loading={loading}
          selected={selected}
          isZh={isZh}
          onToggleDir={toggleDir}
          onOpenFile={openFile}
          rootAction={(
            <button
              type="button"
              className="workbench-tree-action"
              onClick={(event) => {
                event.stopPropagation();
                void refreshAllExpanded();
              }}
              disabled={refreshing}
              aria-label={isZh ? '刷新文件树' : 'Refresh file tree'}
              title={isZh ? '刷新文件树' : 'Refresh file tree'}
            >
              <RefreshIcon />
            </button>
          )}
        />
      </div>
    </div>
  );
}
