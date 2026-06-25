/**
 * 内嵌浏览器（Workbench「浏览器」面板 <webview>）控制句柄注册表 —— 见 ADR 40。
 *
 * 背景：Agent 要操控用户眼前那个可见的 <webview>，最稳的做法是 renderer 在
 * webview `dom-ready` 后把它的 `getWebContentsId()` 上报给 main，main 侧记下当前
 * 活跃的 webContentsId；Agent 工具执行时由 provider 用 `webContents.fromId(id)`
 * 直接拿到同一个 WebContents 操控（loadURL/executeJavaScript/sendInputEvent/
 * capturePage），避免逐跳 IPC 往返的脆弱链路。
 *
 * 这是一个 main 进程内的极简单例：只保存「当前活跃」一个 webview 的句柄与少量
 * 调试元信息（url/title/registeredAt）。范围外：多标签页 / 多 webview 同时操控。
 */

let activeEntry = null;

/**
 * 注册（或刷新）当前活跃 webview 的控制句柄。
 * @param {{ webContentsId: number, url?: string, title?: string }} entry
 * @returns {{ ok: boolean, webContentsId?: number, error?: string }}
 */
export function registerBrowserWebContents(entry = {}) {
  const webContentsId = Number(entry.webContentsId);
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    return { ok: false, error: 'invalid_web_contents_id' };
  }
  activeEntry = {
    webContentsId,
    url: typeof entry.url === 'string' ? entry.url : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    registeredAt: new Date().toISOString(),
  };
  return { ok: true, webContentsId };
}

/**
 * 注销指定 webview 的控制句柄。仅当传入 id 与当前活跃 id 一致时才清空，
 * 避免「新 webview 已注册、旧 webview 卸载」时误清掉新句柄。
 * @param {number} webContentsId
 * @returns {{ ok: boolean, cleared: boolean }}
 */
export function unregisterBrowserWebContents(webContentsId) {
  const id = Number(webContentsId);
  if (activeEntry && (!Number.isInteger(id) || activeEntry.webContentsId === id)) {
    activeEntry = null;
    return { ok: true, cleared: true };
  }
  return { ok: true, cleared: false };
}

/** 读取当前活跃 webview 的控制句柄（无则返回 null）。 */
export function getActiveBrowserEntry() {
  return activeEntry;
}

/** 读取当前活跃 webview 的 webContentsId（无则返回 null）。 */
export function getActiveWebContentsId() {
  return activeEntry?.webContentsId ?? null;
}
