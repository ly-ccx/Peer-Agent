import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

export const RECOVERY_PHASES = Object.freeze(['lease', 'inputs', 'inbox', 'queue', 'tasks', 'watch', 'digest']);
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Per-project recovery is a barrier: stores can replay before any execution is admitted. */
export function createProjectRecovery({ rootDir = null, ports = {}, holdsLease = () => false,
  now = () => new Date().toISOString(), onPhase = null, persistDiagnostic = null } = {}) {
  const ready = new Set(), flights = new Map(), epochs = new Map();
  function diagnostic(workspaceId, record) {
    if (typeof persistDiagnostic === 'function') return persistDiagnostic(workspaceId, record);
    const file = path.join(rootDir || pathOf('projectRuntime'), workspaceId, 'recovery.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...record, at: now() }) + '\n'); renameSync(temporary, file);
  }
  async function run(workspaceId) {
    let phase = 'lease'; const epoch = epochs.get(workspaceId) || 0;
    try {
      for (phase of RECOVERY_PHASES) {
        if (phase !== 'lease' && holdsLease(workspaceId) !== true) throw new Error('lease_unavailable');
        if (typeof ports[phase] !== 'function') throw new Error(`recovery_port_missing:${phase}`);
        await ports[phase](workspaceId);
        if ((epochs.get(workspaceId) || 0) !== epoch) throw new Error('recovery_cancelled');
        if (holdsLease(workspaceId) !== true) throw new Error('lease_unavailable');
        if (typeof onPhase === 'function') await onPhase({ workspaceId, phase });
        if ((epochs.get(workspaceId) || 0) !== epoch || holdsLease(workspaceId) !== true) throw new Error('recovery_cancelled');
      }
      ready.add(workspaceId); diagnostic(workspaceId, { status: 'ready', phase: 'digest' });
      return { ok: true };
    } catch (error) {
      ready.delete(workspaceId);
      const result = { ok: false, phase, error: error?.message || String(error) };
      try { diagnostic(workspaceId, { ...result, status: 'failed' }); } catch { /* The caller still receives a project-local failure. */ }
      return result;
    }
  }
  return {
    recover(workspaceId) {
      if (!WORKSPACE_ID.test(workspaceId)) return Promise.resolve({ ok: false, error: 'invalid_workspace' });
      if (ready.has(workspaceId) && holdsLease(workspaceId) === true) return Promise.resolve({ ok: true, reused: true });
      if (flights.has(workspaceId)) return flights.get(workspaceId);
      ready.delete(workspaceId);
      const flight = run(workspaceId).finally(() => { flights.delete(workspaceId); });
      flights.set(workspaceId, flight); return flight;
    },
    fail(workspaceId, error) { ready.delete(workspaceId); diagnostic(workspaceId, { status: 'failed', phase: 'execution', error: error?.message || String(error) }); },
    isReady: workspaceId => ready.has(workspaceId) && holdsLease(workspaceId) === true,
    drop(workspaceId) { ready.delete(workspaceId); epochs.set(workspaceId, (epochs.get(workspaceId) || 0) + 1); },
  };
}
