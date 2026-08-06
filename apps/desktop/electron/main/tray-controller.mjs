import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { pickExistingTrayIconPath, resolveTrayIconPaths } from './tray-icon-paths.mjs';

export const TRAY_RECENT_LIMIT = 5;
/** 托盘「更多」二级菜单最多展示到第 N 条（含一级已展示的前 TRAY_RECENT_LIMIT 条）。 */
export const TRAY_RECENT_EXPANDED_LIMIT = 20;
export const TRAY_TITLE_MAX_CHARS = 36;

export function truncateTrayTitle(title, maxChars = TRAY_TITLE_MAX_CHARS) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '新会话';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function workspaceShortName(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return '';
  const base = path.basename(workspacePath.trim());
  return base || workspacePath.trim();
}

/**
 * Pure menu template builder (testable without Electron).
 * Labels intentionally bilingual-capable; default Chinese product copy for MVP.
 */
export function buildTrayMenuTemplate({
  recent = [],
  labels = {},
  handlers = {},
  collapsedLimit = TRAY_RECENT_LIMIT,
  expandedLimit = TRAY_RECENT_EXPANDED_LIMIT,
  automationRuntime = null,
  recentAutomationRuns = [],
} = {}) {
  const L = {
    recent: labels.recent ?? '最近会话',
    empty: labels.empty ?? '暂无会话',
    more: labels.more ?? '更多',
    newChat: labels.newChat ?? '新会话',
    open: labels.open ?? '打开 Peer Agent',
    quit: labels.quit ?? '退出 Peer Agent',
  };

  const items = [];
  items.push({ label: L.recent, enabled: false });

  const all = Array.isArray(recent)
    ? recent.filter((c) => typeof c?.id === 'string' && c.id)
    : [];
  const primaryLimit = Math.max(1, Number(collapsedLimit) || TRAY_RECENT_LIMIT);
  const totalLimit = Math.max(primaryLimit, Number(expandedLimit) || TRAY_RECENT_EXPANDED_LIMIT);
  const capped = all.slice(0, totalLimit);
  const primary = capped.slice(0, primaryLimit);
  const overflow = capped.slice(primaryLimit);

  const toRecentItem = (conversation) => {
    const id = conversation.id;
    const title = truncateTrayTitle(conversation.title);
    // macOS native menus ignore "\n" in label; use Electron MenuItem.sublabel
    // (darwin >= 14.4) so workspace appears as a second line like Codex.
    const subtitle = workspaceShortName(conversation.workspacePath);
    return {
      label: title,
      ...(subtitle ? { sublabel: subtitle } : {}),
      id: `tray-recent:${id}`,
      click: () => {
        handlers.onOpenConversation?.({
          conversationId: id,
          workspacePath: typeof conversation.workspacePath === 'string'
            ? conversation.workspacePath
            : '',
          source: 'tray-recent',
        });
      },
    };
  };

  if (primary.length === 0) {
    items.push({ label: L.empty, enabled: false });
  } else {
    for (const conversation of primary) {
      items.push(toRecentItem(conversation));
    }
  }

  // 溢出会话放进「更多」二级菜单，避免一级菜单被拉长。
  if (overflow.length > 0) {
    items.push({ type: 'separator' });
    items.push({
      label: L.more,
      id: 'tray-more',
      submenu: overflow.map((conversation) => toRecentItem(conversation)),
    });
  }

  items.push({ type: 'separator' });
  if (automationRuntime) {
    items.push({ label: `Automations · ${automationRuntime.activeCount ?? 0} active`, enabled: false });
    const recentRuns = Array.isArray(recentAutomationRuns) ? recentAutomationRuns.slice(0, 3) : [];
    for (const run of recentRuns) {
      const summary = truncateTrayTitle(run.summary || run.status || 'Result');
      items.push({
        label: truncateTrayTitle(run.automationName || 'Automation'),
        sublabel: `${run.status || 'completed'} · ${summary}`,
        id: `tray-automation-run-${run.runId}`,
        click: () => handlers.onOpenAutomationRun?.({ automationId: run.automationId, runId: run.runId }),
      });
    }
    items.push({
      label: automationRuntime.globallyPaused ? 'Resume all automations' : 'Pause all automations',
      id: 'tray-automations-toggle',
      click: () => handlers.onToggleAutomations?.(!automationRuntime.globallyPaused),
    });
    items.push({ label: 'Open Automations', id: 'tray-automations-open', click: () => handlers.onOpenAutomations?.() });
    items.push({ type: 'separator' });
  }
  items.push({
    label: L.newChat,
    id: 'tray-new-chat',
    click: () => handlers.onNewChat?.(),
  });
  items.push({
    label: L.open,
    id: 'tray-open',
    click: () => handlers.onOpenApp?.(),
  });
  items.push({ type: 'separator' });
  items.push({
    label: L.quit,
    id: 'tray-quit',
    click: () => handlers.onQuit?.(),
  });

  return items;
}

function loadTrayImage(nativeImage, iconPath) {
  if (!iconPath || !existsSync(iconPath)) return null;
  try {
    const base = path.basename(iconPath);
    const is2xName = /@2x\./i.test(base);
    let image = null;

    // For @2x / 32px templates, load via buffer + scaleFactor so macOS treats
    // them as 16pt Retina bitmaps. Never downscale 32→16 (that causes chunky edges).
    if (is2xName && typeof nativeImage?.createFromBuffer === 'function') {
      try {
        const buffer = readFileSync(iconPath);
        image = nativeImage.createFromBuffer(buffer, { scaleFactor: 2.0 });
      } catch {
        image = null;
      }
    }
    if (!image || image.isEmpty?.()) {
      image = nativeImage.createFromPath(iconPath);
    }
    if (!image || image.isEmpty?.()) return null;

    if (typeof image.getSize === 'function') {
      const size = image.getSize();
      const w = Number(size?.width) || 0;
      const h = Number(size?.height) || 0;
      // Oversized non-@2x fallback only (e.g. 64 favicon) → 16pt.
      if (!is2xName && (w > 18 || h > 18) && !(w >= 30 && w <= 34 && h >= 30 && h <= 34)) {
        image = image.resize({ width: 16, height: 16 });
      }
    }

    // macOS Template naming + setTemplateImage enables auto invert on menu bar.
    if (typeof image.setTemplateImage === 'function') {
      image.setTemplateImage(true);
    }
    return image;
  } catch {
    return null;
  }
}

/**
 * Create macOS/Windows tray controller for recent conversations.
 *
 * deps:
 * - Tray, Menu, nativeImage (electron)
 * - resolvePaths / listRecentConversations / handlers
 */
export function createTrayController({
  Tray,
  Menu,
  nativeImage,
  app,
  isPackaged,
  workspaceRoot,
  resourcesRoot,
  listRecentConversations,
  listRecentAutomationRuns = null,
  getAutomationRuntime = null,
  handlers = {},
  platform = process.platform,
} = {}) {
  if (typeof Tray !== 'function' || typeof Menu?.buildFromTemplate !== 'function') {
    return {
      isActive: () => false,
      refresh: async () => {},
      destroy: () => {},
    };
  }

  const paths = resolveTrayIconPaths({ isPackaged, workspaceRoot, resourcesRoot });
  const iconPath = pickExistingTrayIconPath(paths, { existsSync });
  const image = loadTrayImage(nativeImage, iconPath);
  if (!image) {
    console.warn('[tray] icon missing or empty, tray disabled:', iconPath);
    return {
      isActive: () => false,
      refresh: async () => {},
      destroy: () => {},
    };
  }

  let tray = null;
  let destroyed = false;
  let refreshTimer = null;

  const boundHandlers = {
    onOpenConversation: (payload) => handlers.onOpenConversation?.(payload),
    onNewChat: () => handlers.onNewChat?.(),
    onOpenApp: () => handlers.onOpenApp?.(),
    onOpenAutomations: () => handlers.onOpenAutomations?.(),
    onOpenAutomationRun: (target) => handlers.onOpenAutomationRun?.(target),
    onToggleAutomations: (paused) => handlers.onToggleAutomations?.(paused),
    onQuit: () => handlers.onQuit?.(),
  };

  async function buildMenu() {
    let recent = [];
    try {
      // 一次取到 expanded 上限，模板把溢出项放进「更多」二级菜单。
      const listed = await listRecentConversations?.({ limit: TRAY_RECENT_EXPANDED_LIMIT });
      recent = Array.isArray(listed) ? listed : [];
    } catch (err) {
      console.warn('[tray] listRecentConversations failed:', err);
      recent = [];
    }
    let recentAutomationRuns = [];
    try {
      const listed = await listRecentAutomationRuns?.({ limit: 3 });
      recentAutomationRuns = Array.isArray(listed) ? listed : [];
    } catch (err) {
      console.warn('[tray] listRecentAutomationRuns failed:', err);
    }
    const template = buildTrayMenuTemplate({
      recent,
      recentAutomationRuns,
      handlers: boundHandlers,
      collapsedLimit: TRAY_RECENT_LIMIT,
      expandedLimit: TRAY_RECENT_EXPANDED_LIMIT,
      automationRuntime: typeof getAutomationRuntime === 'function' ? await getAutomationRuntime() : null,
    });
    return Menu.buildFromTemplate(template);
  }

  async function refresh() {
    if (destroyed || !tray) return;
    try {
      const menu = await buildMenu();
      tray.setContextMenu(menu);
    } catch (err) {
      console.warn('[tray] refresh failed:', err);
    }
  }

  function scheduleRefresh(delayMs = 120) {
    if (destroyed) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  tray = new Tray(image);
  tray.setToolTip(typeof app?.name === 'string' && app.name ? app.name : 'Peer Agent');
  if (platform === 'darwin' && typeof tray.setIgnoreDoubleClickEvents === 'function') {
    tray.setIgnoreDoubleClickEvents(true);
  }

  // Rebuild on open-ish interactions so Recent stays fresh without polling.
  tray.on?.('click', () => {
    void refresh().then(() => {
      // On some platforms left-click does not auto-open context menu.
      if (platform !== 'darwin' && tray && !destroyed) {
        try {
          tray.popUpContextMenu?.();
        } catch {
          // ignore
        }
      }
    });
  });
  tray.on?.('right-click', () => {
    void refresh();
  });

  void refresh();

  return {
    isActive: () => Boolean(tray) && !destroyed,
    refresh,
    scheduleRefresh,
    destroy: () => {
      destroyed = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (tray) {
        try {
          tray.destroy();
        } catch {
          // ignore
        }
        tray = null;
      }
    },
  };
}
