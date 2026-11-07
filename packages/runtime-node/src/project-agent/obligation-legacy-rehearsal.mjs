import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { projectWorkSession } from '@peer-agent/protocol';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { createExecutionObligationService } from './execution-obligation.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { obligationLogPath } from './obligation-log.mjs';

const epoch = 'syn-host-now:2026-11-07T09:40:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';

function legacyPlan(id, directory, extra = {}) {
  return { planId: `plan-${id}`, conversationId: `child-${id}`, title: id, status: 'paused', targetWorkspacePath: directory,
    createdAt: '2026-11-07T08:00:00.000Z', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      coordinationBinding: { executionEpoch: `epoch-${id}`, goalRevision: 1 },
      ...(extra.workId ? { workId: extra.workId } : {}),
      cancellation: { operationId: `cancel-${id}`, phase: 'awaiting_outcome', reason: 'cancelled', requestedAt: '2026-11-07T08:00:00.000Z' },
      executionControl: { kind: 'cancel', operationId: `cancel-${id}`, phase: 'reconciling', nextAction: 'execution_stop_unconfirmed',
        revision: 4, hostEpoch: oldEpoch, workspaceId: 'workspace', parentConversationId: 'parent', sessionId: id, planId: `plan-${id}`,
        authorityRef: `cancellation:cancel-${id}`, expectedExecution: { planId: `plan-${id}`, sessionId: id, executionEpoch: `epoch-${id}`, goalRevision: 1 },
        updatedAt: '2026-11-07T08:00:00.000Z' } } };
}

function toolOutput(result) {
  const output = result?.result?.output;
  if (output && typeof output === 'object') return output;
  const text = result?.result?.outputPreview?.legacyResult?.output;
  return typeof text === 'string' ? JSON.parse(text) : null;
}

/**
 * Three rc38-shaped records: no recorder tuple, only a lease epoch, ownership unknown.
 * Drives the main-bot tools, then the host card confirmation. Does not touch a real home
 * unless the caller points PEER_AGENT_HOME there.
 */
export async function rehearseLegacyObligations({ rootDir }) {
  const directory = path.join(rootDir, 'workspace');
  mkdirSync(directory, { recursive: true });
  const plans = new Map(['a', 'b', 'c'].map(id => {
    const row = legacyPlan(id, directory, id === 'b' ? { workId: 'work' } : {});
    return [row.planId, row];
  }));
  const store = createWorkCoordinationStore({ rootDir: path.join(rootDir, 'runtime'), workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'work', workspaceId: 'workspace', parentConversationId: 'parent', state: 'waiting_children', budget: { uncertainDispatches: [{ toolCallId: 'syn-call-b', planId: 'plan-b' }] } });
  const release = registerWorkBudget('workspace', store);
  const scheduler = createExecutionScheduler({ rootDir: path.join(rootDir, 'runtime') });
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: item => plans.get(item.planId) || item });
  for (const id of ['a', 'b', 'c']) {
    scheduler.protectResources(plans.get(`plan-${id}`), { operationId: `cancel-${id}`, state: id === 'b' ? 'reconciling' : 'draining', ...(id === 'b' ? { evidenceCalls: ['syn-call-b'] } : {}) });
  }
  const { createExecutionResources } = await import('./execution-resources.mjs');
  const ledger = createExecutionResources({ rootDir: path.join(rootDir, 'runtime') });
  ledger.markHandle(plans.get('plan-c'), { handleId: 'syn-handle-c', toolCallId: 'syn-call-c', state: 'active' });
  ledger.close();
  const service = createExecutionObligationService({
    plans: () => [...plans.values()],
    readControl: item => item.delegationOrigin.executionControl,
    scheduler, canManage: () => true, storeFor: () => store,
    identity: () => ({ bootId: null, pid: 1, pidStart: null, lookup: () => null }),
    writerEpochFor: () => epoch, now: () => '2026-11-07T10:00:00.000Z',
  });
  const provider = createDelegationProvider({ supervisor: {
    inspectExecutionObligations: input => service.inspect(input),
    requestObligationAuthorization: input => service.requestAuthorization(input),
    resolveExecutionObligation: input => service.resolve(input),
  } });
  const context = { mode: 'project_agent', role: 'project_agent', workspaceId: 'workspace', conversationId: 'parent', turnId: 'turn-legacy', toolCallOrdinal: 1 };
  const steps = [];
  try {
    const inspected = toolOutput(await provider.executeCapability({ call: { toolCallId: 'inspect-legacy', capabilityId: 'local.delegation.inspect_execution_obligation', arguments: { sessionIds: ['a', 'b', 'c'] } } }, context));
    steps.push({ step: 'inspect', ok: inspected?.ok === true, classes: inspected?.items?.map(item => item.classes), allowed: inspected?.items?.map(item => item.allowedActions), error: inspected?.error || null });
    if (inspected?.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    const evidenceRevision = createHash('sha256').update(JSON.stringify(inspected.items.map(item => item.evidenceRevision).sort())).digest('hex');
    const requested = toolOutput(await provider.executeCapability({ call: { toolCallId: 'request-legacy', capabilityId: 'local.delegation.request_obligation_authorization', arguments: {
      evidenceRevision, items: inspected.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: ['acknowledge_unknown', 'retire_follow_up'] })),
    } } }, context));
    steps.push({ step: 'card', ok: requested?.ok === true, grantId: requested?.grantId || null, status: requested?.status || null, error: requested?.error || null });
    if (requested?.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    const confirmed = service.confirm({ actor: 'user_panel', workspaceId: 'workspace', parentConversationId: 'parent', grantId: requested.grantId });
    steps.push({ step: 'confirm', ok: confirmed.ok === true, status: confirmed.grant?.status || null, error: confirmed.error || null });
    if (confirmed.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    const resolved = toolOutput(await provider.executeCapability({ call: { toolCallId: 'resolve-legacy', capabilityId: 'local.delegation.resolve_execution_obligation', arguments: {
      grantId: requested.grantId, idempotencyKey: 'panel-legacy-rehearsal',
      items: confirmed.grant.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: item.actions })),
    } } }, context));
    steps.push({ step: 'resolve', ok: resolved?.ok === true, results: resolved?.items?.map(item => item.result), error: resolved?.error || resolved?.items?.find(item => item.code)?.code || null });
    const lists = ['a', 'b', 'c'].map(id => {
      const row = plans.get(`plan-${id}`);
      const session = projectWorkSession({ planId: row.planId, status: row.status, title: id, delegated: true, runnerStatus: 'running' }, {
        sessionId: id, workspaceId: 'workspace', spawnedAt: '2026-11-07T08:00:00.000Z', origin: row.delegationOrigin,
        obligationDisposition: service.dispositionFor('workspace', id), executionOwnership: 'unknown',
      });
      const inCurrent = session.followUp?.inCurrentList !== false;
      return { sessionId: id, planStatus: row.status, inCurrentList: inCurrent, inObligations: session.followUp?.reason === 'obligation_indexed', reason: session.followUp?.reason || null };
    });
    const claims = scheduler.resourceSnapshot();
    steps.push({ step: 'lists', rows: lists, claimsReleased: claims.some(claim => claim.state === 'released'), claimB: claims.find(claim => claim.execution?.planId === 'plan-b')?.state || null });
    const ok = steps.every(step => step.ok !== false) && lists.every(row => row.inCurrentList === false && row.inObligations === true && row.planStatus !== 'cancelled') && !claims.some(claim => claim.state === 'released');
    return { ok, steps, logPath: obligationLogPath() };
  } finally {
    scheduler.close();
    release();
    store.close();
  }
}
