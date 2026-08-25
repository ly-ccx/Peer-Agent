import { memo, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type { CompactionState } from '../state/types';
import {
  compactionProgressPercent,
  sidebarCompactionStateLabel,
  sidebarConversationActivity,
} from '../state/compactionStateView';
import { shouldShowCompletedUnreadDot } from '../state/completedUnreadState';
import { sidebarActiveState, type SidebarPage } from './sidebarActiveState';

export type SidebarConversationMeta = {
  readonly id: string;
  readonly title: string;
  readonly workspacePath?: string | null;
  readonly messageCount: number;
  readonly updatedAt: string;
  readonly status?: 'active' | 'archived';
  readonly archivedAt?: string | null;
  readonly pinnedAt?: string | null;
  readonly pinnedOrder?: number | null;
  readonly automationOrigin?: {
    readonly kind: 'automation_run';
    readonly automationId: string;
    readonly runId: string;
    readonly automationName?: string;
    readonly triggerSource?: string;
    readonly createdAt?: string;
  } | null;
};

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

export type SidebarConversationRowProps = {
  readonly conv: SidebarConversationMeta;
  readonly pinnedGroup?: boolean;
  readonly isZh: boolean;
  readonly isArchivedView: boolean;
  readonly activePage: SidebarPage;
  readonly activeConversationId: string | null;
  readonly isRunning: boolean;
  readonly compactionState?: CompactionState | null;
  readonly completedUnreadIds: ReadonlySet<string>;
  readonly awaitingGoalPlanCount: number;
  readonly pendingSensitiveCount: number;
  readonly editingConversationId: string | null;
  readonly editingTitle: string;
  readonly editingInputRef: RefObject<HTMLInputElement | null>;
  readonly draggingPinnedId: string | null;
  readonly onSelectConversation: (id: string) => void;
  readonly onContextMenu: (e: ReactMouseEvent<HTMLDivElement>, conv: SidebarConversationMeta) => void;
  readonly beginRenameConversation: (conv: SidebarConversationMeta) => void;
  readonly submitRenameConversation: (conv: SidebarConversationMeta) => void | Promise<void>;
  readonly cancelRenameConversation: () => void;
  readonly setEditingTitle: (value: string) => void;
  readonly onArchiveConversation: (id: string) => void | Promise<void>;
  readonly onRestoreConversation: (id: string) => void | Promise<void>;
  readonly onDeleteConversation: (id: string) => void | Promise<void>;
  readonly onPinConversation: (id: string) => void | Promise<void>;
  readonly onUnpinConversation: (id: string) => void | Promise<void>;
  readonly movePinnedConversation: (dragId: string, targetId: string) => void;
  readonly setDraggingPinnedId: (id: string | null) => void;
};

/**
 * 会话行隔离渲染：父级 overview / awaiting 抖动时，未变化的行可跳过 reconcile。
 */
export const SidebarConversationRow = memo(function SidebarConversationRow({
  conv,
  pinnedGroup = false,
  isZh,
  isArchivedView,
  activePage,
  activeConversationId,
  isRunning,
  compactionState,
  completedUnreadIds,
  awaitingGoalPlanCount,
  pendingSensitiveCount,
  editingConversationId,
  editingTitle,
  editingInputRef,
  draggingPinnedId,
  onSelectConversation,
  onContextMenu,
  beginRenameConversation,
  submitRenameConversation,
  cancelRenameConversation,
  setEditingTitle,
  onArchiveConversation,
  onRestoreConversation,
  onDeleteConversation,
  onPinConversation,
  onUnpinConversation,
  movePinnedConversation,
  setDraggingPinnedId,
}: SidebarConversationRowProps) {
  const activity = sidebarConversationActivity({ isRunning, compactionState });
  const isCompactionVisible = activity.kind === 'compaction';
  const showCompletedUnread = shouldShowCompletedUnreadDot({
    conversationId: conv.id,
    isRunning,
    isCompactionVisible,
    completedUnreadIds,
  });
  const compactPercent = compactionProgressPercent(compactionState);
  const compactLabel = sidebarCompactionStateLabel(compactionState, isZh);
  const compactPercentText = typeof compactPercent === 'number' ? `${Math.round(compactPercent)}%` : null;
  const compactTitle = compactPercentText ? `${compactLabel} ${compactPercentText}` : compactLabel;
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
    pinnedGroup ? 'is-in-pinned-group' : '',
    draggingPinnedId === conv.id ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      data-conversation-id={conv.id}
      className={rowClasses}
      draggable={Boolean(pinnedGroup && canTogglePin)}
      onDragStart={(e) => {
        if (!pinnedGroup || !canTogglePin) return;
        setDraggingPinnedId(conv.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', conv.id);
      }}
      onDragOver={(e) => {
        if (!pinnedGroup || !draggingPinnedId || draggingPinnedId === conv.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!pinnedGroup) return;
        e.preventDefault();
        const dragId = e.dataTransfer.getData('text/plain') || draggingPinnedId;
        if (dragId) movePinnedConversation(dragId, conv.id);
        setDraggingPinnedId(null);
      }}
      onDragEnd={() => setDraggingPinnedId(null)}
      onClick={() => onSelectConversation(conv.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, conv);
      }}
    >
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
              className={`sidebar-conv-pin ${isPinned ? 'active' : ''}`}
              title={isPinned ? (isZh ? '取消置顶' : 'Unpin chat') : (isZh ? '置顶会话' : 'Pin chat')}
              aria-label={isPinned ? (isZh ? '取消置顶' : 'Unpin chat') : (isZh ? '置顶会话' : 'Pin chat')}
              onClick={() => { void (isPinned ? onUnpinConversation(conv.id) : onPinConversation(conv.id)); }}
            >
              <PinIcon filled={isPinned} />
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
});
