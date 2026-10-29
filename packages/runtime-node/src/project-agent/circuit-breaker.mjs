import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathOf } from '../data-store.mjs';

export const CIRCUIT_FAILURE_LIMIT = 5;
export const CIRCUIT_COOLDOWN_MS = 10 * 60_000;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Owns failed-turn accounting and admission; provider retry attempts are not turns. */
export function createCircuitBreaker({ rootDir = null, workspaceId, now = () => new Date().toISOString() } = {}) {
  if (!WORKSPACE_ID.test(workspaceId)) throw new TypeError('workspaceId is invalid');
  const file = path.join(rootDir || pathOf('projectRuntime'), workspaceId, 'circuit-breaker.json');
  let value = { version: 1, failures: 0, status: 'closed', openUntil: null, lastTurnId: null };
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.version !== 1 || !Number.isSafeInteger(stored.failures) || stored.failures < 0
      || !['closed', 'open', 'half_open'].includes(stored.status)
      || stored.status !== 'closed' && !Number.isFinite(Date.parse(stored.openUntil))) throw new Error('invalid circuit state');
    value = stored;
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let trial = false;
  const at = () => { const clock = now(); return clock instanceof Date ? clock.getTime() : typeof clock === 'number' ? clock : Date.parse(clock); };
  function save(patch) {
    value = { ...value, ...patch };
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + '\n'); renameSync(temporary, file);
  }
  function admit({ manual = false } = {}) {
    if (value.status === 'closed') return { allowed: true };
    if (trial) return { allowed: false, reason: 'circuit_trial_running', openUntil: value.openUntil };
    if (!manual && at() < Date.parse(value.openUntil)) return { allowed: false, reason: 'circuit_open', openUntil: value.openUntil };
    trial = true; save({ status: 'half_open' });
    return { allowed: true, trial: true };
  }
  function failure({ turnId, reason = '', retry = null } = {}) {
    if (turnId && value.lastTurnId === turnId) return { replayed: true, ...value };
    const failures = value.failures + 1;
    const opened = failures >= CIRCUIT_FAILURE_LIMIT;
    trial = false;
    save({ failures, lastTurnId: turnId || null, reason: String(reason).slice(0, 500), retry,
      status: opened ? 'open' : 'closed', openUntil: opened ? new Date(at() + CIRCUIT_COOLDOWN_MS).toISOString() : null });
    return { ...value, opened };
  }
  function success() { trial = false; save({ failures: 0, status: 'closed', openUntil: null, lastTurnId: null, reason: '', retry: null }); }
  function abandonTrial() { trial = false; }
  return { admit, failure, success, abandonTrial, state: () => ({ ...value }) };
}
