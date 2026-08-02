import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogIpcMain } from './catalog-ipc-main.mjs';

function createFakeIpcMain() {
  const handles = new Map();
  const listeners = new Map();
  const removed = [];
  return {
    handles,
    listeners,
    removed,
    handle(channel, listener) {
      handles.set(channel, listener);
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeHandler(channel) {
      removed.push(`handle:${channel}`);
      handles.delete(channel);
    },
    removeListener(channel, listener) {
      removed.push(`on:${channel}`);
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
}

const catalog = Object.freeze({
  query: Object.freeze({
    key: 'query', channel: 'transport:query', transport: 'invoke', owner: 'query-ipc',
  }),
  sync: Object.freeze({
    key: 'sync', channel: 'transport:sync', transport: 'send-sync', owner: 'sync-ipc',
  }),
  event: Object.freeze({
    key: 'event', channel: 'transport:event', transport: 'event', owner: 'event-ipc',
  }),
});

test('catalog IPC adapter resolves transport names and authorizes before handlers', async () => {
  const fake = createFakeIpcMain();
  const calls = [];
  const ipc = createCatalogIpcMain({
    ipcMain: fake,
    catalog,
    authorize: ({ entry, event }) => calls.push(`authorize:${entry.key}:${event.id}`),
  });
  ipc.handle('query', (event, value) => {
    calls.push(`handle:${event.id}:${value}`);
    return value + 1;
  });
  ipc.on('sync', (event, value) => {
    calls.push(`on:${event.id}:${value}`);
    event.returnValue = value;
  });

  assert.equal(await fake.handles.get('transport:query')({ id: 'q' }, 4), 5);
  const syncEvent = { id: 's' };
  fake.listeners.get('transport:sync')(syncEvent, 7);
  assert.equal(syncEvent.returnValue, 7);
  assert.deepEqual(calls, [
    'authorize:query:q',
    'handle:q:4',
    'authorize:sync:s',
    'on:s:7',
  ]);
});

test('catalog IPC adapter rejects unknown, duplicate, and wrong-direction registrations', () => {
  const fake = createFakeIpcMain();
  const ipc = createCatalogIpcMain({ ipcMain: fake, catalog });
  ipc.handle('query', () => {});
  assert.throws(() => ipc.handle('query', () => {}), /already registered/);
  assert.throws(() => ipc.handle('missing', () => {}), /Unknown Desktop IPC catalog key/);
  assert.throws(() => ipc.on('event', () => {}), /transport mismatch/);
});

test('catalog IPC adapter disposes in reverse order and only once', () => {
  const fake = createFakeIpcMain();
  const ipc = createCatalogIpcMain({ ipcMain: fake, catalog });
  ipc.handle('query', () => {});
  ipc.on('sync', () => {});

  assert.equal(ipc.registeredCount, 2);
  assert.equal(ipc.dispose(), true);
  assert.equal(ipc.dispose(), false);
  assert.equal(ipc.registeredCount, 0);
  assert.deepEqual(fake.removed, ['on:transport:sync', 'handle:transport:query']);
});

test('catalog IPC owner scopes enforce catalog ownership and clean up only their registrations', () => {
  const fake = createFakeIpcMain();
  const ipc = createCatalogIpcMain({ ipcMain: fake, catalog });
  const queryOwner = ipc.createOwner('query-ipc');
  queryOwner.handle('query', () => 'ok');
  assert.equal(queryOwner.registeredCount, 1);
  assert.equal(ipc.activeOwnerCount, 1);
  assert.throws(() => queryOwner.on('sync', () => {}), /owner mismatch/);
  assert.throws(() => ipc.createOwner('query-ipc'), /already active/);
  assert.equal(queryOwner.dispose(), true);
  assert.equal(queryOwner.dispose(), false);
  assert.equal(queryOwner.registeredCount, 0);
  assert.equal(ipc.activeOwnerCount, 0);
  assert.equal(fake.handles.has('transport:query'), false);

  const replacementOwner = ipc.createOwner('query-ipc');
  replacementOwner.handle('query', () => 'replacement');
  assert.equal(replacementOwner.registeredCount, 1);
  assert.equal(ipc.dispose(), true);
  assert.equal(ipc.dispose(), false);
  assert.equal(fake.handles.has('transport:query'), false);
});

test('catalog IPC adapter rejects asynchronous authorization to preserve sync IPC timing', () => {
  const fake = createFakeIpcMain();
  const ipc = createCatalogIpcMain({ ipcMain: fake, catalog, authorize: async () => {} });
  ipc.on('sync', () => {});
  assert.throws(
    () => fake.listeners.get('transport:sync')({}),
    /authorization must be synchronous/,
  );
});
