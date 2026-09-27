/**
 * 开任务时冻结当时的 active 记忆 id。
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

import { createMemoryStore, isMemoryWorkspaceId } from './memory-store.mjs';

function fail(reason) {
  return { ok: false, reason };
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
      snapshots.push({
        snapshotId: parsed.snapshotId,
        itemIds,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      });
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
  const itemIds = store.list({ workspaceId, status: 'active' })
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
  const snapshot = {
    snapshotId: `snap-${randomUUID()}`,
    itemIds,
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
