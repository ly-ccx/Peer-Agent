/**
 * Headless 浏览器会话（后台静默执行支持）。
 *
 * 当会话的 Browser 工作现场（renderer 的可见 webview）未展开时，
 * 工具调用仍需要一个真实可控的 WebContents。本模块在主进程惰性创建
 * 一个隐藏 BrowserWindow + WebContentsView（共享 persist:peer-browser
 * 分区，保持登录态与可见面板一致），并以 hidden entry 身份注册进
 * browser-control-registry，走同一条 Runtime Projection 执行链。
 *
 * 共存规则（ADR 46 语义扩展）：
 * - 可见 entry 注册时接管 active 槽位；headless entry 同步让位并销毁。
 * - headless entry 只是会话没有可见浏览器的兜底，不参与前台焦点竞争
 *   （claimForeground=false）。
 */

import { registerBrowserWebContents, unregisterBrowserWebContents } from './browser-control-registry.mjs';

const HEADLESS_TAB_ID = '__headless__';
const DEFAULT_HEADLESS_SIZE = { width: 1280, height: 800 };

function isWebContentsAlive(wc) {
  return Boolean(wc) && typeof wc.isDestroyed === 'function' && !wc.isDestroyed();
}

/**
 * @param {{ electron?: typeof import('electron') }} [options]
 */
export function createHeadlessBrowserManager({ electron } = {}) {
  const electronModule = electron ?? null;
  const sessions = new Map(); // conversationId -> { window, view, webContentsId }

  async function ensureHeadlessBrowserEntry(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') {
      return { ok: false, reason: 'invalid_conversation_id' };
    }
    if (!electronModule?.BrowserWindow || !electronModule?.WebContentsView) {
      return { ok: false, reason: 'headless_unavailable' };
    }

    // 幂等复用：同会话已有存活的 headless WebContents 则直接复用注册。
    const existing = sessions.get(conversationId);
    if (existing && isWebContentsAlive(existing.view?.webContents)) {
      return {
        ok: true,
        webContentsId: existing.webContentsId,
        conversationId,
        browserTabId: HEADLESS_TAB_ID,
        hidden: true,
        reused: true,
      };
    }
    if (existing) {
      await disposeSession(conversationId);
    }

    const { BrowserWindow, WebContentsView } = electronModule;
    const window = new BrowserWindow({
      width: DEFAULT_HEADLESS_SIZE.width,
      height: DEFAULT_HEADLESS_SIZE.height,
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        partition: 'persist:peer-browser',
        backgroundThrottling: false,
      },
    });

    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:peer-browser',
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: DEFAULT_HEADLESS_SIZE.width, height: DEFAULT_HEADLESS_SIZE.height });

    const webContentsId = view.webContents.id;
    sessions.set(conversationId, { window, view, webContentsId });

    window.on('closed', () => {
      sessions.delete(conversationId);
      unregisterBrowserWebContents({ webContentsId, conversationId, browserTabId: HEADLESS_TAB_ID });
    });

    // 注册为 hidden entry：active 槽位参与（供 getActiveBrowserEntry 解析），
    // 但不竞争前台焦点。
    const registration = registerBrowserWebContents({
      webContentsId,
      conversationId,
      browserTabId: HEADLESS_TAB_ID,
      active: true,
      claimForeground: false,
      hidden: true,
      url: 'about:blank',
    });
    if (!registration.ok) {
      await disposeSession(conversationId);
      return { ok: false, reason: 'registry_rejected' };
    }

    return {
      ok: true,
      webContentsId,
      conversationId,
      browserTabId: HEADLESS_TAB_ID,
      hidden: true,
      reused: false,
    };
  }

  async function disposeSession(conversationId) {
    const session = sessions.get(conversationId);
    if (!session) return;
    sessions.delete(conversationId);
    unregisterBrowserWebContents({
      webContentsId: session.webContentsId,
      conversationId,
      browserTabId: HEADLESS_TAB_ID,
    });
    try { session.window.destroy(); } catch { /* already destroyed */ }
  }

  function dispose() {
    for (const conversationId of [...sessions.keys()]) {
      void disposeSession(conversationId);
    }
  }

  function isHeadlessEntry(entry) {
    return Boolean(entry) && entry.browserTabId === HEADLESS_TAB_ID && entry.hidden === true;
  }

  return Object.freeze({
    ensureHeadlessBrowserEntry,
    disposeSession,
    dispose,
    isHeadlessEntry,
    HEADLESS_TAB_ID,
  });
}
