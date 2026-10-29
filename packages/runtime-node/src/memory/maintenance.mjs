import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { isMemoryWorkspaceId } from './memory-store.mjs';

const NINETY_DAYS = 90 * 24 * 60 * 60_000;

/** Deterministic maintenance shares the digest clock; it never invokes a model. */
export function createMemoryMaintenance({ rootDir = null, store, readAnchor = null, onChanged = null } = {}) {
  function runDue({ workspaceId, at = new Date(), digestTime = '09:00' } = {}) {
    if (!isMemoryWorkspaceId(workspaceId)) return { ok: false, error: 'invalid_workspace' };
    const time = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(time.getTime()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(digestTime)) return { ok: false, error: 'invalid_time' };
    const [hour, minute] = digestTime.split(':').map(Number);
    if (time.getHours() * 60 + time.getMinutes() < hour * 60 + minute) return { skipped: 'not_due' };
    const date = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
    const file = path.join(rootDir || pathOf('projectRuntime'), workspaceId, 'memory-maintenance.json');
    try { if (JSON.parse(readFileSync(file, 'utf8')).date === date) return { skipped: 'already_ran' }; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const changedIds = [];
    for (const item of store.list({ workspaceId })) {
      if (!['active', 'conflicted'].includes(item.status)) continue;
      const protectedItem = item.pinned || item.kind === 'responsibility';
      const deadline = item.expiresAt && Date.parse(item.expiresAt) <= time.getTime();
      const unused = item.kind === 'preference' && item.trust === 'inferred'
        && time.getTime() - Date.parse(item.lastUsedAt || item.createdAt) >= NINETY_DAYS;
      let patch = null;
      if (!protectedItem && (deadline || unused)) patch = { status: 'expired', maintenanceReason: deadline ? 'expired' : 'unused_90_days' };
      else if (item.trust === 'verified' && !item.needsReverify && typeof readAnchor === 'function'
        && item.fileAnchors?.some(anchor => {
          const observed = readAnchor({ workspaceId: item.workspaceId || workspaceId, path: anchor.path });
          return !observed || observed.contentHash !== anchor.contentHash;
        })) patch = { needsReverify: true, maintenanceReason: 'file_changed' };
      if (!patch) continue;
      const result = store.markMaintained({ id: item.id, workspaceId, ...patch });
      if (!result.ok) throw Error(result.reason || 'maintenance_write_failed');
      changedIds.push(item.id);
    }
    if (changedIds.length && typeof onChanged === 'function') onChanged(workspaceId, changedIds);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ date, completedAt: time.toISOString() }) + '\n'); renameSync(temporary, file);
    return { ok: true, date, changedIds };
  }
  return { runDue };
}
