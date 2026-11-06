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
    if (stored.providerScopes !== undefined && (!stored.providerScopes || typeof stored.providerScopes !== 'object' || Array.isArray(stored.providerScopes)
      || Object.values(stored.providerScopes).some(row => !row || !Number.isSafeInteger(row.failures) || row.failures < 0
        || !['closed', 'open', 'half_open'].includes(row.status) || row.status !== 'closed' && !Number.isFinite(Date.parse(row.openUntil))))) throw new Error('invalid circuit scopes');
    value = stored;
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const trials = new Set();
  const scopeId = key => key || '__legacy__';
  function current(key) {
    if (!key) { const { providerScopes, ...legacy } = value; return legacy; }
    return (value.providerScopes && Object.hasOwn(value.providerScopes, key) ? value.providerScopes[key] : null) || (!value.providerScopes && !value.scopeKey ? current() : {
      version: 1, failures: 0, status: 'closed', openUntil: null, lastTurnId: null });
  }
  const at = () => { const clock = now(); return clock instanceof Date ? clock.getTime() : typeof clock === 'number' ? clock : Date.parse(clock); };
  function save(patch) {
    value = { ...value, ...patch };
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + '\n'); renameSync(temporary, file);
  }
  function saveScope(scopeKey, patch) {
    if (!scopeKey) return save(patch);
    const next = { ...current(scopeKey), ...patch, scopeKey };
    save({ ...next, providerScopes: { ...value.providerScopes, [scopeKey]: next } });
  }
  function admit({ manual = false, scopeKey } = {}) {
    const state = current(scopeKey);
    if (state.status === 'closed') return { allowed: true };
    if (trials.has(scopeId(scopeKey))) return { allowed: false, reason: 'circuit_trial_running', openUntil: state.openUntil };
    if (!manual && at() < Date.parse(state.openUntil)) return { allowed: false, reason: 'circuit_open', openUntil: state.openUntil };
    trials.add(scopeId(scopeKey)); saveScope(scopeKey, { status: 'half_open' });
    return { allowed: true, trial: true };
  }
  function failure({ turnId, reason = '', retry = null, scopeKey } = {}) {
    const state = current(scopeKey);
    if (turnId && state.lastTurnId === turnId) return { replayed: true, ...state };
    const failures = state.failures + 1;
    const opened = failures >= CIRCUIT_FAILURE_LIMIT;
    trials.delete(scopeId(scopeKey));
    saveScope(scopeKey, { failures, lastTurnId: turnId || null, reason: String(reason).slice(0, 500), retry,
      status: opened ? 'open' : 'closed', openUntil: opened ? new Date(at() + CIRCUIT_COOLDOWN_MS).toISOString() : null });
    return { ...current(scopeKey), opened };
  }
  function success({ scopeKey } = {}) { trials.delete(scopeId(scopeKey)); saveScope(scopeKey, { failures: 0, status: 'closed', openUntil: null, lastTurnId: null, reason: '', retry: null }); }
  function abandonTrial({ scopeKey } = {}) { if (scopeKey) trials.delete(scopeId(scopeKey)); else trials.clear(); }
  return { admit, failure, success, abandonTrial, state: ({ scopeKey } = {}) => ({ ...current(scopeKey) }) };
}
