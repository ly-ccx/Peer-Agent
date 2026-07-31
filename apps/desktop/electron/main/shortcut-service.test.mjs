import assert from 'node:assert/strict';
import test from 'node:test';
import { createShortcutService, DEFAULT_SHORTCUTS, validateShortcut } from './shortcut-service.mjs';

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
    merge(partial) {
      // Mirror settings-store shallow top-level merge; nested objects replace.
      settings = { ...settings, ...partial };
      return settings;
    },
  };
  return { registered, settingsStore, service: createShortcutService({ globalShortcut, settingsStore, onQuickChat() {} }), getSettings: () => settings };
}

test('rejects shortcuts without a non-modifier key', () => {
  assert.equal(validateShortcut('CommandOrControl').valid, false);
});

test('registers the configured default shortcut', () => {
  const { service, registered } = fixture();
  const result = service.register();
  assert.equal(result.success, true);
  assert.equal(registered.has(result.accelerator), true);
});

test('keeps previous binding when the next accelerator fails', () => {
  const { service, registered } = fixture({ shortcuts: { quickChat: 'CommandOrControl+Shift+N' } });
  service.register();
  const failed = service.update('quickChat', 'CommandOrControl+Taken');
  assert.equal(failed.success, false);
  assert.equal(registered.has('CommandOrControl+Shift+N'), true);
});

test('reset restores the platform default for quickChat', () => {
  const { service } = fixture({ shortcuts: { quickChat: 'CommandOrControl+Shift+K' } });
  service.register();
  const result = service.reset('quickChat');
  assert.equal(result.quickChat.isDefault, true);
  assert.equal(result.quickChat.registered, true);
});

test('defaults include newTask as CommandOrControl+N', () => {
  assert.equal(DEFAULT_SHORTCUTS.newTask, 'CommandOrControl+N');
});

test('status exposes newTask with default when unset', () => {
  const { service } = fixture();
  const result = service.status();
  assert.equal(result.newTask.configured, 'CommandOrControl+N');
  assert.equal(result.newTask.isDefault, true);
  assert.equal(result.newTask.registered, true);
});

test('update newTask persists without touching global registration', () => {
  const { service, registered, getSettings } = fixture({ shortcuts: { quickChat: 'CommandOrControl+Shift+N' } });
  service.register();
  const before = registered.size;
  const result = service.update('newTask', 'CommandOrControl+T');
  assert.equal(result.newTask.configured, 'CommandOrControl+T');
  assert.equal(result.newTask.isDefault, false);
  assert.equal(registered.size, before);
  assert.equal(getSettings().shortcuts.newTask, 'CommandOrControl+T');
  assert.equal(getSettings().shortcuts.quickChat, 'CommandOrControl+Shift+N');
});

test('update quickChat preserves existing newTask config', () => {
  const { service, getSettings } = fixture({
    shortcuts: { quickChat: 'CommandOrControl+Shift+N', newTask: 'CommandOrControl+T' },
  });
  service.register();
  service.update('quickChat', 'CommandOrControl+Shift+M');
  assert.equal(getSettings().shortcuts.quickChat, 'CommandOrControl+Shift+M');
  assert.equal(getSettings().shortcuts.newTask, 'CommandOrControl+T');
});

test('reset newTask restores CommandOrControl+N', () => {
  const { service } = fixture({ shortcuts: { newTask: 'CommandOrControl+T' } });
  const result = service.reset('newTask');
  assert.equal(result.newTask.configured, 'CommandOrControl+N');
  assert.equal(result.newTask.isDefault, true);
});

test('backward-compatible update(accelerator) still targets quickChat', () => {
  const { service, getSettings } = fixture();
  service.register();
  service.update('CommandOrControl+Shift+Y');
  assert.equal(getSettings().shortcuts.quickChat, 'CommandOrControl+Shift+Y');
});

test('appshot has no default global shortcut and does not occupy CommandOrControl+Shift+A', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SHORTCUTS, 'appshot'), false);
  const registered = new Map();
  const globalShortcut = {
    register(accelerator, handler) { registered.set(accelerator, handler); return true; },
    unregister(accelerator) { registered.delete(accelerator); },
    isRegistered(accelerator) { return registered.has(accelerator); },
  };
  let settings = { shortcuts: { appshot: 'CommandOrControl+Shift+A' } };
  const settingsStore = {
    getAll: () => settings,
    merge: (patch) => { settings = { ...settings, ...patch }; },
  };
  const service = createShortcutService({
    globalShortcut,
    settingsStore,
    onQuickChat: () => {},
  });
  const result = service.register();
  assert.equal(result.actions.quickChat.success, true);
  assert.equal(result.actions.appshot, undefined);
  assert.equal(registered.has('CommandOrControl+Shift+A'), false);
  assert.equal(service.status().appshot.registered, false);
  assert.equal(service.status().appshot.configured, '');
  assert.equal(service.status().appshot.active, null);
});
