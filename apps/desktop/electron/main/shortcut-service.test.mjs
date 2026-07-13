import assert from 'node:assert/strict';
import test from 'node:test';
import { createShortcutService, validateShortcut } from './shortcut-service.mjs';

function fixture(initial = {}) {
  const registered = new Map();
  let settings = initial;
  const globalShortcut = {
    register(accelerator, handler) {
      if (accelerator.includes('Taken')) return false;
      registered.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) { registered.delete(accelerator); },
    isRegistered(accelerator) { return registered.has(accelerator); },
  };
  const settingsStore = {
    getAll: () => settings,
    merge(partial) { settings = { ...settings, ...partial }; return settings; },
  };
  return { registered, settingsStore, service: createShortcutService({ globalShortcut, settingsStore, onQuickChat() {} }) };
}

test('rejects shortcuts without a modifier', () => {
  assert.deepEqual(validateShortcut('N'), { valid: false, reason: 'modifier-required' });
});

test('persists a successfully registered shortcut', () => {
  const { service, settingsStore } = fixture();
  assert.equal(service.register().success, true);
  assert.equal(service.update('CommandOrControl+Shift+K').quickChat.configured, 'CommandOrControl+Shift+K');
  assert.equal(settingsStore.getAll().shortcuts.quickChat, 'CommandOrControl+Shift+K');
});

test('keeps the previous shortcut when registration fails', () => {
  const { service, registered, settingsStore } = fixture();
  const first = service.register();
  const failed = service.update('CommandOrControl+Taken');
  assert.equal(failed.success, false);
  assert.equal(registered.has(first.accelerator), true);
  assert.equal(settingsStore.getAll().shortcuts, undefined);
});

test('reset restores the platform default', () => {
  const { service } = fixture({ shortcuts: { quickChat: 'CommandOrControl+Shift+K' } });
  service.register();
  const result = service.reset();
  assert.equal(result.quickChat.isDefault, true);
  assert.equal(result.quickChat.registered, true);
});
