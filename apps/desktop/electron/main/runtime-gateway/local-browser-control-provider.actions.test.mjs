import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerBrowserWebContents,
  resetBrowserControlRegistryForTests,
} from './browser-control-registry.mjs';
import {
  createLocalBrowserControlProvider,
  normalizeScrollAlignment,
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

function createProvider(browser) {
  return createLocalBrowserControlProvider({
    userDataPath: '/tmp/peer-agent-browser-actions-test',
    artifactStore: {},
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
