import { useCallback, useRef, useState } from 'react';
import { closeResourceConversation, openResourceConversation, type ResourceConversation, type ResourceConversations } from './resourceConversationState';
import type { WorkbenchTabId } from './workbenchTabState';

export function useResourceConversations(ports: {
  readonly workspaceId: string | null; readonly ready: boolean;
  readonly setTab: (tab: WorkbenchTabId) => void; readonly reveal: () => void;
}) {
  const latest = useRef(ports); latest.current = ports;
  const [stored, setStored] = useState<ResourceConversations>({ owner: ports.workspaceId, tabs: [], activeId: null });
  let state = stored;
  if (state.owner !== ports.workspaceId) {
    state = { owner: ports.workspaceId, tabs: [], activeId: null };
    setStored(state);
  }
  const current = useRef(state); current.current = state;
  const openConversation = useCallback((target: ResourceConversation) => {
    const port = latest.current;
    if (!port.ready || target.workspaceId !== port.workspaceId || !target.conversationId) return;
    setStored(value => openResourceConversation(value, target));
    port.setTab('conversations'); port.reveal();
  }, []);
  const activateConversation = useCallback((id: string) => {
    if (!latest.current.ready || !current.current.tabs.some(tab => tab.conversationId === id)) return;
    setStored(value => ({ ...value, activeId: id }));
    latest.current.setTab('conversations');
  }, []);
  const closeConversation = useCallback((id: string) => {
    setStored(value => closeResourceConversation(value, id));
  }, []);
  return { conversations: state.tabs, activeConversationId: state.activeId, openConversation, activateConversation, closeConversation };
}
