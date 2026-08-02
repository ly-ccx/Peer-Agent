import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsIpcRegistrations } from './register-settings-ipc.mjs';

function createServices(calls) {
  return {
    settings: {
      get: () => ({ appearance: 'dark' }),
      update: (payload) => ({ ...payload, updated: true }),
      exportSettings: () => ({ canceled: false, exported: ['settings.json'] }),
      importSettings: () => ({ canceled: false, imported: ['settings.json'] }),
      getDeveloperSettings: () => ({ trace: false }),
      updateDeveloperSettings: (payload) => ({ ...payload, updated: true }),
      resetDeveloperSettings: () => ({}),
      diagnostics: () => ({ isDev: true }),
      updateLocale: (payload) => ({ locale: payload.locale }),
    },
    permissions: {
      approve: (payload) => {
        calls.push(['approve', payload]);
        return { granted: true, toolCallId: payload.toolCallId };
      },
      deny: (payload) => {
        calls.push(['deny', payload]);
        return { granted: false, toolCallId: payload.toolCallId };
      },
    },
  };
}

function registerAll(registrations) {
  const handlers = new Map();
  const listeners = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
      on(channel, listener) {
        assert.equal(listeners.has(channel), false, `duplicate listener: ${channel}`);
        listeners.set(channel, listener);
      },
    });
  }
  return { handlers, listeners, owners };
}

test('settings registrations expose exact owners and channel transport types', () => {
  const registrations = createSettingsIpcRegistrations(createServices([]));
  const { handlers, listeners, owners } = registerAll(registrations);

  assert.deepEqual(owners, [
    'settings-ipc',
    'developer-settings-ipc',
    'locale-ipc',
    'permission-ipc',
  ]);
  assert.deepEqual([...handlers.keys()].sort(), [
    'developer-settings:diagnostics',
    'developer-settings:get',
    'developer-settings:reset',
    'developer-settings:update',
    'locale:set',
    'permission:approve',
    'permission:deny',
    'settings:export',
    'settings:get',
    'settings:import',
    'settings:update',
  ]);
  assert.deepEqual([...listeners.keys()], ['settings:get-sync']);
});

test('settings transport preserves payloads, result shapes, and synchronous returnValue', async () => {
  const calls = [];
  const { handlers, listeners } = registerAll(
    createSettingsIpcRegistrations(createServices(calls)),
  );

  const syncEvent = {};
  listeners.get('settings:get-sync')(syncEvent);
  assert.deepEqual(syncEvent.returnValue, { appearance: 'dark' });
  assert.deepEqual(await handlers.get('settings:update')({}, { appearance: 'light' }), {
    appearance: 'light',
    updated: true,
  });
  assert.deepEqual(await handlers.get('developer-settings:update')({}, { trace: true }), {
    trace: true,
    updated: true,
  });
  assert.deepEqual(await handlers.get('locale:set')({}, { locale: 'en-US' }), {
    locale: 'en-US',
  });
  assert.deepEqual(await handlers.get('permission:approve')({}, { toolCallId: 'call-1' }), {
    granted: true,
    toolCallId: 'call-1',
  });
  assert.deepEqual(await handlers.get('permission:deny')({}, { toolCallId: 'call-2' }), {
    granted: false,
    toolCallId: 'call-2',
  });
  assert.deepEqual(calls, [
    ['approve', { toolCallId: 'call-1' }],
    ['deny', { toolCallId: 'call-2' }],
  ]);
});
