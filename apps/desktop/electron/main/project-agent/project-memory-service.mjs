/**
 * 记忆页动作。渲染层不碰文件系统；导出只经 main 的保存对话框。
 */
import { writeFileSync } from 'node:fs';

import { isMemoryWorkspaceId } from '@peer-agent/runtime-node';

import { liveMemoryIndex } from './memory-index-port.mjs';

function fail(code) {
  return { ok: false, code };
}

function fromStore(result) {
  if (result?.ok) return result;
  return fail(String(result?.reason || 'invalid_input').toUpperCase());
}

function markdown(items) {
  const lines = ['# 记忆', ''];
  for (const item of items) {
    lines.push(`## ${item.kind} · ${item.trust} · ${item.id}`, '', item.text, '');
  }
  return `${lines.join('\n')}\n`;
}

export function createProjectMemoryService({
  store,
  profileStore,
  getSettings = () => ({}),
  mergeSettings = () => {},
  showSaveDialog = async () => ({ canceled: true }),
  onChanged = null,
} = {}) {
  if (!store) throw new TypeError('store is required');

  function workspaceIdOf(payload) {
    const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : '';
    return isMemoryWorkspaceId(workspaceId) ? workspaceId : '';
  }

  function settingsMemory() {
    const memory = getSettings()?.memory;
    const record = memory && typeof memory === 'object' && !Array.isArray(memory) ? memory : {};
    return {
      enabled: record.enabled !== false,
      learnPreferences: record.learnPreferences !== false,
    };
  }

  function switches(workspaceId) {
    const memory = settingsMemory();
    const profile = profileStore?.read?.(workspaceId);
    return {
      memoryEnabled: profile?.memoryEnabled !== false,
      useMemory: memory.enabled,
      learnPreferences: memory.learnPreferences,
    };
  }

  function changed(result, workspaceId) {
    if (result?.ok) {
      liveMemoryIndex().rebuild();
      if (typeof onChanged === 'function') onChanged(workspaceId);
    }
    return result;
  }

  function list(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    let items = store.list({ workspaceId });
    if (typeof payload.kind === 'string' && payload.kind) {
      items = items.filter((item) => item.kind === payload.kind);
    }
    if (typeof payload.trust === 'string' && payload.trust) {
      items = items.filter((item) => item.trust === payload.trust);
    }
    if (typeof payload.status === 'string' && payload.status) {
      items = items.filter((item) => item.status === payload.status);
    }
    if (Array.isArray(payload.ids) && payload.ids.length) {
      const wanted = new Set(payload.ids.filter((id) => typeof id === 'string'));
      items = items.filter((item) => wanted.has(item.id));
    }
    return { ok: true, items, switches: switches(workspaceId) };
  }

  function pin(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    const saved = store.setPinned({
      id: payload.id,
      pinned: payload.pinned,
      workspaceId,
    });
    return changed(saved.ok ? { ok: true, item: saved.item } : fromStore(saved), workspaceId);
  }

  function forget(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim()
      : '用户撤销';
    const saved = store.forget({ id: payload.id, reason, workspaceId });
    return changed(saved.ok ? { ok: true, item: saved.item } : fromStore(saved), workspaceId);
  }

  function restore(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    const saved = payload.resolveConflict === true
      ? store.resolveConflict({ id: payload.id, workspaceId })
      : store.restore({ id: payload.id, workspaceId });
    return changed(saved.ok ? { ok: true, item: saved.item } : fromStore(saved), workspaceId);
  }

  function edit(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    const saved = store.reviseStated({
      id: payload.id,
      text: payload.text,
      workspaceId,
    });
    return changed(saved.ok
      ? { ok: true, item: saved.item, revokedId: saved.revokedId }
      : fromStore(saved), workspaceId);
  }

  async function exportMemory(payload = {}) {
    const listed = list({ workspaceId: payload.workspaceId, status: 'active' });
    if (!listed.ok) return listed;
    const format = payload.format === 'markdown' ? 'markdown' : 'json';
    const picked = await showSaveDialog({
      title: '导出记忆',
      defaultPath: format === 'markdown' ? 'memory.md' : 'memory.json',
    });
    if (!picked || picked.canceled || typeof picked.filePath !== 'string' || !picked.filePath) {
      return fail('CANCELLED');
    }
    const body = format === 'markdown'
      ? markdown(listed.items)
      : `${JSON.stringify(listed.items, null, 2)}\n`;
    writeFileSync(picked.filePath, body, 'utf8');
    return { ok: true, path: picked.filePath, format };
  }

  function setSwitches(payload = {}) {
    const workspaceId = workspaceIdOf(payload);
    if (!workspaceId) return fail('INVALID_WORKSPACE');
    if (typeof payload.memoryEnabled === 'boolean') {
      const profile = profileStore?.read?.(workspaceId);
      if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
      const saved = profileStore.save({ ...profile, memoryEnabled: payload.memoryEnabled });
      if (!saved?.ok) return fail(saved.code || 'SAVE_FAILED');
    }
    if (typeof payload.useMemory === 'boolean' || typeof payload.learnPreferences === 'boolean') {
      const current = settingsMemory();
      mergeSettings({
        memory: {
          enabled: typeof payload.useMemory === 'boolean' ? payload.useMemory : current.enabled,
          learnPreferences: typeof payload.learnPreferences === 'boolean'
            ? payload.learnPreferences
            : current.learnPreferences,
        },
      });
    }
    return { ok: true, switches: switches(workspaceId) };
  }

  return {
    list,
    pin,
    forget,
    restore,
    edit,
    exportMemory,
    setSwitches,
  };
}
