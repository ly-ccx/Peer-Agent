export type SidebarPage = 'chat' | 'automations' | 'tools' | 'settings';

export interface SidebarActiveState {
  readonly conversation: boolean;
  readonly automations: boolean;
  readonly tools: boolean;
  readonly settings: boolean;
}

export function sidebarActiveState(
  activePage: SidebarPage,
  activeConversationId: string | null,
  conversationId: string,
): SidebarActiveState {
  return {
    conversation: activePage === 'chat' && activeConversationId === conversationId,
    automations: activePage === 'automations',
    tools: activePage === 'tools',
    settings: activePage === 'settings',
  };
}
