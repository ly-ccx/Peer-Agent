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
  const browser = {
    inputEvents,
    scripts,
    roleMatchCount: 1,
    textMatchCount: 1,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/page',
    getTitle: () => 'Example',
    sendInputEvent: (event) => {
      inputEvents.push(event);
    },
    executeJavaScript: async (expr) => {
      scripts.push(expr);
      if (expr.includes('elementFromPoint') || expr.includes("reason: 'actionable'")) {
        const reason = browser.actionableReason || 'actionable';
        return {
          ok: reason === 'actionable',
          reason,
          x: 40,
          y: 80,
          x0: 20,
          y0: 60,
          w: 40,
          h: 40,
        };
      }
      if (expr.includes('findTextTestIdMatches')) {
        const count = Number.isInteger(browser.textMatchCount) ? browser.textMatchCount : 1;
        const nthMatch = expr.match(/const wantNth = (null|\d+);/);
        const wantNth = nthMatch && nthMatch[1] !== 'null' ? Number(nthMatch[1]) : null;
        if (wantNth == null) {
          if (count !== 1) return { ok: false, count };
        } else if (wantNth < 0 || wantNth >= count) {
          return { ok: false, count, nth: wantNth };
        }
        if (expr.includes('scrollIntoView') || expr.includes('x0: Math.round')) {
          return {
            ok: true,
            count: 1,
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
        return { ok: true, count: 1 };
      }
      if (expr.includes('findRoleMatches')) {
        const count = Number.isInteger(browser.roleMatchCount) ? browser.roleMatchCount : 1;
        const nthMatch = expr.match(/const wantNth = (null|\d+);/);
        const wantNth = nthMatch && nthMatch[1] !== 'null' ? Number(nthMatch[1]) : null;
        if (wantNth == null) {
          if (count !== 1) return { ok: false, count };
        } else if (wantNth < 0 || wantNth >= count) {
          return { ok: false, count, nth: wantNth };
        }
        if (expr.includes('scrollIntoView') || expr.includes('x0: Math.round')) {
          return {
            ok: true,
            count: 1,
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
        return { ok: true, count: 1 };
      }
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
  return browser;
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

test('click by selector uses mouseDown/Up and records viewport metadata', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 61,
    conversationId: 'conversation-a',
    browserTabId: 'a-click',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { selector: '#go' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'selector');
  assert.equal(execution.result.outputPreview.x, 40);
  assert.equal(execution.result.outputPreview.y, 80);
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseDown', x: 40, y: 80, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 40, y: 80, button: 'left', clickCount: 1 },
  ]);
  assert.ok(browser.scripts.some((expr) => expr.includes('queryDeep(doc, "#go")')));
});

test('click by coordinates skips element lookup', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 62,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-point',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { x: 12, y: 24 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'point');
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseDown', x: 12, y: 24, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 12, y: 24, button: 'left', clickCount: 1 },
  ]);
  assert.equal(browser.scripts.length, 0);
});

test('click supports frame:N selector prefix', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 63,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-frame',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { selector: 'frame:0 #submit' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('queryDeep(doc, "#submit")')));
  assert.equal(browser.inputEvents[0].type, 'mouseDown');
  assert.equal(browser.inputEvents[1].type, 'mouseUp');
});

test('click by unique role/name locates then clicks the element', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 64,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-role',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { role: 'button', name: 'Submit' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'role');
  assert.ok(browser.scripts.some((expr) => expr.includes('findRoleMatches') && expr.includes('"button"') && expr.includes('"Submit"')));
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseDown', x: 40, y: 80, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 40, y: 80, button: 'left', clickCount: 1 },
  ]);
});

test('click by role fails when no unique match exists', async () => {
  const browser = createActionWebContents();
  browser.roleMatchCount = 0;
  registerBrowserWebContents({
    webContentsId: 65,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-role-missing',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { role: 'button', name: 'Missing' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /No unique element matched role/);
  assert.equal(browser.inputEvents.length, 0);
});

test('click by role fails when multiple elements match', async () => {
  const browser = createActionWebContents();
  browser.roleMatchCount = 3;
  registerBrowserWebContents({
    webContentsId: 66,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-role-many',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { role: 'button' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /matched 3 elements/);
  assert.equal(browser.inputEvents.length, 0);
});

test('click by role nth=0 picks the first of several same-named roles', async () => {
  const browser = createActionWebContents();
  browser.roleMatchCount = 3;
  registerBrowserWebContents({
    webContentsId: 68,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-role-nth',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { role: 'button', name: 'OK', nth: 0 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'role');
  assert.equal(execution.result.outputPreview.nth, 0);
  assert.ok(browser.scripts.some((expr) => expr.includes('const wantNth = 0;')));
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseDown', x: 40, y: 80, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 40, y: 80, button: 'left', clickCount: 1 },
  ]);
});

test('click by role nth out of range fails recoverably', async () => {
  const browser = createActionWebContents();
  browser.roleMatchCount = 2;
  registerBrowserWebContents({
    webContentsId: 69,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-role-nth-oob',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { role: 'button', name: 'OK', nth: 5 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /nth=5 is out of range/);
  assert.equal(browser.inputEvents.length, 0);
});

test('click by unique visible text locates then clicks the element', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 71,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-text',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { hasText: 'Submit' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'hasText');
  assert.ok(browser.scripts.some((expr) => expr.includes('findTextTestIdMatches') && expr.includes('"hasText"') && expr.includes('"Submit"')));
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseDown', x: 40, y: 80, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 40, y: 80, button: 'left', clickCount: 1 },
  ]);
});

test('click by unique testid locates then clicks the element', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 72,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-testid',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { testid: 'login-btn' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'testid');
  assert.ok(browser.scripts.some((expr) => expr.includes('findTextTestIdMatches') && expr.includes('"testid"') && expr.includes('"login-btn"')));
});

test('click by hasText fails when no unique match exists', async () => {
  const browser = createActionWebContents();
  browser.textMatchCount = 0;
  registerBrowserWebContents({
    webContentsId: 73,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-text-missing',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { hasText: 'Missing' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /No unique element matched text/);
  assert.equal(browser.inputEvents.length, 0);
});

test('click by hasText nth=0 picks the first of several same texts', async () => {
  const browser = createActionWebContents();
  browser.textMatchCount = 3;
  registerBrowserWebContents({
    webContentsId: 74,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-text-nth',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { hasText: 'OK', nth: 0 }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'hasText');
  assert.equal(execution.result.outputPreview.nth, 0);
});

test('type by unique role/name focuses then inserts text', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 67,
    conversationId: 'conversation-a',
    browserTabId: 'a-type-role',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.type', 'browser_type', { role: 'textbox', name: 'Email', text: 'hi' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'role');
  assert.ok(browser.scripts.some((expr) => expr.includes('findRoleMatches') && expr.includes('el.focus()')));
  assert.ok(browser.inputEvents.some((event) => event.type === 'char' && event.keyCode === 'h'));
});

test('type by unique testid focuses then inserts text', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 75,
    conversationId: 'conversation-a',
    browserTabId: 'a-type-testid',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.type', 'browser_type', { testid: 'email', text: 'hi' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'testid');
  assert.ok(browser.scripts.some((expr) => expr.includes('findTextTestIdMatches') && expr.includes('el.focus()')));
  assert.ok(browser.inputEvents.some((event) => event.type === 'char' && event.keyCode === 'h'));
});

test('hover by unique role/name locates then hovers the element', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 70,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover-role',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.hover', 'browser_hover', { role: 'button', name: 'Menu' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'role');
  assert.ok(browser.scripts.some((expr) => expr.includes('findRoleMatches') && expr.includes('"button"') && expr.includes('"Menu"')));
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseMove', x: 40, y: 80 },
  ]);
});

test('hover by unique visible text locates then hovers the element', async () => {
  const browser = createActionWebContents();
  registerBrowserWebContents({
    webContentsId: 76,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover-text',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.hover', 'browser_hover', { hasText: 'Menu' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.locatedBy, 'hasText');
  assert.ok(browser.scripts.some((expr) => expr.includes('findTextTestIdMatches') && expr.includes('"Menu"')));
  assert.deepEqual(browser.inputEvents, [
    { type: 'mouseMove', x: 40, y: 80 },
  ]);
});

test('click fails when the target stays disabled', async () => {
  const browser = createActionWebContents();
  browser.actionableReason = 'disabled';
  registerBrowserWebContents({
    webContentsId: 81,
    conversationId: 'conversation-a',
    browserTabId: 'a-click-disabled',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.click', 'browser_click', { selector: '#go' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /disabled/i);
  assert.equal(browser.inputEvents.length, 0);
});

test('hover fails when the target stays covered', async () => {
  const browser = createActionWebContents();
  browser.actionableReason = 'occluded';
  registerBrowserWebContents({
    webContentsId: 82,
    conversationId: 'conversation-a',
    browserTabId: 'a-hover-occluded',
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
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /covered/i);
  assert.equal(browser.inputEvents.length, 0);
});

test('type fails when the target node is detached', async () => {
  const browser = createActionWebContents();
  browser.actionableReason = 'stale';
  registerBrowserWebContents({
    webContentsId: 83,
    conversationId: 'conversation-a',
    browserTabId: 'a-type-stale',
    active: true,
    url: browser.getURL(),
  });
  const provider = createProvider(browser);
  const execution = await provider.executeCapability(
    actionCall('local.web.control.type', 'browser_type', { selector: '#q', text: 'hello' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  assert.equal(execution.result.status, 'failed');
  assert.match(String(execution.result.outputPreview?.reason ?? ''), /detached/i);
  assert.equal(browser.inputEvents.length, 0);
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
  assert.ok(browser.scripts.some((expr) => expr.includes('queryDeep(doc, "#menu")')));
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
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[1]') && expr.includes('queryDeep(doc, ".item")')));
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
  assert.ok(browser.scripts.some((expr) => expr.includes('queryDeep(doc, "#src")')));
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('queryDeep(doc, "#dst")')));
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
  assert.ok(browser.scripts.some((expr) => expr.includes('frames[0]') && expr.includes('queryDeep(doc, "#panel")')));
});

test('read_dom 超时：executeJavaScript 永不 resolve 时不永久挂起而是返回 timed out', async () => {
  // 构造一个 executeJavaScript 返回永不 resolve promise 的 webContents，
  // 模拟页面脚本死循环/断点/跨域 iframe 挂起，验证 withTimeout 门卫生效。
  const scripts = [];
  const browser = {
    isDestroyed: () => false,
    getURL: () => 'https://example.com/slow',
    getTitle: () => 'Slow page',
    sendInputEvent: () => {},
    executeJavaScript: (expr) => {
      scripts.push(expr);
      return new Promise(() => {}); // 永不 resolve
    },
  };
  registerBrowserWebContents({
    webContentsId: 61,
    conversationId: 'conversation-a',
    browserTabId: 'a-slow',
    active: true,
    url: browser.getURL(),
  });
  const provider = createLocalBrowserControlProvider({
    userDataPath: '/tmp/peer-agent-browser-actions-test',
    resolveWebContents: () => browser,
    ensureBrowserReady: async () => {},
    executeJSTimeoutMs: 50, // 注入短超时，快速验证
  });
  const started = Date.now();
  const execution = await provider.executeCapability(
    actionCall('local.web.control.readDom', 'browser_read_dom', { format: 'text' }),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );
  const elapsed = Date.now() - started;
  // 关键断言：调用在超时预算内返回（不挂起），且 status=failed。
  assert.equal(execution.result.status, 'failed');
  // 错误文本在 result 的某个字段（reason/message/error 之一），序列化后应含 timed out / 超时。
  const serialized = JSON.stringify(execution.result);
  assert.match(serialized, /timed out|超时/i);
  assert.ok(elapsed < 2_000, `read_dom 应在 1s 内返回而非永久挂起，实际 ${elapsed}ms`);
});
