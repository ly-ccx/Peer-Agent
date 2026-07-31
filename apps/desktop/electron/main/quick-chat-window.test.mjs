import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQuickChatWindowController,
  resolveQuickChatBounds,
  resolveQuickChatExpandedBounds,
  resolveQuickChatPopoverSize,
  resolveQuickChatPopoverWindowBounds,
} from './quick-chat-window.mjs';

function createFakeWindow(initialBounds = { x: 100, y: 100, width: 720, height: 104 }) {
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
    height: 104,
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
  const expectedHeight = Math.max(104, 72 + 24 + size.height);
  assert.deepEqual(resolveQuickChatExpandedBounds(
    { x: 100, y: 100, width: 720, height: 104 },
    { x: 200, y: 72, width: 100, height: 24 },
    { x: 0, y: 0, width: 1000, height: 760 },
    size,
  ), { x: 100, y: 100, width: 720, height: expectedHeight });
});

test('independent popover window bounds sit under the bar and can flip above', () => {
  const size = { width: 240, height: 120 };
  const below = resolveQuickChatPopoverWindowBounds(
    { x: 100, y: 100, width: 720, height: 104 },
    { x: 20, y: 70, width: 80, height: 24 },
    { x: 0, y: 0, width: 1440, height: 900 },
    size,
    'workspace',
  );
  assert.equal(below.y, 204);
  assert.equal(below.width, 240);
  assert.equal(below.height, 120);

  const above = resolveQuickChatPopoverWindowBounds(
    { x: 100, y: 780, width: 720, height: 104 },
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

test('shows an independent popover window without expanding the bar', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  let popoverCreations = 0;
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => {
      popoverCreations += 1;
      return popover;
    },
  });

  controller.show();
  assert.equal(controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }],
  }), true);

  assert.equal(popoverCreations, 1);
  assert.equal(parent.getBounds().height, 104);
  assert.equal(parent.getBounds().width, 720);
  assert.equal(popover.isVisible(), true);
  assert.equal(popover.getBounds().height > 0, true);
  assert.equal(
    popover.calls.some(([name, channel]) => name === 'send' && channel === 'quick-chat-popover:state'),
    true,
  );
});

test('shows one independent popover and sends a validated selection to the main window', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => popover,
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
  assert.equal(popover.isVisible(), false);
  assert.equal(parent.getBounds().height, 104);
  assert.deepEqual(
    parent.calls.filter(([name, channel]) => name === 'send' && channel === 'quick-chat:popover-selected').at(-1)?.slice(1),
    ['quick-chat:popover-selected', { kind: 'workspace', value: '/two' }],
  );
});

test('keeps bar content height while independent popover is open', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => popover,
  });
  controller.show();
  controller.setContentHeight(160);
  assert.equal(parent.getBounds().height, 160);
  controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }],
  });
  assert.equal(parent.getBounds().height, 160);
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.isVisible(), true);
  assert.equal(parent.getBounds().height, 160);
  assert.equal(popover.isVisible(), false);
});

test('keeps the main window visible while closing the independent popover', () => {
  const parent = createFakeWindow();
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => popover,
  });
  controller.show();
  controller.showPopover({ kind: 'workspace', selectedValue: '/one', anchorRect: {}, items: [{ value: '/one', label: 'one' }] });
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.isVisible(), true);
  assert.equal(parent.getBounds().height, 104);
});

test('restores the design width from a compressed native window across every state change', () => {
  const parent = createFakeWindow({ x: 100, y: 100, width: 208, height: 104 });
  const popover = createFakeWindow({ x: 0, y: 0, width: 200, height: 100 });
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
    createPopoverWindow: () => popover,
  });

  controller.show();
  const shownBounds = parent.getBounds();
  assert.equal(shownBounds.width, 720);
  assert.equal(shownBounds.height, 104);

  controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }],
  });
  assert.equal(parent.getBounds().width, 720);
  assert.equal(parent.getBounds().height, 104);

  controller.hidePopover();
  assert.deepEqual(parent.getBounds(), {
    x: shownBounds.x,
    y: shownBounds.y,
    width: 720,
    height: 104,
  });

  controller.setTaskCardVisible(true);
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 334 });
  controller.setTaskCardVisible(false);
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 104 });
});

test('content height drives window growth while keeping the top edge fixed', () => {
  const parent = createFakeWindow({ x: 100, y: 100, width: 720, height: 104 });
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
