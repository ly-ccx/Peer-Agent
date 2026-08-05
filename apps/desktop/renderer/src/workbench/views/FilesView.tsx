import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { filterVisibleEntries, sanitizeNewEntryName } from './filesTreeFilter';

interface FilesViewProps {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly absPath: string;
}

type DraftKind = 'file' | 'dir';

interface CreateDraft {
  readonly parentPath: string;
  readonly kind: DraftKind;
  readonly value: string;
  readonly busy: boolean;
  readonly error: string | null;
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

/** 拼接父子路径，兼容 Windows 分隔符。 */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const trimmed = stripTrailingSep(parent);
  return `${trimmed}${sep}${name}`;
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

  return (
    <svg {...ICON_PROPS} className="workbench-tree-icon workbench-tree-file-icon" data-kind={kind}>
      {paths}
    </svg>
  );
}

function RefreshIcon() {
  return <svg {...ICON_PROPS} viewBox="0 0 20 20"><path d="M15.8 7.1A6.25 6.25 0 1 0 16 12M15.8 7.1V3.8m0 3.3h-3.3" /></svg>;
}

function NewFileIcon() {
  return (
    <svg {...ICON_PROPS} viewBox="0 0 20 20">
      <path d="M4 2.75h7l4 4v10.5H4z" />
      <path d="M11 2.75v4h4M10 9.2v5.6M7.2 12h5.6" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg {...ICON_PROPS} viewBox="0 0 20 20">
      <path d="M2.75 5.8a1.5 1.5 0 0 1 1.5-1.5h3.4l1.55 1.75h6.55a1.5 1.5 0 0 1 1.5 1.5v6.65a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V5.8Z" />
      <path d="M10 9.2v5.6M7.2 12h5.6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...ICON_PROPS} viewBox="0 0 20 20" className="workbench-files-filter-icon">
      <circle cx="8.5" cy="8.5" r="4.25" />
      <path d="M12.2 12.2 16 16" />
    </svg>
  );
}

/**
 * 从 root 到 target 的目录链路（含两端）。
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
  readonly filterQuery: string;
  readonly isZh: boolean;
  readonly onToggleDir: (absPath: string) => void;
  readonly onOpenFile: (entry: DirEntry) => void;
  readonly onSelect: (entry: DirEntry) => void;
  readonly draft: CreateDraft | null;
  readonly onDraftChange: (value: string) => void;
  readonly onDraftCommit: () => void;
  readonly onDraftCancel: () => void;
}

function TreeNode({
  entry,
  depth,
  expanded,
  children,
  loading,
  selected,
  filterQuery,
  isZh,
  onToggleDir,
  onOpenFile,
  onSelect,
  draft,
  onDraftChange,
  onDraftCommit,
  onDraftCancel,
}: TreeNodeProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isOpen = entry.isDir && expanded.has(entry.absPath);
  const isSelected = selected === entry.absPath;
  const kids = entry.isDir ? children.get(entry.absPath) : undefined;
  const isLoading = entry.isDir && loading.has(entry.absPath);
  const kind = getFileVisualKind(entry.name, entry.isDir);
  const showDraftHere = Boolean(draft && draft.parentPath === entry.absPath && isOpen);
  const visibleKids = useMemo(() => {
    if (!kids) return undefined;
    return filterVisibleEntries(kids, filterQuery, (child) =>
      child.isDir ? children.get(child.absPath) : undefined,
    );
  }, [kids, filterQuery, children]);

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected]);

  return (
    <div className="workbench-tree-node" role="treeitem" aria-expanded={entry.isDir ? isOpen : undefined}>
      <div
        ref={rowRef}
        className={`workbench-tree-row${isSelected ? ' is-selected' : ''}`}
        style={{ ['--tree-depth' as string]: depth }}
        tabIndex={0}
        onClick={() => {
          onSelect(entry);
          if (entry.isDir) onToggleDir(entry.absPath);
          else onOpenFile(entry);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(entry);
            if (entry.isDir) onToggleDir(entry.absPath);
            else onOpenFile(entry);
          }
        }}
      >
        <span className={`workbench-tree-chevron${entry.isDir ? '' : ' is-leaf'}${isOpen ? ' is-open' : ''}`} aria-hidden>
          {entry.isDir ? '›' : ''}
        </span>
        <FileTreeIcon kind={kind} open={isOpen} />
        <span className="workbench-tree-name">{entry.name}</span>
      </div>
      {entry.isDir && isOpen ? (
        <div className="workbench-tree-children" role="group">
          {showDraftHere && draft ? (
            <div className="workbench-tree-draft" style={{ ['--tree-depth' as string]: depth + 1 }}>
              <span className="workbench-tree-chevron is-leaf" aria-hidden />
              <FileTreeIcon kind={draft.kind === 'dir' ? 'folder' : 'file'} />
              <input
                className="workbench-tree-draft-input"
                autoFocus
                disabled={draft.busy}
                value={draft.value}
                placeholder={draft.kind === 'dir' ? (isZh ? '文件夹名' : 'Folder name') : (isZh ? '文件名' : 'File name')}
                aria-label={draft.kind === 'dir' ? (isZh ? '新建文件夹' : 'New folder') : (isZh ? '新建文件' : 'New file')}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onDraftCommit();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onDraftCancel();
                  }
                }}
                onBlur={() => {
                  if (!draft.busy) onDraftCommit();
                }}
              />
              {draft.error ? <span className="workbench-tree-draft-error">{draft.error}</span> : null}
            </div>
          ) : null}
          {isLoading && !kids ? (
            <div className="workbench-tree-hint" style={{ ['--tree-depth' as string]: depth + 1 }}>
              {isZh ? '加载中…' : 'Loading…'}
            </div>
          ) : null}
          {visibleKids?.map((child) => (
            <TreeNode
              key={child.absPath}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              children={children}
              loading={loading}
              selected={selected}
              filterQuery={filterQuery}
              isZh={isZh}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
              draft={draft}
              onDraftChange={onDraftChange}
              onDraftCommit={onDraftCommit}
              onDraftCancel={onDraftCancel}
            />
          ))}
          {!isLoading && kids && visibleKids && visibleKids.length === 0 ? (
            <div className="workbench-tree-hint" style={{ ['--tree-depth' as string]: depth + 1 }}>
              {filterQuery.trim()
                ? (isZh ? '无匹配项' : 'No matches')
                : (isZh ? '空目录' : 'Empty')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FilesView({ isZh, workspacePath }: FilesViewProps) {
  const { openDocument, filesTarget } = useWorkbench();
  const rootPath = workspacePath ? stripTrailingSep(workspacePath) : null;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, readonly DirEntry[]>>(() => new Map());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIsDir, setSelectedIsDir] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [draft, setDraft] = useState<CreateDraft | null>(null);

  // 用 ref 镜像最新树状态，供 watch 回调读取，避免 effect 依赖整棵树。
  const expandedRef = useRef(expanded);
  const childrenRef = useRef(children);
  const loadingRef = useRef(loading);
  const selectedRef = useRef(selected);
  const selectedIsDirRef = useRef(selectedIsDir);
  const draftRef = useRef(draft);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { childrenRef.current = children; }, [children]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { selectedIsDirRef.current = selectedIsDir; }, [selectedIsDir]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  // 目录变更防抖：同目录 120ms 内合并；刷新进行中的目录先挂起，结束后补刷。
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshRef = useRef<Set<string>>(new Set());
  const inFlightRefreshRef = useRef<Set<string>>(new Set());
  const deferredRefreshRef = useRef<Set<string>>(new Set());

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
      try {
        const result = await clientApi.readDir(absPath, workspacePath ?? undefined);
        if (!result.ok) {
          if (options?.force) applyReloadResult(absPath, []);
          else {
            setChildren((prev) => {
              const next = new Map(prev);
              next.set(absPath, []);
              childrenRef.current = next;
              return next;
            });
          }
          return [];
        }
        if (options?.force) {
          applyReloadResult(absPath, result.entries);
        } else {
          setChildren((prev) => {
            const next = new Map(prev);
            next.set(absPath, result.entries);
            childrenRef.current = next;
            return next;
          });
        }
        return result.entries;
      } catch {
        if (options?.force) applyReloadResult(absPath, []);
        else {
          setChildren((prev) => {
            const next = new Map(prev);
            next.set(absPath, []);
            childrenRef.current = next;
            return next;
          });
        }
        return [];
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(absPath);
          return next;
        });
      }
    },
    [workspacePath, applyReloadResult],
  );

  const refreshDirs = useCallback(async (dirPaths: readonly string[]) => {
    const unique = [...new Set(dirPaths.map(stripTrailingSep).filter(Boolean))];
    if (unique.length === 0) return;
    setRefreshing(true);
    try {
      for (const dirPath of unique) {
        inFlightRefreshRef.current.add(dirPath);
        try {
          await loadDir(dirPath, { force: true });
        } finally {
          inFlightRefreshRef.current.delete(dirPath);
        }
      }
      const deferred = [...deferredRefreshRef.current];
      deferredRefreshRef.current.clear();
      if (deferred.length > 0) {
        for (const dirPath of deferred) {
          await loadDir(dirPath, { force: true });
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadDir]);

  const scheduleDirRefresh = useCallback((dirPath: string) => {
    const normalized = stripTrailingSep(dirPath);
    if (!normalized) return;
    if (inFlightRefreshRef.current.has(normalized)) {
      deferredRefreshRef.current.add(normalized);
      return;
    }
    pendingRefreshRef.current = mergePendingRefreshPaths(pendingRefreshRef.current, [normalized]);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const batch = [...pendingRefreshRef.current];
      pendingRefreshRef.current.clear();
      debounceTimerRef.current = null;
      void refreshDirs(batch);
    }, 120);
  }, [refreshDirs]);

  const refreshAllExpanded = useCallback(async () => {
    if (!rootPath) return;
    const dirs = collectDirPathsToRefresh(rootPath, expandedRef.current, childrenRef.current);
    await refreshDirs(dirs);
  }, [rootPath, refreshDirs]);

  const toggleDir = useCallback(
    (absPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(absPath)) next.delete(absPath);
        else {
          next.add(absPath);
          void loadDir(absPath);
        }
        return next;
      });
      setSelected(absPath);
      setSelectedIsDir(true);
    },
    [loadDir],
  );

  const selectEntry = useCallback((entry: DirEntry) => {
    setSelected(entry.absPath);
    setSelectedIsDir(entry.isDir);
  }, []);

  const openFile = useCallback(
    (entry: DirEntry) => {
      setSelected(entry.absPath);
      setSelectedIsDir(false);
      openDocument({
        absPath: entry.absPath,
        relPath: workspacePath
          ? toForward(entry.absPath).replace(`${toForward(stripTrailingSep(workspacePath))}/`, '')
          : entry.name,
        name: entry.name,
      });
    },
    [openDocument, workspacePath],
  );

  const resolveCreateParent = useCallback((): string | null => {
    if (!rootPath) return null;
    const current = selectedRef.current;
    if (!current) return rootPath;
    // 选中文件时，在其父目录创建；选中目录时，在该目录下创建。
    if (current === rootPath || selectedIsDirRef.current) return current;
    const parent = current.replace(/[/\\][^/\\]+$/, '');
    return parent || rootPath;
  }, [rootPath]);

  const beginCreate = useCallback((kind: DraftKind) => {
    if (!rootPath) return;
    const parentPath = resolveCreateParent() ?? rootPath;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(parentPath);
      return next;
    });
    void loadDir(parentPath);
    setSelected(parentPath);
    setSelectedIsDir(true);
    setDraft({
      parentPath,
      kind,
      value: kind === 'dir' ? (isZh ? '新建文件夹' : 'New Folder') : (isZh ? '新建文件' : 'untitled.txt'),
      busy: false,
      error: null,
    });
  }, [rootPath, resolveCreateParent, loadDir, isZh]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
  }, []);

  const changeDraft = useCallback((value: string) => {
    setDraft((prev) => (prev ? { ...prev, value, error: null } : prev));
  }, []);

  const commitDraft = useCallback(async () => {
    const current = draftRef.current;
    if (!current || current.busy) return;
    const name = sanitizeNewEntryName(current.value);
    if (!name) {
      setDraft((prev) => (prev ? {
        ...prev,
        error: isZh ? '名称无效' : 'Invalid name',
      } : prev));
      return;
    }
    const absPath = joinPath(current.parentPath, name);
    const relPath = workspacePath
      ? toForward(absPath).replace(`${toForward(stripTrailingSep(workspacePath))}/`, '')
      : name;
    setDraft((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      const result = current.kind === 'dir'
        ? await clientApi.mkdir(absPath, workspacePath ?? undefined, relPath)
        : await clientApi.writeFile(absPath, workspacePath ?? undefined, relPath, '');
      if (!result.ok) {
        const message = result.status === 'already_exists'
          ? (isZh ? '已存在同名项' : 'Already exists')
          : (result.error || (isZh ? '创建失败' : 'Create failed'));
        setDraft((prev) => (prev ? { ...prev, busy: false, error: message } : prev));
        return;
      }
      setDraft(null);
      await loadDir(current.parentPath, { force: true });
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(current.parentPath);
        if (current.kind === 'dir') next.add(result.path ?? absPath);
        return next;
      });
      setSelected(result.path ?? absPath);
      setSelectedIsDir(current.kind === 'dir');
      if (current.kind === 'file') {
        openDocument({
          absPath: result.path ?? absPath,
          relPath,
          name,
        });
      }
    } catch (error) {
      setDraft((prev) => (prev ? {
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : (isZh ? '创建失败' : 'Create failed'),
      } : prev));
    }
  }, [isZh, workspacePath, loadDir, openDocument]);

  // workspace 切换：重置树，默认展开根并加载第一层。
  useEffect(() => {
    setChildren(new Map());
    childrenRef.current = new Map();
    setLoading(new Set());
    setSelected(null);
    setSelectedIsDir(false);
    setFilterQuery('');
    setDraft(null);
    pendingRefreshRef.current.clear();
    deferredRefreshRef.current.clear();
    inFlightRefreshRef.current.clear();
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
      setSelectedIsDir(true);
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
      setSelectedIsDir(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [filesTarget, rootPath, loadDir]);

  // 同步 watch 集合：根 + 已展开目录；main 侧按 diff 增删 fs.watch。
  useEffect(() => {
    if (!rootPath) {
      void clientApi.watchDirs?.([], workspacePath ?? undefined).catch(() => {});
      return;
    }
    const paths = collectWatchDirPaths(rootPath, expanded, children);
    void clientApi.watchDirs?.(paths, workspacePath ?? undefined).catch(() => {});
  }, [rootPath, workspacePath, expanded, children]);

  // 订阅目录变更事件，防抖后 force 重载。
  useEffect(() => {
    if (!rootPath || !clientApi.onFsDirChanged) return undefined;
    const unsubscribe = clientApi.onFsDirChanged((payload) => {
      const dirPath = typeof payload?.dirPath === 'string' ? payload.dirPath : rootPath;
      scheduleDirRefresh(dirPath || rootPath);
    });
    return () => {
      unsubscribe();
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

  const rootKids = children.get(rootPath);
  const visibleRootKids = rootKids
    ? filterVisibleEntries(rootKids, filterQuery, (child) =>
      child.isDir ? children.get(child.absPath) : undefined)
    : undefined;

  return (
    <div className="workbench-files">
      <div className="workbench-files-toolbar" role="toolbar" aria-label={isZh ? '文件操作' : 'File actions'}>
        <button
          type="button"
          className="workbench-files-toolbar-btn"
          onClick={() => beginCreate('file')}
          aria-label={isZh ? '新建文件' : 'New file'}
          title={isZh ? '新建文件' : 'New file'}
        >
          <NewFileIcon />
        </button>
        <button
          type="button"
          className="workbench-files-toolbar-btn"
          onClick={() => beginCreate('dir')}
          aria-label={isZh ? '新建文件夹' : 'New folder'}
          title={isZh ? '新建文件夹' : 'New folder'}
        >
          <NewFolderIcon />
        </button>
        <button
          type="button"
          className="workbench-files-toolbar-btn"
          onClick={() => { void refreshAllExpanded(); }}
          disabled={refreshing}
          aria-label={isZh ? '刷新' : 'Refresh'}
          title={isZh ? '刷新' : 'Refresh'}
        >
          <RefreshIcon />
        </button>
      </div>
      <label className="workbench-files-filter">
        <SearchIcon />
        <input
          type="search"
          className="workbench-files-filter-input"
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
          placeholder={isZh ? '筛选文件…' : 'Filter files…'}
          aria-label={isZh ? '筛选文件' : 'Filter files'}
        />
      </label>
      <div className="workbench-tree" role="tree" aria-label={isZh ? '文件树' : 'File tree'}>
        {/* 根目录本身不渲染成可折叠行，直接展示工具栏目标下的一层内容，贴近参考图。 */}
        <div className="workbench-tree-children workbench-tree-children--root" role="group">
          {draft && draft.parentPath === rootPath ? (
            <div className="workbench-tree-draft" style={{ ['--tree-depth' as string]: 0 }}>
              <span className="workbench-tree-chevron is-leaf" aria-hidden />
              <FileTreeIcon kind={draft.kind === 'dir' ? 'folder' : 'file'} />
              <input
                className="workbench-tree-draft-input"
                autoFocus
                disabled={draft.busy}
                value={draft.value}
                placeholder={draft.kind === 'dir' ? (isZh ? '文件夹名' : 'Folder name') : (isZh ? '文件名' : 'File name')}
                aria-label={draft.kind === 'dir' ? (isZh ? '新建文件夹' : 'New folder') : (isZh ? '新建文件' : 'New file')}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitDraft();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelDraft();
                  }
                }}
                onBlur={() => {
                  if (!draft.busy) void commitDraft();
                }}
              />
              {draft.error ? <span className="workbench-tree-draft-error">{draft.error}</span> : null}
            </div>
          ) : null}
          {loading.has(rootPath) && !rootKids ? (
            <div className="workbench-tree-hint" style={{ ['--tree-depth' as string]: 0 }}>
              {isZh ? '加载中…' : 'Loading…'}
            </div>
          ) : null}
          {(visibleRootKids ?? []).map((child) => (
            <TreeNode
              key={child.absPath}
              entry={child}
              depth={0}
              expanded={expanded}
              children={children}
              loading={loading}
              selected={selected}
              filterQuery={filterQuery}
              isZh={isZh}
              onToggleDir={toggleDir}
              onOpenFile={openFile}
              onSelect={selectEntry}
              draft={draft}
              onDraftChange={changeDraft}
              onDraftCommit={() => { void commitDraft(); }}
              onDraftCancel={cancelDraft}
            />
          ))}
          {!loading.has(rootPath) && rootKids && visibleRootKids && visibleRootKids.length === 0 ? (
            <div className="workbench-tree-hint" style={{ ['--tree-depth' as string]: 0 }}>
              {filterQuery.trim()
                ? (isZh ? '无匹配项' : 'No matches')
                : (isZh ? '空目录' : 'Empty')}
            </div>
          ) : null}
        </div>
        {/* 保留 rootEntry 引用，避免后续扩展时丢失根路径语义 */}
        <span className="workbench-files-root-meta" hidden data-root={rootEntry.absPath} />
      </div>
    </div>
  );
}
