import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';

interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
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
  runningConversationIds,
  runningWorkspacePaths,
  activePage,
  i18n,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onOpenSettings,
  onWorkspaceChanged,
}: {
  readonly conversations: readonly ConversationMeta[];
  readonly activeConversationId: string | null;
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
  readonly onOpenSettings: () => void;
  readonly onWorkspaceChanged?: () => Promise<void> | void;
}) {
  const isZh = i18n.locale === 'zh-CN';
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
    isFinishingRenameRef.current = false;
    setConfirmDeleteId(null);
    setEditingConversationId(conv.id);
    setEditingTitle(conv.title);
  }, []);

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
          <svg className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={wsDropdownOpen ? { transform: 'rotate(180deg)' } : undefined}>
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
        <button type="button" className="sidebar-new-chat" onClick={onNewChat}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          <span>{isZh ? '新对话' : 'New Chat'}</span>
        </button>
      </div>

      {/* ADR 27: key 绑定当前工作区,切换工作区时列表重新挂载,触发一次入场 reveal,
          配合 sidebar.css 的 .sidebar-conversations 动画,避免硬切的卡顿观感。 */}
      <div className="sidebar-conversations" key={activeWorkspace ?? 'none'}>
        {conversations.length === 0 ? (
          <p className="sidebar-empty">{isZh ? '暂无对话' : 'No conversations'}</p>
        ) : conversations.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-conversation-item ${conv.id === activeConversationId && activePage === 'chat' ? 'active' : ''}`}
            onClick={() => onSelectConversation(conv.id)}
            onMouseEnter={() => setHoveredId(conv.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {runningConversationIds?.has(conv.id) ? (
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
                title={isZh ? '双击编辑标题' : 'Double-click to edit title'}
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
                  className="sidebar-conv-delete"
                  aria-label={isZh ? '删除对话' : 'Delete conversation'}
                  onClick={() => setConfirmDeleteId(conv.id)}
                >×</button>
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <button type="button" className={`sidebar-nav-btn ${activePage === 'settings' ? 'active' : ''}`} onClick={onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <span>{isZh ? '设置' : 'Settings'}</span>
        </button>
      </div>
    </aside>
  );
}
