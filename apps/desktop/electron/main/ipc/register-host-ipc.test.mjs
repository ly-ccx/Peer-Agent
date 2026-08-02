import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostIpcRegistrations } from './register-host-ipc.mjs';

function registerAll(registrations) {
  const handlers = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
    });
  }
  return { handlers, owners };
}

test('host registrations expose exact owners and forward results without reshaping', async () => {
  const calls = [];
  const startupPermissions = { blocked: false, checks: [] };
  const registrations = createHostIpcRegistrations({
    os: {
      getStartupPermissions: async () => startupPermissions,
    },
    host: {
      restart: (payload) => {
        calls.push(payload);
        return { ok: true, hostDir: payload.hostDir };
      },
    },
  });
  const { handlers, owners } = registerAll(registrations);

  assert.deepEqual(owners, ['os-ipc', 'host-ipc']);
  assert.deepEqual([...handlers.keys()], ['os:startup-permissions', 'host:restart']);
  assert.equal(await handlers.get('os:startup-permissions')(), startupPermissions);
  assert.deepEqual(await handlers.get('host:restart')({}, { hostDir: '/host' }), {
    ok: true,
    hostDir: '/host',
  });
  assert.deepEqual(calls, [{ hostDir: '/host' }]);
});

test('host restart defaults a missing payload to an empty object', () => {
  const seen = [];
  const { handlers } = registerAll(createHostIpcRegistrations({
    os: { getStartupPermissions: () => ({}) },
    host: {
      restart: (payload) => {
        seen.push(payload);
        return payload;
      },
    },
  }));

  assert.deepEqual(handlers.get('host:restart')({}, undefined), {});
  assert.deepEqual(seen, [{}]);
});
