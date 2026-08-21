import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getActiveBrowserEntry,
  resetBrowserControlRegistryForTests,
} from './browser-control-registry.mjs';
import { createLocalBrowserControlProvider } from './local-browser-control-provider.mjs';
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
      this.webContents = createHeadlessWebContents();
      created.views.push(this);
    }
    setBounds() {}
  }
  function createHeadlessWebContents() {
    let url = 'about:blank';
    const navigations = [];
    return {
      id: 2000 + created.views.length,
      navigations,
      getURL: () => url,
      getTitle: () => (url === 'about:blank' ? '' : 'Example'),
      isDestroyed: () => false,
      loadURL: async (next) => { url = next; navigations.push(next); },
    };
  }
  return { created, BrowserWindow: MockWindow, WebContentsView: MockView };
}

function createProviderWithHeadless({ ensureBrowserReady } = {}) {
  const electron = createMockElectron();
  const headlessManager = createHeadlessBrowserManager({ electron });
  const webContentsById = new Map();
  for (const view of electron.created.views) {
    webContentsById.set(view.webContents.id, view.webContents);
  }
  // MockView 惰性创建，hook 一下让 map 实时同步。
  const origView = electron.WebContentsView;
  electron.WebContentsView = class extends origView {
    constructor(opts) {
      super(opts);
      webContentsById.set(this.webContents.id, this.webContents);
    }
  };

  const provider = createLocalBrowserControlProvider({
    ensureBrowserReady,
    userDataPath: '/tmp/peer-agent-browser-provider-headless-test',
    artifactStore: {},
    headlessManager,
    browserReadyTimeoutMs: 30,
    resolveWebContents: (id) => webContentsById.get(id) ?? null,
  });
  return { provider, electron, headlessManager };
}

test('navigate falls back to headless when no visible browser entry exists', async () => {
  // ensureBrowserReady 抛错 = 面板不在（reveal 失败），工具不应失败。
  const { provider } = createProviderWithHeadless({
    ensureBrowserReady: async () => { throw new Error('panel not mounted'); },
  });

  const execution = await provider.executeCapability(
    {
      call: {
        toolCallId: 'call-1',
        capabilityId: 'local.web.control.navigate',
        arguments: { url: 'https://example.com' },
      },
    },
    { locale: 'zh-CN', toolContext: { conversationId: 'conversation-fallback' } },
  );

  assert.equal(execution.result.status, 'success');
  const output = execution.result.outputPreview;
  assert.equal(output.action, 'navigate');
  assert.equal(output.finalUrl, 'https://example.com');
  assert.equal(output.headless, true, '输出应标注 headless 来源');
  assert.equal(output.conversationId, 'conversation-fallback');

  // headless entry 已注册进 registry，后续调用幂等复用。
  const entry = getActiveBrowserEntry('conversation-fallback');
  assert.ok(entry);
  assert.equal(entry.hidden, true);
  assert.equal(entry.browserTabId, '__headless__');
});

test('headless execution grants carry headless scope semantics', async () => {
  const { provider } = createProviderWithHeadless({
    ensureBrowserReady: async () => { throw new Error('panel not mounted'); },
  });

  const execution = await provider.executeCapability(
    {
      call: {
        toolCallId: 'call-2',
        capabilityId: 'local.web.control.navigate',
        arguments: { url: 'https://example.com' },
      },
    },
    { locale: 'en-US', toolContext: { conversationId: 'conversation-scope' } },
  );

  const grant = execution.permissionGrant;
  assert.ok(grant);
  assert.equal(grant.granted, true);
  // 第一次调用时 entry 尚未注册（scope 在 resolveTarget 前构造），
  // 但输出与后续调用的 scope 必须携带 headless 标记。
  const output = execution.result.outputPreview;
  assert.equal(output.headless, true);

  // 第二次调用（headless entry 已是 active）scope 应带 headless:true。
  const second = await provider.executeCapability(
    {
      call: {
        toolCallId: 'call-3',
        capabilityId: 'local.web.control.navigate',
        arguments: { url: 'https://example.org' },
      },
    },
    { locale: 'en-US', toolContext: { conversationId: 'conversation-scope' } },
  );
  assert.equal(second.permissionGrant.scope.headless, true);
  assert.equal(second.permissionGrant.scope.kind, 'browser-control');
});

test('openPanel degrades to background mode instead of failing when reveal fails', async () => {
  const { provider } = createProviderWithHeadless({
    ensureBrowserReady: async () => { throw new Error('no renderer ack'); },
  });

  const execution = await provider.executeCapability(
    {
      call: {
        toolCallId: 'call-4',
        capabilityId: 'local.web.control.openPanel',
        arguments: {},
      },
    },
    { locale: 'zh-CN', toolContext: { conversationId: 'conversation-bg' } },
  );

  assert.equal(execution.result.status, 'success', 'openPanel 不再硬失败');
  const output = JSON.parse(execution.result.output);
  assert.equal(output.status, 'background');
  assert.equal(output.visible, false);
  assert.equal(output.headless, true, '降级路径应预热 headless 会话');
  // Evidence 记录了降级事实。
  assert.match(execution.result.evidence.summary, /degraded to headless/);

  // 预热的 headless entry 可被后续 navigate 直接使用。
  const entry = getActiveBrowserEntry('conversation-bg');
  assert.ok(entry);
  assert.equal(entry.hidden, true);
});

test('visible entry still takes priority over headless fallback', async () => {
  const { provider, electron } = createProviderWithHeadless({
    ensureBrowserReady: async () => { /* 面板就绪，不抛错 */ },
  });
  const { registerBrowserWebContents } = await import('./browser-control-registry.mjs');

  // 可见 entry 注册在先。
  const visibleWc = (() => {
    let url = 'https://visible.example';
    return {
      isDestroyed: () => false,
      getURL: () => url,
      getTitle: () => 'Visible',
      loadURL: async (next) => { url = next; },
    };
  })();
  registerBrowserWebContents({
    webContentsId: 777,
    conversationId: 'conversation-priority',
    browserTabId: 'tab-visible',
    active: true,
    url: 'https://visible.example',
  });

  // 用自定义 resolveWebContents 让 777 可解析。
  const electron2 = createMockElectron();
  const headlessManager2 = createHeadlessBrowserManager({ electron: electron2 });
  const map = new Map([[777, visibleWc]]);
  const origView = electron2.WebContentsView;
  electron2.WebContentsView = class extends origView {
    constructor(opts) {
      super(opts);
      map.set(this.webContents.id, this.webContents);
    }
  };
  const provider2 = createLocalBrowserControlProvider({
    ensureBrowserReady: async () => {},
    userDataPath: '/tmp/peer-agent-browser-provider-headless-test',
    artifactStore: {},
    headlessManager: headlessManager2,
    browserReadyTimeoutMs: 30,
    resolveWebContents: (id) => map.get(id) ?? null,
  });

  const execution = await provider2.executeCapability(
    {
      call: {
        toolCallId: 'call-5',
        capabilityId: 'local.web.control.navigate',
        arguments: { url: 'https://example.com' },
      },
    },
    { locale: 'en-US', toolContext: { conversationId: 'conversation-priority' } },
  );

  assert.equal(execution.result.status, 'success');
  const output = execution.result.outputPreview;
  assert.equal(output.browserTabId, 'tab-visible', '可见 entry 优先');
  assert.equal(output.headless, undefined, '非 headless 执行不带标记');
  assert.equal(electron2.created.windows.length, 0, '可见目标在场时不创建 headless 窗口');
});
