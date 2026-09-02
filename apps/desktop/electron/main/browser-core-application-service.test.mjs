import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCoreApplicationService } from './browser-core-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  let activeWebContentsId = null;
  const image = {
    isEmpty: () => false,
    toPNG: () => Buffer.from('png-data'),
  };
  const browserWebContents = {
    isDestroyed: () => false,
    capturePage: async () => image,
  };
  const browserSession = {
    async clearStorageData(options) {
      calls.push(['clear-storage-data', options]);
    },
    async clearCache() {
      calls.push(['clear-cache']);
    },
  };
  const ports = {
    getActiveWebContentsId: () => activeWebContentsId,
    registerWebContents: (registration) => {
      calls.push(['register', registration]);
      activeWebContentsId = Number(registration.webContentsId) || null;
      return { ok: true, webContentsId: activeWebContentsId };
    },
    unregisterWebContents: (registration) => {
      calls.push(['unregister', registration]);
      activeWebContentsId = null;
      return { ok: true, cleared: true };
    },
    rebuildMenu: () => calls.push(['rebuild-menu']),
    getBrowserSession: () => browserSession,
    getWebContentsById: (id) => {
      calls.push(['get-web-contents', id]);
      return browserWebContents;
    },
    resolveWindowFromSender: (sender) => {
      calls.push(['resolve-window', sender]);
      return { id: 'window' };
    },
    showSaveDialog: async (window, options) => {
      calls.push(['show-save-dialog', window, options]);
      return { canceled: false, filePath: '/chosen/capture.png' };
    },
    getDownloadsPath: () => '/downloads',
    joinPath: (...parts) => parts.join('/'),
    now: () => new Date('2026-08-01T10:20:30.456Z'),
    writeFile: async (targetPath, content) => {
      calls.push(['write-file', targetPath, content]);
    },
    openExternal: async (url) => {
      calls.push(['open-external', url]);
    },
    ...overrides,
  };

  return {
    calls,
    image,
    browserSession,
    browserWebContents,
    service: createBrowserCoreApplicationService(ports),
    setActiveWebContentsId(value) {
      activeWebContentsId = value;
    },
  };
}

test('registry commands rebuild the app menu only when active-browser presence changes', () => {
  const { calls, service, setActiveWebContentsId } = createHarness();
  const registration = { webContentsId: 42, conversationId: 'conversation-1' };

  assert.deepEqual(service.registerWebContents(registration), { ok: true, webContentsId: 42 });
  assert.deepEqual(calls, [['register', registration], ['rebuild-menu']]);

  calls.length = 0;
  setActiveWebContentsId(7);
  service.registerWebContents({ webContentsId: 42 });
  assert.deepEqual(calls, [['register', { webContentsId: 42 }]]);

  calls.length = 0;
  assert.deepEqual(service.unregisterWebContents(registration), { ok: true, cleared: true });
  assert.deepEqual(calls, [['unregister', registration], ['rebuild-menu']]);
});

test('clearSiteData validates URLs and preserves protocol error results', async () => {
  const { calls, service } = createHarness();

  assert.deepEqual(await service.clearSiteData(), { ok: false, error: 'invalid_url' });
  assert.deepEqual(await service.clearSiteData({ url: 'not a url' }), {
    ok: false,
    error: 'invalid_url',
  });
  assert.deepEqual(await service.clearSiteData({ url: 'file:///tmp/index.html' }), {
    ok: false,
    error: 'unsupported_scheme',
  });
  assert.deepEqual(calls, []);
});

test('clearSiteData clears the legacy storage set and best-effort HTTP cache', async () => {
  const { calls, service } = createHarness();

  assert.deepEqual(await service.clearSiteData({ url: 'https://example.com/path?q=1' }), {
    ok: true,
    origin: 'https://example.com',
  });
  assert.deepEqual(calls, [
    ['clear-storage-data', {
      origin: 'https://example.com',
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'shadercache',
        'websql',
        'serviceworkers',
        'cachestorage',
      ],
    }],
    ['clear-cache'],
  ]);
});

test('clearSiteData ignores cache failures but maps storage failures', async () => {
  const storageError = new Error('storage failed');
  const cacheHarness = createHarness({
    getBrowserSession: () => ({
      clearStorageData: async () => {},
      clearCache: async () => {
        throw new Error('cache failed');
      },
    }),
  });
  assert.deepEqual(await cacheHarness.service.clearSiteData({ url: 'https://example.com' }), {
    ok: true,
    origin: 'https://example.com',
  });

  const storageHarness = createHarness({
    getBrowserSession: () => ({
      clearStorageData: async () => {
        throw storageError;
      },
      clearCache: async () => {},
    }),
  });
  assert.deepEqual(await storageHarness.service.clearSiteData({ url: 'https://example.com' }), {
    ok: false,
    error: 'storage failed',
  });
});

test('capturePage rejects invalid or unavailable targets and empty captures', async () => {
  const { service } = createHarness();
  assert.deepEqual(await service.capturePage({ webContentsId: 0 }), {
    ok: false,
    error: 'invalid_web_contents_id',
  });

  const unavailable = createHarness({ getWebContentsById: () => null });
  assert.deepEqual(await unavailable.service.capturePage({ webContentsId: 5 }), {
    ok: false,
    error: 'browser_unavailable',
  });

  const destroyed = createHarness({
    getWebContentsById: () => ({ isDestroyed: () => true }),
  });
  assert.deepEqual(await destroyed.service.capturePage({ webContentsId: 5 }), {
    ok: false,
    error: 'browser_unavailable',
  });

  const empty = createHarness({
    getWebContentsById: () => ({
      isDestroyed: () => false,
      capturePage: async () => ({ isEmpty: () => true }),
    }),
  });
  assert.deepEqual(await empty.service.capturePage({ webContentsId: 5 }), {
    ok: false,
    error: 'empty_capture',
  });
});

test('capturePage writes an explicit trimmed path without opening a dialog', async () => {
  const { calls, service } = createHarness();

  assert.deepEqual(
    await service.capturePage({ sender: { id: 1 }, webContentsId: '5', savePath: '  /tmp/page.png  ' }),
    { ok: true, path: '/tmp/page.png', bytes: 8 },
  );
  assert.deepEqual(calls, [
    ['get-web-contents', 5],
    ['write-file', '/tmp/page.png', Buffer.from('png-data')],
  ]);
});

test('capturePage uses the legacy save-dialog defaults and supports cancellation', async () => {
  const sender = { id: 9 };
  const { calls, service } = createHarness();

  assert.deepEqual(await service.capturePage({ sender, webContentsId: 5 }), {
    ok: true,
    path: '/chosen/capture.png',
    bytes: 8,
  });
  assert.deepEqual(calls[1], ['resolve-window', sender]);
  assert.deepEqual(calls[2], ['show-save-dialog', { id: 'window' }, {
    title: 'Save screenshot',
    defaultPath: '/downloads/peer-browser-2026-08-01T10-20-30-456Z.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  }]);

  const cancelled = createHarness({
    showSaveDialog: async () => ({ canceled: true, filePath: null }),
  });
  assert.deepEqual(await cancelled.service.capturePage({ sender, webContentsId: 5 }), {
    ok: false,
    error: 'cancelled',
  });
});

test('capturePage maps host failures to the legacy error result', async () => {
  const failing = createHarness({
    getWebContentsById: () => ({
      isDestroyed: () => false,
      capturePage: async () => {
        throw new Error('capture exploded');
      },
    }),
  });

  assert.deepEqual(await failing.service.capturePage({ webContentsId: 5 }), {
    ok: false,
    error: 'capture exploded',
  });
});

test('openExternal only opens http(s) URLs in the system browser', async () => {
  const { calls, service } = createHarness();

  assert.deepEqual(await service.openExternal(), { ok: false, error: 'invalid_url' });
  assert.deepEqual(await service.openExternal({ url: 'not a url' }), {
    ok: false,
    error: 'invalid_url',
  });
  assert.deepEqual(await service.openExternal({ url: 'file:///tmp/secret' }), {
    ok: false,
    error: 'unsupported_protocol',
  });
  assert.deepEqual(await service.openExternal({ url: 'javascript:alert(1)' }), {
    ok: false,
    error: 'unsupported_protocol',
  });
  assert.equal(calls.some((entry) => entry[0] === 'open-external'), false);

  assert.deepEqual(await service.openExternal({ url: 'https://github.com/ly-ccx/Peer-Agent' }), {
    ok: true,
    url: 'https://github.com/ly-ccx/Peer-Agent',
  });
  assert.deepEqual(await service.openExternal({ url: 'http://localhost:5173/app' }), {
    ok: true,
    url: 'http://localhost:5173/app',
  });
  assert.deepEqual(calls.filter((entry) => entry[0] === 'open-external'), [
    ['open-external', 'https://github.com/ly-ccx/Peer-Agent'],
    ['open-external', 'http://localhost:5173/app'],
  ]);
});
