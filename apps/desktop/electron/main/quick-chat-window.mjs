const DEFAULT_SIZE = Object.freeze({ width: 720, height: 104 });
const TASK_SIZE = Object.freeze({ width: 720, height: 334 });
const POPOVER_MAX_SIZE = Object.freeze({ width: 360, height: 280 });
const POPOVER_GAP = 6;

export function resolveQuickChatPopoverSize(state = {}) {
  const items = Array.isArray(state.items) ? state.items : [];
  const hasDetails = items.some((item) => typeof item?.detail === 'string' && item.detail.length > 0);
  const longestText = items.reduce((length, item) => Math.max(
    length,
    String(item?.label ?? '').length,
    String(item?.detail ?? '').length,
  ), 0);
  const rowHeight = hasDetails ? 44 : 34;
  const width = state.kind === 'effort'
    ? 240
    : Math.min(
      POPOVER_MAX_SIZE.width,
      Math.max(state.kind === 'workspace' ? 280 : 190, 80 + longestText * (hasDetails ? 6.2 : 7.2)),
    );
  const height = state.kind === 'effort'
    ? 72
    : Math.min(POPOVER_MAX_SIZE.height, 12 + Math.max(1, items.length) * rowHeight);
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

export function resolveQuickChatExpandedBounds(parentBounds, anchorRect, _displayBounds, size = POPOVER_MAX_SIZE, baseHeight = DEFAULT_SIZE.height) {
  const popoverBottom = Math.round((anchorRect?.y ?? baseHeight) + (anchorRect?.height ?? 0)) + POPOVER_GAP + size.height;
  return {
    width: parentBounds.width,
    height: Math.max(baseHeight, popoverBottom),
    x: parentBounds.x,
    y: parentBounds.y,
  };
}

export function createQuickChatWindowController({ screen, createWindow }) {
  let quickChatWindow = null;
  let popoverState = null;
  let taskCardVisible = false;

  function baseSize() {
    return taskCardVisible ? TASK_SIZE : DEFAULT_SIZE;
  }

  function resizeForCurrentState({ animate = false } = {}) {
    if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
    const currentBounds = quickChatWindow.getBounds();
    const size = baseSize();
    const baseBounds = { ...currentBounds, width: size.width, height: size.height };
    if (!popoverState) {
      quickChatWindow.setBounds(baseBounds, animate);
      quickChatWindow.setMaximumSize?.(size.width, size.height);
      return;
    }
    const display = screen.getDisplayMatching?.(baseBounds) ?? screen.getAllDisplays()[0];
    const area = display?.workArea ?? display?.bounds ?? baseBounds;
    const expandedBounds = resolveQuickChatExpandedBounds(
      baseBounds,
      popoverState.anchorRect,
      area,
      resolveQuickChatPopoverSize(popoverState),
      size.height,
    );
    // Older running windows may still carry the collapsed native maxHeight.
    // Electron clamps setBounds until that constraint is lifted first.
    quickChatWindow.setMaximumSize?.(size.width, Math.max(expandedBounds.height, area.height));
    quickChatWindow.setBounds(expandedBounds, animate);
  }

  function hidePopover({ restoreFocus = false } = {}) {
    const wasOpen = popoverState !== null;
    popoverState = null;
    if (wasOpen) resizeForCurrentState();
    if (restoreFocus && quickChatWindow && !quickChatWindow.isDestroyed()) {
      quickChatWindow.show();
      quickChatWindow.focus();
      quickChatWindow.webContents.send('quick-chat:popover-closed');
    }
  }

  function ensureWindow() {
    if (quickChatWindow && !quickChatWindow.isDestroyed()) return quickChatWindow;
    quickChatWindow = createWindow();
    quickChatWindow.on('closed', () => {
      popoverState = null;
      quickChatWindow = null;
    });
    quickChatWindow.on('blur', () => {
      if (quickChatWindow && !quickChatWindow.isDestroyed() && !quickChatWindow.webContents.isDevToolsOpened()) {
        hidePopover();
        quickChatWindow.hide();
      }
    });
    return quickChatWindow;
  }

  function showPopover(nextState) {
    if (!nextState || !['workspace', 'model', 'effort', 'mode', 'access'].includes(nextState.kind) || !Array.isArray(nextState.items)) return false;
    popoverState = nextState;
    ensureWindow();
    resizeForCurrentState();
    return true;
  }

  function selectPopoverValue(value) {
    if (!popoverState || !popoverState.items.some((item) => item?.value === value)) return false;
    const kind = popoverState.kind;
    hidePopover({ restoreFocus: true });
    quickChatWindow?.webContents.send('quick-chat:popover-selected', { kind, value });
    return true;
  }

  function show() {
    const win = ensureWindow();
    popoverState = null;
    const bounds = resolveQuickChatBounds({
      cursorPoint: screen.getCursorScreenPoint(),
      displays: screen.getAllDisplays(),
      size: baseSize(),
    });
    win.setBounds(bounds, false);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.show();
    win.focus();
    win.webContents.send('quick-chat:shown');
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
    taskCardVisible = visible;
    const win = quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
    if (!win) return false;
    resizeForCurrentState({ animate: true });
    return true;
  }

  function getWindow() {
    return quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null;
  }

  return {
    show,
    toggle,
    hide,
    setTaskCardVisible,
    getWindow,
    showPopover,
    hidePopover,
    selectPopoverValue,
  };
}

export { DEFAULT_SIZE, POPOVER_MAX_SIZE };
