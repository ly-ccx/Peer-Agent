import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocalAccessLevel } from '@peer-agent/protocol';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useWorkbenchOptional } from '../../../workbench/WorkbenchContext';
import { WorkbenchToggle } from '../../../workbench/WorkbenchToggle';
import { SidebarToggle } from '../../../workbench/SidebarToggle';
import { ChatHeaderCapabilities } from './ChatHeaderCapabilities';

export interface ChatHeaderAction {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly icon?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onAction: () => void;
}

/**
 * ChatHeader — 聊天区域顶部标题栏。
 *
 * 位于 chat-surface 顶部固定 36px 区域（即 macOS 交通灯同行），
 * 提供会话标题（可内联编辑）、上下文菜单和快捷操作按钮。
 * 遵循 Frost 设计语言的冷感 + 简洁原则。
 */
export function ChatHeader({
  title,
  automationOrigin = null,
  isZh,
  i18n,
  isStreaming,
  hasScroll,
  localAccessLevel,
  editTriggerRef,
  onRename,
  onArchive,
  onBranch,
  onFind,
  onOpenTools,
  onOpenAutomationRun,
  onClose,
}: {
  readonly title: string;
  readonly automationOrigin?: {
    kind: 'automation_run';
    automationId: string;
    runId: string;
    automationName?: string;
    triggerSource?: string;
    originWorkspacePath?: string;
    createdAt?: string;
  } | null;
  readonly isZh: boolean;
  readonly i18n: I18nRuntime;
  readonly isStreaming: boolean;
  readonly hasScroll?: boolean;
  readonly localAccessLevel: LocalAccessLevel;
  readonly editTriggerRef?: MutableRefObject<(() => void) | null>;
  readonly onRename?: (newTitle: string) => void;
  readonly onArchive?: () => void;
  readonly onBranch?: () => void;
  readonly onFind?: () => void;
  readonly onOpenTools?: () => void;
  readonly onOpenAutomationRun?: (target: { automationId: string; runId: string }) => void;
  /** When set (e.g. conversation Drawer), render a close control in the main header row. */
  readonly onClose?: () => void;
}) {
  const workbench = useWorkbenchOptional();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Sync edit value when title prop changes (e.g. after rename).
  useEffect(() => { setEditValue(title); }, [title]);

  // Focus input when entering edit mode.
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const beginEdit = useCallback(() => {
    setEditValue(title);
    setEditing(true);
    setMenuOpen(false);
  }, [title]);

  // 暴露 beginEdit 给外层快捷键调用。
  useEffect(() => {
    if (editTriggerRef) {
      editTriggerRef.current = onRename ? beginEdit : null;
    }
  }, [editTriggerRef, beginEdit, onRename]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onRename?.(trimmed);
    }
  }, [editValue, title, onRename]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditValue(title);
  }, [title]);

  const menuActions: ChatHeaderAction[] = [
    ...(onRename ? [{
      id: 'rename',
      label: isZh ? '重命名对话' : 'Rename conversation',
      shortcut: '⌥⌘R',
      onAction: beginEdit,
    }] : []),
    ...(onArchive ? [{
      id: 'archive',
      label: isZh ? '归档对话' : 'Archive conversation',
      shortcut: '⌥⇧A',
      disabled: isStreaming,
      onAction: () => { setMenuOpen(false); onArchive(); },
    }] : []),
    ...(onBranch ? [{
      id: 'branch',
      label: isZh ? '分叉对话' : 'Branch conversation',
      onAction: () => { setMenuOpen(false); onBranch(); },
    }] : []),
    ...(onFind ? [{
      id: 'find',
      label: isZh ? '查找' : 'Find in conversation',
      shortcut: '⌘F',
      onAction: () => { setMenuOpen(false); onFind(); },
    }] : []),
  ];

  const displayTitle = title || (isZh ? '新对话' : 'New Chat');

  return (
    <header className={`chat-header${hasScroll ? ' has-scroll' : ''}`} aria-label={isZh ? '对话标题栏' : 'Conversation header'}>
      <div className="chat-header-left">
        {workbench ? <SidebarToggle isZh={isZh} /> : null}
        {editing ? (
          <input
            ref={inputRef}
            className="chat-header-title-input"
            value={editValue}
            maxLength={80}
            aria-label={isZh ? '编辑标题' : 'Edit title'}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            }}
          />
        ) : (
          <>
            {automationOrigin?.kind === 'automation_run' ? (
              <button
                type="button"
                className="chat-header-automation-badge"
                onClick={() => onOpenAutomationRun?.({ automationId: automationOrigin.automationId, runId: automationOrigin.runId })}
                title={
                  automationOrigin.automationName
                    ? (isZh
                      ? `自动化：${automationOrigin.automationName}`
                      : `Automation: ${automationOrigin.automationName}`)
                    : (isZh ? '自动化会话' : 'Automation conversation')
                }
              >
                {isZh ? '自动化 · 查看运行' : 'Automation · View run'}
              </button>
            ) : null}
            <span
              className="chat-header-title"
              title={isZh ? '双击编辑标题' : 'Double-click to edit'}
              onDoubleClick={onRename ? beginEdit : undefined}
            >
              {displayTitle}
            </span>
          </>
        )}

        {/* More actions menu */}
        <div className="chat-header-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className={`chat-header-menu-btn ${menuOpen ? 'active' : ''}`}
            aria-label={isZh ? '更多操作' : 'More actions'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="chat-header-menu" role="menu">
              {menuActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={`chat-header-menu-item ${action.danger ? 'danger' : ''}`}
                  disabled={action.disabled}
                  onClick={action.onAction}
                >
                  <span className="chat-header-menu-item-label">{action.label}</span>
                  {action.shortcut ? (
                    <span className="chat-header-menu-item-shortcut">{action.shortcut}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="chat-header-right">
        <ChatHeaderCapabilities
          i18n={i18n}
          localAccessLevel={localAccessLevel}
          onOpenTools={onOpenTools}
        />
        {onFind ? (
          <button
            type="button"
            className="chat-header-action-btn"
            aria-label={isZh ? '查找' : 'Find'}
            title={isZh ? '查找 (⌘F)' : 'Find (⌘F)'}
            onClick={onFind}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
        ) : null}
        {workbench ? <WorkbenchToggle isZh={isZh} /> : null}
        {onClose ? (
          <button
            type="button"
            className="chat-header-action-btn chat-header-close-btn"
            aria-label={isZh ? '关闭' : 'Close'}
            title={isZh ? '关闭抽屉' : 'Close drawer'}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        ) : null}
      </div>
    </header>
  );
}
