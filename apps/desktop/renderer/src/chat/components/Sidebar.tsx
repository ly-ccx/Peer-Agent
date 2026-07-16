import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { BrandWordmark } from '../../app/components/BrandWordmark';
import { VersionBadge } from '../../app/components/VersionBadge';
import { SidebarResizer } from '../../workbench/SidebarResizer';
import {
  compactionProgressPercent,
  sidebarCompactionStateLabel,
  sidebarConversationActivity,
} from '../state/compactionStateView';
import type { CompactionState } from '../state/types';
import { useAwaitingGoalPlanCounts } from './goal/useAwaitingGoalPlans';

type ConversationView = 'active' | 'archived';

interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  status?: ConversationView;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
}

interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt: string;
}

interface WorkspaceInfo {
  name: string;
  absolutePath: string;
  git?: { branch?: string; isDirty?: boolean };
}

// 将 ISO 时间戳格式化为简洁的相对时间（跟随设计稿风格：纯「X 单位」，不带「前」字）。
// 粒度：刚刚 / X 分钟 / X 小时 / X 天 / X 周 / X 个月 / X 年。
// 兜底：空值 / 非法日期 / 未来时间均返回「刚刚」(Now)，避免出现负数或 NaN。
function formatRelativeTime(iso: string | null | undefined, isZh: boolean): string {
  if (!iso) return isZh ? '刚刚' : 'Now';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return isZh ? '刚刚' : 'Now';
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return isZh ? '刚刚' : 'Now';
  const min = Math.floor(sec / 60);
  if (min < 60) return isZh ? `${min} 分钟` : `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return isZh ? `${hour} 小时` : `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day < 7) return isZh ? `${day} 天` : `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 5) return isZh ? `${week} 周` : `${week}w`;
  const month = Math.floor(day / 30);
  if (month < 12) return isZh ? `${month} 个月` : `${month}mo`;
  const year = Math.floor(day / 365);
  return isZh ? `${year} 年` : `${year}y`;
}

function PinIcon({ size = 13, filled = false }: { readonly size?: number; readonly filled?: boolean }) {
  if (filled) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 3a1 1 0 0 0-.99 1.14L7.8 9.7l-2.5 2.5A1 1 0 0 0 5 12.9V15a1 1 0 0 0 1 1h5v6a1 1 0 1 0 2 0v-6h5a1 1 0 0 0 1-1v-2.1a1 1 0 0 0-.3-.7l-2.5-2.5 1.79-5.56A1 1 0 0 0 17 3H8Z" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M8 3h8" />
      <path d="m9 3 1 7-3 3v2h10v-2l-3-3 1-7" />
    </svg>
  );
}

export function Sidebar({
  conversations,
  activeConversationId,
  conversationView,
  runningConversationIds,
  compactionStates,
  runningWorkspacePaths,
  activePage,
  i18n,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  onPinConversation,
  onUnpinConversation,
  onReorderPinnedConversations,
  onShowActiveConversations,
  onOpenSettings,
  onWorkspaceChanged,
  pendingConfirmationCounts,
}: {
  readonly conversations: readonly ConversationMeta[];
  readonly activeConversationId: string | null;
  readonly conversationView: ConversationView;
  // 当前正在流式运行的会话 id 集合(表达层状态,真值来自 main 的 activeStreams 广播)。
  readonly runningConversationIds?: ReadonlySet<string>;
  // 当前正在执行上下文压缩的会话 -> 显式压缩状态机。
  readonly compactionStates?: ReadonlyMap<string, CompactionState>;
  // 本地敏感操作确认数量；计划审批数量由 useAwaitingGoalPlanCounts 从同一后端事实投影。
  readonly pendingConfirmationCounts?: ReadonlyMap<string, number>;
  // ADR 27: 有运行中流的工作区路径集合,用于在工作区入口/下拉项上提示"该工作区有任务在跑"。
  readonly runningWorkspacePaths?: ReadonlySet<string>;
  readonly activePage: string;
  readonly i18n: I18nRuntime;
  readonly onNewChat: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onDeleteConversation: (id: string) => void;
  readonly onRenameConversation: (id: string, title: string) => void | Promise<void>;
  readonly onArchiveConversation: (id: string) => void | Promise<void>;
  readonly onRestoreConversation: (id: string) => void | Promise<void>;
  readonly onPinConversation: (id: string) => void | Promise<void>;
  readonly onUnpinConversation: (id: string) => void | Promise<void>;
  readonly onReorderPinnedConversations: (ids: readonly string[]) => void | Promise<void>;
  readonly onShowActiveConversations: () => void | Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onWorkspaceChanged?: () => Promise<void> | void;
}) {
  const isZh = i18n.locale === 'zh-CN';
  const isArchivedView = conversationView === 'archived';
  const awaitingGoalPlanCounts = useAwaitingGoalPlanCounts(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; conversation: ConversationMeta } | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const isFinishingRenameRef = useRef(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  // 退场动画态:关闭时先置 closing 播退场动画,动画结束(onAnimationEnd)再真正卸载下拉。
  const [wsClosing, setWsClosing] = useState(false);
  const wsWrapRef = useRef<HTMLDivElement>(null);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [draggingPinnedId, setDraggingPinnedId] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const result = await clientApi.workspaceList();
      setWorkspaces(result.workspaces);
      setActiveWorkspace(result.activeWorkspace);
      if (result.activeWorkspace) {
        const info = await clientApi.workspaceInfo({ path: result.activeWorkspace });
        setWsInfo(info);
      } else {
        setWsInfo(null);
      }
    } catch {}
  }, []);

  useEffect(() => { void refreshWorkspaces(); }, [refreshWorkspaces]);

  // 请求关闭下拉:置 closing 播退场动画,真正卸载交给 onAnimationEnd。
  const requestCloseDropdown = useCallback(() => {
    setWsDropdownOpen((open) => {
      if (open) setWsClosing(true);
      return open;
    });
  }, []);

  // 点击头部:已展开则走退场关闭,未展开则直接打开。
  const toggleDropdown = useCallback(() => {
    if (wsDropdownOpen) {
      if (!wsClosing) setWsClosing(true);
    } else {
      setWsClosing(false);
      setWsDropdownOpen(true);
    }
  }, [wsDropdownOpen, wsClosing]);

  // 点击下拉外部时关闭(走退场)。
  useEffect(() => {
    if (!wsDropdownOpen || wsClosing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wsWrapRef.current?.contains(e.target as Node)) requestCloseDropdown();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [wsDropdownOpen, wsClosing, requestCloseDropdown]);

  const handleAddWorkspace = useCallback(async () => {
    requestCloseDropdown();
    const result = await clientApi.workspaceAdd();
    if (result) { await refreshWorkspaces(); onWorkspaceChanged?.(); }
  }, [requestCloseDropdown, refreshWorkspaces, onWorkspaceChanged]);

  const handleSwitchWorkspace = useCallback(async (wsPath: string) => {
    // ADR 27: 去阻塞切换。先乐观回填当前工作区名称(用已知的 workspaces 条目),
    // 避免等待 git(workspaceInfo)阻塞 UI;git 分支等信息由后续 refresh 异步补齐。
    requestCloseDropdown();
    const known = workspaces.find((w) => w.path === wsPath);
    setActiveWorkspace(wsPath);
    setWsInfo(known ? { name: known.name, absolutePath: wsPath } : null);
    await clientApi.workspaceSetActive({ path: wsPath });
    // 会话列表刷新(onWorkspaceChanged)与工作区/ git 详情刷新并行,互不阻塞。
    await Promise.all([
      Promise.resolve(onWorkspaceChanged?.()),
      refreshWorkspaces(),
    ]);
  }, [workspaces, requestCloseDropdown, refreshWorkspaces, onWorkspaceChanged]);

  const handleRemoveWorkspace = useCallback(async (wsPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await clientApi.workspaceRemove({ path: wsPath });
    await refreshWorkspaces();
    onWorkspaceChanged?.();
  }, [refreshWorkspaces, onWorkspaceChanged]);

  useEffect(() => {
    if (!editingConversationId) return;
    editingInputRef.current?.focus();
    editingInputRef.current?.select();
  }, [editingConversationId]);

  const beginRenameConversation = useCallback((conv: ConversationMeta) => {
    if (isArchivedView) return;
    isFinishingRenameRef.current = false;
    setConfirmDeleteId(null);
    setContextMenu(null);
    setEditingConversationId(conv.id);
    setEditingTitle(conv.title || (isZh ? '新对话' : 'New Chat'));
  }, [isArchivedView, isZh]);

  const finishRenameConversation = useCallback(() => {
    isFinishingRenameRef.current = true;
    setEditingConversationId(null);
    setEditingTitle('');
  }, []);

  const cancelRenameConversation = useCallback(() => {
    finishRenameConversation();
  }, [finishRenameConversation]);

  const submitRenameConversation = useCallback(async (conv: ConversationMeta) => {
    if (isFinishingRenameRef.current) return;
    const nextTitle = editingTitle.trim();
    finishRenameConversation();
    if (!nextTitle || nextTitle === conv.title) return;
    await onRenameConversation(conv.id, nextTitle);
  }, [editingTitle, finishRenameConversation, onRenameConversation]);

  const pinnedConversations = useMemo(() => conversations
    .filter((conv) => !isArchivedView && conv.pinnedAt)
    .sort((a, b) => Number(a.pinnedOrder ?? 0) - Number(b.pinnedOrder ?? 0)), [conversations, isArchivedView]);
  const normalConversations = useMemo(
    () => isArchivedView ? conversations : conversations.filter((conv) => !conv.pinnedAt),
    [conversations, isArchivedView],
  );
  const pinnedIds = useMemo(() => pinnedConversations.map((conv) => conv.id), [pinnedConversations]);

  const movePinnedConversation = useCallback((dragId: string, targetId: string) => {
    if (dragId === targetId) return;
    const from = pinnedIds.indexOf(dragId);
    const to = pinnedIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const nextIds = [...pinnedIds];
    const [moved] = nextIds.splice(from, 1);
    nextIds.splice(to, 0, moved);
    void onReorderPinnedConversations(nextIds);
  }, [onReorderPinnedConversations, pinnedIds]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!contextMenuRef.current?.contains(e.target as Node)) closeContextMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [closeContextMenu, contextMenu]);

  const renderConversationRow = (conv: ConversationMeta, options: { pinnedGroup?: boolean } = {}) => {
    const isRunning = Boolean(runningConversationIds?.has(conv.id));
    // 上下文压缩状态(含进度百分比)：压缩优先级高于运行点，避免运行中自动压缩时左侧列表不显示。
    const compactionState = compactionStates?.get(conv.id);
    const activity = sidebarConversationActivity({ isRunning, compactionState });
    const isCompactionVisible = activity.kind === 'compaction';
    const compactPercent = compactionProgressPercent(compactionState);
    const compactLabel = sidebarCompactionStateLabel(compactionState, isZh);
    const compactPercentText = typeof compactPercent === 'number' ? `${Math.round(compactPercent)}%` : null;
    const compactTitle = compactPercentText ? `${compactLabel} ${compactPercentText}` : compactLabel;
    const awaitingGoalPlanCount = awaitingGoalPlanCounts.get(conv.id) ?? 0;
    const pendingSensitiveCount = pendingConfirmationCounts?.get(conv.id) ?? 0;
    const pendingApprovalCount = awaitingGoalPlanCount + pendingSensitiveCount;
    const pendingApprovalLabel = isZh ? '待审批' : 'Pending approval';
    const pendingApprovalText = pendingApprovalCount > 1
      ? `${pendingApprovalLabel} · ${pendingApprovalCount}`
      : pendingApprovalLabel;
    const isPinned = Boolean(conv.pinnedAt);
    const canTogglePin = !isArchivedView;
    const rowClasses = [
      'conversation-row',
      activeConversationId === conv.id ? 'active' : '',
      isRunning ? 'is-running' : '',
      isCompactionVisible ? 'is-compacting' : '',
      isPinned ? 'is-pinned' : '',
      options.pinnedGroup ? 'is-in-pinned-group' : '',
      draggingPinnedId === conv.id ? 'is-dragging' : '',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={conv.id}
        className={rowClasses}
        draggable={Boolean(options.pinnedGroup && canTogglePin)}
        onDragStart={(e) => {
          if (!options.pinnedGroup || !canTogglePin) return;
          setDraggingPinnedId(conv.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', conv.id);
        }}
        onDragOver={(e) => {
          if (!options.pinnedGroup || !draggingPinnedId || draggingPinnedId === conv.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          if (!options.pinnedGroup) return;
          e.preventDefault();
          const dragId = e.dataTransfer.getData('text/plain') || draggingPinnedId;
          if (dragId) movePinnedConversation(dragId, conv.id);
          setDraggingPinnedId(null);
        }}
        onDragEnd={() => setDraggingPinnedId(null)}
        onClick={() => onSelectConversation(conv.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, conversation: conv });
        }}
        onMouseEnter={() => setHoveredId(conv.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        {canTogglePin ? (
          <button
            type="button"
            className={`sidebar-conv-pin sidebar-conv-pin-leading ${isPinned ? 'active' : ''}`}
            title={isPinned ? (isZh ? '取消置顶' : 'Unpin chat') : (isZh ? '置顶会话' : 'Pin chat')}
            aria-label={isPinned ? (isZh ? '取消置顶' : 'Unpin chat') : (isZh ? '置顶会话' : 'Pin chat')}
            onClick={(e) => {
              e.stopPropagation();
              void (isPinned ? onUnpinConversation(conv.id) : onPinConversation(conv.id));
            }}
          >
            <PinIcon filled={isPinned} />
          </button>
        ) : null}
        {activity.kind === 'running' ? (
          <span
            className="sidebar-conv-spinner"
            role="img"
            aria-label={isZh ? '运行中' : 'Running'}
            title={isZh ? '运行中' : 'Running'}
          />
        ) : null}
        {isCompactionVisible ? (
          <span className="sidebar-conv-compacting" title={compactTitle}>
            <span
              className="sidebar-conv-compacting-dot"
              role="img"
              aria-label={compactTitle}
            />
            {compactPercentText ? (
              <span className="sidebar-conv-compacting-pct">{compactPercentText}</span>
            ) : null}
          </span>
        ) : null}
        {pendingApprovalCount > 0 ? (
          <span className="sidebar-conv-awaiting" title={pendingApprovalText}>
            {pendingApprovalText}
          </span>
        ) : null}
        {editingConversationId === conv.id ? (
          <input
            ref={editingInputRef}
            className="sidebar-conv-title-input"
            value={editingTitle}
            maxLength={80}
            aria-label={isZh ? '编辑对话标题' : 'Edit conversation title'}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={() => { void submitRenameConversation(conv); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitRenameConversation(conv);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRenameConversation();
              }
            }}
          />
        ) : (
          <span
            className="sidebar-conv-title"
            title={isArchivedView ? undefined : (isZh ? '双击编辑标题' : 'Double-click to edit title')}
            onDoubleClick={(e) => { e.stopPropagation(); beginRenameConversation(conv); }}
          >
            {conv.title || (isZh ? '新对话' : 'New Chat')}
          </span>
        )}
        {confirmDeleteId === conv.id ? (
          <span className="sidebar-conv-confirm" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="confirm-yes" onClick={() => { setConfirmDeleteId(null); onDeleteConversation(conv.id); }}>
              {isZh ? '删除' : 'Del'}
            </button>
            <button type="button" className="confirm-no" onClick={() => setConfirmDeleteId(null)}>
              {isZh ? '取消' : 'No'}
            </button>
          </span>
        ) : hoveredId === conv.id ? (
          <span className="sidebar-conv-actions" onClick={(e) => e.stopPropagation()}>
            {isArchivedView ? (
              <button
                type="button"
                className="sidebar-conv-restore"
                title={isZh ? '恢复会话' : 'Restore chat'}
                aria-label={isZh ? '恢复会话' : 'Restore chat'}
                onClick={() => { void onRestoreConversation(conv.id); }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v6h6" />
                </svg>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="sidebar-conv-edit"
                  title={isZh ? '编辑标题' : 'Edit title'}
                  aria-label={isZh ? '编辑标题' : 'Edit title'}
                  onClick={() => beginRenameConversation(conv)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="sidebar-conv-archive"
                  title={isRunning ? (isZh ? '运行中不可归档' : 'Cannot archive while running') : isCompactionVisible ? (isZh ? '压缩中不可归档' : 'Cannot archive while compacting') : (isZh ? '归档会话' : 'Archive chat')}
                  aria-label={isZh ? '归档会话' : 'Archive chat'}
                  disabled={isRunning || isCompactionVisible}
                  onClick={() => { if (!isRunning && !isCompactionVisible) void onArchiveConversation(conv.id); }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="4" rx="1" />
                    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                    <path d="M10 12h4" />
                  </svg>
                </button>
              </>
            )}
            <button
              type="button"
              className="sidebar-conv-delete"
              aria-label={isZh ? '删除对话' : 'Delete conversation'}
              onClick={() => setConfirmDeleteId(conv.id)}
            >
              ×
            </button>
          </span>
        ) : (
          <time
            className="sidebar-conv-time"
            dateTime={conv.updatedAt}
            title={conv.updatedAt ? new Date(conv.updatedAt).toLocaleString() : undefined}
          >
            {formatRelativeTime(conv.updatedAt, isZh)}
          </time>
        )}
      </div>
    );
  };

  const contextConv = contextMenu?.conversation ?? null;
  const contextIsPinned = Boolean(contextConv?.pinnedAt);
  const contextIsRunning = Boolean(contextConv && runningConversationIds?.has(contextConv.id));
  const contextCompactionState = contextConv ? compactionStates?.get(contextConv.id) : undefined;
  const contextIsCompacting = Boolean(contextCompactionState && contextCompactionState.phase !== 'idle');
  const contextCanTogglePin = Boolean(contextConv && !isArchivedView && !contextIsRunning && !contextIsCompacting);

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true">
          <img className="sidebar-brand-icon light" src="./logo-light.png" alt="" />
          <img className="sidebar-brand-icon dark" src="./logo-dark.png" alt="" />
        </span>
        <span className="sidebar-brand-copy">
          <BrandWordmark />
        </span>
      </div>

      <div className="sidebar-workspace-wrap" ref={wsWrapRef}>
        <div className="sidebar-workspace" onClick={toggleDropdown}>
          {/* ADR 27: 折叠态下,若有"非当前工作区"存在运行中的流,显示一个运行点,
              提示用户切走的工作区任务仍在跑——展开下拉可定位到具体工作区。 */}
          {[...(runningWorkspacePaths ?? [])].some((p) => p !== activeWorkspace) ? (
            <span
              className="ws-running-dot ws-running-dot-other"
              aria-label={isZh ? '其它工作区有任务运行中' : 'Tasks running in another workspace'}
              title={isZh ? '其它工作区有任务正在运行' : 'Another workspace has running tasks'}
            />
          ) : null}
          {wsInfo ? (
            <>
              <span className="ws-name">{wsInfo.name}</span>
              {wsInfo.git?.branch ? <span className="ws-branch">{wsInfo.git.branch}</span> : null}
            </>
          ) : (
            <span className="ws-name ws-placeholder">{isZh ? '选择工作区...' : 'Select workspace...'}</span>
          )}
          <svg className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={wsDropdownOpen && !wsClosing ? { transform: 'rotate(180deg)' } : undefined}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>

        {wsDropdownOpen ? (
          <div
            className={`ws-dropdown${wsClosing ? ' closing' : ''}`}
            onAnimationEnd={(e) => {
              // 退场动画结束后才真正卸载下拉,避免关闭瞬间无过渡。
              if (wsClosing && e.target === e.currentTarget) {
                setWsDropdownOpen(false);
                setWsClosing(false);
              }
            }}
          >
            {workspaces.map((ws) => (
              <div
                key={ws.path}
                className={`ws-dropdown-item ${ws.path === activeWorkspace ? 'active' : ''}`}
                onClick={() => handleSwitchWorkspace(ws.path)}
              >
                {/* ADR 27: 该工作区有运行中的流时显示运行点,提示任务仍在跑(未丢失)。 */}
                {runningWorkspacePaths?.has(ws.path) ? (
                  <span
                    className="ws-running-dot"
                    aria-label={isZh ? '有任务运行中' : 'Tasks running'}
                    title={isZh ? '该工作区有任务正在运行' : 'This workspace has running tasks'}
                  />
                ) : null}
                <span className="ws-dropdown-name">{ws.name}</span>
                <button type="button" className="ws-dropdown-remove" onClick={(e) => handleRemoveWorkspace(ws.path, e)}>×</button>
              </div>
            ))}
            <div className="ws-dropdown-item ws-dropdown-add" onClick={handleAddWorkspace}>
              + {isZh ? '添加工作区' : 'Add Workspace'}
            </div>
          </div>
        ) : null}
      </div>

      <div className="sidebar-top">
        {isArchivedView ? (
          <button type="button" className="sidebar-new-chat sidebar-return-chat" onClick={() => { void onShowActiveConversations(); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 19-7-7 7-7" />
              <path d="M19 12H5" />
            </svg>
            <span>{isZh ? '返回会话' : 'Back to Chats'}</span>
          </button>
        ) : (
          <button type="button" className="sidebar-new-chat" onClick={onNewChat}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            <span>{isZh ? '新建任务' : 'New Task'}</span>
          </button>
        )}
      </div>

      <div className={`channel-conversation-list ${isArchivedView ? 'is-archive-view' : ''}`}>
        {conversations.length === 0 ? (
          <div className="sidebar-empty-state">
            {isArchivedView
              ? (isZh ? '暂无已归档会话' : 'No archived chats')
              : (isZh ? '暂无会话' : 'No chats yet')}
          </div>
        ) : null}
        {!isArchivedView && pinnedConversations.length > 0 ? (
          <section className="sidebar-pinned-section" aria-label={isZh ? '置顶会话' : 'Pinned chats'}>
            <button
              type="button"
              className="sidebar-section-heading"
              aria-expanded={!pinnedCollapsed}
              onClick={() => setPinnedCollapsed((collapsed) => !collapsed)}
            >
              <svg
                className={`sidebar-section-chevron ${pinnedCollapsed ? 'is-collapsed' : ''}`}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span>{isZh ? '置顶' : 'Pinned'}</span>
              <span className="sidebar-section-count">{pinnedConversations.length}</span>
            </button>
            {!pinnedCollapsed ? pinnedConversations.map((conv) => renderConversationRow(conv, { pinnedGroup: true })) : null}
          </section>
        ) : null}
        {normalConversations.map((conv) => renderConversationRow(conv))}
      </div>

      {contextMenu && contextConv ? (
        <div
          ref={contextMenuRef}
          className="sidebar-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {!isArchivedView ? (
            <button
              type="button"
              role="menuitem"
              disabled={!contextCanTogglePin}
              onClick={() => {
                closeContextMenu();
                if (!contextCanTogglePin) return;
                void (contextIsPinned ? onUnpinConversation(contextConv.id) : onPinConversation(contextConv.id));
              }}
            >
              <PinIcon filled={contextIsPinned} />
              <span>{contextIsPinned ? (isZh ? '取消置顶' : 'Unpin chat') : (isZh ? '置顶会话' : 'Pin chat')}</span>
            </button>
          ) : null}
          {!isArchivedView ? (
            <button type="button" role="menuitem" onClick={() => { closeContextMenu(); beginRenameConversation(contextConv); }}>
              <span>{isZh ? '编辑标题' : 'Edit title'}</span>
            </button>
          ) : null}
          {isArchivedView ? (
            <button type="button" role="menuitem" onClick={() => { closeContextMenu(); void onRestoreConversation(contextConv.id); }}>
              <span>{isZh ? '恢复会话' : 'Restore chat'}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={contextIsRunning || contextIsCompacting}
              onClick={() => {
                closeContextMenu();
                if (!contextIsRunning && !contextIsCompacting) void onArchiveConversation(contextConv.id);
              }}
            >
              <span>{isZh ? '归档会话' : 'Archive chat'}</span>
            </button>
          )}
          <button type="button" role="menuitem" className="danger" onClick={() => { closeContextMenu(); setConfirmDeleteId(contextConv.id); }}>
            <span>{isZh ? '删除会话' : 'Delete chat'}</span>
          </button>
        </div>
      ) : null}

      <div className="sidebar-bottom">
        <button type="button" className={`sidebar-nav-btn ${activePage === 'settings' ? 'active' : ''}`} onClick={onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>{isZh ? '设置' : 'Settings'}</span>
        </button>
        <VersionBadge i18n={i18n} />
      </div>
      <SidebarResizer isZh={isZh} />
    </aside>
  );
}
