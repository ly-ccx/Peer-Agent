/**
 * 任务系统通知回执与 attention 版本持久化。
 *
 * 路径：~/.peer-agent/task-notification-receipts.json（device scope）
 * 启动时加载；成功弹出 / 阅读后写入；冷启动不回放历史终态。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

const STORE_VERSION = 1;

/**
 * @param {string} filePath
 * @returns {{version:number, tasks: Record<string, object>}}
 */
function emptyState() {
  return { version: STORE_VERSION, tasks: {} };
}

/**
 * @param {unknown} raw
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const tasks = {};
  const source = raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks) ? raw.tasks : {};
  for (const [taskId, entry] of Object.entries(source)) {
    if (!taskId || !entry || typeof entry !== 'object') continue;
    tasks[taskId] = {
      attentionVersion: Number.isFinite(entry.attentionVersion)
        ? Math.max(0, Math.trunc(entry.attentionVersion))
        : 0,
      lastNotifiedAttentionVersion: Number.isFinite(entry.lastNotifiedAttentionVersion)
        ? Math.max(0, Math.trunc(entry.lastNotifiedAttentionVersion))
        : 0,
      lastReadAttentionVersion: Number.isFinite(entry.lastReadAttentionVersion)
        ? Math.max(0, Math.trunc(entry.lastReadAttentionVersion))
        : 0,
      lastStatus: typeof entry.lastStatus === 'string' ? entry.lastStatus : null,
      lastNotifiedAt: typeof entry.lastNotifiedAt === 'string' ? entry.lastNotifiedAt : null,
      lastReadAt: typeof entry.lastReadAt === 'string' ? entry.lastReadAt : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }
  return { version: STORE_VERSION, tasks };
}

/**
 * @param {string} filePath
 */
function readState(filePath) {
  if (!existsSync(filePath)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeState(raw);
  } catch {
    return emptyState();
  }
}

/**
 * 原子写：先写 .tmp 再 rename。
 * @param {string} filePath
 * @param {object} state
 */
function writeState(filePath, state) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * @param {{ receiptFile?: string }} [options]
 */
export function createTaskNotificationReceiptStore({
  receiptFile = pathOf('taskNotificationReceipts'),
} = {}) {
  let state = readState(receiptFile);

  function persist() {
    writeState(receiptFile, state);
  }

  /**
   * @param {string} taskId
   */
  function get(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    return state.tasks[id] ? { ...state.tasks[id] } : null;
  }

  /**
   * @param {string} taskId
   */
  function ensure(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    if (!state.tasks[id]) {
      state.tasks[id] = {
        attentionVersion: 0,
        lastNotifiedAttentionVersion: 0,
        lastReadAttentionVersion: 0,
        lastStatus: null,
        lastNotifiedAt: null,
        lastReadAt: null,
        updatedAt: null,
      };
    }
    return state.tasks[id];
  }

  /**
   * 记录观察到的状态与 attentionVersion（不代表已通知）。
   * @param {string} taskId
   * @param {{ status?: string|null, attentionVersion?: number }} patch
   */
  function observe(taskId, patch = {}) {
    const entry = ensure(taskId);
    if (!entry) return null;
    if (typeof patch.status === 'string' || patch.status === null) {
      entry.lastStatus = patch.status ?? null;
    }
    if (Number.isFinite(patch.attentionVersion)) {
      entry.attentionVersion = Math.max(entry.attentionVersion, Math.trunc(patch.attentionVersion));
    }
    entry.updatedAt = new Date().toISOString();
    persist();
    return { ...entry };
  }

  /**
   * 标记该 attentionVersion 已成功弹出系统通知。
   * @param {string} taskId
   * @param {number} attentionVersion
   * @param {{ status?: string|null }} [extra]
   */
  function markNotified(taskId, attentionVersion, extra = {}) {
    const entry = ensure(taskId);
    if (!entry) return null;
    const version = Math.max(0, Math.trunc(attentionVersion || 0));
    entry.attentionVersion = Math.max(entry.attentionVersion, version);
    entry.lastNotifiedAttentionVersion = Math.max(entry.lastNotifiedAttentionVersion, version);
    entry.lastNotifiedAt = new Date().toISOString();
    if (typeof extra.status === 'string' || extra.status === null) {
      entry.lastStatus = extra.status ?? entry.lastStatus;
    }
    entry.updatedAt = entry.lastNotifiedAt;
    persist();
    return { ...entry };
  }

  /**
   * 标记已读（状态栏 / 打开会话 / 点击通知后）。
   * @param {string} taskId
   * @param {number} attentionVersion
   */
  function markRead(taskId, attentionVersion) {
    const entry = ensure(taskId);
    if (!entry) return null;
    const version = Math.max(0, Math.trunc(attentionVersion || 0));
    entry.attentionVersion = Math.max(entry.attentionVersion, version);
    entry.lastReadAttentionVersion = Math.max(entry.lastReadAttentionVersion, version);
    entry.lastReadAt = new Date().toISOString();
    entry.updatedAt = entry.lastReadAt;
    persist();
    return { ...entry };
  }

  /**
   * 冷启动种子：把当前已存在的可通知终态记为「已观察且已通知」，避免回放。
   * @param {Array<{taskId:string, status:string, attentionVersion?:number}>} tasks
   */
  function seedFromExistingTasks(tasks = []) {
    const now = new Date().toISOString();
    let changed = false;
    for (const task of tasks) {
      const id = String(task?.taskId || '').trim();
      if (!id) continue;
      const entry = ensure(id);
      if (!entry) continue;
      // 已有通知回执的不降级覆盖
      const version = Number.isFinite(task.attentionVersion)
        ? Math.max(0, Math.trunc(task.attentionVersion))
        : Math.max(entry.attentionVersion, 1);
      if (entry.lastNotifiedAttentionVersion >= version && entry.lastStatus) continue;
      entry.lastStatus = typeof task.status === 'string' ? task.status : entry.lastStatus;
      entry.attentionVersion = Math.max(entry.attentionVersion, version);
      // 启动时把当前版本视为「已处理」，防止冷启动回放
      entry.lastNotifiedAttentionVersion = Math.max(entry.lastNotifiedAttentionVersion, version);
      entry.lastReadAttentionVersion = Math.max(entry.lastReadAttentionVersion, version);
      entry.updatedAt = now;
      changed = true;
    }
    if (changed) persist();
    return state;
  }

  function getAll() {
    const out = {};
    for (const [id, entry] of Object.entries(state.tasks)) {
      out[id] = { ...entry };
    }
    return out;
  }

  /** 测试辅助：重载磁盘状态 */
  function reload() {
    state = readState(receiptFile);
    return getAll();
  }

  return {
    get,
    observe,
    markNotified,
    markRead,
    seedFromExistingTasks,
    getAll,
    reload,
  };
}
