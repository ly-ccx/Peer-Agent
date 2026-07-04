import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useWorkbench } from '../WorkbenchContext';

interface FilesViewProps {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly absPath: string;
}

/** 去掉路径末尾的分隔符。 */
function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
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
}: TreeNodeProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const key = toForward(stripTrailingSep(entry.absPath));
  const isSelected = selected != null && toForward(stripTrailingSep(selected)) === key;
  const isOpen = entry.isDir && expanded.has(entry.absPath);
  const isLoading = entry.isDir && loading.has(entry.absPath);
  const kids = children.get(entry.absPath);

  // 被定位选中的目录滚动到可视区。
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
        <span className="workbench-tree-name">{entry.name}</span>
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
          ) : (
            (kids ?? []).map((child) => (
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
          )}
        </div>
      ) : null}
    </div>
  );
}

export function FilesView({ isZh, workspacePath }: FilesViewProps) {
  const { filesTarget, openFile: openWorkbenchFile } = useWorkbench();
  const rootPath = workspacePath ? stripTrailingSep(workspacePath) : null;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<ReadonlyMap<string, readonly DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // 子节点缓存的 ref 镜像：reveal 串行展开链路时读取最新缓存，避免闭包过期。
  const childrenRef = useRef<Map<string, readonly DirEntry[]>>(new Map());

  // 列目录并写入缓存；已缓存则直接返回。
  const loadDir = useCallback(
    async (absPath: string): Promise<readonly DirEntry[]> => {
      const cached = childrenRef.current.get(absPath);
      if (cached) return cached;
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
      childrenRef.current.set(absPath, entries);
      setChildren(new Map(childrenRef.current));
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(absPath);
        return next;
      });
      return entries;
    },
    [workspacePath],
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
      />
    </div>
  );
}
