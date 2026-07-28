import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { pickExistingTrayIconPath, resolveTrayIconPaths } from './tray-icon-paths.mjs';

export const TRAY_RECENT_LIMIT = 5;
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

  const list = Array.isArray(recent) ? recent.slice(0, TRAY_RECENT_LIMIT) : [];
  if (list.length === 0) {
    items.push({ label: L.empty, enabled: false });
  } else {
    for (const conversation of list) {
      const id = typeof conversation?.id === 'string' ? conversation.id : '';
      if (!id) continue;
      const title = truncateTrayTitle(conversation.title);
      // macOS native menus ignore "\n" in label; use Electron MenuItem.sublabel
      // (darwin >= 14.4) so workspace appears as a second line like Codex.
      const subtitle = workspaceShortName(conversation.workspacePath);
      items.push({
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
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    label: L.more,
    id: 'tray-more',
    click: () => handlers.onMore?.(),
  });
  items.push({ type: 'separator' });
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
    onMore: () => handlers.onMore?.(),
    onNewChat: () => handlers.onNewChat?.(),
    onOpenApp: () => handlers.onOpenApp?.(),
    onQuit: () => handlers.onQuit?.(),
  };

  async function buildMenu() {
    let recent = [];
    try {
      const listed = await listRecentConversations?.({ limit: TRAY_RECENT_LIMIT });
      recent = Array.isArray(listed) ? listed : [];
    } catch (err) {
      console.warn('[tray] listRecentConversations failed:', err);
      recent = [];
    }
    const template = buildTrayMenuTemplate({ recent, handlers: boundHandlers });
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
