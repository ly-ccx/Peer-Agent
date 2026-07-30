/**
 * AskForPermission 风格：打开「完全磁盘访问」后，在系统设置窗口正下方弹出 always-on-top 拖拽浮窗。
 * 系统设置本身没有底部拖区；浮窗提供可拖 Peer Agent LOGO，复用 startAppDrag 同步链路。
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FLOAT_SIZE = { width: 400, height: 96 };
const POSITION_GAP_PX = 10;

/**
 * @param {{
 *   BrowserWindow: typeof import('electron').BrowserWindow,
 *   screen: typeof import('electron').screen,
 *   path: typeof import('node:path'),
 *   existsSync: (p: string) => boolean,
 *   preloadPath: string,
 *   resolveDragTarget: () => { ok: boolean, appPath?: string, displayName?: string, error?: string },
 *   resolveLogoFilePath?: () => string | null,
 *   resolveLogoDataUrl?: () => string | null,
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
    resolveLogoDataUrl,
    isZh = () => true,
  } = deps;

  /** @type {import('electron').BrowserWindow | null} */
  let floatWindow = null;
  let hideTimer = null;
  let followTimer = null;

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearFollowTimer() {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
  }

  function destroy() {
    clearHideTimer();
    clearFollowTimer();
    if (floatWindow && !floatWindow.isDestroyed()) {
      try { floatWindow.close(); } catch { /* ignore */ }
    }
    floatWindow = null;
  }

  function hide() {
    clearHideTimer();
    clearFollowTimer();
    if (floatWindow && !floatWindow.isDestroyed()) {
      try { floatWindow.hide(); } catch { /* ignore */ }
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 读取 System Settings / System Preferences 窗口 bounds（Electron 顶左原点坐标）。
   * 优先 CGWindowList（Swift，不需要辅助功能权限）；失败再退回 System Events。
   */
  function readSystemSettingsWindowBounds() {
    if (process.platform !== 'darwin') return null;
    return readSettingsBoundsViaCGWindowList() || readSettingsBoundsViaSystemEvents();
  }

  /** CGWindowList → 已转换为与 Electron setBounds 一致的顶左原点坐标。 */
  function readSettingsBoundsViaCGWindowList() {
    // Quartz bounds 原点在主屏左下；Swift 内转成 Electron 顶左后再输出。
    // 用 String(format:) 避免 JS template 与 Swift \( ) 插值转义互相踩踏。
    const script = [
      'import Cocoa',
      'let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)',
      'guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(0) }',
      'let owners: Set<String> = ["System Settings", "System Preferences"]',
      'var best: (CGFloat, CGRect)? = nil',
      'for w in list {',
      '  guard let owner = w[kCGWindowOwnerName as String] as? String, owners.contains(owner) else { continue }',
      '  let layer = w[kCGWindowLayer as String] as? Int ?? 0',
      '  if layer != 0 { continue }',
      '  guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }',
      '  let x = CGFloat((b["X"] as? NSNumber)?.doubleValue ?? -1)',
      '  let y = CGFloat((b["Y"] as? NSNumber)?.doubleValue ?? -1)',
      '  let width = CGFloat((b["Width"] as? NSNumber)?.doubleValue ?? 0)',
      '  let height = CGFloat((b["Height"] as? NSNumber)?.doubleValue ?? 0)',
      '  if width < 240 || height < 160 { continue }',
      '  let rect = CGRect(x: x, y: y, width: width, height: height)',
      '  let area = width * height',
      '  if best == nil || area > best!.0 { best = (area, rect) }',
      '}',
      'guard let chosen = best?.1 else { exit(0) }',
      'let primary = NSScreen.screens.first(where: { abs($0.frame.origin.x) < 0.5 && abs($0.frame.origin.y) < 0.5 }) ?? NSScreen.main ?? NSScreen.screens[0]',
      'let primaryTop = primary.frame.origin.y + primary.frame.size.height',
      'let electronX = Double(chosen.origin.x)',
      'let electronY = Double(primaryTop - (chosen.origin.y + chosen.size.height))',
      'let w = Double(chosen.size.width)',
      'let h = Double(chosen.size.height)',
      'print(NSString(format: "%.1f,%.1f,%.1f,%.1f", electronX, electronY, w, h))',
    ].join('\n');
    try {
      const out = execFileSync('swift', ['-e', script], {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return parseBoundsCsv(out);
    } catch {
      return null;
    }
  }

  function readSettingsBoundsViaSystemEvents() {
    const script = `
tell application "System Events"
  set procNames to {"System Settings", "System Preferences"}
  repeat with procName in procNames
    try
      if exists process procName then
        tell process procName
          set winCount to count of windows
          if winCount > 0 then
            set w to window 1
            set p to position of w
            set s to size of w
            return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
          end if
        end tell
      end if
    end try
  end repeat
end tell
return ""
`
    try {
      const out = execFileSync('osascript', ['-e', script], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // System Events position 已是顶左原点（屏幕坐标）
      return parseBoundsCsv(out);
    } catch {
      return null;
    }
  }

  function parseBoundsCsv(out) {
    if (!out) return null;
    const parts = out.split(',').map((x) => Number(String(x).trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [x, y, width, height] = parts;
    if (width < 200 || height < 120) return null;
    return { x, y, width, height };
  }

  function clampToDisplay(bounds, display) {
    const area = display.workArea;
    const width = Math.min(bounds.width, area.width - 16);
    const height = Math.min(bounds.height, area.height - 16);
    let x = bounds.x;
    let y = bounds.y;
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
    y = Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8));
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  /**
   * 贴在系统设置窗口底部（列表附近），而不是屏幕底边。
   * 原因：设置窗很高时，“窗口下方”会超出 workArea，旧 clamp 会把浮窗挤到屏幕最底部，看起来离设置很远。
   */
  function computeFloatBounds() {
    const settings = readSystemSettingsWindowBounds();
    if (settings) {
      const display = screen.getDisplayMatching({
        x: Math.round(settings.x),
        y: Math.round(settings.y),
        width: Math.round(settings.width),
        height: Math.round(settings.height),
      });
      const area = display.workArea;
      const width = Math.min(FLOAT_SIZE.width, Math.max(280, settings.width - 48));
      const height = FLOAT_SIZE.height;
      // 水平：相对设置窗口居中
      let x = Math.round(settings.x + (settings.width - width) / 2);
      // 垂直：叠在设置窗口底部内侧（AskForPermission 同款“贴着列表下方”）
      // 略伸到窗口外一点点也没关系，但绝不能被 clamp 甩到屏幕底。
      let y = Math.round(settings.y + settings.height - height - 18);

      // 若底部内侧会跑出 workArea，则贴 workArea 底但仍然水平对齐设置窗
      const minY = area.y + 8;
      const maxY = area.y + area.height - height - 8;
      if (y > maxY) y = maxY;
      if (y < minY) y = minY;
      // 水平限制在 workArea
      const minX = area.x + 8;
      const maxX = area.x + area.width - width - 8;
      if (x < minX) x = minX;
      if (x > maxX) x = maxX;

      // 额外：保证浮窗至少与设置窗垂直重叠/紧邻（不要落到另一个屏幕底）
      const settingsBottom = settings.y + settings.height;
      if (y > settingsBottom + 24) {
        y = Math.round(settingsBottom - height - 12);
        if (y < minY) y = minY;
      }
      return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    }

    // fallback：没有读到设置窗时，仍避免“无脑贴屏幕底”——贴主窗口附近/光标屏中下部
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const x = Math.round(area.x + (area.width - FLOAT_SIZE.width) / 2);
    // 中下部而不是最底：更接近通常 System Settings 弹窗位置
    const y = Math.round(area.y + area.height * 0.62);
    return clampToDisplay(
      { x, y, width: FLOAT_SIZE.width, height: FLOAT_SIZE.height },
      display,
    );
  }

  function positionWindow(win) {
    const bounds = computeFloatBounds();
    win.setBounds(bounds);
    return bounds;
  }

  function buildHtml(payload) {
    const title = payload.isZh
      ? `↑ 将 ${payload.displayName} 拖到上方「完全磁盘访问」列表`
      : `↑ Drag ${payload.displayName} into Full Disk Access list above`;
    const subtitle = payload.isZh
      ? '按住 LOGO 拖进列表 · 列表不会自动出现 App'
      : 'Hold LOGO and drop into the list · apps never auto-appear';
    const logoSrc = payload.logoFileUrl || '';
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
    border: 1px solid rgba(0,0,0,0.10);
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 12px 32px rgba(0,0,0,0.22);
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
  .logo-fallback {
    display: flex; align-items: center; justify-content: center;
    background: #111; color: #fff; font-size: 13px; font-weight: 700;
  }
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; flex: 1; }
  .meta strong {
    font-size: 13px; font-weight: 650; line-height: 1.3;
    color: rgba(20,20,20,0.92);
  }
  .meta span {
    font-size: 11.5px; line-height: 1.35;
    color: rgba(60,60,67,0.72);
  }
  .close {
    border: 0; background: transparent;
    color: rgba(60,60,67,0.55);
    font-size: 18px; line-height: 1;
    width: 28px; height: 28px;
    border-radius: 8px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .close:hover { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.75); }
  .err {
    position: absolute; left: 14px; right: 42px; bottom: 6px;
    font-size: 11px; color: #b42318;
  }
</style>
</head>
<body>
  <div class="card" id="drag" draggable="true" title="${escapeHtml(title)}">
    ${logoSrc
      ? `<img class="logo" src="${escapeHtml(logoSrc)}" alt="" draggable="false" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div class="logo logo-fallback" style="display:none">PA</div>`
      : `<div class="logo logo-fallback">PA</div>`}
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
    // Electron 原生文件拖拽：必须在 dragstart 同步调用 startDrag。
    // preventDefault 避免 HTML5 拖影抢事件，否则会出现“没有拖动过程”。
    drag.addEventListener('dragstart', (e) => {
      err.hidden = true;
      if (!appPath || !window.peerAgent?.startAppDrag) {
        e.preventDefault();
        err.hidden = false;
        err.textContent = 'Drag unavailable';
        return;
      }
      try {
        // 先同步启动原生拖拽，再 preventDefault 接管 HTML5 拖拽
        const result = window.peerAgent.startAppDrag({ appPath });
        if (result && result.ok === false) {
          e.preventDefault();
          err.hidden = false;
          err.textContent = result.error || 'start_drag_failed';
          return;
        }
        // 关键：阻止默认 HTML5 drag，让 Electron startDrag 接管视觉与 payload
        e.preventDefault();
      } catch (ex) {
        e.preventDefault();
        err.hidden = false;
        err.textContent = String(ex && ex.message ? ex.message : ex);
      }
    });
  </script>
</body>
</html>`;
  }

  function ensureWindow() {
    if (floatWindow && !floatWindow.isDestroyed()) return floatWindow;
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
      floatWindow.setAlwaysOnTop(true, 'screen-saver');
      floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch { /* ignore */ }
    floatWindow.on('closed', () => {
      floatWindow = null;
      clearHideTimer();
      clearFollowTimer();
    });
    return floatWindow;
  }

  function startFollowSettings() {
    clearFollowTimer();
    // 用户拖动系统设置窗口时，浮窗跟随贴在其下方
    followTimer = setInterval(() => {
      if (!floatWindow || floatWindow.isDestroyed() || !floatWindow.isVisible()) return;
      try { positionWindow(floatWindow); } catch { /* ignore */ }
    }, 300);
  }

  function show(options = {}) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'unsupported_platform' };
    }
    const target = resolveDragTarget();
    if (!target?.ok || !target.appPath) {
      return { ok: false, error: target?.error || 'app_path_not_found' };
    }

    let logoSrc = '';
    try {
      if (typeof resolveLogoDataUrl === 'function') {
        logoSrc = resolveLogoDataUrl() || '';
      }
    } catch { logoSrc = ''; }
    if (!logoSrc) {
      try {
        const logoPath = typeof resolveLogoFilePath === 'function' ? resolveLogoFilePath() : null;
        if (logoPath && existsSync(logoPath)) {
          logoSrc = pathToFileURL(logoPath).href;
        }
      } catch { logoSrc = ''; }
    }

    const payload = {
      appPath: target.appPath,
      displayName: target.displayName || 'Peer Agent',
      logoFileUrl: logoSrc,
      isZh: options.isZh !== undefined ? options.isZh : isZh(),
    };
    const html = buildHtml(payload);
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const win = ensureWindow();
    const bounds = positionWindow(win);
    void win.loadURL(url);
    if (!win.isVisible()) win.showInactive();
    try { win.moveTop(); } catch { /* ignore */ }
    startFollowSettings();

    clearHideTimer();
    const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : 8 * 60 * 1000;
    if (ttlMs > 0) {
      hideTimer = setTimeout(() => hide(), ttlMs);
    }
    return {
      ok: true,
      appPath: target.appPath,
      displayName: payload.displayName,
      bounds,
      attachedToSettings: Boolean(readSystemSettingsWindowBounds()),
    };
  }

  return {
    show,
    hide,
    destroy,
    isOpen: () => Boolean(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()),
    // test helpers
    _computeFloatBounds: computeFloatBounds,
    _readSystemSettingsWindowBounds: readSystemSettingsWindowBounds,
  };
}
