import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { pickExistingTrayIconPath, resolveTrayIconPaths } from './tray-icon-paths.mjs';

export const TRAY_RECENT_LIMIT = 5;
/** 托盘「更多」二级菜单最多展示到第 N 条（含一级已展示的前 TRAY_RECENT_LIMIT 条）。 */
export const TRAY_RECENT_EXPANDED_LIMIT = 20;
export const TRAY_TITLE_MAX_CHARS = 36;
/**
 * 订阅驱动的托盘菜单重建延迟。
 * CLI/跨进程变更风暴时，2s 仍可能叠到同步 git/list；抬到 5s，点击路径仍即时 refresh。
 */
export const TRAY_SUBSCRIPTION_REFRESH_DELAY_MS = 5_000;
/**
 * 订阅刷新复用最近一次托盘输入的窗口。
 * 指纹未变时跳过 listConversations/listRuns 等同步加载。
 */
export const TRAY_MENU_INPUT_CACHE_TTL_MS = 5_000;

export function truncateTrayTitle(title, maxChars = TRAY_TITLE_MAX_CHARS) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '新任务';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function workspaceShortName(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return '';
  const base = path.basename(workspacePath.trim());
  return base || workspacePath.trim();
}

/** 托盘菜单内容指纹：未变时跳过 Menu.buildFromTemplate / setContextMenu。 */
export function buildTrayMenuFingerprint({
  recent = [],
  recentAutomationRuns = [],
  automationRuntime = null,
} = {}) {
  return JSON.stringify({
    recent: (Array.isArray(recent) ? recent : []).map((item) => ({
      id: item?.id ?? null,
      title: item?.title ?? null,
      updatedAt: item?.updatedAt ?? null,
      workspacePath: item?.workspacePath ?? null,
      status: item?.status ?? null,
    })),
    recentAutomationRuns: (Array.isArray(recentAutomationRuns) ? recentAutomationRuns : []).map((item) => ({
      automationId: item?.automationId ?? null,
      runId: item?.runId ?? null,
      automationName: item?.automationName ?? null,
      status: item?.status ?? null,
      summary: item?.summary ?? null,
      updatedAt: item?.updatedAt ?? null,
    })),
    automationRuntime: automationRuntime
      ? {
          activeCount: automationRuntime.activeCount ?? 0,
          globallyPaused: Boolean(automationRuntime.globallyPaused),
        }
      : null,
  });
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
    recent: labels.recent ?? '最近任务',
    empty: labels.empty ?? '暂无任务',
    more: labels.more ?? '更多',
    newChat: labels.newChat ?? '新任务',
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

  let lastMenuFingerprint = null;
  let cachedMenuInputs = null;
  let cachedMenuInputsAt = 0;

  async function loadTrayMenuInputs({ force = false } = {}) {
    const now = Date.now();
    if (
      !force
      && cachedMenuInputs
      && now - cachedMenuInputsAt < TRAY_MENU_INPUT_CACHE_TTL_MS
    ) {
      return cachedMenuInputs;
    }
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
    const automationRuntime = typeof getAutomationRuntime === 'function'
      ? await getAutomationRuntime()
      : null;
    const inputs = { recent, recentAutomationRuns, automationRuntime };
    cachedMenuInputs = inputs;
    cachedMenuInputsAt = now;
    return inputs;
  }

  async function refresh({ force = false } = {}) {
    if (destroyed || !tray) return;
    try {
      const inputs = await loadTrayMenuInputs({ force });
      const fingerprint = buildTrayMenuFingerprint(inputs);
      if (!force && fingerprint === lastMenuFingerprint) {
        return;
      }
      const template = buildTrayMenuTemplate({
        recent: inputs.recent,
        recentAutomationRuns: inputs.recentAutomationRuns,
        handlers: boundHandlers,
        collapsedLimit: TRAY_RECENT_LIMIT,
        expandedLimit: TRAY_RECENT_EXPANDED_LIMIT,
        automationRuntime: inputs.automationRuntime,
      });
      const menu = Menu.buildFromTemplate(template);
      tray.setContextMenu(menu);
      lastMenuFingerprint = fingerprint;
    } catch (err) {
      console.warn('[tray] refresh failed:', err);
    }
  }

  // 性能治理：订阅驱动刷新抬到 5s 退避；TTL 内复用输入，跳过 listConversations/listRuns。
  // 点击/右键路径仍调用 refresh({ force: true }) 即时刷新。
  function scheduleRefresh(delayMs = TRAY_SUBSCRIPTION_REFRESH_DELAY_MS) {
    if (destroyed) return;
    if (refreshTimer) return; // 已有排队刷新：不提前、不重置（风暴退避）
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
    void refresh({ force: true }).then(() => {
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
    void refresh({ force: true });
  });

  void refresh({ force: true });

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
