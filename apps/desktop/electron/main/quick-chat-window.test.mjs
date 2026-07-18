import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQuickChatWindowController,
  resolveQuickChatBounds,
  resolveQuickChatExpandedBounds,
  resolveQuickChatPopoverSize,
} from './quick-chat-window.mjs';

function createFakeWindow(initialBounds = { x: 100, y: 100, width: 720, height: 104 }) {
  const handlers = new Map();
  const calls = [];
  let destroyed = false;
  let visible = false;
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
    getBounds: () => ({ ...bounds }),
    setBounds: (nextBounds, animate) => { bounds = { ...bounds, ...nextBounds }; calls.push(['setBounds', nextBounds, animate]); },
    setMaximumSize: (...args) => calls.push(['setMaximumSize', ...args]),
    setAlwaysOnTop: (...args) => calls.push(['setAlwaysOnTop', ...args]),
    setVisibleOnAllWorkspaces: (...args) => calls.push(['setVisibleOnAllWorkspaces', ...args]),
    show: () => { visible = true; calls.push(['show']); },
    hide: () => { visible = false; calls.push(['hide']); },
    focus: () => calls.push(['focus']),
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
};

test('positions the floating window on the display containing the cursor', () => {
  assert.deepEqual(resolveQuickChatBounds({
    cursorPoint: screen.getCursorScreenPoint(), displays: screen.getAllDisplays(), size: { width: 600, height: 200 },
  }), { x: 1300, y: 154, width: 600, height: 200 });
});

test('sizes the inline popover from its item count instead of reserving an empty fixed panel', () => {
  assert.deepEqual(resolveQuickChatPopoverSize({
    kind: 'workspace',
    items: [
      { label: 'one', detail: '/workspaces/one' },
      { label: 'two', detail: '/workspaces/two' },
    ],
  }), { width: 280, height: 100 });
  assert.deepEqual(resolveQuickChatPopoverSize({
    kind: 'effort',
    items: [{ label: '标准思考' }, { label: '深度思考' }],
  }), { width: 240, height: 72 });
});

test('expands the main window only downward without moving its top edge', () => {
  const size = { width: 280, height: 100 };
  assert.deepEqual(resolveQuickChatExpandedBounds(
    { x: 100, y: 100, width: 720, height: 104 },
    { x: 200, y: 72, width: 100, height: 24 },
    { x: 0, y: 0, width: 1000, height: 760 },
    size,
  ), { x: 100, y: 100, width: 720, height: 202 });
  assert.deepEqual(resolveQuickChatExpandedBounds(
    { x: 100, y: 650, width: 720, height: 104 },
    { x: 20, y: 72, width: 100, height: 24 },
    { x: 0, y: 0, width: 1000, height: 760 },
    size,
  ), { x: 100, y: 650, width: 720, height: 202 });
});

test('creates one main window and toggles its visibility', () => {
  let creations = 0;
  const window = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => { creations += 1; return window; } });
  assert.equal(controller.toggle(), true);
  assert.equal(controller.toggle(), false);
  assert.equal(controller.show(), window);
  assert.equal(creations, 1);
  assert.equal(window.getBounds().height, 104);
});

test('applies always-on-top and all-workspaces once on create, not on every show', () => {
  const window = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => window });

  controller.prewarm();
  const afterCreate = window.calls.filter(([name]) => name === 'setAlwaysOnTop' || name === 'setVisibleOnAllWorkspaces');
  assert.equal(afterCreate.filter(([name]) => name === 'setAlwaysOnTop').length, 1);
  assert.equal(afterCreate.filter(([name]) => name === 'setVisibleOnAllWorkspaces').length, 1);

  window.calls.length = 0;
  controller.show();
  controller.hide();
  controller.show();
  const showCalls = window.calls.filter(([name]) => name === 'setAlwaysOnTop' || name === 'setVisibleOnAllWorkspaces');
  assert.equal(showCalls.length, 0);
  assert.equal(window.calls.filter(([name]) => name === 'setBounds').length >= 1, true);
  assert.equal(window.calls.filter(([name]) => name === 'show').length, 2);
});

test('expands the main window for an inline popover without creating another window', () => {
  const parent = createFakeWindow();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
  });

  controller.show();
  assert.equal(controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }],
  }), true);

  assert.equal('getPopoverWindow' in controller, false);
  assert.equal(parent.getBounds().height, 182);
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.getBounds().height, 104);
});

test('shows one inline popover and sends a validated selection to the main window', () => {
  const parent = createFakeWindow();
  const controller = createQuickChatWindowController({
    screen,
    createWindow: () => parent,
  });
  controller.show();
  assert.equal(controller.showPopover({
    kind: 'model', selectedValue: 'model-a', anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }],
  }), true);
  const expectedWorkspaceOptions = {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  };
  assert.equal(parent.calls.some(([name, visible, options]) => (
    name === 'setVisibleOnAllWorkspaces'
    && visible === true
    && assert.deepEqual(options, expectedWorkspaceOptions) === undefined
  )), true);
  assert.equal(parent.getBounds().height, 182);
  assert.equal(controller.selectPopoverValue('missing'), false);
  assert.equal(controller.selectPopoverValue('model-b'), true);
  assert.equal(parent.getBounds().height, 104);
  assert.equal(parent.calls.some(([name, channel, payload]) => name === 'send' && channel === 'quick-chat:popover-selected' && payload.value === 'model-b'), true);
});

test('lifts the native height cap before expanding and restores it after closing', () => {
  const parent = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => parent });
  controller.show();
  parent.calls.length = 0;

  controller.showPopover({
    kind: 'model',
    selectedValue: 'model-a',
    anchorRect: { x: 180, y: 72, width: 100, height: 24 },
    items: [{ value: 'model-a', label: 'Model A' }],
  });

  const expandLimitIndex = parent.calls.findIndex(([name, width, height]) => (
    name === 'setMaximumSize' && width === 720 && height === 760
  ));
  const expandBoundsIndex = parent.calls.findIndex(([name, bounds]) => (
    name === 'setBounds' && bounds.height > 104
  ));
  assert.ok(expandLimitIndex >= 0);
  assert.ok(expandBoundsIndex > expandLimitIndex);

  parent.calls.length = 0;
  controller.hidePopover();
  assert.deepEqual(parent.calls.at(-1), ['setMaximumSize', 720, 104]);
  assert.equal(parent.getBounds().height, 104);
});

test('keeps the main window visible while closing the inline popover', () => {
  const parent = createFakeWindow();
  const controller = createQuickChatWindowController({ screen, createWindow: () => parent });
  controller.show();
  controller.showPopover({ kind: 'workspace', selectedValue: '/one', anchorRect: {}, items: [{ value: '/one', label: 'one' }] });
  controller.hidePopover({ restoreFocus: true });
  assert.equal(parent.isVisible(), true);
  assert.equal(parent.getBounds().height, 104);
});

test('restores the design width from a compressed native window across every state change', () => {
  const parent = createFakeWindow({ x: 100, y: 100, width: 208, height: 104 });
  const controller = createQuickChatWindowController({ screen, createWindow: () => parent });

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

  controller.hidePopover();
  assert.deepEqual(parent.getBounds(), { ...shownBounds, width: 720, height: 104 });

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
