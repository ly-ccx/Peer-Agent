import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEditorPreferenceService } from './editor-preference-service.mjs';
import { createSettingsStore } from './settings-store.mjs';

const VSCODE = { id: 'vscode', name: 'Visual Studio Code' };
const ZED = { id: 'zed', name: 'Zed' };

function fakeService({ editors = [VSCODE, ZED], settings = {} } = {}) {
  let state = settings;
  const service = createEditorPreferenceService({
    getSettings: () => state,
    mergeSettings: (partial) => {
      state = { ...state, ...partial };
      return state;
    },
    detectEditors: () => editors,
  });
  return { service, read: () => state };
}

test('resolve falls back to the first candidate when nothing is stored', () => {
  const { service } = fakeService();

  assert.deepEqual(service.resolve(), {
    editors: [VSCODE, ZED],
    defaultEditorId: 'vscode',
    stored: null,
    stale: false,
  });
});

test('resolve honours a stored choice that is still installed', () => {
  const { service } = fakeService({ settings: { preferredEditor: { editorId: 'zed' } } });

  assert.deepEqual(service.resolve(), {
    editors: [VSCODE, ZED],
    defaultEditorId: 'zed',
    stored: 'zed',
    stale: false,
  });
});

test('resolve degrades gracefully when the remembered editor was uninstalled', () => {
  const { service } = fakeService({
    editors: [ZED],
    settings: { preferredEditor: { editorId: 'vscode' } },
  });

  // 不能把已卸载的 vscode 交给上层，但要保留 stored 以便 UI 说明「原选择不可用」。
  assert.deepEqual(service.resolve(), {
    editors: [ZED],
    defaultEditorId: 'zed',
    stored: 'vscode',
    stale: true,
  });
});

test('resolve reports no default when this machine has no editors at all', () => {
  const { service } = fakeService({
    editors: [],
    settings: { preferredEditor: { editorId: 'vscode' } },
  });

  const resolved = service.resolve();
  assert.equal(resolved.defaultEditorId, null);
  assert.equal(resolved.stale, true);
});

test('setDefault only accepts editors that exist on this machine', () => {
  const { service, read } = fakeService();

  assert.deepEqual(service.setDefault('zed'), { ok: true, editorId: 'zed' });
  assert.deepEqual(read().preferredEditor, { editorId: 'zed' });

  assert.deepEqual(service.setDefault('ghost'), { ok: false, reason: 'editor_not_found' });
  assert.deepEqual(service.setDefault(''), { ok: false, reason: 'invalid_editor' });
  // 失败的写入不应污染已保存的值。
  assert.deepEqual(read().preferredEditor, { editorId: 'zed' });
});

test('clearDefault forgets the choice and returns to the first candidate', () => {
  const { service } = fakeService({ settings: { preferredEditor: { editorId: 'zed' } } });

  assert.deepEqual(service.clearDefault(), { ok: true });
  assert.equal(service.resolve().defaultEditorId, 'vscode');
  assert.equal(service.resolve().stored, null);
});

test('malformed stored values are ignored instead of throwing', () => {
  for (const stored of [null, 'zed', [], { editorId: 42 }, { editorId: '' }]) {
    const { service } = fakeService({ settings: { preferredEditor: stored } });
    assert.equal(service.resolve().stored, null);
    assert.equal(service.resolve().defaultEditorId, 'vscode');
  }
});

test('the choice survives a restart through the real settings store', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-editor-pref-'));
  try {
    const settingsFile = path.join(root, 'settings.json');
    const build = () => {
      const store = createSettingsStore({ settingsFile });
      return createEditorPreferenceService({
        getSettings: () => store.getAll(),
        mergeSettings: (partial) => store.merge(partial),
        detectEditors: () => [VSCODE, ZED],
      });
    };

    assert.deepEqual(build().setDefault('zed'), { ok: true, editorId: 'zed' });

    // 全新实例 = 重启后重新读盘。
    assert.equal(build().resolve().defaultEditorId, 'zed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('storing the editor preference keeps other settings namespaces intact', () => {
  const { service, read } = fakeService({
    settings: { appMode: 'work', appearance: { theme: 'dark' } },
  });

  service.setDefault('zed');

  assert.deepEqual(read(), {
    appMode: 'work',
    appearance: { theme: 'dark' },
    preferredEditor: { editorId: 'zed' },
  });
});
