/**
 * 开任务时冻结当时的 active 记忆 id 和正文。
 * 之后的写入不改已有快照。
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import { createMemoryStore, isEffectiveMemory, isMemoryWorkspaceId } from './memory-store.mjs';

function fail(reason) {
  return { ok: false, reason };
}

function freezeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const text = typeof item.text === 'string' ? item.text : '';
  if (!id || !text) return null;
  return {
    id,
    kind: typeof item.kind === 'string' ? item.kind : 'fact',
    text,
    trust: item.trust === 'verified' ? 'verified' : 'stated',
    status: item.status === 'forgotten' ? 'forgotten' : 'active',
    scope: item.scope === 'user' ? 'user' : 'project',
  };
}

function readFrozenItems(raw) {
  if (!Array.isArray(raw)) return null;
  const items = [];
  for (const entry of raw) {
    const item = freezeItem(entry);
    if (item) items.push(item);
  }
  return items;
}

function readLines(file) {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const snapshots = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed.snapshotId !== 'string' || !Array.isArray(parsed.itemIds)) continue;
      const itemIds = parsed.itemIds.filter((id) => typeof id === 'string' && id.trim());
      const snapshot = {
        snapshotId: parsed.snapshotId,
        itemIds,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      };
      const items = readFrozenItems(parsed.items);
      if (items) snapshot.items = items;
      snapshots.push(snapshot);
    } catch {
      // 坏行跳过。
    }
  }
  return snapshots;
}

/**
 * @param {string} workspaceId
 * @param {{ rootDir?: string | null, store?: object, now?: () => Date }} [options]
 */
export function createSnapshot(workspaceId, options = {}) {
  if (!isMemoryWorkspaceId(workspaceId)) return fail('invalid_workspace');
  const store = options.store || createMemoryStore(options);
  const now = options.now || (() => new Date());
  const active = store.list({ workspaceId, status: 'active' })
    .filter(item => isEffectiveMemory(item, now().getTime()))
    .sort((left, right) => left.id.localeCompare(right.id));
  const snapshot = {
    snapshotId: `snap-${randomUUID()}`,
    itemIds: active.map((item) => item.id),
    items: active.map((item) => freezeItem(item)).filter(Boolean),
    createdAt: now().toISOString(),
  };
  const file = path.join(path.dirname(store.projectFile(workspaceId)), 'snapshots.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
  return { ok: true, ...snapshot };
}

export function readSnapshots(workspaceId, options = {}) {
  if (!isMemoryWorkspaceId(workspaceId)) return [];
  const store = options.store || createMemoryStore(options);
  const file = path.join(path.dirname(store.projectFile(workspaceId)), 'snapshots.jsonl');
  return readLines(file);
}
