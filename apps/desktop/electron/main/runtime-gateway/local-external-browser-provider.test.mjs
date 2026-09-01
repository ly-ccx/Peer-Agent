import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExternalBrowserAdapter } from './external-browser-adapter.mjs';
import { createLocalExternalBrowserProvider } from './local-external-browser-provider.mjs';
import { createLocalBrowserControlProvider } from './local-browser-control-provider.mjs';

function createFakePlaywright() {
  let currentUrl = 'about:blank';
  const locators = new Map();
  function locatorFor(selector) {
    if (!locators.has(selector)) {
      locators.set(selector, {
        clicks: 0,
        async click() { this.clicks += 1; },
        async hover() {},
        async type() {},
        async fill() {},
        async press() {},
        async innerText() { return 'hello'; },
        async innerHTML() { return '<p>hello</p>'; },
        first() { return this; },
      });
    }
    return locators.get(selector);
  }
  const page = {
    url() { return currentUrl; },
    async title() { return 'Example'; },
    async goto(url) { currentUrl = url; },
    locator(selector) { return locatorFor(selector); },
    frames() { return []; },
    async screenshot() { return Buffer.from('png'); },
    async content() { return '<html>ok</html>'; },
    async innerText() { return 'page'; },
    on() {},
  };
  return {
    locators,
    chromium: {
      async launchPersistentContext() {
        return {
          pages() { return [page]; },
          async newPage() { return page; },
          async close() {},
        };
      },
    },
  };
}

function call(capabilityId, args = {}) {
  return {
    call: {
      toolCallId: `tc-${capabilityId}`,
      capabilityId,
      arguments: args,
    },
  };
}

function contextFor(conversationId = 'conv-1') {
  return {
    locale: 'en-US',
    toolContext: { conversationId },
    requestPermission: async () => ({ granted: true }),
  };
}

async function withProvider(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'peer-l2-provider-'));
  const fake = createFakePlaywright();
  const adapter = createExternalBrowserAdapter({
    playwrightFactory: async () => fake,
    userDataPath: tmp,
    headless: true,
  });
  const provider = createLocalExternalBrowserProvider({
    userDataPath: tmp,
    adapter,
  });
  try {
    await fn({ provider, fake, tmp });
  } finally {
    await adapter.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
}

test('open then close a temporary L2 session through the capability provider', async () => {
  await withProvider(async ({ provider }) => {
    const opened = await provider.executeCapability(
      call('local.web.external.open', { url: 'https://example.com' }),
      contextFor(),
    );
    assert.equal(opened.result.status, 'success');
    assert.equal(opened.result.outputPreview.profileKind, 'temporary');
    assert.equal(opened.result.outputPreview.isolatedFromL1, true);
    assert.equal(opened.result.outputPreview.url, 'https://example.com');
    assert.match(opened.result.evidence.summary, /isolated from the in-app browser/i);

    const closed = await provider.executeCapability(call('local.web.external.close'), contextFor());
    assert.equal(closed.result.status, 'success');
    assert.equal(closed.result.outputPreview.closed, true);

    const clickAfterClose = await provider.executeCapability(
      call('local.web.external.click', { selector: '#x' }),
      contextFor(),
    );
    assert.equal(clickAfterClose.result.status, 'failed');
    assert.match(clickAfterClose.result.outputPreview.reason, /browser_external_open/i);
  });
});

test('whitelist click/type/screenshot/readDom succeed; download/dialog are refused recoverably', async () => {
  await withProvider(async ({ provider, fake }) => {
    await provider.executeCapability(call('local.web.external.open'), contextFor());
    const clicked = await provider.executeCapability(
      call('local.web.external.click', { selector: '#go' }),
      contextFor(),
    );
    assert.equal(clicked.result.status, 'success');
    assert.equal(fake.locators.get('#go').clicks, 1);

    const typed = await provider.executeCapability(
      call('local.web.external.type', { selector: '#q', text: 'hi' }),
      contextFor(),
    );
    assert.equal(typed.result.status, 'success');

    const shot = await provider.executeCapability(call('local.web.external.screenshot'), contextFor());
    assert.equal(shot.result.status, 'success');
    assert.ok(shot.result.outputPreview.artifactRef.startsWith('local-external-browser-artifact://'));
    assert.equal(shot.result.output.visualObservation.kind, 'browser_screenshot');

    const dom = await provider.executeCapability(call('local.web.external.readDom'), contextFor());
    assert.equal(dom.result.status, 'success');
    assert.ok(dom.result.outputPreview.artifactRef);

    const hovered = await provider.executeCapability(
      call('local.web.external.hover', { selector: '.menu' }),
      contextFor(),
    );
    assert.equal(hovered.result.status, 'success');
    const scrolled = await provider.executeCapability(
      call('local.web.external.scroll', { deltaY: 40 }),
      contextFor(),
    );
    assert.equal(scrolled.result.status, 'success');

    const download = await provider.adapter.execute('download', { conversationId: 'conv-1' }).catch((err) => err);
    assert.equal(download.code, 'download_not_supported');
    assert.equal(download.recoverable, true);
    const dialog = await provider.adapter.execute('dialog', { conversationId: 'conv-1' }).catch((err) => err);
    assert.equal(dialog.code, 'dialog_not_supported');
    assert.equal(dialog.recoverable, true);
    assert.equal(provider.capabilityIds.includes('local.web.external.download'), false);
    assert.equal(provider.capabilityIds.includes('local.web.external.dialog'), false);

    const unknown = await provider.executeCapability(
      { call: { toolCallId: 'tc-unknown', capabilityId: 'local.web.control.click', arguments: { selector: '#x' } } },
      contextFor(),
    );
    assert.equal(unknown, null);
  });
});

test('L2 provider does not claim L1 capabilities; L1 provider does not claim L2', async () => {
  await withProvider(async ({ provider, tmp }) => {
    const l1 = createLocalBrowserControlProvider({
      userDataPath: tmp,
      artifactStore: {},
      headlessManager: false,
    });
    assert.equal(provider.capabilityIds.includes('local.web.control.click'), false);
    assert.equal(l1.capabilityIds.includes('local.web.external.open'), false);
    assert.equal(provider.providerId, 'local.browser.external');
    assert.equal(l1.providerId, 'local.browser.control');
  });
});

test('missing conversation and invalid url fail recoverably', async () => {
  await withProvider(async ({ provider }) => {
    const noConv = await provider.executeCapability(call('local.web.external.open'), { locale: 'en-US' });
    assert.equal(noConv.result.status, 'failed');
    assert.match(noConv.result.outputPreview.reason, /conversation/i);

    const badUrl = await provider.executeCapability(
      call('local.web.external.navigate', { url: 'file:///etc/passwd' }),
      contextFor(),
    );
    assert.equal(badUrl.result.status, 'failed');
    assert.match(badUrl.result.outputPreview.reason, /http\(s\)/i);
  });
});
