import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function readJsonArray(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

export function createRuntimeResultQueue({ queuePath, maxItems = 1000 }) {
  let items = readJsonArray(queuePath);

  function persist() {
    writeJsonArray(queuePath, items);
  }

  function enqueue(report, reason) {
    const item = {
      queueId: randomUUID(),
      report,
      reason: reason ?? 'send_failed',
      attemptCount: 0,
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    items = [...items, item].slice(-maxItems);
    persist();
    return item;
  }

  function list() {
    return [...items];
  }

  function count() {
    return items.length;
  }

  function markAttempt(queueId, error) {
    items = items.map((item) => item.queueId === queueId
      ? {
          ...item,
          attemptCount: item.attemptCount + 1,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        }
      : item);
    persist();
  }

  function remove(queueId) {
    const before = items.length;
    items = items.filter((item) => item.queueId !== queueId);
    if (items.length !== before) persist();
  }

  function clear() {
    items = [];
    persist();
  }

  return {
    enqueue,
    list,
    count,
    markAttempt,
    remove,
    clear,
  };
}
