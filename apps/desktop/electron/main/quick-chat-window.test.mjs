import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQuickChatWindowController,
  resolveQuickChatBounds,
  resolveQuickChatExpandedBounds,
  resolveQuickChatPopoverSize,
  resolveQuickChatPopoverWindowBounds,
} from './quick-chat-window.mjs';

function createFakeWindow(initialBounds = { x: 100, y: 100, width: 720, height: 64 }) {
  const handlers = new Map();
  const calls = [];
  let destroyed = false;
  let visible = false;
  let focused = false;
  let devtoolsOpen = false;
  let bounds = { ...initialBounds };
  return {
    calls,
    webContents: {
      isDevToolsOpened: () => devtoolsOpen,
      isLoading: () => false,
      once: (event, handler) => handlers.set(`webContents:${event}`, handler),
      send: (...args) => calls.push(['send', ...args]),
    },
    on: (event, handler) => handlers.set(event, handler),
    emit: (event) => handlers.get(event)?.(),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isFocused: () => focused,
    getBounds: () => ({ ...bounds }),
    setBounds: (nextBounds, animate) => { bounds = { ...bounds, ...nextBounds }; calls.push(['setBounds', nextBounds, animate]); },
    setMaximumSize: (...args) => calls.push(['setMaximumSize', ...args]),
    setAlwaysOnTop: (...args) => calls.push(['setAlwaysOnTop', ...args]),
    setVisibleOnAllWorkspaces: (...args) => calls.push(['setVisibleOnAllWorkspaces', ...args]),
    show: () => { visible = true; focused = true; calls.push(['show']); },
    hide: () => { visible = false; focused = false; calls.push(['hide']); },
    focus: () => { focused = true; calls.push(['focus']); },
    close: () => { destroyed = true; handlers.get('closed')?.(); },
    setDevtoolsOpen: (value) => { devtoolsOpen = value; },
  };
}


function createFakeMenu() {
  const calls = [];
  let lastTemplate = null;
  let lastPopup = null;
  return {
    calls,
    get lastTemplate() { return lastTemplate; },
    get lastPopup() { return lastPopup; },
    buildFromTemplate: (template) => {
      lastTemplate = template;
      calls.push(['buildFromTemplate', template]);
      return {
        popup: (opts) => {
          lastPopup = opts;
          calls.push(['popup', opts]);
          // Tests can invoke selection via template click.
        },
      };
    },
  };
}

const screen = {
  getCursorScreenPoint: () => ({ x: 1200, y: 200 }),
  getAllDisplays: () => [
    { bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 } },
    { bounds: { x: 1000, y: 0, width: 1200, height: 900 }, workArea: { x: 1000, y: 20, width: 1200, height: 840 } },
  ],
  getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 } }),
  getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 } }),
};

test('positions the floating window on the display containing the cursor', () => {
  assert.deepEqual(resolveQuickChatBounds({
    cursorPoint: { x: 1200, y: 200 },
    displays: screen.getAllDisplays(),
  }), {
    width: 720,
    height: 64,
    x: 1000 + Math.round((1200 - 720) / 2),
    y: Math.round(20 + Math.max(24, 840 * 0.16)),
  });
});

test('sizes the popover from content width (compact), not full bar width', () => {
  const size = resolveQuickChatPopoverSize({
    kind: 'workspace',
    items: [
      { value: '/one', label: 'alpha', detail: '/Users/demo/one' },
      { value: '/two', label: 'beta', detail: '/Users/demo/two' },
    ],
  });
  assert.equal(size.width < 720, true);
  assert.equal(size.width >= 280, true);
  assert.equal(size.height > 0, true);
});

test('legacy expanded bounds only grow downward without moving top edge', () => {
  const size = resolveQuickChatPopoverSize({
    kind: 'model',
    items: [{ value: 'a', label: 'Model A' }],
  });
  const expectedHeight = Math.max(80, 72 + 24 + size.height);
  assert.deepEqual(resolveQuickChatExpandedBounds(
    { x: 100, y: 100, width: 720, height: 64 },
    { x: 200, y: 72, width: 100, height: 24 },
    { x: 0, y: 0, width: 1000, height: 760 },
    size,
  ), { x: 100, y: 100, width: 720, height: expectedHeight });
});

test('independent popover window bounds sit under the bar and can flip above', () => {
  const size = { width: 240, height: 120 };
  const below = resolveQuickChatPopoverWindowBounds(
    { x: 100, y: 100, width: 720, height: 64 },
    { x: 20, y: 70, width: 80, height: 24 },
    { x: 0, y: 0, width: 1440, height: 900 },
    size,
    'workspace',
  );
  assert.equal(below.y, 164);
  assert.equal(below.width, 240);
  assert.equal(below.height, 120);

  const above = resolveQuickChatPopoverWindowBounds(
    { x: 100, y: 780, width: 720, height: 64 },
    { x: 20, y: 70, width: 80, height: 24 },
    { x: 0, y: 0, width: 1440, height: 900 },
    size,
    'workspace',
  );
  assert.equal(above.y < 780, true);
  assert.equal(above.height, 120);
});

test('creates one main window and toggles its visibility', () => {
  let creations = 0;
  const window = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => { creations += 1; return window; } });
  assert.equal(controller.toggle(), true);
  assert.equal(controller.toggle(), false);
  assert.equal(controller.show(), window);
  assert.equal(creations, 1);
  assert.equal(window.getBounds().width, 720);
  assert.equal(window.isVisible(), true);
});

test('configures always-on-top once at create, not on every show', () => {
  const window = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => window });
  // ensureWindow configures always-on-top during first show/create
  controller.show();
  const createCalls = window.calls.filter(([name]) => name === 'setAlwaysOnTop' || name === 'setVisibleOnAllWorkspaces');
  assert.equal(createCalls.length >= 2, true);
  window.calls.length = 0;
  controller.hide();
  controller.show();
  const showCalls = window.calls.filter(([name]) => name === 'setAlwaysOnTop' || name === 'setVisibleOnAllWorkspaces');
  assert.equal(showCalls.length, 0);
  assert.equal(window.calls.filter(([name]) => name === 'setBounds').length >= 1, true);
  assert.equal(window.calls.filter(([name]) => name === 'show').length, 1);
});

test('shows native Menu for simple enums without creating a popover window', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  let popoverCreations = 0;
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => {
      popoverCreations += 1;
      return popover;
    },
    Menu: menu,
  });

  controller.show();
  assert.equal(controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }],
  }), true);

  assert.equal(popoverCreations, 0);
  assert.equal(parent.getBounds().height, 64);
  assert.equal(popover.isVisible(), false);
  assert.equal(menu.calls.some(([name]) => name === 'buildFromTemplate'), true);
  assert.equal(menu.calls.some(([name]) => name === 'popup'), true);
  assert.equal(menu.lastTemplate?.length, 2);
  assert.equal(menu.lastTemplate?.[0]?.checked, true);
  // Menu.popup coords are window-local (not screen absolute).
  assert.deepEqual(
    { x: menu.lastPopup?.x, y: menu.lastPopup?.y },
    { x: 180, y: 96 },
  );
});

test('shows native Menu for effort options without creating a popover window', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  let popoverCreations = 0;
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => {
      popoverCreations += 1;
      return popover;
    },
    Menu: menu,
  });

  controller.show();
  assert.equal(controller.showPopover({
    kind: 'effort',
    selectedValue: 'high',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }],
  }), true);

  assert.equal(popoverCreations, 0);
  assert.equal(parent.getBounds().height, 64);
  assert.equal(popover.isVisible(), false);
  assert.equal(menu.lastTemplate?.length, 2);
  assert.equal(menu.lastTemplate?.[0]?.label, 'High');
  assert.equal(menu.lastTemplate?.[0]?.checked, true);
});

test('native Menu selection validates and sends to the main window', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'workspace',
    selectedValue: '/one',
    anchorRect: { x: 12, y: 72, width: 120, height: 24 },
    items: [
      { value: '/one', label: 'one' },
      { value: '/two', label: 'two' },
    ],
  }), true);
  assert.equal(controller.selectPopoverValue('/missing'), false);
  assert.equal(controller.selectPopoverValue('/two'), true);
  assert.equal(parent.getBounds().height, 64);
  assert.deepEqual(
    parent.calls.filter(([name, channel]) => name === 'send' && channel === 'quick-chat:popover-selected').at(-1)?.slice(1),
    ['quick-chat:popover-selected', { kind: 'workspace', value: '/two' }],
  );
});

test('effort menu selection validates and sends to the main window', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'effort',
    selectedValue: 'high',
    anchorRect: { x: 12, y: 72, width: 120, height: 24 },
    items: [
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ],
  }), true);
  assert.equal(controller.selectPopoverValue('missing'), false);
  assert.equal(controller.selectPopoverValue('low'), true);
  assert.equal(parent.getBounds().height, 64);
  assert.deepEqual(
    parent.calls.filter(([name, channel]) => name === 'send' && channel === 'quick-chat:popover-selected').at(-1)?.slice(1),
    ['quick-chat:popover-selected', { kind: 'effort', value: 'low' }],
  );
});

test('groups model items into provider submenus', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'model',
    selectedValue: 'm2',
    anchorRect: { x: 10, y: 10, width: 40, height: 20 },
    items: [
      { value: 'm1', label: 'gpt-a', group: 'OpenAI' },
      { value: 'm2', label: 'gpt-b', group: 'OpenAI' },
      { value: 'm3', label: 'claude-a', group: 'Anthropic' },
      { value: 'flat', label: 'standalone' },
    ],
  }), true);

  assert.equal(menu.lastTemplate?.length, 3);
  assert.equal(menu.lastTemplate?.[0]?.label, 'OpenAI');
  assert.equal(Array.isArray(menu.lastTemplate?.[0]?.submenu), true);
  assert.equal(menu.lastTemplate?.[0]?.submenu?.length, 2);
  assert.equal(menu.lastTemplate?.[0]?.submenu?.[1]?.label, 'gpt-b');
  assert.equal(menu.lastTemplate?.[0]?.submenu?.[1]?.checked, true);
  assert.equal(menu.lastTemplate?.[1]?.label, 'Anthropic');
  assert.equal(menu.lastTemplate?.[1]?.submenu?.length, 1);
  assert.equal(menu.lastTemplate?.[2]?.label, 'standalone');
  assert.equal(menu.lastTemplate?.[2]?.type, 'checkbox');
});

test('keeps bar content height while native menu is open', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  controller.setContentHeight(160);
  assert.equal(parent.getBounds().height, 160);
  controller.showPopover({
    kind: 'effort',
    selectedValue: 'high',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'high', label: 'High' }],
  });
  assert.equal(parent.getBounds().height, 160);
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.isVisible(), true);
  assert.equal(parent.getBounds().height, 160);
});

test('keeps the main window visible while closing the native menu state', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  controller.showPopover({ kind: 'effort', selectedValue: 'high', anchorRect: {}, items: [{ value: 'high', label: 'High' }] });
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.isVisible(), true);
  assert.equal(parent.getBounds().height, 64);
});

test('restores the design width from a compressed native window across every state change', () => {
  const parent = createFakeWindow({ x: 100, y: 100, width: 208, height: 64 });
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });

  controller.show();
  const shownBounds = parent.getBounds();
  assert.equal(shownBounds.width, 720);
  assert.equal(shownBounds.height, 64);

  controller.showPopover({
    kind: 'effort',
    selectedValue: 'high',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'high', label: 'High' }],
  });
  assert.equal(parent.getBounds().width, 720);
  assert.equal(parent.getBounds().height, 64);

  controller.hidePopover();
  assert.deepEqual(parent.getBounds(), {
    x: shownBounds.x,
    y: shownBounds.y,
    width: 720,
    height: 64,
  });

  controller.setTaskCardVisible(true);
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 334 });
  controller.setTaskCardVisible(false);
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 64 });
});

test('content height drives window growth while keeping the top edge fixed', () => {
  const parent = createFakeWindow({ x: 100, y: 100, width: 720, height: 64 });
  const controller = createQuickChatWindowController({ screen, createWindow: () => parent });
  controller.show();
  const shownBounds = parent.getBounds();

  const result = controller.setContentHeight(180);
  assert.deepEqual(result, { ok: true, height: 180 });
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 180 });

  const clamped = controller.setContentHeight(999);
  assert.deepEqual(clamped, { ok: true, height: 480 });
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 480 });

  const same = controller.setContentHeight(480);
  assert.deepEqual(same, { ok: true, height: 480 });
});

test('hides on blur but remains visible while devtools is open', () => {
  const window = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => window });
  controller.show();
  window.setDevtoolsOpen(true);
  window.emit('blur');
  assert.equal(window.isVisible(), true);
  window.setDevtoolsOpen(false);
  window.emit('blur');
  assert.equal(window.isVisible(), false);
});

test('recreates the singleton after it is closed', () => {
  const windows = [createFakeWindow(), createFakeWindow()];
  let index = 0;
  const controller = createQuickChatWindowController({ screen, createWindow: () => windows[index++] });
  controller.show();
  windows[0].close();
  assert.equal(controller.show(), windows[1]);
  assert.equal(index, 2);
});

test('keeps bar visible while native Menu is open even if bar blurs', () => {
  const parent = createFakeWindow();
  const menu = createFakeMenu();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'mode',
    selectedValue: 'agent',
    anchorRect: { x: 20, y: 70, width: 80, height: 24 },
    items: [{ value: 'agent', label: 'Agent' }, { value: 'chat', label: 'Chat' }],
  }), true);
  parent.emit('blur');
  assert.equal(parent.isVisible(), true);
});

test('menuSelection survives popup callback after click', () => {
  const parent = createFakeWindow();
  const calls = [];
  let lastTemplate = null;
  const menu = {
    calls,
    buildFromTemplate: (template) => {
      lastTemplate = template;
      calls.push(['buildFromTemplate', template]);
      return {
        popup: (opts) => {
          calls.push(['popup', opts]);
          // Click second item, then close callback (common macOS order variants).
          template[1]?.click?.();
          opts?.callback?.();
        },
      };
    },
  };
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    Menu: menu,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'mode',
    selectedValue: 'agent',
    anchorRect: { x: 10, y: 10, width: 40, height: 20 },
    items: [
      { value: 'agent', label: 'Agent' },
      { value: 'chat', label: 'Chat' },
    ],
  }), true);
  assert.equal(lastTemplate?.length, 2);
  const selected = parent.calls.filter(([name, channel]) => name === 'send' && channel === 'quick-chat:popover-selected');
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].slice(1), ['quick-chat:popover-selected', { kind: 'mode', value: 'chat' }]);
  // Dismiss closed event should not fire after a successful selection.
  const closed = parent.calls.filter(([name, channel]) => name === 'send' && channel === 'quick-chat:popover-closed');
  assert.equal(closed.length, 0);
});

test('destroy closes owned windows once and clears controller references', () => {
  const parent = createFakeWindow();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
  });

  controller.prewarm();
  assert.equal(controller.getWindow(), parent);

  controller.destroy();
  controller.destroy();

  assert.equal(parent.isDestroyed(), true);
  assert.equal(controller.getWindow(), null);
});

