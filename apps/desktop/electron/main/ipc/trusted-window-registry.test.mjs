import assert from 'node:assert/strict';
import test from 'node:test';
import { getDesktopIpcPolicy } from '../../ipc/channels.mjs';
import {
  createTrustedWindowRegistry,
  DesktopIpcAuthorizationError,
} from './trusted-window-registry.mjs';

function createWebContents(url = 'https://app.local/index.html') {
  const handlers = new Map();
  const mainFrame = { url, parent: null };
  return {
    handlers,
    mainFrame,
    getURL: () => mainFrame.url,
    on(name, handler) { handlers.set(name, handler); },
    once(name, handler) { handlers.set(name, handler); },
    removeListener(name, handler) {
      if (handlers.get(name) === handler) handlers.delete(name);
    },
    setWindowOpenHandler(handler) { handlers.set('window-open', handler); },
  };
}

function createEvent(sender, frame = sender.mainFrame) {
  return { sender, senderFrame: frame };
}

const queryEntry = Object.freeze({
  channel: 'settings:get',
  allowedWindowRoles: Object.freeze(['main']),
  framePolicy: 'top-frame',
  originPolicy: 'app-origin',
});

test('trusted window registry authorizes only the registered role, top frame, and location', () => {
  const sender = createWebContents();
  const registry = createTrustedWindowRegistry();
  registry.registerWindow({
    window: { webContents: sender },
    role: 'main',
    allowedLocations: ['https://app.local/index.html'],
  });

  assert.deepEqual(registry.authorize({ entry: queryEntry, event: createEvent(sender) }), { role: 'main' });
  assert.equal(registry.getRole(sender), 'main');
});

test('trusted window registry fails closed for unknown sender, wrong role, child frame, and origin', () => {
  const sender = createWebContents();
  const registry = createTrustedWindowRegistry();
  registry.registerWindow({
    window: { webContents: sender },
    role: 'quick-chat',
    allowedLocations: ['https://app.local/index.html'],
  });

  assert.throws(
    () => registry.authorize({ entry: queryEntry, event: createEvent(createWebContents()) }),
    DesktopIpcAuthorizationError,
  );
  assert.throws(
    () => registry.authorize({ entry: queryEntry, event: createEvent(sender) }),
    /not allowed for this window role/,
  );

  const quickEntry = { ...queryEntry, allowedWindowRoles: ['quick-chat'] };
  assert.throws(
    () => registry.authorize({ entry: quickEntry, event: createEvent(sender, { url: sender.mainFrame.url, parent: {} }) }),
    /trusted top frame/,
  );
  sender.mainFrame.url = 'https://evil.invalid/index.html';
  assert.throws(
    () => registry.authorize({ entry: quickEntry, event: createEvent(sender) }),
    /untrusted location/,
  );
});

test('trusted window registry blocks navigation and new windows while opening safe external URLs', async () => {
  const sender = createWebContents();
  const external = [];
  const registry = createTrustedWindowRegistry({ openExternal: (url) => external.push(url) });
  registry.registerWindow({
    window: { webContents: sender },
    role: 'main',
    allowedLocations: ['https://app.local/index.html'],
  });

  let prevented = false;
  sender.handlers.get('will-navigate')({ preventDefault: () => { prevented = true; } }, 'https://example.com/');
  assert.equal(prevented, true);
  assert.deepEqual(sender.handlers.get('window-open')({ url: 'https://example.com/docs' }), { action: 'deny' });
  await Promise.resolve();
  assert.deepEqual(external, ['https://example.com/', 'https://example.com/docs']);

  prevented = false;
  sender.handlers.get('will-navigate')({ preventDefault: () => { prevented = true; } }, 'https://app.local/index.html?window=main');
  assert.equal(prevented, false);
});

test('permission drag float is limited to its exact data URL and catalog allowlist', () => {
  const trustedUrl = 'data:text/html;charset=utf-8,%3Cmain%3Etrusted%3C%2Fmain%3E';
  const sender = createWebContents(trustedUrl);
  const registry = createTrustedWindowRegistry();
  registry.registerWindow({
    window: { webContents: sender },
    role: 'permission-drag-float',
    allowedLocations: [trustedUrl],
  });

  for (const channel of [
    'settings:get-sync',
    'browser:start-app-drag',
    'browser:hide-fda-drag-float-sync',
    'browser:fda-drag-float-dragging',
  ]) {
    const entry = getDesktopIpcPolicy(channel);
    assert.ok(entry, `missing catalog policy for ${channel}`);
    assert.deepEqual(
      registry.authorize({ entry, event: createEvent(sender) }),
      { role: 'permission-drag-float' },
    );
  }

  const unrelatedEntry = getDesktopIpcPolicy('conversations:list');
  assert.throws(
    () => registry.authorize({ entry: unrelatedEntry, event: createEvent(sender) }),
    /not allowed for this window role/,
  );
  sender.mainFrame.url = `${trustedUrl}tampered`;
  assert.throws(
    () => registry.authorize({
      entry: getDesktopIpcPolicy('browser:start-app-drag'),
      event: createEvent(sender),
    }),
    /untrusted location/,
  );
  sender.mainFrame.url = trustedUrl;
  assert.throws(
    () => registry.authorize({
      entry: getDesktopIpcPolicy('browser:start-app-drag'),
      event: createEvent(sender, { url: trustedUrl, parent: {} }),
    }),
    /trusted top frame/,
  );
});

test('trusted window registry removes identity when webContents is destroyed', () => {
  const sender = createWebContents('file:///Applications/Peer/dist/index.html');
  const registry = createTrustedWindowRegistry();
  const unregister = registry.registerWindow({
    window: { webContents: sender },
    role: 'main',
    allowedLocations: ['file:///Applications/Peer/dist/index.html'],
  });
  assert.equal(registry.getRole(sender), 'main');
  sender.handlers.get('destroyed')();
  assert.equal(registry.getRole(sender), null);
  assert.equal(sender.handlers.has('will-navigate'), false);
  assert.equal(sender.handlers.has('will-redirect'), false);
  assert.equal(sender.handlers.has('destroyed'), false);
  assert.equal(unregister(), false);
  assert.equal(registry.dispose(), true);
  assert.equal(registry.dispose(), false);
});

test('registry dispose unregisters every live window and is idempotent', () => {
  const sender = createWebContents();
  const registry = createTrustedWindowRegistry();
  registry.registerWindow({
    window: { webContents: sender },
    role: 'main',
    allowedLocations: ['https://app.local/index.html'],
  });
  assert.equal(registry.dispose(), true);
  assert.equal(registry.getRole(sender), null);
  assert.equal(sender.handlers.has('will-navigate'), false);
  assert.equal(sender.handlers.has('will-redirect'), false);
  assert.equal(sender.handlers.has('destroyed'), false);
  assert.equal(registry.dispose(), false);
});
