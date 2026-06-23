import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { VersionBadge } from '../../app/components/VersionBadge';

type ConversationView = 'active' | 'archived';

interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  status?: ConversationView;
  archivedAt?: string | null;
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

export function Sidebar({
  conversations,
  activeConversationId,
  conversationView,
  runningConversationIds,
  runningWorkspacePaths,
  activePage,
  i18n,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  onShowArchivedConversations,
  onShowActiveConversations,
  onOpenSettings,
  onWorkspaceChanged,
}: {
  readonly conversations: readonly ConversationMeta[];
  readonly activeConversationId: string | null;
  readonly conversationView: ConversationView;
  // 当前正在流式运行的会话 id 集合(表达层状态,真值来自 main 的 activeStreams 广播)。
  readonly runningConversationIds?: ReadonlySet<string>;
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
  readonly onShowArchivedConversations: () => void | Promise<void>;
  readonly onShowActiveConversations: () => void | Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onWorkspaceChanged?: () => Promise<void> | void;
}) {
  const isZh = i18n.locale === 'zh-CN';
  const isArchivedView = conversationView === 'archived';
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const isFinishingRenameRef = useRef(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);

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

  const handleAddWorkspace = useCallback(async () => {
    setWsDropdownOpen(false);
    const result = await clientApi.workspaceAdd();
    if (result) { await refreshWorkspaces(); onWorkspaceChanged?.(); }
  }, [refreshWorkspaces, onWorkspaceChanged]);

  const handleSwitchWorkspace = useCallback(async (wsPath: string) => {
    // ADR 27: 去阻塞切换。先乐观回填当前工作区名称(用已知的 workspaces 条目),
    // 避免等待 git(workspaceInfo)阻塞 UI;git 分支等信息由后续 refresh 异步补齐。
    setWsDropdownOpen(false);
    const known = workspaces.find((w) => w.path === wsPath);
    setActiveWorkspace(wsPath);
    setWsInfo(known ? { name: known.name, absolutePath: wsPath } : null);
    await clientApi.workspaceSetActive({ path: wsPath });
    // 会话列表刷新(onWorkspaceChanged)与工作区/ git 详情刷新并行,互不阻塞。
    await Promise.all([
      Promise.resolve(onWorkspaceChanged?.()),
      refreshWorkspaces(),
    ]);
  }, [workspaces, refreshWorkspaces, onWorkspaceChanged]);

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

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true">
          <img className="sidebar-brand-icon light" src="./logo-light.png" alt="" />
          <img className="sidebar-brand-icon dark" src="./logo-dark.png" alt="" />
        </span>
        <span className="sidebar-brand-copy">
          <span className="sidebar-brand-title">Peer Agent</span>
        </span>
        <VersionBadge i18n={i18n} />
      </div>

      <div className="sidebar-workspace-wrap">
        <div className="sidebar-workspace" onClick={() => setWsDropdownOpen(!wsDropdownOpen)}>
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
          <svg className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={wsDropdownOpen ? { transform: 'rotate(180deg)' } : undefined}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>

        {wsDropdownOpen ? (
          <div className="ws-dropdown">
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
            <span>{isZh ? '新对话' : 'New Chat'}</span>
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
        {conversations.map((conv) => {
          const isRunning = Boolean(runningConversationIds?.has(conv.id));
          return (
            <div
              key={conv.id}
              className={`conversation-row ${activeConversationId === conv.id ? 'active' : ''} ${isRunning ? 'is-running' : ''}`}
              onClick={() => onSelectConversation(conv.id)}
              onMouseEnter={() => setHoveredId(conv.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {isRunning ? (
                <span
                  className="sidebar-conv-spinner"
                  role="img"
                  aria-label={isZh ? '运行中' : 'Running'}
                  title={isZh ? '运行中' : 'Running'}
                />
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
                        <path d="M3 7v6h6" />
                        <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
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
                        title={isRunning ? (isZh ? '运行中不可归档' : 'Cannot archive while running') : (isZh ? '归档会话' : 'Archive chat')}
                        aria-label={isZh ? '归档会话' : 'Archive chat'}
                        disabled={isRunning}
                        onClick={() => { if (!isRunning) void onArchiveConversation(conv.id); }}
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
                  >×</button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={`sidebar-nav-btn ${isArchivedView ? 'active' : ''}`}
          onClick={() => { void onShowArchivedConversations(); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="4" rx="1" />
            <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
            <path d="M10 12h4" />
          </svg>
          <span>{isZh ? '已归档会话' : 'Archived Chats'}</span>
        </button>
        <button type="button" className={`sidebar-nav-btn ${activePage === 'settings' ? 'active' : ''}`} onClick={onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>{isZh ? '设置' : 'Settings'}</span>
        </button>
      </div>
    </aside>
  );
}
