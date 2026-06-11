import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useState } from 'react';
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
  activePage,
  i18n,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onOpenSettings,
  onWorkspaceChanged,
}: {
  readonly conversations: readonly ConversationMeta[];
  readonly activeConversationId: string | null;
  readonly activePage: string;
  readonly i18n: I18nRuntime;
  readonly onNewChat: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onDeleteConversation: (id: string) => void;
  readonly onOpenSettings: () => void;
  readonly onWorkspaceChanged?: () => Promise<void> | void;
}) {
  const isZh = i18n.locale === 'zh-CN';
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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
    setWsDropdownOpen(false);
    await clientApi.workspaceSetActive({ path: wsPath });
    await refreshWorkspaces();
    onWorkspaceChanged?.();
  }, [refreshWorkspaces, onWorkspaceChanged]);

  const handleRemoveWorkspace = useCallback(async (wsPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await clientApi.workspaceRemove({ path: wsPath });
    await refreshWorkspaces();
    onWorkspaceChanged?.();
  }, [refreshWorkspaces, onWorkspaceChanged]);

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

      <div className="sidebar-conversations">
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
            <span className="sidebar-conv-title">{conv.title || (isZh ? '新对话' : 'New Chat')}</span>
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
              <button
                type="button"
                className="sidebar-conv-delete"
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conv.id); }}
              >×</button>
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
