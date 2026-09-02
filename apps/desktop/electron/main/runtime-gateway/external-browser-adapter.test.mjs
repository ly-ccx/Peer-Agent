import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createExternalBrowserAdapter,
  EXTERNAL_BROWSER_ALLOWED_ACTIONS,
  parseExternalFrameSelector,
} from './external-browser-adapter.mjs';

function createFakePlaywright() {
  const calls = [];
  let currentUrl = 'about:blank';
  let currentTitle = '';
  const locators = new Map();

  function locatorFor(selector) {
    if (!locators.has(selector)) {
      locators.set(selector, {
        selector,
        clicks: 0,
        hovers: 0,
        typed: [],
        filled: [],
        pressed: [],
        async click() { this.clicks += 1; calls.push({ kind: 'click', selector }); },
        async hover() { this.hovers += 1; calls.push({ kind: 'hover', selector }); },
        async type(text) { this.typed.push(text); calls.push({ kind: 'type', selector, text }); },
        async fill(text) { this.filled.push(text); calls.push({ kind: 'fill', selector, text }); },
        async press(key) { this.pressed.push(key); calls.push({ kind: 'press', selector, key }); },
        async innerText() { return `text:${selector}`; },
        async innerHTML() { return `<div id="${selector}">html</div>`; },
        async textContent() { return `text:${selector}`; },
        async evaluate(fn, arg) { calls.push({ kind: 'evaluate', selector, arg }); return fn?.({ scrollBy() {} }, arg); },
        async scrollIntoViewIfNeeded() { calls.push({ kind: 'scrollIntoView', selector }); },
        first() { return this; },
      });
    }
    return locators.get(selector);
  }

  const page = {
    _handlers: {},
    url() { return currentUrl; },
    async title() { return currentTitle; },
    async goto(url) {
      currentUrl = url;
      currentTitle = `title:${url}`;
      calls.push({ kind: 'goto', url });
    },
    locator(selector) { return locatorFor(selector); },
    frames() { return [{ locator: (css) => locatorFor(`frame:${css}`) }]; },
    async screenshot() {
      calls.push({ kind: 'screenshot' });
      return Buffer.from('png-bytes');
    },
    async content() { return '<html><body>page</body></html>'; },
    async innerText() { return 'page-text'; },
    async evaluate() { return 'page-text'; },
    keyboard: {
      async type(text) { calls.push({ kind: 'keyboard.type', text }); },
      async press(key) { calls.push({ kind: 'keyboard.press', key }); },
    },
    mouse: {
      async wheel(dx, dy) { calls.push({ kind: 'wheel', dx, dy }); },
    },
    on(event, handler) {
      this._handlers[event] = handler;
      calls.push({ kind: 'on', event });
    },
  };

  const context = {
    pages() { return [page]; },
    async newPage() { return page; },
    async close() { calls.push({ kind: 'context.close' }); },
  };

  return {
    calls,
    page,
    locators,
    chromium: {
      async launchPersistentContext(userDataDir, options) {
        calls.push({ kind: 'launchPersistentContext', userDataDir, options });
        return context;
      },
    },
  };
}

async function withAdapter(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'peer-l2-adapter-'));
  const fake = createFakePlaywright();
  const adapter = createExternalBrowserAdapter({
    playwrightFactory: async () => fake,
    userDataPath: tmp,
    headless: true,
  });
  try {
    await fn({ adapter, fake, tmp });
  } finally {
    await adapter.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
}

test('parseExternalFrameSelector supports optional frame:N prefix', () => {
  assert.deepEqual(parseExternalFrameSelector('#ok'), { framePath: [], css: '#ok' });
  assert.deepEqual(parseExternalFrameSelector('frame:0 #submit'), { framePath: [0], css: '#submit' });
});

test('open/close creates a temporary Peer-managed session and destroys it', async () => {
  await withAdapter(async ({ adapter, fake }) => {
    const opened = await adapter.open({ conversationId: 'c1', url: 'https://example.com' });
    assert.equal(opened.profileKind, 'temporary');
    assert.equal(opened.isolatedFromL1, true);
    assert.equal(opened.conversationId, 'c1');
    assert.equal(opened.url, 'https://example.com');
    assert.ok(opened.sessionId);
    assert.equal(fake.calls.some((c) => c.kind === 'launchPersistentContext'), true);
    assert.equal(fake.calls.some((c) => c.kind === 'goto' && c.url === 'https://example.com'), true);
    assert.equal(fake.calls.some((c) => c.kind === 'on' && c.event === 'download'), true);
    assert.equal(fake.calls.some((c) => c.kind === 'on' && c.event === 'dialog'), true);

    const closed = await adapter.close({ conversationId: 'c1' });
    assert.equal(closed.closed, true);
    assert.equal(adapter.getSession('c1'), null);
    await assert.rejects(
      () => adapter.click({ conversationId: 'c1', selector: '#x' }),
      (err) => err.code === 'session_not_open' && err.recoverable === true,
    );
  });
});

test('whitelist actions navigate/click/type/hover/scroll/screenshot/readDom run through locators', async () => {
  await withAdapter(async ({ adapter, fake }) => {
    await adapter.open({ conversationId: 'c1' });
    await adapter.navigate({ conversationId: 'c1', url: 'https://example.com/app' });
    await adapter.click({ conversationId: 'c1', selector: '#go' });
    await adapter.type({ conversationId: 'c1', selector: '#q', text: 'hello', clear: true, submit: true });
    await adapter.hover({ conversationId: 'c1', selector: '.menu' });
    await adapter.scroll({ conversationId: 'c1', deltaY: 80 });
    const shot = await adapter.screenshot({ conversationId: 'c1' });
    const dom = await adapter.readDom({ conversationId: 'c1' });

    assert.equal(fake.locators.get('#go').clicks, 1);
    assert.deepEqual(fake.locators.get('#q').filled, ['hello']);
    assert.deepEqual(fake.locators.get('#q').pressed, ['Enter']);
    assert.equal(fake.locators.get('.menu').hovers, 1);
    assert.equal(fake.calls.some((c) => c.kind === 'wheel' && c.dy === 80), true);
    assert.ok(Buffer.isBuffer(shot.pngBuffer));
    assert.equal(dom.content, 'page-text');
    assert.deepEqual(EXTERNAL_BROWSER_ALLOWED_ACTIONS, [
      'open', 'close', 'navigate', 'click', 'type', 'hover', 'scroll', 'screenshot', 'readDom',
    ]);
  });
});

test('download and dialog are refused with recoverable errors', async () => {
  await withAdapter(async ({ adapter }) => {
    await adapter.open({ conversationId: 'c1' });
    await assert.rejects(
      () => adapter.execute('download', { conversationId: 'c1' }),
      (err) => err.code === 'download_not_supported' && err.recoverable === true,
    );
    await assert.rejects(
      () => adapter.execute('dialog', { conversationId: 'c1' }),
      (err) => err.code === 'dialog_not_supported' && err.recoverable === true,
    );
    await assert.rejects(
      () => adapter.execute('cdp', { conversationId: 'c1' }),
      (err) => err.code === 'action_not_whitelisted' && err.recoverable === true,
    );
  });
});

test('page download/dialog events are cancelled and recorded, not exposed as CDP', async () => {
  await withAdapter(async ({ adapter, fake }) => {
    await adapter.open({ conversationId: 'c1' });
    const downloadHandler = fake.page._handlers.download;
    const dialogHandler = fake.page._handlers.dialog;
    assert.equal(typeof downloadHandler, 'function');
    assert.equal(typeof dialogHandler, 'function');
    let downloadCancelled = false;
    let dialogDismissed = false;
    await downloadHandler({ url: () => 'https://example.com/file.zip', async cancel() { downloadCancelled = true; } });
    await dialogHandler({ type: () => 'alert', async dismiss() { dialogDismissed = true; } });
    assert.equal(downloadCancelled, true);
    assert.equal(dialogDismissed, true);
    assert.equal(adapter.getSession('c1').lastBlocked.kind, 'dialog');
  });
});
