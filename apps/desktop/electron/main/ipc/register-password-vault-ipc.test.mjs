import assert from 'node:assert/strict';
import test from 'node:test';
import { createPasswordVaultIpcRegistrations } from './register-password-vault-ipc.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const ports = {
    listEntries: () => {
      calls.push(['list']);
      return [{ id: 'all' }];
    },
    listForOrigin: (origin) => {
      calls.push(['list-origin', origin]);
      return [{ id: 'origin' }];
    },
    upsertEntry: (payload) => {
      calls.push(['upsert', payload]);
      return { id: 'entry-1' };
    },
    deleteEntry: (id) => {
      calls.push(['delete', id]);
      return { ok: true };
    },
    revealPassword: (id) => {
      calls.push(['reveal', id]);
      return { ok: true, password: 'secret' };
    },
    fill: (payload) => {
      calls.push(['fill', payload]);
      return { ok: true, id: payload?.id };
    },
    ...overrides,
  };
  const registrations = createPasswordVaultIpcRegistrations({ passwordVault: ports });
  const handlers = new Map();
  const ipc = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  };
  for (const registration of registrations) registration.register(ipc);
  return { calls, handlers, registrations };
}

test('password vault IPC has one owner for management and user-triggered fill channels', () => {
  const { handlers, registrations } = createHarness();

  assert.deepEqual(registrations.map(({ owner }) => owner), ['password-vault-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'password-vault:delete',
    'password-vault:fill',
    'password-vault:list',
    'password-vault:reveal',
    'password-vault:upsert',
  ]);
});

test('password vault IPC preserves list routing and CRUD result projection', async () => {
  const { calls, handlers } = createHarness();
  const payload = { origin: 'https://example.com', username: 'alice' };

  assert.deepEqual(await handlers.get('password-vault:list')(null), {
    ok: true,
    entries: [{ id: 'all' }],
  });
  assert.deepEqual(await handlers.get('password-vault:list')(null, { origin: payload.origin }), {
    ok: true,
    entries: [{ id: 'origin' }],
  });
  assert.deepEqual(await handlers.get('password-vault:upsert')(null, payload), {
    ok: true,
    entry: { id: 'entry-1' },
  });
  assert.deepEqual(await handlers.get('password-vault:delete')(null), { ok: true });
  assert.deepEqual(await handlers.get('password-vault:reveal')(null, { id: 'entry-1' }), {
    ok: true,
    password: 'secret',
  });
  const fillPayload = { id: 'entry-1', webContentsId: 17, fillUsername: false };
  assert.deepEqual(await handlers.get('password-vault:fill')(null, fillPayload), {
    ok: true,
    id: 'entry-1',
  });
  assert.deepEqual(calls, [
    ['list'],
    ['list-origin', payload.origin],
    ['upsert', payload],
    ['delete', undefined],
    ['reveal', 'entry-1'],
    ['fill', fillPayload],
  ]);
});

test('password vault IPC maps management exceptions without leaking them', async () => {
  const { handlers } = createHarness({
    listEntries: () => { throw new Error('list exploded'); },
    listForOrigin: () => { throw new Error(); },
    upsertEntry: () => { throw new Error('upsert exploded'); },
    deleteEntry: () => { throw new Error('delete exploded'); },
    revealPassword: () => { throw new Error('reveal exploded'); },
    fill: () => { throw new Error('fill exploded'); },
  });

  assert.deepEqual(await handlers.get('password-vault:list')(null), {
    ok: false,
    error: 'list exploded',
    entries: [],
  });
  assert.deepEqual(await handlers.get('password-vault:list')(null, { origin: 'https://x' }), {
    ok: false,
    error: 'list_failed',
    entries: [],
  });
  assert.deepEqual(await handlers.get('password-vault:upsert')(null), {
    ok: false,
    error: 'upsert exploded',
  });
  assert.deepEqual(await handlers.get('password-vault:delete')(null), {
    ok: false,
    error: 'delete exploded',
  });
  assert.deepEqual(await handlers.get('password-vault:reveal')(null), {
    ok: false,
    error: 'reveal exploded',
  });
  assert.deepEqual(await handlers.get('password-vault:fill')(null), {
    ok: false,
    error: 'fill exploded',
  });
});
