const DEFAULT_SIZE = Object.freeze({ width: 720, height: 104 });
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

export function resolveQuickChatWindowBackground(appearance, systemUsesDarkColors = false) {
  const mode = appearance?.mode;
  const followsSystem = mode === 'system' || mode == null;
  const useDark = mode === 'dark' || (followsSystem && systemUsesDarkColors);
  return useDark ? '#11141A' : '#F7F8FA';
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

export function resolveQuickChatPopoverBounds(parentBounds, anchorRect, displayBounds, size = POPOVER_MAX_SIZE) {
  const anchorX = parentBounds.x + Math.round(anchorRect?.x ?? 0);
  const anchorBottom = parentBounds.y + Math.round((anchorRect?.y ?? parentBounds.height) + (anchorRect?.height ?? 0));
  const minX = displayBounds.x + 8;
  const maxX = displayBounds.x + displayBounds.width - size.width - 8;
  const minY = displayBounds.y + 8;
  const maxY = displayBounds.y + displayBounds.height - size.height - 8;
  const roomBelow = displayBounds.y + displayBounds.height - anchorBottom;
  const preferredY = roomBelow >= size.height + POPOVER_GAP
    ? anchorBottom + POPOVER_GAP
    : parentBounds.y - size.height - POPOVER_GAP;
  return {
    width: size.width,
    height: size.height,
    x: Math.min(maxX, Math.max(minX, anchorX)),
    y: Math.min(maxY, Math.max(minY, preferredY)),
  };
}

export function createQuickChatWindowController({ screen, createWindow, createPopoverWindow }) {
  let quickChatWindow = null;
  let popoverWindow = null;
  let popoverState = null;
  let suppressParentBlur = false;

  function hidePopover({ restoreFocus = false } = {}) {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    popoverState = null;
    suppressParentBlur = false;
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
      if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.close();
      popoverWindow = null;
      popoverState = null;
      quickChatWindow = null;
    });
    quickChatWindow.on('blur', () => {
      if (suppressParentBlur) return;
      if (quickChatWindow && !quickChatWindow.isDestroyed() && !quickChatWindow.webContents.isDevToolsOpened()) {
        hidePopover();
        quickChatWindow.hide();
      }
    });
    quickChatWindow.on('move', () => { if (popoverState) positionPopover(); });
    return quickChatWindow;
  }

  function ensurePopoverWindow() {
    if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;
    popoverWindow = createPopoverWindow(ensureWindow());
    popoverWindow.on('closed', () => {
      popoverWindow = null;
      popoverState = null;
      suppressParentBlur = false;
    });
    popoverWindow.on('blur', () => {
      if (popoverWindow && !popoverWindow.isDestroyed() && !popoverWindow.webContents.isDevToolsOpened()) {
        hidePopover({ restoreFocus: true });
      }
    });
    return popoverWindow;
  }

  function positionPopover() {
    if (!popoverState || !quickChatWindow || quickChatWindow.isDestroyed()) return;
    const picker = ensurePopoverWindow();
    const parentBounds = quickChatWindow.getBounds();
    const display = screen.getDisplayMatching?.(parentBounds) ?? screen.getAllDisplays()[0];
    const area = display?.workArea ?? display?.bounds ?? parentBounds;
    const size = resolveQuickChatPopoverSize(popoverState);
    picker.setBounds(resolveQuickChatPopoverBounds(parentBounds, popoverState.anchorRect, area, size), false);
  }

  function showPopover(nextState) {
    if (!nextState || !['workspace', 'model', 'effort', 'mode', 'access'].includes(nextState.kind) || !Array.isArray(nextState.items)) return false;
    popoverState = nextState;
    suppressParentBlur = true;
    const picker = ensurePopoverWindow();
    positionPopover();
    picker.setAlwaysOnTop(true, 'floating');
    picker.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const sendState = () => picker.webContents.send('quick-chat-popover:state', popoverState);
    if (picker.webContents.isLoading?.()) picker.webContents.once?.('did-finish-load', sendState);
    else sendState();
    picker.show();
    picker.focus();
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
    const bounds = resolveQuickChatBounds({
      cursorPoint: screen.getCursorScreenPoint(),
      displays: screen.getAllDisplays(),
      size: DEFAULT_SIZE,
    });
    win.setBounds(bounds, false);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
    getWindow,
    getPopoverWindow,
    showPopover,
    hidePopover,
    selectPopoverValue,
  };
}

export { DEFAULT_SIZE, POPOVER_MAX_SIZE };
