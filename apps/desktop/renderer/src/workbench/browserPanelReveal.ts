export const MAX_PREPARED_BROWSER_CONVERSATIONS = 8;

export type BrowserPanelRevealStatus = 'opened' | 'activated' | 'already_active';

export interface BrowserPanelRevealDecision {
  readonly accept: boolean;
  readonly stealUi: boolean;
  readonly prepareSession: boolean;
  readonly mountPrepared: boolean;
  readonly status: BrowserPanelRevealStatus;
  readonly error?: string;
}

/**
 * Browser 工作现场的 reveal 决策。
 *
 * Root workbench 负责给任意会话准备可调度的 Browser WebContents。
 * 只有「请求会话就是当前前台会话，并且明确要求 focus」时，才打开/切到 Browser 面板。
 * 后台 Task 可以挂上本会话浏览器，但不能抢走用户正在看的工作台。
 */
export function resolveBrowserPanelReveal(input: {
  readonly requestConversationId: string | null | undefined;
  readonly hostConversationId: string | null;
  readonly layoutHost?: 'root' | 'local';
  readonly focus?: boolean;
  readonly hostOpen: boolean;
  readonly hostBrowserActive: boolean;
  readonly requestSessionExists: boolean;
}): BrowserPanelRevealDecision {
  const requestId = typeof input.requestConversationId === 'string'
    ? input.requestConversationId.trim()
    : '';
  if (!requestId) {
    return {
      accept: false,
      stealUi: false,
      prepareSession: false,
      mountPrepared: false,
      status: 'opened',
      error: 'missing_conversation',
    };
  }

  // 会话抽屉只表达当前会话，不承担全局 Browser 调度。
  if ((input.layoutHost ?? 'root') !== 'root') {
    return {
      accept: false,
      stealUi: false,
      prepareSession: false,
      mountPrepared: false,
      status: 'opened',
      error: 'not_reveal_host',
    };
  }

  const isHostConversation = requestId === input.hostConversationId;
  const stealUi = input.focus !== false && isHostConversation;
  if (isHostConversation) {
    const alreadyVisible = input.hostOpen && input.hostBrowserActive;
    return {
      accept: true,
      stealUi,
      prepareSession: true,
      mountPrepared: true,
      status: alreadyVisible ? 'already_active' : input.hostOpen ? 'activated' : 'opened',
    };
  }

  return {
    accept: true,
    stealUi: false,
    prepareSession: true,
    mountPrepared: true,
    status: input.requestSessionExists ? 'already_active' : 'opened',
  };
}

export function rememberPreparedBrowser(
  ids: readonly string[],
  conversationId: string,
  limit = MAX_PREPARED_BROWSER_CONVERSATIONS,
): string[] {
  const nextId = conversationId.trim();
  if (!nextId) return [...ids];
  const without = ids.filter((id) => id !== nextId);
  const merged = [...without, nextId];
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}
