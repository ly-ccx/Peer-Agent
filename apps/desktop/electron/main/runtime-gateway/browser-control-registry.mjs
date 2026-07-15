/**
 * 会话级内嵌浏览器控制句柄注册表（ADR 46）。
 *
 * 条目以 conversationId + browserTabId 为稳定身份；每个会话只暴露自己的活跃网页
 * 标签给 Agent。窗口菜单仍通过 foregroundEntryKey 操控前台会话的活跃标签。
 */

const FALLBACK_CONVERSATION_KEY = '__none';

const entriesByKey = new Map();
const activeEntryKeyByConversation = new Map();
let foregroundEntryKey = null;

function conversationKey(conversationId) {
  return typeof conversationId === 'string' && conversationId ? conversationId : FALLBACK_CONVERSATION_KEY;
}

function entryKey(conversationId, browserTabId) {
  return `${conversationKey(conversationId)}\u0000${browserTabId}`;
}

function findEntryKeyByWebContentsId(webContentsId) {
  for (const [key, entry] of entriesByKey) {
    if (entry.webContentsId === webContentsId) return key;
  }
  return null;
}

/**
 * @param {{
 *   webContentsId: number,
 *   conversationId?: string | null,
 *   browserTabId: string,
 *   active?: boolean,
 *   url?: string,
 *   title?: string
 * }} entry
 */
export function registerBrowserWebContents(entry = {}) {
  const webContentsId = Number(entry.webContentsId);
  const browserTabId = typeof entry.browserTabId === 'string' ? entry.browserTabId.trim() : '';
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    return { ok: false, error: 'invalid_web_contents_id' };
  }
  if (!browserTabId) {
    return { ok: false, error: 'invalid_browser_tab_id' };
  }

  const convKey = conversationKey(entry.conversationId);
  const key = entryKey(entry.conversationId, browserTabId);
  const registered = {
    webContentsId,
    conversationId: convKey === FALLBACK_CONVERSATION_KEY ? null : convKey,
    browserTabId,
    active: entry.active === true,
    url: typeof entry.url === 'string' ? entry.url : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    registeredAt: new Date().toISOString(),
  };
  entriesByKey.set(key, registered);

  if (registered.active) {
    activeEntryKeyByConversation.set(convKey, key);
    foregroundEntryKey = key;
  } else if (activeEntryKeyByConversation.get(convKey) === key) {
    activeEntryKeyByConversation.delete(convKey);
    if (foregroundEntryKey === key) foregroundEntryKey = null;
  }

  return {
    ok: true,
    webContentsId,
    conversationId: registered.conversationId,
    browserTabId,
  };
}

/**
 * @param {{ webContentsId: number, conversationId?: string | null, browserTabId?: string } | number} input
 */
export function unregisterBrowserWebContents(input) {
  const payload = input && typeof input === 'object' ? input : { webContentsId: input };
  const webContentsId = Number(payload.webContentsId);
  const key = typeof payload.browserTabId === 'string' && payload.browserTabId
    ? entryKey(payload.conversationId, payload.browserTabId)
    : findEntryKeyByWebContentsId(webContentsId);
  const registered = key ? entriesByKey.get(key) : null;
  if (!registered || !Number.isInteger(webContentsId) || registered.webContentsId !== webContentsId) {
    return { ok: true, cleared: false };
  }

  entriesByKey.delete(key);
  const convKey = conversationKey(registered.conversationId);
  if (activeEntryKeyByConversation.get(convKey) === key) {
    activeEntryKeyByConversation.delete(convKey);
  }
  if (foregroundEntryKey === key) foregroundEntryKey = null;
  return { ok: true, cleared: true };
}

/**
 * 传 conversationId 时只解析该会话的活跃标签；无参数时返回前台窗口活跃标签。
 */
export function getActiveBrowserEntry(conversationId) {
  const key = arguments.length > 0
    ? activeEntryKeyByConversation.get(conversationKey(conversationId))
    : foregroundEntryKey;
  return key ? entriesByKey.get(key) ?? null : null;
}

export function getActiveWebContentsId(conversationId) {
  const entry = arguments.length > 0
    ? getActiveBrowserEntry(conversationId)
    : getActiveBrowserEntry();
  return entry?.webContentsId ?? null;
}

export function resetBrowserControlRegistryForTests() {
  entriesByKey.clear();
  activeEntryKeyByConversation.clear();
  foregroundEntryKey = null;
}
