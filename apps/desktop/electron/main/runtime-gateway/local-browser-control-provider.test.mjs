import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerBrowserWebContents,
  resetBrowserControlRegistryForTests,
} from './browser-control-registry.mjs';
import { createLocalBrowserControlProvider } from './local-browser-control-provider.mjs';

function createWebContents(initialUrl) {
  let url = initialUrl;
  const navigations = [];
  return {
    navigations,
    isDestroyed: () => false,
    loadURL: async (nextUrl) => {
      navigations.push(nextUrl);
      url = nextUrl;
    },
    getURL: () => url,
    getTitle: () => url,
  };
}

function navigateCall(url) {
  return {
    call: {
      toolCallId: 'tool-call-1',
      capabilityId: 'local.web.control.navigate',
      toolName: 'browser_navigate',
      arguments: { url },
      riskLevel: 'L3_external_write',
      dataLevel: 'D2_sensitive',
    },
  };
}

test.beforeEach(() => resetBrowserControlRegistryForTests());

test('browser provider resolves the active tab from the tool conversation context', async () => {
  const browserA = createWebContents('https://example.com/a');
  const browserB = createWebContents('https://example.com/b');
  const webContentsById = new Map([[11, browserA], [21, browserB]]);
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
    url: browserA.getURL(),
  });
  registerBrowserWebContents({
    webContentsId: 21,
    conversationId: 'conversation-b',
    browserTabId: 'b-1',
    active: true,
    url: browserB.getURL(),
  });
  const provider = createLocalBrowserControlProvider({
    userDataPath: '/tmp/peer-agent-browser-provider-test',
    artifactStore: {},
    resolveWebContents: (id) => webContentsById.get(id),
  });

  const execution = await provider.executeCapability(
    navigateCall('https://openai.com'),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-a' },
      requestPermission: async () => ({ granted: true }),
    },
  );

  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.outputPreview.conversationId, 'conversation-a');
  assert.equal(execution.result.outputPreview.browserTabId, 'a-1');
  assert.deepEqual(browserA.navigations, ['https://openai.com']);
  assert.deepEqual(browserB.navigations, []);
});

test('browser provider fails instead of falling back to another conversation', async () => {
  const browserA = createWebContents('https://example.com/a');
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
    url: browserA.getURL(),
  });
  const provider = createLocalBrowserControlProvider({
    userDataPath: '/tmp/peer-agent-browser-provider-test',
    artifactStore: {},
    resolveWebContents: () => browserA,
  });

  const execution = await provider.executeCapability(
    navigateCall('https://openai.com'),
    {
      locale: 'en-US',
      toolContext: { conversationId: 'conversation-b' },
      requestPermission: async () => ({ granted: true }),
    },
  );

  assert.equal(execution.result.status, 'failed');
  assert.deepEqual(browserA.navigations, []);
});
