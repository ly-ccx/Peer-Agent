import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

const SCHEMA_VERSION = 1;
const DEFINITION_STATUSES = new Set(['draft', 'active', 'paused', 'completed', 'disabled', 'archived']);
const RUN_STATUSES = new Set([
  'scheduled', 'queued', 'preparing', 'running', 'waiting_permission', 'waiting_user',
  'succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked',
]);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function requireIso(value, label) {
  const result = requireString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO timestamp`);
  return result;
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('definition must be an object');
  requireString(definition.automationId, 'definition.automationId');
  requireString(definition.name, 'definition.name');
  requireString(definition.prompt, 'definition.prompt');
  requireString(definition.workspacePath, 'definition.workspacePath');
  if (!Number.isInteger(definition.version) || definition.version < 1) throw new TypeError('definition.version must be positive');
  if (!DEFINITION_STATUSES.has(definition.status)) throw new TypeError('definition.status is invalid');
  if (!definition.schedule || typeof definition.schedule !== 'object') throw new TypeError('definition.schedule is required');
  requireString(definition.schedule.kind, 'definition.schedule.kind');
  requireString(definition.schedule.timezone, 'definition.schedule.timezone');
  if (!definition.grant || typeof definition.grant !== 'object') throw new TypeError('definition.grant is required');
  requireString(definition.grant.preset, 'definition.grant.preset');
  requireIso(definition.createdAt, 'definition.createdAt');
  requireIso(definition.updatedAt, 'definition.updatedAt');
  return definition;
}

function validateRun(run) {
  if (!run || typeof run !== 'object') throw new TypeError('run must be an object');
  requireString(run.runId, 'run.runId');
  requireString(run.automationId, 'run.automationId');
  requireString(run.idempotencyKey, 'run.idempotencyKey');
  if (!RUN_STATUSES.has(run.status)) throw new TypeError('run.status is invalid');
  requireIso(run.scheduledAt, 'run.scheduledAt');
  requireIso(run.createdAt, 'run.createdAt');
  if (!run.snapshot || typeof run.snapshot !== 'object') throw new TypeError('run.snapshot is required');
  return run;
}

function compareNewest(left, right) {
  return String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''));
}

export function automationRunIsTerminal(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Device-local durable Automation store. It owns facts only; schedule computation and execution
 * stay behind Scheduler/Runner modules.
 */
export function createAutomationStore({ storeDir = pathOf('automations'), onChange } = {}) {
  const definitionsFile = path.join(storeDir, 'definitions.json');
  const runsDir = path.join(storeDir, 'runs');
  const runtimeFile = path.join(storeDir, 'runtime.json');
  let listener = typeof onChange === 'function' ? onChange : null;

  function ensure() {
    mkdirSync(runsDir, { recursive: true });
  }

  /** listRuns 热路径缓存：避免 overview 对每个 automation 反复 readdir+读盘。 */
  let runsListCache = null;

  function invalidateRunsListCache() {
    runsListCache = null;
  }

  function readAllRunsUncached() {
    ensure();
    const runs = [];
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.json')) continue;
      const value = readJson(path.join(runsDir, name));
      if (!value || value.schemaVersion !== SCHEMA_VERSION) continue;
      try {
        runs.push(validateRun(value.run));
      } catch { /* isolate corrupt run records */ }
    }
    runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return runs;
  }

  function getAllRunsCached() {
    if (!runsListCache) {
      runsListCache = readAllRunsUncached();
    }
    return runsListCache;
  }

  function emit(event) {
    if (!listener) return;
    try { listener(clone(event)); } catch (error) {
      console.warn('[automation-store] onChange failed:', error?.message ?? error);
    }
  }

  function readDefinitionsEnvelope() {
    const value = readJson(definitionsFile);
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.definitions)) {
      return { schemaVersion: SCHEMA_VERSION, definitions: [] };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      definitions: value.definitions.filter((item) => {
        try { validateDefinition(item); return true; } catch { return false; }
      }),
    };
  }

  function persistDefinitions(definitions) {
    writeJsonAtomic(definitionsFile, { schemaVersion: SCHEMA_VERSION, definitions });
  }

  function listDefinitions({ workspacePath, statuses, query } = {}) {
    const statusSet = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
    const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
    return readDefinitionsEnvelope().definitions
      .filter((item) => !workspacePath || item.workspacePath === workspacePath)
      .filter((item) => !statusSet || statusSet.has(item.status))
      .filter((item) => !needle || `${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(needle))
      .sort(compareNewest)
      .map(clone);
  }

  function getDefinition(automationId) {
    const id = requireString(automationId, 'automationId');
    return clone(readDefinitionsEnvelope().definitions.find((item) => item.automationId === id) || null);
  }

  function createDefinition(input, { now = new Date().toISOString(), automationId = randomUUID() } = {}) {
    const definitions = readDefinitionsEnvelope().definitions;
    if (definitions.some((item) => item.automationId === automationId)) throw new Error('automation_already_exists');
    const definition = validateDefinition({
      ...clone(input),
      automationId,
      version: 1,
      status: input.status || 'draft',
      consecutiveFailures: Number.isInteger(input.consecutiveFailures) ? input.consecutiveFailures : 0,
      createdAt: now,
      updatedAt: now,
    });
    definitions.push(definition);
    persistDefinitions(definitions);
    emit({ type: 'definition_changed', automationId });
    return clone(definition);
  }

  function replaceDefinition(next, { expectedVersion } = {}) {
    validateDefinition(next);
    const envelope = readDefinitionsEnvelope();
    const index = envelope.definitions.findIndex((item) => item.automationId === next.automationId);
    if (index < 0) throw new Error('automation_not_found');
    const current = envelope.definitions[index];
    if (expectedVersion != null && current.version !== expectedVersion) throw new Error('automation_version_conflict');
    if (next.version !== current.version + 1) throw new Error('automation_version_must_increment');
    envelope.definitions[index] = clone(next);
    persistDefinitions(envelope.definitions);
    emit({ type: 'definition_changed', automationId: next.automationId });
    return clone(next);
  }

  function updateDefinition(automationId, expectedVersion, updater, { now = new Date().toISOString() } = {}) {
    const current = getDefinition(automationId);
    if (!current) throw new Error('automation_not_found');
    if (current.version !== expectedVersion) throw new Error('automation_version_conflict');
    const patch = typeof updater === 'function' ? updater(clone(current)) : updater;
    const next = {
      ...current,
      ...clone(patch),
      automationId: current.automationId,
      createdAt: current.createdAt,
      version: current.version + 1,
      updatedAt: now,
    };
    return replaceDefinition(next, { expectedVersion });
  }

  function updateDefinitionRuntimeFacts(automationId, patch, { now = new Date().toISOString() } = {}) {
    const allowed = new Set([
      'status', 'pauseReason', 'consecutiveFailures', 'lastScheduledAt', 'lastRunAt', 'nextRunAt',
    ]);
    const invalid = Object.keys(patch || {}).filter((key) => !allowed.has(key));
    if (invalid.length) throw new Error(`automation_runtime_patch_forbidden:${invalid.join(',')}`);
    const envelope = readDefinitionsEnvelope();
    const index = envelope.definitions.findIndex((item) => item.automationId === automationId);
    if (index < 0) throw new Error('automation_not_found');
    const current = envelope.definitions[index];
    const next = validateDefinition({
      ...current,
      ...clone(patch),
      automationId: current.automationId,
      createdAt: current.createdAt,
      version: current.version,
      updatedAt: now,
    });
    envelope.definitions[index] = next;
    persistDefinitions(envelope.definitions);
    emit({ type: 'definition_changed', automationId });
    return clone(next);
  }

  function runFile(runId) {
    return path.join(runsDir, `${requireString(runId, 'runId')}.json`);
  }

  function getRun(runId) {
    const value = readJson(runFile(runId));
    if (!value || value.schemaVersion !== SCHEMA_VERSION) return null;
    try { return clone(validateRun(value.run)); } catch { return null; }
  }

  function listRuns({ automationId, statuses, limit, before } = {}) {
    const statusSet = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
    const beforeMs = before ? Date.parse(before) : NaN;
    let runs = getAllRunsCached();
    if (automationId) {
      runs = runs.filter((run) => run.automationId === automationId);
    }
    if (statusSet) {
      runs = runs.filter((run) => statusSet.has(run.status));
    }
    if (Number.isFinite(beforeMs)) {
      runs = runs.filter((run) => Date.parse(run.createdAt) < beforeMs);
    }
    return runs.slice(0, Number.isInteger(limit) && limit > 0 ? limit : runs.length).map(clone);
  }

  function findRunByIdempotencyKey(idempotencyKey) {
    const key = requireString(idempotencyKey, 'idempotencyKey');
    return listRuns().find((run) => run.idempotencyKey === key) || null;
  }

  function createRun(input, { runId = randomUUID(), now = new Date().toISOString() } = {}) {
    ensure();
    if (existsSync(runFile(runId))) throw new Error('automation_run_already_exists');
    if (findRunByIdempotencyKey(input.idempotencyKey)) throw new Error('automation_run_idempotency_conflict');
    const run = validateRun({
      ...clone(input),
      runId,
      status: input.status || 'scheduled',
      createdAt: now,
      attentionVersion: Number.isInteger(input.attentionVersion) ? input.attentionVersion : 0,
    });
    writeJsonAtomic(runFile(runId), { schemaVersion: SCHEMA_VERSION, run });
    invalidateRunsListCache();
    emit({ type: 'run_changed', automationId: run.automationId, runId });
    return clone(run);
  }

  function updateRun(runId, updater) {
    const current = getRun(runId);
    if (!current) throw new Error('automation_run_not_found');
    const patch = typeof updater === 'function' ? updater(clone(current)) : updater;
    const next = validateRun({ ...current, ...clone(patch), runId: current.runId, automationId: current.automationId });
    writeJsonAtomic(runFile(runId), { schemaVersion: SCHEMA_VERSION, run: next });
    invalidateRunsListCache();
    emit({ type: 'run_changed', automationId: next.automationId, runId });
    return clone(next);
  }

  function deleteRun(runId) {
    const current = getRun(runId);
    if (!current) return false;
    rmSync(runFile(runId), { force: true });
    invalidateRunsListCache();
    emit({ type: 'run_changed', automationId: current.automationId, runId });
    return true;
  }

  function getRuntimeState() {
    const value = readJson(runtimeFile);
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !value.runtime) {
      return { globallyPaused: false, activeRunIds: [], updatedAt: new Date(0).toISOString() };
    }
    return clone({
      globallyPaused: Boolean(value.runtime.globallyPaused),
      ...(value.runtime.pausedAt ? { pausedAt: value.runtime.pausedAt } : {}),
      activeRunIds: Array.isArray(value.runtime.activeRunIds) ? [...new Set(value.runtime.activeRunIds.filter(Boolean))] : [],
      updatedAt: value.runtime.updatedAt || new Date(0).toISOString(),
    });
  }

  function setRuntimeState(patch, { now = new Date().toISOString() } = {}) {
    const current = getRuntimeState();
    const next = {
      ...current,
      ...clone(patch),
      activeRunIds: [...new Set((patch.activeRunIds ?? current.activeRunIds).filter(Boolean))],
      updatedAt: now,
    };
    writeJsonAtomic(runtimeFile, { schemaVersion: SCHEMA_VERSION, runtime: next });
    emit({ type: 'runtime_changed', state: next });
    return clone(next);
  }

  function setOnChange(next) {
    listener = typeof next === 'function' ? next : null;
  }

  ensure();
  return {
    schemaVersion: SCHEMA_VERSION,
    get storeDir() { return storeDir; },
    listDefinitions,
    getDefinition,
    createDefinition,
    replaceDefinition,
    updateDefinition,
    updateDefinitionRuntimeFacts,
    listRuns,
    getRun,
    findRunByIdempotencyKey,
    createRun,
    updateRun,
    deleteRun,
    getRuntimeState,
    setRuntimeState,
    setOnChange,
  };
}
