/**
 * AskForPermission 风格：打开「完全磁盘访问」后，在屏幕下方弹出 always-on-top 拖拽浮窗。
 * 系统设置本身没有底部拖区；浮窗由我们提供可拖的 Peer Agent LOGO，复用 startAppDrag 同步链路。
 */

import { pathToFileURL } from 'node:url';

const FLOAT_SIZE = { width: 380, height: 108 };

/**
 * @param {{
 *   BrowserWindow: typeof import('electron').BrowserWindow,
 *   screen: typeof import('electron').screen,
 *   path: typeof import('node:path'),
 *   existsSync: (p: string) => boolean,
 *   preloadPath: string,
 *   resolveDragTarget: () => { ok: boolean, appPath?: string, displayName?: string, error?: string },
 *   resolveLogoFilePath: () => string | null,
 *   isZh?: () => boolean,
 * }} deps
 */
export function createFullDiskAccessDragFloatController(deps) {
  const {
    BrowserWindow,
    screen,
    path,
    existsSync,
    preloadPath,
    resolveDragTarget,
    resolveLogoFilePath,
    isZh = () => true,
  } = deps;

  /** @type {import('electron').BrowserWindow | null} */
  let floatWindow = null;
  let hideTimer = null;

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function destroy() {
    clearHideTimer();
    if (floatWindow && !floatWindow.isDestroyed()) {
      try { floatWindow.close(); } catch { /* ignore */ }
    }
    floatWindow = null;
  }

  function hide() {
    clearHideTimer();
    if (floatWindow && !floatWindow.isDestroyed()) {
      try { floatWindow.hide(); } catch { /* ignore */ }
    }
  }

  function buildHtml(payload) {
    const title = payload.isZh
      ? `↑ 将 ${payload.displayName} 拖到上方「完全磁盘访问」列表`
      : `↑ Drag ${payload.displayName} into Full Disk Access list above`;
    const subtitle = payload.isZh
      ? '列表不会自动出现 App · 按住 LOGO 拖入后打开开关'
      : 'Apps never auto-appear · Hold the logo, drop into the list, then enable';
    const logoSrc = payload.logoFileUrl || '';
    // 内联极简样式；拖拽走 preload startAppDrag（sendSync）
    return `<!doctype html>
<html lang="${payload.isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FDA Drag</title>
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }
  .card {
    box-sizing: border-box;
    height: 100%;
    margin: 0;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(0,0,0,0.08);
    background: rgba(255,255,255,0.92);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: grab;
  }
  .card:active { cursor: grabbing; }
  .logo {
    width: 44px; height: 44px; border-radius: 12px;
    object-fit: cover; flex: 0 0 auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    pointer-events: none;
  }
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .meta strong {
    font-size: 13px; font-weight: 650; line-height: 1.3;
    color: rgba(20,20,20,0.92);
  }
  .meta span {
    font-size: 11.5px; line-height: 1.35;
    color: rgba(60,60,67,0.72);
  }
  .close {
    margin-left: auto;
    border: 0; background: transparent;
    color: rgba(60,60,67,0.55);
    font-size: 18px; line-height: 1;
    width: 28px; height: 28px;
    border-radius: 8px;
    cursor: pointer;
  }
  .close:hover { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.75); }
  .err {
    position: absolute; left: 14px; right: 14px; bottom: 6px;
    font-size: 11px; color: #b42318;
  }
</style>
</head>
<body>
  <div class="card" id="drag" draggable="true" title="${escapeHtml(title)}">
    ${logoSrc ? `<img class="logo" src="${escapeHtml(logoSrc)}" alt="" />` : `<div class="logo" style="background:#111;border-radius:12px"></div>`}
    <div class="meta">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(subtitle)}</span>
    </div>
    <button class="close" id="close" type="button" aria-label="Close">×</button>
  </div>
  <div class="err" id="err" hidden></div>
  <script>
    const appPath = ${JSON.stringify(payload.appPath || '')};
    const displayName = ${JSON.stringify(payload.displayName || 'Peer Agent')};
    const drag = document.getElementById('drag');
    const err = document.getElementById('err');
    document.getElementById('close').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { window.peerAgent?.hideFdaDragFloat?.(); } catch (_) {}
    });
    drag.addEventListener('dragstart', (e) => {
      err.hidden = true;
      if (!appPath || !window.peerAgent?.startAppDrag) {
        e.preventDefault();
        err.hidden = false;
        err.textContent = 'Drag unavailable';
        return;
      }
      try {
        const result = window.peerAgent.startAppDrag({ appPath });
        if (result && result.ok === false) {
          e.preventDefault();
          err.hidden = false;
          err.textContent = result.error || 'start_drag_failed';
          return;
        }
      } catch (ex) {
        e.preventDefault();
        err.hidden = false;
        err.textContent = String(ex && ex.message ? ex.message : ex);
        return;
      }
      try {
        e.dataTransfer.setData('text/plain', displayName || appPath);
        e.dataTransfer.effectAllowed = 'copyMove';
      } catch (_) {}
    });
  </script>
</body>
</html>`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function positionWindow(win) {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const x = Math.round(area.x + (area.width - FLOAT_SIZE.width) / 2);
    // 贴在工作区底部上方一点，模拟「设置窗口下方」的固定拖条位置
    const y = Math.round(area.y + area.height - FLOAT_SIZE.height - 28);
    win.setBounds({ x, y, width: FLOAT_SIZE.width, height: FLOAT_SIZE.height });
  }

  function show(options = {}) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'unsupported_platform' };
    }
    const target = resolveDragTarget();
    if (!target?.ok || !target.appPath) {
      return { ok: false, error: target?.error || 'app_path_not_found' };
    }
    const logoPath = resolveLogoFilePath();
    let logoFileUrl = '';
    if (logoPath && existsSync(logoPath)) {
      try { logoFileUrl = pathToFileURL(logoPath).href; } catch { logoFileUrl = ''; }
    }
    const payload = {
      appPath: target.appPath,
      displayName: target.displayName || 'Peer Agent',
      logoFileUrl,
      isZh: options.isZh !== undefined ? options.isZh : isZh(),
    };
    const html = buildHtml(payload);
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    if (!floatWindow || floatWindow.isDestroyed()) {
      floatWindow = new BrowserWindow({
        ...FLOAT_SIZE,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: true,
        alwaysOnTop: true,
        focusable: true,
        roundedCorners: true,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: preloadPath,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      floatWindow.__peerAgentFdaDragFloat = true;
      try {
        floatWindow.setAlwaysOnTop(true, 'floating');
        floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch { /* ignore */ }
      floatWindow.on('closed', () => {
        floatWindow = null;
        clearHideTimer();
      });
    }

    positionWindow(floatWindow);
    void floatWindow.loadURL(url);
    if (!floatWindow.isVisible()) floatWindow.showInactive();
    try { floatWindow.moveTop(); } catch { /* ignore */ }

    // 用户授权通常需要一点时间；默认 8 分钟后自动收起，避免常驻打扰
    clearHideTimer();
    const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : 8 * 60 * 1000;
    if (ttlMs > 0) {
      hideTimer = setTimeout(() => hide(), ttlMs);
    }
    return { ok: true, appPath: target.appPath, displayName: payload.displayName };
  }

  return {
    show,
    hide,
    destroy,
    isOpen: () => Boolean(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()),
  };
}
