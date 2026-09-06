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

/**
 * 切走会话时：非空白页立刻记进活页名单，空白 about:blank 不占名额。
 * 必须在 render 当帧算出下一份名单，不能等 useEffect，否则第一帧会卸掉 webview。
 */
export function rememberLeavingBrowserConversation(
  ids: readonly string[],
  leavingId: string | null | undefined,
  isBlank: boolean,
  limit = MAX_PREPARED_BROWSER_CONVERSATIONS,
): string[] {
  const id = typeof leavingId === 'string' ? leavingId.trim() : '';
  if (!id || isBlank) return [...ids];
  return rememberPreparedBrowser(ids, id, limit);
}

/**
 * 当前前台会话加上后台活页名单。前台必须在同一数组里，切回来才能复用同一个 BrowserView。
 *
 * 返回值只表达「谁该挂着」，不保证 DOM 顺序。渲染前必须再走
 * `stabilizeMountedBrowserOrder`：Electron `<webview>` 的 guest WebContents
 * 在宿主节点被 insertBefore/appendChild 挪动时会被销毁并整页重载。
 */
export function mountedBrowserConversations(
  conversationId: string | null,
  preparedIds: readonly string[],
  limit = MAX_PREPARED_BROWSER_CONVERSATIONS,
): string[] {
  const currentId = typeof conversationId === 'string' ? conversationId.trim() : '';
  const prepared = preparedIds.filter((id) => id && id !== currentId);
  if (!currentId) return prepared.slice(-limit);
  return rememberPreparedBrowser(prepared, currentId, limit);
}

/**
 * 把下一帧要挂着的会话排成「只追加、只删除」的稳定顺序。
 * 切走再切回时集合不变则顺序不变，React 就不会挪 webview 宿主节点。
 */
export function stabilizeMountedBrowserOrder(
  previousOrder: readonly string[],
  nextIds: readonly string[],
): string[] {
  const nextSet = new Set(nextIds.filter((id) => Boolean(id)));
  const kept = previousOrder.filter((id) => nextSet.has(id));
  const keptSet = new Set(kept);
  const added: string[] = [];
  for (const id of nextSet) {
    if (!keptSet.has(id)) added.push(id);
  }
  return [...kept, ...added];
}
