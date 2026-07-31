const DEFAULT_SIZE = Object.freeze({ width: 720, height: 104 });
const TASK_SIZE = Object.freeze({ width: 720, height: 334 });
const MAX_CONTENT_HEIGHT = 480;
const POPOVER_MAX_SIZE = Object.freeze({ width: 360, height: 360 });
/** Keep in sync with renderer QuickChatPopover gap (flush to bar bottom). */
const POPOVER_GAP = 0;
const POPOVER_VIEWPORT_INSET = 8;
/** Panel padding 6+6 + shell border 1+1 — keep in sync with quick-chat.css. */
const POPOVER_CHROME_HEIGHT = 14;
const RIGHT_ALIGNED_KINDS = new Set(['model', 'effort']);
const POPOVER_KINDS = new Set(['workspace', 'model', 'effort', 'mode', 'access']);

export function clampQuickChatContentHeight(height, { hasTaskCard = false } = {}) {
  const fallback = hasTaskCard ? TASK_SIZE.height : DEFAULT_SIZE.height;
  const numeric = Number(height);
  const next = Number.isFinite(numeric) ? Math.ceil(numeric) : fallback;
  return Math.min(MAX_CONTENT_HEIGHT, Math.max(DEFAULT_SIZE.height, next));
}

export function resolveQuickChatPopoverSize(state = {}) {
  const items = Array.isArray(state.items) ? state.items : [];
  const hasDetails = items.some((item) => typeof item?.detail === 'string' && item.detail.length > 0);
  const longestText = items.reduce((length, item) => Math.max(
    length,
    String(item?.label ?? '').length,
    String(item?.detail ?? '').length,
  ), 0);
  // Detail rows render label + detail (padding 6*2 + lines ~12/10 + gap).
  // Access descriptions may wrap to 2 lines; budget a bit taller than single-line paths.
  const rowHeight = state.kind === 'access'
    ? 58
    : hasDetails
      ? 52
      : 36;
  // Compact content width (not full bar width).
  const minWidth = state.kind === 'workspace'
    ? 300
    : state.kind === 'effort'
      ? 240
      : state.kind === 'access'
        ? 280
        : 190;
  const width = state.kind === 'effort'
    ? 240
    : Math.min(
      POPOVER_MAX_SIZE.width,
      Math.max(minWidth, 80 + longestText * (hasDetails ? 6.2 : 7.2)),
    );
  // Effort panel: heading + slider + tight padding (112 left too much empty air).
  const height = state.kind === 'effort'
    ? 84
    : Math.min(
      POPOVER_MAX_SIZE.height,
      POPOVER_CHROME_HEIGHT + Math.max(1, items.length) * rowHeight,
    );
  return { width: Math.round(width), height: Math.round(height) };
}

export function resolveQuickChatBounds({ cursorPoint, displays, size = DEFAULT_SIZE }) {
  const display = displays.find(({ bounds }) => (
    cursorPoint.x >= bounds.x
    && cursorPoint.x < bounds.x + bounds.width
    && cursorPoint.y >= bounds.y
    && cursorPoint.y < bounds.y + bounds.height
  )) ?? displays[0];
  const area = display?.workArea ?? display?.bounds ?? { x: 0, y: 0, width: size.width, height: size.height };
  return {
    width: size.width,
    height: size.height,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + Math.max(24, area.height * 0.16)),
  };
}

/**
 * @deprecated Inline expand-bar path. Independent popover uses
 * resolveQuickChatPopoverWindowBounds. Kept for transitional geometry tests.
 */
export function resolveQuickChatExpandedBounds(parentBounds, anchorRect, _displayBounds, size = POPOVER_MAX_SIZE, baseHeight = DEFAULT_SIZE.height) {
  const popoverBottom = Math.round((anchorRect?.y ?? baseHeight) + (anchorRect?.height ?? 0)) + POPOVER_GAP + size.height;
  return {
    width: parentBounds.width,
    height: Math.max(baseHeight, popoverBottom),
    x: parentBounds.x,
    y: parentBounds.y,
  };
}

/**
 * Screen-space bounds for an independent popover BrowserWindow.
 * Prefer flush under the bar; flip above when workArea space is insufficient.
 */
export function resolveQuickChatPopoverWindowBounds(barBounds, anchorRect, workArea, popoverSize, kind = '') {
  const size = {
    width: Math.max(1, Math.round(Number(popoverSize?.width) || POPOVER_MAX_SIZE.width)),
    height: Math.max(1, Math.round(Number(popoverSize?.height) || POPOVER_MAX_SIZE.height)),
  };
  const area = workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const bar = barBounds ?? { x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  const anchor = anchorRect && typeof anchorRect === 'object'
    ? {
        x: Number(anchorRect.x) || 0,
        y: Number(anchorRect.y) || 0,
        width: Number(anchorRect.width) || 0,
        height: Number(anchorRect.height) || 0,
      }
    : { x: 0, y: 0, width: bar.width, height: bar.height };

  // Renderer reports viewport-local rects; convert to screen via bar origin.
  const screenAnchor = {
    x: bar.x + anchor.x,
    y: bar.y + anchor.y,
    width: anchor.width,
    height: anchor.height,
  };

  const preferRight = RIGHT_ALIGNED_KINDS.has(kind) || Boolean(anchorRect?.alignRight);
  let left = preferRight
    ? Math.round(screenAnchor.x + screenAnchor.width - size.width)
    : Math.round(screenAnchor.x);
  const minLeft = area.x + POPOVER_VIEWPORT_INSET;
  const maxLeft = area.x + area.width - size.width - POPOVER_VIEWPORT_INSET;
  left = Math.min(Math.max(minLeft, left), Math.max(minLeft, maxLeft));

  const belowTop = Math.round(bar.y + bar.height) + POPOVER_GAP;
  const aboveTop = Math.round(bar.y - size.height) - POPOVER_GAP;
  const spaceBelow = (area.y + area.height) - belowTop - POPOVER_VIEWPORT_INSET;
  const spaceAbove = aboveTop - (area.y + POPOVER_VIEWPORT_INSET);
  let top;
  if (spaceBelow < size.height && spaceAbove > spaceBelow) {
    top = Math.max(area.y + POPOVER_VIEWPORT_INSET, aboveTop);
  } else {
    top = Math.min(belowTop, area.y + area.height - size.height - POPOVER_VIEWPORT_INSET);
    top = Math.max(area.y + POPOVER_VIEWPORT_INSET, top);
  }

  return { x: left, y: top, width: size.width, height: size.height };
}

export function createQuickChatWindowController({
  screen,
  createWindow,
  createPopoverWindow = null,
}) {
  let quickChatWindow = null;
  let popoverWindow = null;
  let popoverState = null;
  let taskCardVisible = false;
  let contentHeight = DEFAULT_SIZE.height;

  function baseSize() {
    return {
      width: DEFAULT_SIZE.width,
      height: clampQuickChatContentHeight(contentHeight, { hasTaskCard: taskCardVisible }),
    };
  }

  function displayForBounds(bounds) {
    return screen.getDisplayMatching?.(bounds)
      ?? screen.getDisplayNearestPoint?.({
        x: Math.round((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2),
        y: Math.round((bounds?.y ?? 0) + (bounds?.height ?? 0) / 2),
      })
      ?? screen.getAllDisplays?.()?.[0]
      ?? null;
  }

  /** Bar height is content-only; never expands for menus. */
  function resizeBarForContent({ animate = false } = {}) {
    if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
    const currentBounds = quickChatWindow.getBounds();
    const size = baseSize();
    const nextBounds = {
      x: currentBounds.x,
      y: currentBounds.y,
      width: size.width,
      height: size.height,
    };
    // Lift max first so Electron does not clamp a taller content height.
    quickChatWindow.setMaximumSize?.(size.width, Math.max(size.height, MAX_CONTENT_HEIGHT));
    quickChatWindow.setBounds(nextBounds, animate);
    quickChatWindow.setMaximumSize?.(size.width, size.height);
  }

  function hidePopover({ restoreFocus = false } = {}) {
    const wasOpen = popoverState !== null;
    popoverState = null;
    if (popoverWindow && !popoverWindow.isDestroyed()) {
      if (typeof popoverWindow.isVisible !== 'function' || popoverWindow.isVisible()) {
        popoverWindow.hide();
      }
    }
    if (wasOpen) resizeBarForContent();
    if (restoreFocus && quickChatWindow && !quickChatWindow.isDestroyed()) {
      quickChatWindow.show();
      quickChatWindow.focus();
      quickChatWindow.webContents?.send?.('quick-chat:popover-closed');
    } else if (wasOpen && quickChatWindow && !quickChatWindow.isDestroyed()) {
      // Match legacy: only notify closed when restoreFocus path used to send.
      // Selection path uses restoreFocus:true. External hide still notifies bar UI.
      quickChatWindow.webContents?.send?.('quick-chat:popover-closed');
    }
  }

  function ensureWindow() {
    if (quickChatWindow && !quickChatWindow.isDestroyed()) return quickChatWindow;
    quickChatWindow = createWindow();
    // 置顶 / 全 Space 可见在创建时配置一次，避免每次 show 都走昂贵的原生层调用。
    quickChatWindow.setAlwaysOnTop?.(true, 'floating');
    quickChatWindow.setVisibleOnAllWorkspaces?.(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    quickChatWindow.on('closed', () => {
      hidePopover({ restoreFocus: false });
      popoverState = null;
      quickChatWindow = null;
    });
    quickChatWindow.on('blur', () => {
      if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
      if (quickChatWindow.webContents?.isDevToolsOpened?.()) return;
      // Keep bar open when focus moved into the independent popover.
      if (popoverWindow && !popoverWindow.isDestroyed()) {
        const popFocused = typeof popoverWindow.isFocused === 'function' && popoverWindow.isFocused();
        const popVisible = typeof popoverWindow.isVisible !== 'function' || popoverWindow.isVisible();
        if (popFocused || (popVisible && popoverState)) return;
      }
      hidePopover({ restoreFocus: false });
      quickChatWindow.hide();
    });
    return quickChatWindow;
  }

  function ensurePopoverWindow() {
    if (typeof createPopoverWindow !== 'function') return null;
    if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;
    popoverWindow = createPopoverWindow();
    if (!popoverWindow) return null;
    popoverWindow.setAlwaysOnTop?.(true, 'floating');
    popoverWindow.setVisibleOnAllWorkspaces?.(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    popoverWindow.on?.('closed', () => {
      popoverWindow = null;
      if (popoverState) {
        popoverState = null;
        if (quickChatWindow && !quickChatWindow.isDestroyed()) {
          quickChatWindow.webContents?.send?.('quick-chat:popover-closed');
        }
      }
    });
    popoverWindow.on?.('blur', () => {
      setTimeout(() => {
        if (!popoverState) return;
        if (!popoverWindow || popoverWindow.isDestroyed()) return;
        const barFocused = quickChatWindow
          && !quickChatWindow.isDestroyed()
          && typeof quickChatWindow.isFocused === 'function'
          && quickChatWindow.isFocused();
        const popFocused = typeof popoverWindow.isFocused === 'function' && popoverWindow.isFocused();
        if (barFocused || popFocused) return;
        hidePopover({ restoreFocus: false });
      }, 0);
    });
    return popoverWindow;
  }

  // 启动后预热：创建并加载 renderer，但不 show，降低首次/再次唤醒冷启动成本。
  function prewarm() {
    ensureWindow();
    if (typeof createPopoverWindow === 'function') ensurePopoverWindow();
    return quickChatWindow;
  }

  function showPopover(nextState) {
    if (!nextState || !POPOVER_KINDS.has(nextState.kind) || !Array.isArray(nextState.items)) {
      return false;
    }
    const win = ensureWindow();
    if (!win || win.isDestroyed()) return false;

    // Toggle same kind closed (bar trigger clicked again).
    if (
      popoverState
      && popoverState.kind === nextState.kind
      && popoverWindow
      && !popoverWindow.isDestroyed()
      && (typeof popoverWindow.isVisible !== 'function' || popoverWindow.isVisible())
    ) {
      hidePopover({ restoreFocus: true });
      return false;
    }

    popoverState = {
      kind: nextState.kind,
      items: nextState.items,
      selectedValue: typeof nextState.selectedValue === 'string' ? nextState.selectedValue : '',
      anchorRect: nextState.anchorRect ?? null,
    };

    // Without an independent popover factory, refuse rather than expand the bar.
    if (typeof createPopoverWindow !== 'function') {
      // Dev/test fallback: still accept state so unit tests without factory can
      // exercise select/hide; they must not expand bar height.
      resizeBarForContent();
      return true;
    }

    const pop = ensurePopoverWindow();
    if (!pop || pop.isDestroyed()) {
      popoverState = null;
      return false;
    }

    const barBounds = win.getBounds();
    const display = displayForBounds(barBounds);
    const area = display?.workArea ?? display?.bounds ?? barBounds;
    const size = resolveQuickChatPopoverSize(popoverState);
    const bounds = resolveQuickChatPopoverWindowBounds(
      barBounds,
      popoverState.anchorRect,
      area,
      size,
      popoverState.kind,
    );

    // Bar stays at content height only.
    resizeBarForContent();
    pop.setMaximumSize?.(POPOVER_MAX_SIZE.width, POPOVER_MAX_SIZE.height);
    pop.setBounds(bounds);
    pop.show();
    pop.focus();
    pop.webContents?.send?.('quick-chat-popover:state', {
      kind: popoverState.kind,
      items: popoverState.items,
      selectedValue: popoverState.selectedValue,
    });
    return true;
  }

  function selectPopoverValue(value) {
    if (!popoverState || !popoverState.items.some((item) => item?.value === value)) return false;
    const kind = popoverState.kind;
    hidePopover({ restoreFocus: true });
    quickChatWindow?.webContents?.send?.('quick-chat:popover-selected', { kind, value });
    return true;
  }

  function show() {
    const win = ensureWindow();
    popoverState = null;
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    const bounds = resolveQuickChatBounds({
      cursorPoint: screen.getCursorScreenPoint(),
      displays: screen.getAllDisplays(),
      size: baseSize(),
    });
    // show 热路径只做定位 + 显示 + 聚焦；置顶/全 Space 已在 ensureWindow 一次性配置。
    // Lift max first so a taller content height is not clamped by a stale max.
    win.setMaximumSize?.(bounds.width, Math.max(bounds.height, MAX_CONTENT_HEIGHT));
    win.setBounds(bounds, false);
    win.setMaximumSize?.(bounds.width, bounds.height);
    win.show();
    win.focus();
    win.webContents?.send?.('quick-chat:shown');
    return win;
  }

  function toggle() {
    const win = quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
    if (win?.isVisible()) {
      hide();
      return false;
    }
    show();
    return true;
  }

  function hide() {
    hidePopover();
    if (quickChatWindow && !quickChatWindow.isDestroyed()) quickChatWindow.hide();
  }

  function setTaskCardVisible(visible) {
    taskCardVisible = Boolean(visible);
    if (taskCardVisible) {
      contentHeight = Math.max(contentHeight, TASK_SIZE.height);
    } else if (contentHeight === TASK_SIZE.height) {
      contentHeight = DEFAULT_SIZE.height;
    }
    const win = quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
    if (!win) return false;
    resizeBarForContent({ animate: true });
    return true;
  }

  function setContentHeight(height) {
    const nextHeight = clampQuickChatContentHeight(height, { hasTaskCard: taskCardVisible });
    if (nextHeight === contentHeight) {
      return { ok: true, height: contentHeight };
    }
    contentHeight = nextHeight;
    const win = quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
    if (win) resizeBarForContent({ animate: false });
    return { ok: true, height: contentHeight };
  }

  function getWindow() {
    return quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
  }

  function getPopoverWindow() {
    return popoverWindow && !popoverWindow.isDestroyed() ? popoverWindow : null;
  }

  return {
    show,
    toggle,
    hide,
    prewarm,
    setTaskCardVisible,
    setContentHeight,
    getWindow,
    getPopoverWindow,
    showPopover,
    hidePopover,
    selectPopoverValue,
  };
}

export { DEFAULT_SIZE, MAX_CONTENT_HEIGHT, POPOVER_MAX_SIZE, TASK_SIZE };
