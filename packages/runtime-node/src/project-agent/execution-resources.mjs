import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, lstatSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { executionIdentity, sameExecution } from './session-control-kernel.mjs';
import { sessionFactsFromPlan } from './session-facts.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { directoryResource } from './execution-scopes.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ended = new Set(['completed', 'failed', 'cancelled']);
export function unsettledExecution(plan) {
  const origin = plan?.delegationOrigin;
  const binding = workBudgetBinding(origin?.workspaceId);
  const work = typeof origin?.workId === 'string' && origin.workId ? binding?.store.readWork?.(origin.workId) : undefined;
  const relevant = row => !row.planId || row.planId === plan.planId;
  const rows = [...(work?.budget?.uncertainDispatches || []).filter(relevant),
    ...Object.values(work?.budget?.attempts || {}).filter(relevant).flatMap(attempt => attempt.pendingTools || [])];
  return [...new Set([...rows.map(row => row.toolCallId).filter(Boolean), ...(!work ? origin?.cancellation?.evidenceCalls || [] : [])])];
}
/** Cancellation completion outranks a superseded takeover, but never actual execution. */
export function executionProtection(plan) {
  const origin = plan?.delegationOrigin;
  if (!origin) return 'released';
  if (sessionFactsFromPlan(plan).executionOwnership === 'live') return 'active';
  const control = workBudgetBinding(origin.workspaceId)?.store.readSessionControl?.(origin.sessionId) || origin.executionControl;
  if (control && sameExecution(control.expectedExecution, executionIdentity(plan))) {
    if (control.phase !== 'settled') return control.phase === 'reconciling' ? 'reconciling' : 'draining';
    if (control.stopReceipt) return unsettledExecution(plan).length ? 'reconciling' : 'released';
  }
  if (origin.cancellation?.phase === 'completed') return unsettledExecution(plan).length
    || sessionFactsFromPlan(plan).executionOwnership !== 'ended' ? 'reconciling' : 'released';
  if (origin.cancellation) return origin.cancellation.phase === 'awaiting_outcome' ? 'reconciling' : 'draining';
  if (origin.takeover?.phase === 'stopping') return 'draining';
  if (origin.executionControl && origin.executionControl.phase !== 'settled') return 'draining';
  if (origin.phase === 'running') return ended.has(plan.status) && ['completed', 'failed', 'cancelled', 'stopped'].includes(plan.runner?.status)
    ? unsettledExecution(plan).length ? 'reconciling' : 'released' : 'active';
  if (unsettledExecution(plan).length) return 'reconciling';
  return 'released';
}
export function executionResource(plan, { allowMissing = false } = {}) {
  if (plan.delegationOrigin?.readOnly === true) return null;
  const directory = plan.deliveryBinding?.executionIsolation === 'worktree' && plan.deliveryBinding.worktreePath
    || plan.targetWorkspacePath || plan.deliveryBinding?.targetWorkspacePath || plan.originWorkspacePath;
  if (!directory) throw new Error('execution_resource_scope_unknown');
  return directoryResource(directory, { allowMissing });
}
function resourceSet(plan, scopes = []) {
  if (!Array.isArray(scopes) || scopes.length > 32 || scopes.some(scope => scope?.kind !== 'directory')) throw new Error('execution_resource_scope_unknown');
  const resources = [executionResource(plan), ...scopes.map(scope => directoryResource(scope.path))].filter(Boolean);
  return [...new Map(resources.map(resource => [resource.resourceRef, resource])).values()].sort((a, b) => a.resourceRef.localeCompare(b.resourceRef));
}
const conflicts = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`)
  || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);

/** Device-local arbitration. A project lease alone cannot serialize directory aliases across projects. */
export function createExecutionResources({ rootDir, now = () => new Date().toISOString() } = {}) {
  let db, fileIdentity;
  const file = rootDir ? path.join(rootDir, 'execution-resources.sqlite') : ':memory:';
  function open() {
    if (db) {
      if (rootDir && (!existsSync(file) || statSync(file).ino !== fileIdentity)) throw new Error('execution_resource_store_changed');
      return db;
    }
    if (rootDir) { mkdirSync(rootDir, { recursive: true }); if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('execution_resource_store_invalid'); }
    if (rootDir && !existsSync(file)) for (const name of readdirSync(rootDir)) {
      const manifest = path.join(rootDir, name, 'coordination-v2', 'manifest.json');
      if (existsSync(manifest)) {
        const version = JSON.parse(readFileSync(manifest, 'utf8')).minimumWriterVersion;
        // Independent intent format 8 predates the resource ledger.
        if (version === 7 || version >= 9) throw new Error('execution_resource_store_missing');
      }
    }
    const connection = new DatabaseSync(file);
    if (rootDir) chmodSync(file, 0o600);
    try {
      connection.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = connection.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('execution_resource_schema_unsupported');
      connection.exec('CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, planId TEXT NOT NULL, sessionId TEXT NOT NULL, workspaceId TEXT NOT NULL, resource TEXT NOT NULL, epoch TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL);'
        + 'CREATE INDEX IF NOT EXISTS claims_resource ON claims(resource,state);'
        + 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,value TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS requirements (planId TEXT PRIMARY KEY,value TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS resource_events (revision INTEGER PRIMARY KEY AUTOINCREMENT,resource TEXT NOT NULL,operationId TEXT NOT NULL); PRAGMA user_version=1;');
      db = connection; if (rootDir) fileIdentity = statSync(file).ino;
      return db;
    } catch (error) { connection.close(); throw error; }
  }
  function transaction(run) {
    const connection = open(); connection.exec('BEGIN IMMEDIATE');
    try { const result = run(connection); connection.exec('COMMIT'); return result; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }
  const rows = connection => connection.prepare("SELECT value FROM claims WHERE state!='released'").all().map(row => JSON.parse(row.value));
  function put(connection, claim) {
    connection.prepare('INSERT OR REPLACE INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run(claim.claimId, claim.execution.planId,
      claim.execution.sessionId, claim.workspaceId, claim.resourceRef, claim.execution.executionEpoch, claim.state, claim.revision, JSON.stringify(claim));
  }
  function owned(plan, resource, hostEpoch) {
    const execution = executionIdentity(plan);
    return { claimId: `claim-${digest([resource.resourceRef, execution])}`, ...resource, execution, workspaceId: plan.delegationOrigin.workspaceId,
      hostEpoch, title: plan.title || '', state: 'reserved', revision: 1, evidenceCalls: [], updatedAt: now() };
  }
  function blocker(claim) {
    return ['draining', 'reconciling'].includes(claim.state)
      ? { kind: 'protection', nextAction: claim.evidenceCalls.length ? 'reconcile_execution_outcome' : 'confirm_execution_stopped', code: claim.evidenceCalls.length ? 'execution_outcome_unknown' : 'execution_stop_unconfirmed',
        resourceRef: claim.resourceRef, claimId: claim.claimId, sessionId: claim.execution.sessionId, operationId: claim.operationId, evidenceCalls: claim.evidenceCalls }
      : { kind: 'owner', code: 'resource_busy', resourceRef: claim.resourceRef, claimId: claim.claimId,
        sessionId: claim.execution.sessionId, title: claim.title };
  }
  function requiredScopes(connection, plan) {
    const row = connection.prepare('SELECT value FROM requirements WHERE planId=?').get(plan.planId), request = row && JSON.parse(row.value);
    return request && sameExecution(request.execution, executionIdentity(plan)) ? request.scopes : [];
  }
  function inspect(plan, connection = open(), hostEpoch, scopes = []) {
    if (plan.delegationOrigin?.readOnly === true) return { allowed: true };
    const execution = executionIdentity(plan), current = rows(connection);
    const requested = [...new Map([...requiredScopes(connection, plan), ...scopes].map(scope => [scope?.path, scope])).values()];
    for (const resource of resourceSet(plan, requested)) for (const claim of current) {
      if (!conflicts(claim.resourceRef, resource.resourceRef)) continue;
      if (sameExecution(claim.execution, execution) && hostEpoch && claim.hostEpoch !== hostEpoch) return { allowed: false,
        blocker: { kind: 'recovery', code: 'execution_resource_owner_changed', resourceRef: resource.resourceRef } };
      if (sameExecution(claim.execution, execution) && !['draining', 'reconciling'].includes(claim.state)
        && (claim.resourceRef !== resource.resourceRef || claim.identity === resource.identity)) continue;
      return { allowed: false, blocker: blocker(claim) };
    }
    return { allowed: true };
  }
  return {
    inspect: (plan, hostEpoch) => inspect(plan, open(), hostEpoch),
    reserve(plan, hostEpoch, scopes = [], { recordConflict = false } = {}) {
      if (plan.delegationOrigin?.readOnly === true) return { allowed: true };
      if (!hostEpoch) return { allowed: false, blocker: { kind: 'recovery', code: 'execution_resource_owner_unknown' } };
      return transaction(connection => {
        const required = [...new Map([...requiredScopes(connection, plan), ...scopes].map(scope => [scope.path, scope])).values()];
        const decision = inspect(plan, connection, hostEpoch, required);
        if (!decision.allowed) {
          if (recordConflict) {
            resourceSet(plan, required); // Validate the complete host-derived set before retaining it.
            connection.prepare('INSERT OR REPLACE INTO requirements VALUES (?,?)').run(plan.planId,
              JSON.stringify({ execution: executionIdentity(plan), scopes: required }));
          }
          return decision;
        }
        const claims = [];
        for (const resource of resourceSet(plan, required)) {
          const claim = owned(plan, resource, hostEpoch), old = connection.prepare('SELECT value FROM claims WHERE id=?').get(claim.claimId);
          if (old) {
            const previous = JSON.parse(old.value);
            if (previous.state !== 'released') { claims.push(previous); continue; }
            claim.revision = previous.revision + 1;
          }
          put(connection, claim); claims.push(claim);
        }
        return { allowed: true, claim: claims[0], claims };
      });
    },
    rebindRequirements(from, to, receiptId) {
      return transaction(connection => {
        const row = connection.prepare('SELECT value FROM requirements WHERE planId=?').get(from.planId);
        if (!row) return;
        const request = JSON.parse(row.value);
        if (sameExecution(request.execution, to)) return;
        const recorded = connection.prepare('SELECT value FROM receipts WHERE id=?').get(`resource-settlement:${receiptId}`);
        if (from.planId !== to.planId || from.sessionId !== to.sessionId || !sameExecution(request.execution, from)
          || !recorded || !sameExecution(JSON.parse(recorded.value).execution, from)) throw new Error('execution_resource_receipt_invalid');
        connection.prepare('UPDATE requirements SET value=? WHERE planId=?').run(JSON.stringify({ ...request, execution: to }), from.planId);
      });
    },
    activate(plan, hostEpoch) {
      if (plan.delegationOrigin?.readOnly === true) return true;
      return transaction(connection => {
        const execution = executionIdentity(plan);
        const claims = rows(connection).filter(row => sameExecution(row.execution, execution)), primary = executionResource(plan);
        if (!claims.some(claim => claim.resourceRef === primary.resourceRef) || claims.some(claim => claim.hostEpoch !== hostEpoch
          || !['reserved', 'active'].includes(claim.state) || directoryResource(claim.resourceRef.slice('directory:'.length)).identity !== claim.identity)) return false;
        for (const claim of claims) if (claim.state !== 'active') put(connection, { ...claim, state: 'active', revision: claim.revision + 1, updatedAt: now() });
        return true;
      });
    },
    protect(plan, { hostEpoch, operationId, state = 'draining', evidenceCalls = [] } = {}) {
      if (plan.delegationOrigin?.readOnly === true) return;
      return transaction(connection => {
        const resource = executionResource(plan, { allowMissing: true }), next = owned(plan, resource, hostEpoch);
        const claims = rows(connection).filter(row => sameExecution(row.execution, next.execution));
        if (!claims.some(claim => claim.claimId === next.claimId)) {
          const previous = connection.prepare('SELECT value FROM claims WHERE id=?').get(next.claimId);
          claims.push(previous ? JSON.parse(previous.value) : next);
        }
        for (const old of claims) {
          if (old.state === state && old.operationId === operationId && JSON.stringify(old.evidenceCalls) === JSON.stringify(evidenceCalls)) continue;
          put(connection, { ...old, state, operationId, evidenceCalls: [...new Set([...(old.evidenceCalls || []), ...evidenceCalls])],
            revision: old.revision + 1, updatedAt: now() });
        }
      });
    },
    settle(plan, receipt, hostEpoch) {
      if (plan.delegationOrigin?.readOnly === true) return;
      if (!Array.isArray(receipt?.resourceClaims) || !receipt?.receiptId || !receipt.operationId || receipt.scope !== 'managed_execution' || !Array.isArray(receipt.unknownCalls) || !sameExecution(receipt.execution, executionIdentity(plan)) || !receipt.admissionClosed || !receipt.runnerIdle || !receipt.schedulerIdle) throw new Error('execution_resource_receipt_invalid');
      return transaction(connection => {
        const id = `resource-settlement:${receipt.receiptId}`, previous = connection.prepare('SELECT value FROM receipts WHERE id=?').get(id);
        if (previous) {
          const recorded = JSON.parse(previous.value);
          if (recorded.requestDigest !== digest(receipt)) throw new Error('execution_resource_receipt_conflict');
          return recorded;
        }
        const current = rows(connection);
        const claims = receipt.resourceClaims.flatMap(ref => {
          const claim = current.find(row => row.claimId === ref.claimId);
          if (!claim) return [];
          if (!sameExecution(claim.execution, receipt.execution) || claim.revision !== ref.revision) throw new Error('execution_resource_receipt_stale');
          return [claim];
        });
        if (claims.some(claim => Object.values(claim.handles || {}).some(handle => handle.state !== 'ended'))) throw new Error('execution_stop_unconfirmed');
        for (const claim of claims) {
          // The caller rechecks the current project writer. The matching durable stop
          // receipt, rather than the expired host's PID, authorizes an ownership handoff.
          const unknown = [...new Set(receipt.unknownCalls || [])];
          if (unknown.length && claim.state === 'reconciling' && claim.operationId === receipt.operationId
            && JSON.stringify(claim.evidenceCalls) === JSON.stringify(unknown)) continue;
          put(connection, { ...claim, state: unknown.length ? 'reconciling' : 'released', evidenceCalls: unknown,
            operationId: receipt.operationId, revision: claim.revision + 1, updatedAt: now() });
          connection.prepare('INSERT INTO resource_events(resource,operationId) VALUES (?,?)').run(claim.resourceRef, receipt.operationId);
        }
        const result = { receiptId: receipt.receiptId, requestDigest: digest(receipt), execution: receipt.execution, updatedAt: now() };
        connection.prepare('INSERT INTO receipts VALUES (?,?)').run(id, JSON.stringify(result)); return result;
      });
    },
    markHandle(plan, handle) {
      if (plan.delegationOrigin?.readOnly === true) return;
      return transaction(connection => {
        const claims = rows(connection).filter(row => sameExecution(row.execution, executionIdentity(plan)));
        if (!claims.length) throw new Error('execution_resource_owner_unknown');
        for (const claim of claims) {
          const handles = { ...claim.handles, [handle.handleId]: handle };
          put(connection, { ...claim, handles, revision: claim.revision + 1, updatedAt: now() });
        }
      });
    },
    unsettledHandles(plan) { return rows(open()).filter(row => sameExecution(row.execution, executionIdentity(plan)))
      .flatMap(row => Object.values(row.handles || {})).filter(handle => handle.state !== 'ended'); },
    /** Import legacy protection before admitting new writes. It never manufactures a stop proof. */
    reconcile(plans, hostEpochFor, ownsWorkspace) {
      for (const plan of plans) {
        if (plan.delegationOrigin?.readOnly === true) continue;
        if (!ownsWorkspace(plan.delegationOrigin?.workspaceId)) {
          // A foreign workspace may alias an owned directory. Import only protection;
          // releasing it still requires its actual writer and a matching stop receipt.
          if (executionProtection(plan) !== 'released' && !this.hasClaim(plan)) this.protect(plan, {
            hostEpoch: `unproven:${plan.delegationOrigin.workspaceId}`, state: 'reconciling', evidenceCalls: unsettledExecution(plan) });
          continue;
        }
        const native = this.unsettledHandles(plan);
        const state = native.length && sessionFactsFromPlan(plan).executionOwnership !== 'live' ? 'reconciling' : executionProtection(plan), hostEpoch = hostEpochFor(plan.delegationOrigin.workspaceId);
        try {
          const control = workBudgetBinding(plan.delegationOrigin.workspaceId)?.store.readSessionControl?.(plan.delegationOrigin.sessionId) || plan.delegationOrigin.executionControl;
          // A durable stop may precede the SQLite commit or its GoalPlan mirror. Replay
          // it before importing protection; import must not invalidate its claim revisions.
          if (control?.stopReceipt && sameExecution(control.expectedExecution, executionIdentity(plan))
            && JSON.stringify(control.stopReceipt.unknownCalls) === JSON.stringify(unsettledExecution(plan))
            && sessionFactsFromPlan(plan).executionOwnership !== 'live' && !native.length) {
            this.settle(plan, control.stopReceipt, hostEpoch);
            continue;
          }
          if (state === 'released') continue;
          if (state === 'active') {
            const previous = rows(open()).find(row => sameExecution(row.execution, executionIdentity(plan)));
            if (!previous && sessionFactsFromPlan(plan).executionOwnership === 'unknown') {
              this.protect(plan, { hostEpoch, state: 'reconciling', evidenceCalls: [...new Set([...unsettledExecution(plan), ...native.map(handle => handle.toolCallId)])] }); continue;
            }
            if (previous?.hostEpoch === hostEpoch && ['reserved', 'active'].includes(previous.state)) continue;
            const reserved = this.reserve(plan, hostEpoch);
            if (reserved.allowed) this.activate(plan, hostEpoch);
          } else this.protect(plan, { hostEpoch, state, operationId: plan.delegationOrigin.executionControl?.operationId || plan.delegationOrigin.cancellation?.operationId || plan.delegationOrigin.takeover?.operationId,
            evidenceCalls: [...new Set([...unsettledExecution(plan), ...native.map(handle => handle.toolCallId)])] });
        } catch (error) {
          if (!['ENOENT', 'execution_resource_receipt_stale', 'execution_resource_scope_unknown'].includes(error.code || error.message)) throw error;
          this.protect(plan, { hostEpoch, state: 'reconciling', operationId: plan.delegationOrigin.executionControl?.operationId, evidenceCalls: [...new Set([...unsettledExecution(plan), ...native.map(handle => handle.toolCallId)])] });
        }
      }
    },
    revision() { return Number(open().prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM resource_events').get().revision); },
    snapshot() { return rows(open()); },
    claimsFor(plan) { return rows(open()).filter(row => sameExecution(row.execution, executionIdentity(plan))); },
    admitted(plan, hostEpoch) {
      if (plan.delegationOrigin?.readOnly === true) return true;
      const resource = executionResource(plan);
      return rows(open()).some(row => sameExecution(row.execution, executionIdentity(plan)) && row.hostEpoch === hostEpoch
        && row.resourceRef === resource.resourceRef && row.identity === resource.identity && ['reserved', 'active'].includes(row.state));
    },
    hasClaim(plan) { return rows(open()).some(row => sameExecution(row.execution, executionIdentity(plan))); },
    close() { db?.close(); db = undefined; },
  };
}
