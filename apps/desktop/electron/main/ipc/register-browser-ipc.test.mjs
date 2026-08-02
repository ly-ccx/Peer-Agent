import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserIpcRegistrations } from './register-browser-ipc.mjs';

function createServices(calls) {
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return `${name}-result`;
  };
  return {
    browser: {
      registerWebContents: port('register'),
      unregisterWebContents: port('unregister'),
      clearSiteData: port('clear-site-data'),
      capturePage: port('capture-page'),
    },
    sessionImport: {
      listSessionSources: port('list-session-sources'),
      getPreflight: port('session-import-preflight'),
      listSessionSites: port('list-session-sites'),
      importSiteSession: port('import-site-session'),
    },
    fdaDrag: {
      openFullDiskAccessSettings: port('open-fda-settings'),
      hideDragFloat: port('hide-float'),
      setDragFloatDragging: port('set-dragging'),
      hideDragFloatSync: port('hide-float-sync'),
      startAppDrag: port('start-app-drag'),
      getAppDragTarget: port('get-app-drag-target'),
    },
  };
}

function createHarness() {
  const calls = [];
  const [registration] = createBrowserIpcRegistrations(createServices(calls));
  const handlers = new Map();
  const listeners = new Map();
  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
  });
  return { calls, registration, handlers, listeners };
}

test('browser owner registers Browser, Session Import, and FDA channels once', () => {
  const { registration, handlers, listeners } = createHarness();

  assert.equal(registration.owner, 'browser-ipc');
  assert.deepEqual([...handlers.keys()], [
    'browser:register-webcontents',
    'browser:unregister-webcontents',
    'browser:clear-site-data',
    'browser:capture-page',
    'browser:list-session-sources',
    'browser:session-import-preflight',
    'browser:list-session-sites',
    'browser:import-site-session',
    'browser:open-full-disk-access-settings',
    'browser:hide-fda-drag-float',
    'browser:get-app-drag-target',
  ]);
  assert.deepEqual([...listeners.keys()], [
    'browser:fda-drag-float-dragging',
    'browser:hide-fda-drag-float-sync',
    'browser:start-app-drag',
  ]);
});

test('browser owner projects Browser and Session Import payloads', () => {
  const { calls, handlers } = createHarness();
  const sender = { id: 17 };

  assert.equal(
    handlers.get('browser:register-webcontents')({ sender }, { webContentsId: 1 }),
    'register-result',
  );
  assert.equal(
    handlers.get('browser:unregister-webcontents')({ sender }, { webContentsId: 2 }),
    'unregister-result',
  );
  assert.equal(
    handlers.get('browser:clear-site-data')({ sender }, { url: 'https://example.com' }),
    'clear-site-data-result',
  );
  assert.equal(
    handlers.get('browser:capture-page')(
      { sender },
      { webContentsId: 3, savePath: '/tmp/page.png' },
    ),
    'capture-page-result',
  );
  assert.equal(
    handlers.get('browser:list-session-sources')({ sender }),
    'list-session-sources-result',
  );
  assert.equal(
    handlers.get('browser:session-import-preflight')({ sender }),
    'session-import-preflight-result',
  );
  assert.equal(
    handlers.get('browser:list-session-sites')({ sender }, { profileId: 'profile-1' }),
    'list-session-sites-result',
  );
  assert.equal(
    handlers.get('browser:import-site-session')(
      { sender },
      { profileId: 'profile-1', registrableDomains: ['example.com'] },
    ),
    'import-site-session-result',
  );

  assert.deepEqual(calls, [
    ['register', { webContentsId: 1 }],
    ['unregister', { webContentsId: 2 }],
    ['clear-site-data', { url: 'https://example.com' }],
    ['capture-page', { webContentsId: 3, savePath: '/tmp/page.png', sender }],
    ['list-session-sources'],
    ['session-import-preflight'],
    ['list-session-sites', { profileId: 'profile-1' }],
    ['import-site-session', {
      profileId: 'profile-1',
      registrableDomains: ['example.com'],
    }],
  ]);
});

test('browser owner preserves FDA payloads and synchronous returnValue semantics', () => {
  const { calls, handlers, listeners } = createHarness();
  const sender = { id: 21 };

  assert.equal(
    handlers.get('browser:open-full-disk-access-settings')(
      { sender },
      { isZh: true },
    ),
    'open-fda-settings-result',
  );
  assert.equal(
    handlers.get('browser:hide-fda-drag-float')({ sender }),
    'hide-float-result',
  );
  assert.equal(
    handlers.get('browser:get-app-drag-target')({ sender }),
    'get-app-drag-target-result',
  );

  listeners.get('browser:fda-drag-float-dragging')(
    { sender },
    { dragging: true },
  );
  const hideEvent = { sender };
  const dragEvent = { sender };
  listeners.get('browser:hide-fda-drag-float-sync')(hideEvent);
  listeners.get('browser:start-app-drag')(
    dragEvent,
    { appPath: '/Applications/Peer Agent.app' },
  );

  assert.equal(hideEvent.returnValue, 'hide-float-sync-result');
  assert.equal(dragEvent.returnValue, 'start-app-drag-result');
  assert.deepEqual(calls, [
    ['open-fda-settings', { isZh: true }],
    ['hide-float'],
    ['get-app-drag-target'],
    ['set-dragging', { dragging: true }],
    ['hide-float-sync'],
    ['start-app-drag', { appPath: '/Applications/Peer Agent.app' }, sender],
  ]);
});

test('browser owner preserves default empty payloads', () => {
  const { calls, handlers, listeners } = createHarness();
  const sender = { id: 17 };

  handlers.get('browser:register-webcontents')({ sender });
  handlers.get('browser:unregister-webcontents')({ sender });
  handlers.get('browser:clear-site-data')({ sender });
  handlers.get('browser:capture-page')({ sender });
  handlers.get('browser:list-session-sources')({ sender });
  handlers.get('browser:session-import-preflight')({ sender });
  handlers.get('browser:list-session-sites')({ sender });
  handlers.get('browser:import-site-session')({ sender });
  handlers.get('browser:open-full-disk-access-settings')({ sender });
  listeners.get('browser:fda-drag-float-dragging')({ sender });
  listeners.get('browser:start-app-drag')({ sender });

  assert.deepEqual(calls, [
    ['register', {}],
    ['unregister', {}],
    ['clear-site-data', {}],
    ['capture-page', { sender }],
    ['list-session-sources'],
    ['session-import-preflight'],
    ['list-session-sites', {}],
    ['import-site-session', {}],
    ['open-fda-settings', {}],
    ['set-dragging', {}],
    ['start-app-drag', {}, sender],
  ]);
});

test('browser owner fails fast when a required service port is absent', () => {
  assert.throws(() => createBrowserIpcRegistrations(), /browser\.registerWebContents/);

  const calls = [];
  const services = createServices(calls);
  delete services.fdaDrag;
  assert.throws(
    () => createBrowserIpcRegistrations(services),
    /fdaDrag\.openFullDiskAccessSettings/,
  );
});
