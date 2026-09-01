import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerBrowserWebContents,
  resetBrowserControlRegistryForTests,
} from './browser-control-registry.mjs';
import {
  createLocalBrowserControlProvider,
  interpolateDragPath,
  normalizeScrollAlignment,
  parseBrowserKeySpec,
} from './local-browser-control-provider.mjs';

function createActionWebContents() {
  const inputEvents = [];
  const scripts = [];
  return {
    inputEvents,
    scripts,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/page',
    getTitle: () => 'Example',
    sendInputEvent: (event) => {
      inputEvents.push(event);
    },
    executeJavaScript: async (expr) => {
      scripts.push(expr);
      if (expr.includes('collectRoles')) {
        return {
          count: 2,
          truncated: false,
          nodes: [
            { role: 'button', name: 'Submit', tag: 'button', selector: '#go', disabled: false, x: 10, y: 20, w: 80, h: 24 },
            { role: 'link', name: 'Home', tag: 'a', selector: 'a.home', disabled: false, href: '/', x: 0, y: 0, w: 40, h: 16 },
          ],
        };
      }
      if (expr.includes('getBoundingClientRect')) {
        return {
          x: 40,
          y: 80,
          dpr: 1,
          vvScale: 1,
          scrollX: 0,
          scrollY: 0,
          x0: 20,
          y0: 60,
          w: 40,
          h: 40,
        };
      }
      if (expr.includes('scrollBy') || expr.includes('scrollIntoView')) {
        return {
          before: { x: 0, y: 0 },
          after: { x: 0, y: 240 },
          mode: expr.includes('scrollIntoView') && !expr.includes('scrollBy') ? 'intoView' : 'delta',
        };
      }
      return true;
    },
  };
}

function actionCall(capabilityId, toolName, args) {
  return {
    call: {
      toolCallId: `tool-call-${toolName}`,
      capabilityId,
      toolName,
      arguments: args,
      riskLevel: 'L3_external_write',
      dataLevel: 'D2_sensitive',
    },
  };
}

function createArtifactStore() {
  const texts = [];
  return {
    texts,
    writeTextArtifact: async (entry) => {
      texts.push(entry);
      return {
        artifactRef: `local-browser-artifact://${entry.actionId}`,
        artifactRefs: [`local-browser-artifact://${entry.actionId}/content`],
        truncated: false,
      };
    },
  };
}

function createProvider(browser, artifactStore = {}) {
  return createLocalBrowserControlProvider({
    userDataPath: '/tmp/peer-agent-browser-actions-test',
    artifactStore,
    resolveWebContents: () => browser,
    ensureBrowserReady: async () => {},
  });
}

test.beforeEach(() => resetBrowserControlRegistryForTests());

test('normalizeScrollAlignment 只接受 start/center/end/nearest', () => {
  assert.equal(normalizeScrollAlignment('center'), 'center');
  assert.equal(normalizeScrollAlignment(' nearest '), 'nearest');
  assert.equal(normalizeScrollAlignment('top'), '');
  assert.equal(normalizeScrollAlignment(1), '');
});

test('hover by selector uses mouseMove and records viewport metadata', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 41,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.hover', 'browser_hover', { selector: '#menu' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.action, 'hover');
  assert.equal(execution.result.outputPreview.locatedBy, 'selector');
  assert.equal(execution.result.outputPreview.x, 40);
  assert.equal(execution.result.outputPreview.y, 80);
  assert.deepEqual(browser.inputEvents, [{ type: 'mouseMove', x: 40, y: 80 }]);
  assert.ok(browser.scripts.some((expr) => expr.includes('querySelector("#menu")')));
});

test('hover by coordinates skips element lookup', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 42,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover-point',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.hover', 'browser_hover', { x: 12, y: 24 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'point');
  assert.deepEqual(browser.inputEvents, [{ type: 'mouseMove', x: 12, y: 24 }]);
  assert.equal(browser.scripts.length, 0);
});

test('hover supports frame:N selector prefix', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 43,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover-frame',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.hover', 'browser_hover', { selector: 'frame:1 .item' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[1]') && expr.includes('querySelector(".item")')));
});

test('scroll by selector delta uses executeJavaScript and records after offset', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 44,
    conversationId: 'conversation-a',
    browserTabId: 'a-scroll',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.scroll', 'browser_scroll', { selector: '#list', deltaY: 240 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.action, 'scroll');
  assert.equal(execution.result.outputPreview.mode, 'delta');
  assert.equal(execution.result.outputPreview.after.y, 240);
  assert.ok(browser.scripts.some((expr) => expr.includes('scrollBy(0, 240)')));
  assert.equal(browser.inputEvents.length, 0);
});

test('scrollIntoView uses block/inline and frame prefix', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 45,
    conversationId: 'conversation-a',
    browserTabId: 'a-scroll-view',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.scroll', 'browser_scroll', {
      selector: 'frame:0 #card',
      block: 'center',
    }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.mode, 'intoView');
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('scrollIntoView({block:"center"')));
});

test('scroll without selector or delta fails recoverably', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 46,
    conversationId: 'conversation-a',
    browserTabId: 'a-scroll-fail',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.scroll', 'browser_scroll', {}),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  const reason = execution.result.outputPreview?.reason
    ?? execution.result.error?.reason
    ?? execution.result.reason
    ?? '';
  assert.match(String(reason), /deltaX\/deltaY|block\/inline|selector/);
});

test('parseBrowserKeySpec 白名单与修饰键', () => {
  assert.equal(parseBrowserKeySpec('Enter').keyName, 'Return');
  assert.equal(parseBrowserKeySpec('Tab').ok, true);
  assert.deepEqual(parseBrowserKeySpec('Meta+K').modifiers, {
    alt: false,
    control: false,
    meta: true,
    shift: false,
  });
  assert.equal(parseBrowserKeySpec('Meta+K').keyName, 'K');
  assert.equal(parseBrowserKeySpec('F12').ok, false);
  assert.equal(parseBrowserKeySpec('Shift').ok, false);
});

test('interpolateDragPath 至少 3 步且含起终点', () => {
  const path = interpolateDragPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 6);
  assert.ok(path.length >= 3 && path.length <= 8);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[path.length - 1], { x: 10, y: 0 });
});

test('key sends Enter after optional selector focus', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 47,
    conversationId: 'conversation-a',
    browserTabId: 'a-key',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.key', 'browser_key', { keys: ['Enter'], selector: '#field' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.deepEqual(execution.result.outputPreview.keys, ['Enter']);
  assert.ok(browser.scripts.some((expr) => expr.includes('el.focus()')));
  assert.ok(browser.inputEvents.some((event) => event.type === 'keyDown' && event.keyCode === 'Return'));
  assert.ok(browser.inputEvents.some((event) => event.type === 'keyUp' && event.keyCode === 'Return'));
});

test('key rejects unknown names recoverably', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 48,
    conversationId: 'conversation-a',
    browserTabId: 'a-key-fail',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.key', 'browser_key', { keys: ['F12'] }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  const reason = execution.result.outputPreview?.reason ?? '';
  assert.match(String(reason), /Unsupported key|F12/);
  assert.equal(browser.inputEvents.length, 0);
});

test('drag from/to coordinates interpolates mouse path', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 49,
    conversationId: 'conversation-a',
    browserTabId: 'a-drag',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.drag', 'browser_drag', {
      fromX: 10,
      fromY: 20,
      toX: 40,
      toY: 80,
    }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.action, 'drag');
  assert.equal(browser.inputEvents[0].type, 'mouseDown');
  assert.equal(browser.inputEvents[browser.inputEvents.length - 1].type, 'mouseUp');
  assert.ok(browser.inputEvents.filter((event) => event.type === 'mouseMove').length >= 2);
  assert.equal(browser.inputEvents[0].x, 10);
  assert.equal(browser.inputEvents[browser.inputEvents.length - 1].x, 40);
});

test('drag from selector to selector uses locator chain', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 50,
    conversationId: 'conversation-a',
    browserTabId: 'a-drag-sel',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.drag', 'browser_drag', {
      fromSelector: '#src',
      toSelector: 'frame:0 #dst',
    }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.from.locatedBy, 'selector');
  assert.equal(execution.result.outputPreview.to.locatedBy, 'selector');
  assert.ok(browser.scripts.some((expr) => expr.includes('querySelector("#src")')));
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('querySelector("#dst")')));
});

test('read_dom format=roles 落角色快照并返回 role/name 摘要', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 51,
    conversationId: 'conversation-a',
    browserTabId: 'a-roles',
    active: true,
    url: browser.getURL(),
  });
  const store = createArtifactStore();
  const provider = createProvider(browser, store);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.readDom', 'browser_read_dom', { format: 'roles' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.format, 'roles');
  assert.equal(execution.result.outputPreview.roleCount, 2);
  assert.match(execution.result.outputPreview.summary, /button "Submit"/);
  assert.ok(browser.scripts.some((expr) => expr.includes('collectRoles')));
  assert.equal(store.texts[0].format, 'roles');
  assert.match(store.texts[0].content, /"role": "button"/);
});

test('read_dom format=roles 支持 frame:N 前缀', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 52,
    conversationId: 'conversation-a',
    browserTabId: 'a-roles-frame',
    active: true,
    url: browser.getURL(),
  });
  const store = createArtifactStore();
  const provider = createProvider(browser, store);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.readDom', 'browser_read_dom', { format: 'roles', selector: 'frame:0 #panel' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('querySelector("#panel")')));
});
