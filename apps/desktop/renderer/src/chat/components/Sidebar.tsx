import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clientApi } from '../../clientApi';
import type { DesktopStartupSnapshot } from '../../app/state/useDesktopBootstrap';
import { BrandWordmark } from '../../app/components/BrandWordmark';
import { EditProjectDialog, type ProjectWorkspace } from './EditProjectDialog';
import { abbreviateWorkspacePath } from './workspacePathDisplay';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { VersionBadge } from '../../app/components/VersionBadge';
import { SidebarResizer } from '../../workbench/SidebarResizer';
import {
  compactionProgressPercent,
  sidebarCompactionStateLabel,
  sidebarConversationActivity,
} from '../state/compactionStateView';
import { shouldShowCompletedUnreadDot } from '../state/completedUnreadState';
import { hasRunningWorkspaces, isWorkspaceRunning } from '../state/runningWorkspaceState';
import type { CompactionState } from '../state/types';
import { useListFlip } from '../hooks/useListFlip';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { countWorkbenchInbox } from '../state/workbenchInboxCounts';
import { groupTasksByWorkspace } from '../state/groupTasksByWorkspace';
import {
  isWorkspaceTaskTreeOpen,
  nextWorkspaceTreeToggles,
  openWorkspaceTreeToggles,
  UNASSIGNED_WORKSPACE_KEY,
} from '../state/workspaceTaskTree';
import { useAwaitingGoalPlanCounts } from './goal/useAwaitingGoalPlans';
import { sidebarActiveState, type SidebarPage } from './sidebarActiveState';

type ConversationView = 'active' | 'archived';

interface ConversationMeta {
  id: string;
  title: string;
  workspacePath?: string | null;
  messageCount: number;
  updatedAt: string;
  status?: ConversationView;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  /** Durable automation Fresh Run origin; rename-safe badge signal. */
  automationOrigin?: {
    kind: 'automation_run';
    automationId: string;
    runId: string;
    automationName?: string;
    triggerSource?: string;
    createdAt?: string;
  } | null;
}

interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt: string;
  linkedFolders?: readonly { path: string; name: string }[];
}

interface WorkspaceInfo {
  name: string;
  absolutePath: string;
  git?: { branch?: string; isDirty?: boolean };
}

function sortWorkspaceTasks<T extends { pinnedAt?: string | null; pinnedOrder?: number | null }>(
  items: readonly T[],
  archived: boolean,
): readonly T[] {
  if (archived || items.length === 0) return items;
  const pinned = items
    .filter((item) => item.pinnedAt)
    .sort((a, b) => Number(a.pinnedOrder ?? 0) - Number(b.pinnedOrder ?? 0));
  const normal = items.filter((item) => !item.pinnedAt);
  return [...pinned, ...normal];
}

/** 工作区名称缩写：peer_agent -> PA, peer-knowledge -> PK */
function workspaceInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] || '';
    const b = parts[1][0] || '';
    return `${a}${b}`.toUpperCase() || 'WS';
  }
  const alnum = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  if (!alnum) return 'WS';
  if (/[\u4e00-\u9fff]/.test(alnum)) return alnum.slice(0, 2);
  return alnum.slice(0, 2).toUpperCase();
}

/** 按视口边界夹紧右键菜单坐标，避免贴边时被裁切。 */
function clampContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  padding = 8,
): { x: number; y: number } {
  const maxX = Math.max(padding, window.innerWidth - menuWidth - padding);
  const maxY = Math.max(padding, window.innerHeight - menuHeight - padding);
  return {
    x: Math.min(Math.max(padding, x), maxX),
    y: Math.min(Math.max(padding, y), maxY),
  };
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
  completedUnreadConversationIds,
  compactionStates,
  runningWorkspacePaths,
  activePage,
  i18n,
  onNewChat,
  newTaskShortcutLabel,
  onOpenSearch,
  onSelectConversation,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  onDeleteConversation,
  onPinConversation,
  onUnpinConversation,
  onReorderPinnedConversations,
  onShowActiveConversations,
  onOpenAutomations,
  onOpenTools,
  onOpenSettings,
  onOpenHome,
  onOpenWorkspaceHome,
  homeScope = 'all',
  onWorkspaceChanged,
  pendingConfirmationCounts,
  startupSnapshot,
}: {
  readonly conversations: readonly ConversationMeta[];
  readonly activeConversationId: string | null;
  readonly conversationView: ConversationView;
  // 当前正在流式运行的会话 id 集合(表达层状态,真值来自 main 的 activeStreams 广播)。
  readonly runningConversationIds?: ReadonlySet<string>;
  // 任务完成后尚未打开查看的会话 id 集合(表达层状态,会话内内存态)。
  readonly completedUnreadConversationIds?: ReadonlySet<string>;
  // 当前正在执行上下文压缩的会话 -> 显式压缩状态机。
  readonly compactionStates?: ReadonlyMap<string, CompactionState>;
  // 本地敏感操作确认数量；计划审批数量由 useAwaitingGoalPlanCounts 从同一后端事实投影。
  readonly pendingConfirmationCounts?: ReadonlyMap<string, number>;
  // ADR 27: 有运行中流的工作区路径集合,用于在工作区入口/下拉项上提示"该工作区有任务在跑"。
  readonly runningWorkspacePaths?: ReadonlySet<string>;
  readonly activePage: SidebarPage;
  readonly i18n: I18nRuntime;
  readonly onNewChat: () => void;
  readonly newTaskShortcutLabel?: string;
  readonly onOpenSearch?: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onRenameConversation: (id: string, title: string) => void | Promise<void>;
  readonly onArchiveConversation: (id: string) => void | Promise<void>;
  readonly onRestoreConversation: (id: string) => void | Promise<void>;
  readonly onDeleteConversation: (id: string) => void | Promise<void>;
  readonly onPinConversation: (id: string) => void | Promise<void>;
  readonly onUnpinConversation: (id: string) => void | Promise<void>;
  readonly onReorderPinnedConversations: (ids: readonly string[]) => void | Promise<void>;
  readonly onShowActiveConversations: () => void | Promise<void>;
  readonly onOpenAutomations: () => void;
  readonly onOpenTools: () => void;
  readonly onOpenSettings: () => void;
  /** 顶部「工作台」：跨工作区全部行动权。 */
  readonly onOpenHome: () => void;
  /** 下方工作区入口：只激活该区（新任务落点），不跳走。 */
  readonly onOpenWorkspaceHome?: (workspacePath: string) => void;
  /** 当前工作台数据范围：全局高亮工作台，区级高亮工作区行。 */
  readonly homeScope?: 'all' | 'workspace';
  readonly onWorkspaceChanged?: () => Promise<void> | void;
  readonly startupSnapshot?: DesktopStartupSnapshot | null;
}) {
  const isZh = i18n.locale === 'zh-CN';
  const isArchivedView = conversationView === 'archived';
  const isAnyWorkspaceRunning = hasRunningWorkspaces(runningWorkspacePaths);
  const confirm = useConfirm();
  const awaitingGoalPlanCounts = useAwaitingGoalPlanCounts(true);
  const overviewItems = useTaskOverview({ workspacePath: null, includeTerminal: false });
  const inboxCounts = useMemo(() => countWorkbenchInbox(overviewItems), [overviewItems]);
  
  const [contextMenu, setContextMenu] = useState<
    | { kind: 'conversation'; x: number; y: number; conversation: ConversationMeta }
    | { kind: 'workspace'; x: number; y: number; workspace: WorkspaceEntry }
    | null
  >(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const isFinishingRenameRef = useRef(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>(() => startupSnapshot?.workspaces ?? []);
  const groupedTasks = useMemo(
    () => groupTasksByWorkspace(workspaces, conversations),
    [conversations, workspaces],
  );
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => startupSnapshot?.activeWorkspace ?? null);
  const [, setWsInfo] = useState<WorkspaceInfo | null>(() => startupSnapshot?.workspaceInfo as WorkspaceInfo | null ?? null);
  const [workspaceTreeToggles, setWorkspaceTreeToggles] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [draggingPinnedId, setDraggingPinnedId] = useState<string | null>(null);
  const [projectPopoverPath, setProjectPopoverPath] = useState<string | null>(null);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  const projectPopoverRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    void refreshWorkspaces();
    return clientApi.onWorkspacesChanged(() => {
      void refreshWorkspaces();
    });
  }, [refreshWorkspaces]);

  // 点击工作区时只切到对应 active workspace，作为新任务落点。
  const ensureWorkspaceActive = useCallback(async (wsPath: string) => {
    if (wsPath === activeWorkspace) {
      return;
    }
    // ADR 27: 去阻塞切换。先乐观回填当前工作区名称(用已知的 workspaces 条目),
    // 避免等待 git(workspaceInfo)阻塞 UI;git 分支等信息由后续 refresh 异步补齐。
    const known = workspaces.find((w) => w.path === wsPath);
    setActiveWorkspace(wsPath);
    setWsInfo(known ? { name: known.name, absolutePath: wsPath } : null);
    await clientApi.workspaceSetActive({ path: wsPath });
    // 会话列表刷新(onWorkspaceChanged)与工作区/ git 详情刷新并行,互不阻塞。
    await Promise.all([
      Promise.resolve(onWorkspaceChanged?.()),
      refreshWorkspaces(),
    ]);
  }, [activeWorkspace, workspaces, refreshWorkspaces, onWorkspaceChanged]);

  // 点击工作区：只激活该区，不跳到工作台；并展开该区任务树。
  const handleActivateWorkspace = useCallback(async (wsPath: string) => {
    setWorkspaceTreeToggles((current) => openWorkspaceTreeToggles(current, wsPath));
    onOpenWorkspaceHome?.(wsPath);
    await ensureWorkspaceActive(wsPath);
  }, [ensureWorkspaceActive, onOpenWorkspaceHome]);

  const toggleWorkspaceTree = useCallback((wsPath: string) => {
    setWorkspaceTreeToggles((current) => nextWorkspaceTreeToggles(current, wsPath));
  }, []);

  const handleAddWorkspace = useCallback(async () => {
    const result = await clientApi.workspaceAdd();
    if (result) {
      await refreshWorkspaces();
      if (result.path) {
        await handleActivateWorkspace(result.path);
      }
      onWorkspaceChanged?.();
    }
  }, [refreshWorkspaces, onWorkspaceChanged, handleActivateWorkspace]);

  const handleRemoveWorkspace = useCallback(async (wsPath: string) => {
    const target = workspaces.find((ws) => ws.path === wsPath);
    const name = target?.name?.trim() || wsPath;
    const ok = await confirm({
      title: isZh ? '移除工作区' : 'Remove workspace',
      message: isZh
        ? `确定移除「${name}」？该工作区下的会话记录将一并删除，磁盘上的文件不受影响。`
        : `Remove “${name}”? Conversations under this workspace will also be deleted. Files on disk are not affected.`,
      confirmText: isZh ? '移除' : 'Remove',
      cancelText: isZh ? '取消' : 'Cancel',
      tone: 'danger',
    });
    if (!ok) return;
    await clientApi.workspaceRemove({ path: wsPath });
    await refreshWorkspaces();
    onWorkspaceChanged?.();
  }, [confirm, isZh, workspaces, refreshWorkspaces, onWorkspaceChanged]);

  const handleRevealWorkspace = useCallback(async (wsPath: string) => {
    try {
      await clientApi.openPath(wsPath);
    } catch (error: unknown) {
      console.error('Failed to reveal workspace in Finder', error);
    }
  }, []);

  const openProjectEditor = useCallback((wsPath: string) => {
    setProjectPopoverPath(null);
    setEditingProjectPath(wsPath);
  }, []);

  useEffect(() => {
    if (!projectPopoverPath) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (projectPopoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[data-project-path="${CSS.escape(projectPopoverPath)}"]`)) {
        return;
      }
      setProjectPopoverPath(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [projectPopoverPath]);

  useEffect(() => {
    if (!editingConversationId) return;
    editingInputRef.current?.focus();
    editingInputRef.current?.select();
  }, [editingConversationId]);

  const beginRenameConversation = useCallback((conv: ConversationMeta) => {
    if (isArchivedView) return;
    isFinishingRenameRef.current = false;
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
  const normalIds = useMemo(() => normalConversations.map((conv) => conv.id), [normalConversations]);
  const listOrderKey = useMemo(
    () => `${pinnedCollapsed ? 'pinned-collapsed' : pinnedIds.join(',')}|${normalIds.join(',')}`,
    [normalIds, pinnedCollapsed, pinnedIds],
  );
  const conversationListRef = useRef<HTMLDivElement>(null);
  useListFlip(conversationListRef, listOrderKey, {
    // 置顶拖拽进行中不播 FLIP，避免与原生 drag 抢 transform。
    enabled: draggingPinnedId == null,
  });

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

  // 菜单 portal 到 body 后，按真实尺寸把 left/top 夹进视口，避免顶部/底部被裁切。
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = contextMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampContextMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    if (next.x !== contextMenu.x || next.y !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: next.x, y: next.y } : prev));
    }
  }, [contextMenu]);

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
    const showCompletedUnread = shouldShowCompletedUnreadDot({
      conversationId: conv.id,
      isRunning,
      isCompactionVisible,
      completedUnreadIds: completedUnreadConversationIds,
    });
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
    const isEditing = editingConversationId === conv.id;
    const activeState = sidebarActiveState(activePage, activeConversationId, conv.id);
    const rowClasses = [
      'conversation-row',
      activeState.conversation ? 'active' : '',
      isRunning ? 'is-running' : '',
      isCompactionVisible ? 'is-compacting' : '',
      showCompletedUnread ? 'has-completed-unread' : '',
      isPinned ? 'is-pinned' : '',
      isEditing ? 'is-editing' : '',
      isArchivedView ? 'is-archived' : '',
      options.pinnedGroup ? 'is-in-pinned-group' : '',
      draggingPinnedId === conv.id ? 'is-dragging' : '',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={conv.id}
        data-conversation-id={conv.id}
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
          setContextMenu({ kind: 'conversation', x: e.clientX, y: e.clientY, conversation: conv });
        }}
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
        {showCompletedUnread ? (
          <span
            className="sidebar-conv-completed-unread"
            role="img"
            aria-label={isZh ? '任务已完成，未读' : 'Completed, unread'}
            title={isZh ? '任务已完成，未读' : 'Completed, unread'}
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
          <>
            {conv.automationOrigin?.kind === 'automation_run' ? (
              <span
                className="sidebar-conv-automation-badge"
                title={
                  conv.automationOrigin.automationName
                    ? (isZh
                      ? `自动化：${conv.automationOrigin.automationName}`
                      : `Automation: ${conv.automationOrigin.automationName}`)
                    : (isZh ? '自动化会话' : 'Automation conversation')
                }
              >
                {isZh ? '自动化' : 'Auto'}
              </span>
            ) : null}
            <span
              className="sidebar-conv-title"
              title={isArchivedView ? undefined : (isZh ? '双击编辑标题' : 'Double-click to edit title')}
              onDoubleClick={(e) => { e.stopPropagation(); beginRenameConversation(conv); }}
            >
              {conv.title || (isZh ? '新对话' : 'New Chat')}
            </span>
          </>
        )}
        <span className="sidebar-conv-actions" onClick={(e) => e.stopPropagation()}>
          {isArchivedView ? (
            <>
              <button
                type="button"
                className="sidebar-conv-delete"
                title={isZh ? '永久删除' : 'Delete permanently'}
                aria-label={isZh ? '永久删除' : 'Delete permanently'}
                onClick={() => { void onDeleteConversation(conv.id); }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
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
            </>
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
        </span>
        <time
          className="sidebar-conv-time"
          dateTime={conv.updatedAt}
          title={conv.updatedAt ? new Date(conv.updatedAt).toLocaleString() : undefined}
        >
          {formatRelativeTime(conv.updatedAt, isZh)}
        </time>
      </div>
    );
  };

  const focusedWorkspace = useMemo(() => {
    const current = conversations.find((conversation) => conversation.id === activeConversationId);
    if (!current) return null;
    return current.workspacePath || UNASSIGNED_WORKSPACE_KEY;
  }, [activeConversationId, conversations]);

  const isUnassignedOpen = isWorkspaceTaskTreeOpen({
    path: UNASSIGNED_WORKSPACE_KEY,
    toggled: workspaceTreeToggles,
    activeWorkspace,
    focusedWorkspace,
  });

  const contextConv = contextMenu?.kind === 'conversation' ? contextMenu.conversation : null;
  const contextWorkspace = contextMenu?.kind === 'workspace' ? contextMenu.workspace : null;
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
        {onOpenSearch ? (
          <button
            type="button"
            className="sidebar-search-icon-btn"
            onClick={onOpenSearch}
            title={`${i18n.t('searchChats.open')} (${i18n.t('searchChats.shortcut')})`}
            aria-label={`${i18n.t('searchChats.open')} (${i18n.t('searchChats.shortcut')})`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
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
          <button
            type="button"
            className="sidebar-new-chat"
            onClick={onNewChat}
            title={newTaskShortcutLabel ? `${isZh ? '新建任务' : 'New Task'} (${newTaskShortcutLabel})` : (isZh ? '新建任务' : 'New Task')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            <span>{isZh ? '新建任务' : 'New Task'}</span>
            {newTaskShortcutLabel ? <kbd className="sidebar-new-chat-kbd">{newTaskShortcutLabel}</kbd> : null}
          </button>
        )}
        <button
          type="button"
          className={`sidebar-automation-nav${activePage === 'home' && homeScope === 'all' ? ' active' : ''}`}
          onClick={onOpenHome}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />
          </svg>
          <span>{isZh ? '工作台' : 'Workbench'}</span>
          <span
            className="sidebar-workbench-counts"
            title={isZh ? '需要你处理 · 待验收' : 'Needs you · Ready to accept'}
          >
            {isZh
              ? `需要你 ${inboxCounts.needsYou} · 待验收 ${inboxCounts.resultReady}`
              : `Needs you ${inboxCounts.needsYou} · Ready ${inboxCounts.resultReady}`}
          </span>
          {isAnyWorkspaceRunning ? (
            <span
              className="ws-running-dot"
              role="img"
              aria-label={isZh ? '有任务运行中' : 'Tasks running'}
              title={isZh ? '有任务运行中' : 'Tasks running'}
            />
          ) : null}
        </button>
        <button type="button" className={`sidebar-automation-nav${activePage === 'automations' ? ' active' : ''}`} onClick={onOpenAutomations}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2v3M16 2v3M4 9h16" />
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="m9 14 2 2 4-4" />
          </svg>
          <span>{isZh ? '自动化' : 'Automation tasks'}</span>
        </button>
        <button type="button" className={`sidebar-automation-nav${activePage === 'tools' ? ' active' : ''}`} onClick={onOpenTools}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <span>{isZh ? '插件' : 'Plugins'}</span>
        </button>
      </div>

      <div className="sidebar-workspace-tree">
        <div className="sidebar-workspace-tree-header">
          <span className="sidebar-workspace-tree-label">{isZh ? '工作区' : 'WORKSPACE'}</span>
          <span className="sidebar-workspace-tree-count">{workspaces.length}</span>
        </div>

        <div className="sidebar-workspace-tree-list" ref={conversationListRef}>
          {workspaces.map((ws) => {
            // activeWorkspace 始终是新任务落点；点工作区只激活，不跳走。
            const isActiveWorkspace = activeWorkspace === ws.path;
            const isWorkspaceViewActive =
              activePage === 'home' && homeScope === 'workspace' && isActiveWorkspace;
            const isRunning = runningWorkspacePaths?.has(ws.path);
            const workspaceTasks = sortWorkspaceTasks(groupedTasks.byPath.get(ws.path) ?? [], isArchivedView);
            const isTreeOpen = isWorkspaceTaskTreeOpen({
              path: ws.path,
              toggled: workspaceTreeToggles,
              activeWorkspace,
              focusedWorkspace,
            });
            return (
              <div
                key={ws.path}
                className={[
                  'sidebar-workspace-node',
                  isActiveWorkspace ? 'is-active' : '',
                  isWorkspaceViewActive ? 'is-home' : '',
                  isTreeOpen ? '' : 'is-collapsed',
                ].filter(Boolean).join(' ')}
              >
                <div
                  className="sidebar-workspace-row"
                  data-project-path={ws.path}
                  aria-expanded={workspaceTasks.length > 0 ? isTreeOpen : undefined}
                  onClick={() => { void handleActivateWorkspace(ws.path); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ kind: 'workspace', x: e.clientX, y: e.clientY, workspace: ws });
                  }}
                  role="button"
                  tabIndex={0}
                  title={`${abbreviateWorkspacePath(ws.path)} · ${isZh ? '设为当前工作区' : 'Set as current workspace'}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void handleActivateWorkspace(ws.path);
                    }
                  }}
                >
                  {workspaceTasks.length > 0 ? (
                    <button
                      type="button"
                      className="sidebar-workspace-chevron-btn"
                      aria-expanded={isTreeOpen}
                      aria-label={isTreeOpen
                        ? (isZh ? `折叠 ${ws.name}` : `Collapse ${ws.name}`)
                        : (isZh ? `展开 ${ws.name}` : `Expand ${ws.name}`)}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleWorkspaceTree(ws.path);
                      }}
                    >
                      <svg
                        className={`sidebar-section-chevron${isTreeOpen ? '' : ' is-collapsed'}`}
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
                    </button>
                  ) : (
                    <span className="sidebar-workspace-chevron-btn" aria-hidden="true" />
                  )}
                  <span className="sidebar-workspace-avatar" aria-hidden="true">
                    {workspaceInitials(ws.name)}
                  </span>
                  <span className="sidebar-workspace-meta">
                    <span className="sidebar-workspace-name">{ws.name}</span>
                    <span className="sidebar-workspace-path" title={ws.path}>
                      {abbreviateWorkspacePath(ws.path)}
                    </span>
                  </span>
                  {!isTreeOpen && workspaceTasks.length > 0 ? (
                    <span className="sidebar-workspace-task-count" title={isZh ? `${workspaceTasks.length} 个任务` : `${workspaceTasks.length} tasks`}>
                      {workspaceTasks.length}
                    </span>
                  ) : null}
                  {isRunning ? <span className="ws-running-dot" title={isZh ? '运行中' : 'Running'} /> : null}
                </div>
                {isTreeOpen && workspaceTasks.length > 0 ? (
                  <div className="channel-conversation-list sidebar-workspace-tasks">
                    {workspaceTasks.map((conv) => renderConversationRow(conv, { pinnedGroup: Boolean(conv.pinnedAt) && !isArchivedView }))}
                  </div>
                ) : null}
                {projectPopoverPath === ws.path ? (
                  <div ref={projectPopoverRef} className="sidebar-project-popover" role="dialog" aria-label={isZh ? '项目文件夹' : 'Project folders'}>
                    <div className="sidebar-project-popover-title">{ws.name}</div>
                    <div className="sidebar-project-popover-folders">
                      <div className="sidebar-project-popover-folder">
                        <span className="sidebar-project-popover-path" title={ws.path}>
                          {abbreviateWorkspacePath(ws.path)}
                        </span>
                        <span className="sidebar-project-popover-primary">{isZh ? '主要' : 'Primary'}</span>
                      </div>
                      {(ws.linkedFolders ?? []).map((folder) => (
                        <div key={folder.path} className="sidebar-project-popover-folder">
                          <span className="sidebar-project-popover-path" title={folder.path}>
                            {abbreviateWorkspacePath(folder.path)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="sidebar-project-popover-edit"
                      onClick={() => openProjectEditor(ws.path)}
                    >
                      {isZh ? '编辑项目' : 'Edit project'}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}

          {groupedTasks.unassigned.length > 0 ? (
            <div className={`sidebar-workspace-node${isUnassignedOpen ? '' : ' is-collapsed'}`}>
              <div
                className="sidebar-workspace-row sidebar-workspace-row--static"
                role="button"
                tabIndex={0}
                aria-expanded={isUnassignedOpen}
                title={isZh ? '未归属任务' : 'Unassigned tasks'}
                onClick={() => {
                  setWorkspaceTreeToggles((current) => openWorkspaceTreeToggles(current, UNASSIGNED_WORKSPACE_KEY));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setWorkspaceTreeToggles((current) => openWorkspaceTreeToggles(current, UNASSIGNED_WORKSPACE_KEY));
                  }
                }}
              >
                <button
                  type="button"
                  className="sidebar-workspace-chevron-btn"
                  aria-expanded={isUnassignedOpen}
                  aria-label={isUnassignedOpen
                    ? (isZh ? '折叠未归属' : 'Collapse unassigned')
                    : (isZh ? '展开未归属' : 'Expand unassigned')}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleWorkspaceTree(UNASSIGNED_WORKSPACE_KEY);
                  }}
                >
                  <svg
                    className={`sidebar-section-chevron${isUnassignedOpen ? '' : ' is-collapsed'}`}
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
                </button>
                <span className="sidebar-workspace-meta">
                  <span className="sidebar-workspace-name">{isZh ? '未归属' : 'Unassigned'}</span>
                </span>
                {!isUnassignedOpen ? (
                  <span className="sidebar-workspace-task-count">
                    {groupedTasks.unassigned.length}
                  </span>
                ) : null}
              </div>
              {isUnassignedOpen ? (
                <div className="channel-conversation-list sidebar-workspace-tasks">
                  {sortWorkspaceTasks(groupedTasks.unassigned, isArchivedView).map((conv) => (
                    renderConversationRow(conv, { pinnedGroup: Boolean(conv.pinnedAt) && !isArchivedView })
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <button type="button" className="sidebar-workspace-add" onClick={() => { void handleAddWorkspace(); }}>
            + {isZh ? '添加工作区' : 'Add Workspace'}
          </button>
        </div>
      </div>


      {contextMenu && contextWorkspace
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="sidebar-context-menu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  setProjectPopoverPath(contextWorkspace.path);
                }}
              >
                <span>{isZh ? '查看项目文件夹' : 'Show project folders'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  void handleRevealWorkspace(contextWorkspace.path);
                }}
              >
                <span>{isZh ? '在 Finder 中显示' : 'Reveal in Finder'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  openProjectEditor(contextWorkspace.path);
                }}
              >
                <span>{isZh ? '编辑项目' : 'Edit project'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  closeContextMenu();
                  void handleRemoveWorkspace(contextWorkspace.path);
                }}
              >
                <span>{isZh ? '移除' : 'Remove'}</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {contextMenu && contextConv
        ? createPortal(
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  void navigator.clipboard.writeText(contextConv.id).catch((error: unknown) => {
                    console.error('Failed to copy Session ID', error);
                  });
                }}
              >
                <span>{isZh ? '复制会话 ID' : 'Copy Session ID'}</span>
              </button>
              {isArchivedView ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeContextMenu();
                      void onDeleteConversation(contextConv.id);
                    }}
                  >
                    <span>{isZh ? '永久删除' : 'Delete permanently'}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { closeContextMenu(); void onRestoreConversation(contextConv.id); }}>
                    <span>{isZh ? '恢复会话' : 'Restore chat'}</span>
                  </button>
                </>
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
            </div>,
            document.body,
          )
        : null}

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
      {editingProjectPath
        ? (() => {
            const editingProject = workspaces.find((workspace) => workspace.path === editingProjectPath) as ProjectWorkspace | undefined;
            return editingProject ? (
              <EditProjectDialog
                workspace={editingProject}
                isZh={isZh}
                onClose={() => setEditingProjectPath(null)}
                onChanged={refreshWorkspaces}
                onRemoveProject={async (path) => {
                  setEditingProjectPath(null);
                  await handleRemoveWorkspace(path);
                }}
              />
            ) : null;
          })()
        : null}
    </aside>
  );
}
