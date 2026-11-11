import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createCoordinationSnapshot } from './coordination-snapshot.mjs';

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
export async function createReadHost({ moduleRoot, fixtureRoot, parentHash, bindings, coordinationSnapshot, trace }) {
  if (process.env.PEER_AGENT_HOME !== fixtureRoot) throw new Error('fixture_environment_not_set_before_import');
  const from = relative => import(pathToFileURL(path.join(moduleRoot, relative)).href);
  const [{ createConversationStore }, { createGoalPlanStore }, { createSessionSupervisor },
    { createSessionVerification }, { createBotProfileStore }, { createProjectAgentApplicationService }] = await Promise.all([
    from('packages/conversation-store/dist/index.mjs'), from('packages/runtime-node/dist/goal-plan-store.mjs'),
    from('packages/runtime-node/dist/project-agent/session-supervisor.mjs'),
    from('packages/runtime-node/dist/project-agent/session-verification.mjs'),
    from('packages/runtime-node/dist/project-agent/bot-profile-store.mjs'),
    from('apps/desktop/electron/main/project-agent/project-agent-application-service.mjs'),
  ]);
  const profiles = createBotProfileStore({ rootDir: fixtureRoot });
  const target = fs.readdirSync(path.join(fixtureRoot, 'projects')).flatMap(id => {
    try { return [profiles.read(id)]; } catch { return []; }
  }).find(profile => profile && profile.status !== 'archived' && (!parentHash
    || createHash('sha256').update(profile.agentConversationId || '').digest('hex').startsWith(parentHash)));
  if (!target?.workspaceId || !target.agentConversationId) throw new Error('fixture_target_missing');
  const conversationStore = createConversationStore({ storeDir: path.join(fixtureRoot, 'conversations') });
  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(fixtureRoot, 'goal-plans') });
  let coordination;
  let unregister;
  if (coordinationSnapshot) {
    const [{ DatabaseSync }, { registerWorkBudget }] = await Promise.all([
      from('packages/runtime-node/dist/sqlite/connection.mjs'), from('packages/runtime-node/dist/project-agent/work-budget.mjs'),
    ]);
    coordination = createCoordinationSnapshot(new DatabaseSync(coordinationSnapshot, { readOnly: true }));
    for (const key of ['readLifecycleFacts', 'readSnapshot', 'readSessionControl', 'readWork']) trace.wrap(coordination, key, `Coordination.${key}`);
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
  supervisor = createSessionSupervisor({ conversationStore, goalPlanStore, deferRecovery: true,
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
  const service = createProjectAgentApplicationService({ enabled: () => true, sessions: supervisor,
    readPersistedObligationGrants: () => ({ ok: true, grants: [], source: 'isolated-empty-fixture' }) });
  const payload = { workspaceId: target.workspaceId, parentConversationId: target.agentConversationId };
  return { service, payload, fixtureObservation, sessionFacts: () => supervisor.list({ workspaceId: target.workspaceId }),
    close() { unregister?.(); coordination?.close(); }, async query() {
    const result = await service.listObligationGrants(payload);
    if (result.ok !== true || result.grants?.length !== 0) throw new Error('empty_query_fixture_changed');
    return result;
  } };
}
