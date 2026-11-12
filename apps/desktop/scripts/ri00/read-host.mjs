import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createCoordinationSnapshot } from './coordination-snapshot.mjs';
import { createReadOnlyCoordination } from './readonly-coordination.mjs';

export function installReadMetrics(trace, fixtureRoot) {
  const restores = [];
  for (const name of ['statSync', 'lstatSync', 'readdirSync', 'readFileSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (!trace.enabled()) return Reflect.apply(original, this, args);
      const file = typeof args[0] === 'string' ? args[0] : '';
      if (!file.startsWith(fixtureRoot + path.sep)) return Reflect.apply(original, this, args);
      const relative = path.relative(fixtureRoot, file);
      const category = relative.includes('evidence-index') ? 'evidence' : relative.split(path.sep)[0];
      return trace.sync(`fs.${name}:${category}`, () => {
        trace.count(`fs.${name}:${category}`);
        const value = Reflect.apply(original, this, args);
        // UTF-8 decoding code units are not claimed as disk byte counts.
        if (name === 'readFileSync') trace.count('readCodeUnitsOrBufferBytes', value.length);
        return value;
      });
    };
    const replacement = fs[name];
    restores.push(() => { if (fs[name] === replacement) fs[name] = original; });
  }
  for (const name of ['parse', 'stringify']) restores.push(trace.wrap(JSON, name, `JSON.${name}`));
  restores.push(trace.wrap(globalThis, 'structuredClone', 'structuredClone'));
  syncBuiltinESMExports();
  return () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); };
}

/** Recreates the real read dependency; never constructs a runner or acquires a project lease. */
export async function createReadHost({ moduleRoot, fixtureRoot, parentHash, bindings, coordinationSnapshot, coordinationLiveRoot, sourcePlans, sourceStores, desktopDiagnostics, output, readOnlyGuard, trace }) {
  if (process.env.PEER_AGENT_HOME !== fixtureRoot) throw new Error('fixture_environment_not_set_before_import');
  if(sourceStores&&(!coordinationLiveRoot||!readOnlyGuard))throw new Error('source_stores_require_readonly_source_guard');
  const storeRoot=sourceStores?path.dirname(coordinationLiveRoot):fixtureRoot;
  const from = relative => import(pathToFileURL(path.join(moduleRoot, relative)).href);
  let disposeDiagnostic = () => {};
  if (desktopDiagnostics) {
    // Import pure production diagnostic functions with their automatic OS-home sink disabled.
    process.env.PEER_AGENT_SLOW_TIMER_MS = '0';
    const [{ recordDiagnosticPhase, flushDiagnosticPhases, createDiagnosticWriter }, { setDiagnosticPhaseObserver }] = await Promise.all([
      from('apps/desktop/electron/main/slow-timer-probe.mjs'), from('packages/runtime-node/dist/diagnostic-phase.mjs'),
    ]);
    const writer = createDiagnosticWriter({ file: path.join(output, 'desktop-diagnostic.log') });
    const previous = setDiagnosticPhaseObserver((name, fields) => {
      if (name === 'plan.normalize') { trace.count('planNormalizeCalls'); trace.count('planNormalizeMs', Number(fields.ms) || 0); }
      return trace.sync('DesktopDiagnostic.phaseObserver', () => recordDiagnosticPhase(name, fields));
    });
    const timer = setInterval(() => flushDiagnosticPhases(writer), 1000); timer.unref();
    disposeDiagnostic = () => { clearInterval(timer); setDiagnosticPhaseObserver(previous); flushDiagnosticPhases(writer); };
  }
  const [{ createConversationStore }, { createGoalPlanStore }, { createSessionSupervisor },
    { createSessionVerification }, { createBotProfileStore }, { createProjectAgentApplicationService },
    { createExecutionScheduler }, { readPersistedObligationGrants }] = await Promise.all([
    from('packages/conversation-store/dist/index.mjs'), from('packages/runtime-node/dist/goal-plan-store.mjs'),
    from('packages/runtime-node/dist/project-agent/session-supervisor.mjs'),
    from('packages/runtime-node/dist/project-agent/session-verification.mjs'),
    from('packages/runtime-node/dist/project-agent/bot-profile-store.mjs'),
    from('apps/desktop/electron/main/project-agent/project-agent-application-service.mjs'),
    from('packages/runtime-node/dist/project-agent/execution-scheduler.mjs'),
    from('packages/runtime-node/dist/project-agent/execution-obligation.mjs'),
  ]);
  const profiles = createBotProfileStore({ rootDir: storeRoot });
  const target = fs.readdirSync(path.join(storeRoot, 'projects')).flatMap(id => {
    try { return [profiles.read(id)]; } catch { return []; }
  }).find(profile => profile && profile.status !== 'archived' && (!parentHash
    || createHash('sha256').update(profile.agentConversationId || '').digest('hex').startsWith(parentHash)));
  if (!target?.workspaceId || !target.agentConversationId) throw new Error('fixture_target_missing');
  const conversationStore = createConversationStore({ storeDir: path.join(storeRoot, 'conversations') });
  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(sourcePlans ? path.dirname(coordinationLiveRoot) : storeRoot, 'goal-plans') });
  let coordination;
  let coordinationFailures = 0;
  let unregister;
  if (coordinationSnapshot || coordinationLiveRoot) {
    const [{ DatabaseSync }, { registerWorkBudget }] = await Promise.all([
      from('packages/runtime-node/dist/sqlite/connection.mjs'), from('packages/runtime-node/dist/project-agent/work-budget.mjs'),
    ]);
    coordination = coordinationLiveRoot
      ? await createReadOnlyCoordination({ moduleRoot, rootDir: coordinationLiveRoot, workspaceId: target.workspaceId, guard: readOnlyGuard })
      : createCoordinationSnapshot(new DatabaseSync(coordinationSnapshot, { readOnly: true }));
    for (const key of ['read', 'readLifecycleFacts', 'readSnapshot', 'readSessionControl', 'readWork']) trace.wrap(coordination, key, `Coordination.${key}`);
    for (const key of ['read', 'readLifecycleFacts', 'readSnapshot', 'readSessionControl', 'readWork']) {
      const original = coordination[key];
      coordination[key] = function (...args) { try { return Reflect.apply(original, this, args); }
        catch (error) { coordinationFailures++; throw error; } };
    }
    unregister = registerWorkBudget(target.workspaceId, coordination);
  }
  for (const key of ['getPlan', 'listEvidenceIndex']) {
    const original = goalPlanStore[key];
    goalPlanStore[key] = function (...args) {
      trace.count(key);
      return trace.sync(`GoalPlanStore.${key}`, () => {
        const result = Reflect.apply(original, this, args);
        if (key === 'listEvidenceIndex') trace.count('evidenceRows', result.length);
        return result;
      });
    };
  }
  for (const key of ['getPersistedConversationHistory', 'getPersistedConversationHistories']) {
    trace.wrap(conversationStore, key, `ConversationStore.${key}`);
  }
  let supervisor;
  const verification = createSessionVerification({ goalPlanStore,
    readReport: plan => supervisor.readReportSummary(plan.delegationOrigin.sessionId) });
  trace.wrap(verification, 'facts', 'SessionVerification.facts');
  const hostFacts = plan => trace.sync('Desktop.readSessionFacts', () => ({
    autoHandoffOnPolicyAccept: profiles.read(plan.delegationOrigin.workspaceId)?.autoHandoffOnPolicyAccept === true,
    hostAuthority: verification.facts(plan.delegationOrigin.sessionId) || {},
  }));
  const scheduler = createExecutionScheduler(); // Desktop AgentTurnExecutor's default is rootless; no device writer is opened.
  supervisor = createSessionSupervisor({ conversationStore, goalPlanStore, executionScheduler: scheduler, deferRecovery: true,
    canManageWorkspace: () => false, autonomousCoordinationEnabled: () => false,
    ...(bindings ? { readSessionFacts: hostFacts,
      resolveAcceptancePolicy: workspaceId => profiles.read(workspaceId)?.acceptancePolicy } : {}),
  });
  trace.wrap(supervisor, 'list', 'SessionSupervisor.list');
  const fixtureObservation = { listCalls: 0, minSessions: null, maxSessions: 0 };
  const listed = supervisor.list;
  supervisor.list = function (...args) {
    const result = Reflect.apply(listed, this, args);
    fixtureObservation.listCalls += 1;
    fixtureObservation.minSessions = fixtureObservation.minSessions === null ? result.length : Math.min(fixtureObservation.minSessions, result.length);
    fixtureObservation.maxSessions = Math.max(fixtureObservation.maxSessions, result.length);
    return result;
  };
  trace.wrap(supervisor, 'readReportSummary', 'SessionSupervisor.readReportSummary');
  const grantRoot = coordinationLiveRoot || path.join(fixtureRoot, 'project-runtime');
  const persistedGrants = Boolean(coordinationLiveRoot || fs.existsSync(path.join(grantRoot, target.workspaceId, '.read-models', 'coordination-current.json')));
  const service = createProjectAgentApplicationService({ enabled: () => true, sessions: supervisor,
    readPersistedObligationGrants: persistedGrants
      ? workspaceId => readPersistedObligationGrants({ rootDir: grantRoot, workspaceId })
      : () => ({ ok: true, grants: [], source: 'isolated-empty-fixture' }) });
  const payload = { workspaceId: target.workspaceId, parentConversationId: target.agentConversationId };
  return { service, payload, fixtureObservation, sourceRevision: () => coordination?.revision?.(),
    readFailures: () => coordinationFailures, dependencyBindings: { receiptRead: Boolean(coordination), persistedGrants, desktopDiagnostics: Boolean(desktopDiagnostics), scheduler: 'desktop-rootless',
      stores: sourceStores ? 'production-readonly-source' : sourcePlans ? 'source-plans-and-isolated-other-stores' : 'isolated-copy',
      sourceValidation: coordinationLiveRoot ? 'production-readonly-source' : coordination ? 'isolated-backup' : 'excluded' },
    sessionFacts: () => supervisor.list({ workspaceId: target.workspaceId }),
    close() { unregister?.(); coordination?.close(); scheduler.close(); disposeDiagnostic(); }, async query() {
    const result = await service.listObligationGrants(payload);
    if (result.ok !== true || result.grants?.length !== 0) throw new Error('empty_query_fixture_changed');
    return result;
  } };
}
