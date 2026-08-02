import assert from 'node:assert/strict';
import test from 'node:test';
import { registerIpcOwners } from './register-all.mjs';

function createFakeIpc(log) {
  const active = new Set();
  return {
    createOwner(owner) {
      if (active.has(owner)) throw new Error(`duplicate:${owner}`);
      active.add(owner);
      log.push(`create:${owner}`);
      let disposed = false;
      return {
        owner,
        handle(key) { log.push(`handle:${owner}:${key}`); },
        on(key) { log.push(`on:${owner}:${key}`); },
        dispose() {
          if (disposed) return false;
          disposed = true;
          active.delete(owner);
          log.push(`ipc-dispose:${owner}`);
          return true;
        },
      };
    },
  };
}

test('registerIpcOwners registers in order, closes all ingress first, and disposes once', () => {
  const log = [];
  const host = registerIpcOwners({
    ipc: createFakeIpc(log),
    registrations: [
      {
        owner: 'alpha-ipc',
        register(ipc) {
          ipc.handle('alpha:get', () => {});
          return () => log.push('resource-dispose:alpha-ipc');
        },
      },
      {
        owner: 'beta-ipc',
        register(ipc) {
          ipc.on('beta:send', () => {});
          return () => log.push('resource-dispose:beta-ipc');
        },
      },
    ],
  });

  assert.equal(host.ownerCount, 2);
  assert.equal(host.dispose(), true);
  assert.equal(host.dispose(), false);
  assert.deepEqual(log, [
    'create:alpha-ipc',
    'handle:alpha-ipc:alpha:get',
    'create:beta-ipc',
    'on:beta-ipc:beta:send',
    'ipc-dispose:beta-ipc',
    'ipc-dispose:alpha-ipc',
    'resource-dispose:beta-ipc',
    'resource-dispose:alpha-ipc',
  ]);
});

test('registerIpcOwners rolls back the partial owner and prior owners in reverse order', () => {
  const log = [];
  assert.throws(
    () => registerIpcOwners({
      ipc: createFakeIpc(log),
      registrations: [
        {
          owner: 'alpha-ipc',
          register(ipc) {
            ipc.handle('alpha:get', () => {});
            return () => log.push('resource-dispose:alpha-ipc');
          },
        },
        {
          owner: 'beta-ipc',
          register(ipc) {
            ipc.handle('beta:get', () => {});
            throw new Error('beta-start-failed');
          },
        },
      ],
    }),
    /beta-start-failed/,
  );
  assert.deepEqual(log, [
    'create:alpha-ipc',
    'handle:alpha-ipc:alpha:get',
    'create:beta-ipc',
    'handle:beta-ipc:beta:get',
    'ipc-dispose:beta-ipc',
    'ipc-dispose:alpha-ipc',
    'resource-dispose:alpha-ipc',
  ]);
});

test('registerIpcOwners rolls back prior owners when owner scope creation fails', () => {
  const log = [];
  const base = createFakeIpc(log);
  assert.throws(
    () => registerIpcOwners({
      ipc: {
        createOwner(owner) {
          if (owner === 'beta-ipc') throw new Error('beta-owner-failed');
          return base.createOwner(owner);
        },
      },
      registrations: [
        {
          owner: 'alpha-ipc',
          register: () => () => log.push('resource-dispose:alpha-ipc'),
        },
        { owner: 'beta-ipc', register: () => {} },
      ],
    }),
    /beta-owner-failed/,
  );
  assert.deepEqual(log, [
    'create:alpha-ipc',
    'ipc-dispose:alpha-ipc',
    'resource-dispose:alpha-ipc',
  ]);
});

test('registerIpcOwners rejects duplicate owners and asynchronous registration', () => {
  assert.throws(
    () => registerIpcOwners({
      ipc: createFakeIpc([]),
      registrations: [
        { owner: 'alpha-ipc', register: () => {} },
        { owner: 'alpha-ipc', register: () => {} },
      ],
    }),
    /declared more than once/,
  );
  assert.throws(
    () => registerIpcOwners({
      ipc: createFakeIpc([]),
      registrations: [{ owner: 'alpha-ipc', register: async () => {} }],
    }),
    /must be synchronous/,
  );
});

test('registerIpcOwners continues cleanup and reports every cleanup failure', () => {
  const log = [];
  const host = registerIpcOwners({
    ipc: createFakeIpc(log),
    registrations: [
      {
        owner: 'alpha-ipc',
        register: () => () => {
          log.push('resource-dispose:alpha-ipc');
          throw new Error('alpha-cleanup-failed');
        },
      },
      {
        owner: 'beta-ipc',
        register: () => () => {
          log.push('resource-dispose:beta-ipc');
          throw new Error('beta-cleanup-failed');
        },
      },
    ],
  });
  assert.throws(() => host.dispose(), AggregateError);
  assert.deepEqual(log.slice(2), [
    'ipc-dispose:beta-ipc',
    'ipc-dispose:alpha-ipc',
    'resource-dispose:beta-ipc',
    'resource-dispose:alpha-ipc',
  ]);
  assert.equal(host.dispose(), false);
});
