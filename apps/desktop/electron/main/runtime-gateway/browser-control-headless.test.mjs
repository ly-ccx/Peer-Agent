import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerBrowserWebContents,
  getActiveBrowserEntry,
  resetBrowserControlRegistryForTests,
} from './browser-control-registry.mjs';
import { createHeadlessBrowserManager } from './browser-control-headless.mjs';

test.beforeEach(() => resetBrowserControlRegistryForTests());

function createMockElectron() {
  const created = { windows: [], views: [] };
  class MockWindow {
    constructor(opts) {
      this.opts = opts;
      this.closedHandlers = [];
      const self = this;
      this.contentView = { children: [], addChildView(v) { self.contentView.children.push(v); } };
      created.windows.push(this);
    }
    on(evt, handler) { if (evt === 'closed') this.closedHandlers.push(handler); }
    destroy() { this.destroyed = true; }
  }
  class MockView {
    constructor(opts) {
      this.opts = opts;
      this.webContents = { id: 1000 + created.views.length, isDestroyed: () => false };
      created.views.push(this);
    }
    setBounds() {}
  }
  return {
    created,
    BrowserWindow: MockWindow,
    WebContentsView: MockView,
  };
}

test('ensureHeadlessBrowserEntry creates a hidden window+view and registers a hidden entry', async () => {
  const electron = createMockElectron();
  const manager = createHeadlessBrowserManager({ electron });

  const result = await manager.ensureHeadlessBrowserEntry('conversation-a');

  assert.equal(result.ok, true);
  assert.equal(result.hidden, true);
  assert.equal(result.reused, false);
  assert.equal(result.browserTabId, '__headless__');
  assert.equal(electron.created.windows.length, 1);
  assert.equal(electron.created.views.length, 1);
  // 隐藏语义：不显示、不抢焦点、不进任务栏。
  assert.equal(electron.created.windows[0].opts.show, false);
  assert.equal(electron.created.windows[0].opts.focusable, false);
  assert.equal(electron.created.windows[0].opts.skipTaskbar, true);
  // 共享内嵌浏览器持久分区。
  assert.equal(electron.created.views[0].opts.webPreferences.partition, 'persist:peer-browser');

  const entry = getActiveBrowserEntry('conversation-a');
  assert.ok(entry, 'headless entry 应注册为会话的 active entry');
  assert.equal(entry.hidden, true);
  assert.equal(entry.browserTabId, '__headless__');
  assert.equal(entry.webContentsId, result.webContentsId);
});

test('ensureHeadlessBrowserEntry is idempotent and reuses the live session', async () => {
  const electron = createMockElectron();
  const manager = createHeadlessBrowserManager({ electron });

  const first = await manager.ensureHeadlessBrowserEntry('conversation-a');
  const second = await manager.ensureHeadlessBrowserEntry('conversation-a');

  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.webContentsId, first.webContentsId);
  assert.equal(electron.created.windows.length, 1, '复用，不重复创建窗口');
});

test('ensureHeadlessBrowserEntry replaces a destroyed session', async () => {
  const electron = createMockElectron();
  const manager = createHeadlessBrowserManager({ electron });

  await manager.ensureHeadlessBrowserEntry('conversation-a');
  // 模拟 view 被销毁。
  electron.created.views[0].webContents.isDestroyed = () => true;

  const recreated = await manager.ensureHeadlessBrowserEntry('conversation-a');
  assert.equal(recreated.ok, true);
  assert.equal(recreated.reused, false);
  assert.equal(electron.created.windows.length, 2, '旧 session 被清理后重建');
});

test('a visible entry takes over the active slot; headless no longer resolves', async () => {
  const electron = createMockElectron();
  const manager = createHeadlessBrowserManager({ electron });
  await manager.ensureHeadlessBrowserEntry('conversation-a');

  // 可见面板注册同会话的可见 entry。
  registerBrowserWebContents({
    webContentsId: 4242,
    conversationId: 'conversation-a',
    browserTabId: 'tab-visible',
    active: true,
  });

  const entry = getActiveBrowserEntry('conversation-a');
  assert.equal(entry.webContentsId, 4242, '可见 entry 接管 active 槽位');
  assert.notEqual(entry.browserTabId, '__headless__');
});

test('disposeSession unregisters the headless entry and destroys the window', async () => {
  const electron = createMockElectron();
  const manager = createHeadlessBrowserManager({ electron });
  const ensured = await manager.ensureHeadlessBrowserEntry('conversation-a');

  await manager.disposeSession('conversation-a');

  assert.equal(electron.created.windows[0].destroyed, true);
  // headless entry 已从 registry 移除；无可见 entry 时该会话回到无浏览器状态。
  const entry = getActiveBrowserEntry('conversation-a');
  assert.notEqual(entry?.webContentsId, ensured.webContentsId);
});

test('isHeadlessEntry identifies only hidden __headless__ entries', () => {
  const manager = createHeadlessBrowserManager({ electron: {} });
  assert.equal(manager.isHeadlessEntry({ browserTabId: '__headless__', hidden: true }), true);
  assert.equal(manager.isHeadlessEntry({ browserTabId: '__headless__', hidden: false }), false);
  assert.equal(manager.isHeadlessEntry({ browserTabId: 'tab-1', hidden: true }), false);
  assert.equal(manager.isHeadlessEntry(null), false);
});

test('invalid conversation id or missing electron APIs fail gracefully', async () => {
  const manager = createHeadlessBrowserManager({ electron: createMockElectron() });
  assert.equal((await manager.ensureHeadlessBrowserEntry('')).ok, false);
  assert.equal((await manager.ensureHeadlessBrowserEntry(null)).ok, false);

  const bare = createHeadlessBrowserManager({ electron: {} });
  const result = await bare.ensureHeadlessBrowserEntry('conversation-a');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'headless_unavailable');
});
