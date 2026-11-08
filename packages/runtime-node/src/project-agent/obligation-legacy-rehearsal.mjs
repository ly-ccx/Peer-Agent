import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { projectWorkSession } from '@peer-agent/protocol';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { createExecutionObligationService } from './execution-obligation.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { validateDelegationInput } from './tool-specs.mjs';
import { obligationLogPath } from './obligation-log.mjs';

const epoch = 'syn-host-now:2026-11-07T09:40:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';
const IDS = ['legacy', 'dead-1', 'dead-2', 'dead-3'];
const DEAD_IDS = ['dead-1', 'dead-2', 'dead-3'];
const recorder = { bootId: 'boot-now', pid: 4242, pidStart: 'linux:100', hostId: 'host-old', acquiredAt: '2026-11-07T08:00:00.000Z' };

function legacyPlan(id, directory, extra = {}) {
  return { planId: `plan-${id}`, conversationId: `child-${id}`, title: id, status: 'paused', targetWorkspacePath: directory,
    createdAt: '2026-11-07T08:00:00.000Z', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      coordinationBinding: { executionEpoch: `epoch-${id}`, goalRevision: 1 },
      cancellation: { operationId: `cancel-${id}`, phase: 'awaiting_outcome', reason: 'cancelled', requestedAt: '2026-11-07T08:00:00.000Z' },
      executionControl: { kind: 'cancel', operationId: `cancel-${id}`, phase: 'reconciling', nextAction: 'execution_stop_unconfirmed',
        revision: 4, hostEpoch: oldEpoch, workspaceId: 'workspace', parentConversationId: 'parent', sessionId: id, planId: `plan-${id}`,
        authorityRef: `cancellation:cancel-${id}`, expectedExecution: { planId: `plan-${id}`, sessionId: id, executionEpoch: `epoch-${id}`, goalRevision: 1 },
        updatedAt: '2026-11-07T08:00:00.000Z', ...(extra.recorder ? { recorder: extra.recorder } : {}) } } };
}

function toolOutput(result) {
  const output = result?.result?.output;
  if (output && typeof output === 'object') return output;
  const text = result?.result?.outputPreview?.legacyResult?.output;
  return typeof text === 'string' ? JSON.parse(text) : null;
}

/** Copy only fields that already appear on the previous tool JSON. No hash is computed here. */
function requestFromInspect(inspected, ids) {
  return { items: inspected.items.filter(item => ids.includes(item.sessionId)).map(item => ({
    obligationId: item.obligationId, sessionId: item.sessionId, operationId: item.operationId,
    evidenceRevision: item.evidenceRevision, actions: [...item.allowedActions],
  })) };
}
function resolveFromAuthorization(authorization) {
  return { grantId: authorization.grantId, idempotencyKey: authorization.idempotencyKey,
    items: authorization.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: [...item.actions] })) };
}

/**
 * One legacy record and two dead-recorder records. Tool arguments are copied from the
 * previous tool JSON and checked against the tool schema. Desktop passes the live bridge.
 */
export async function rehearseLegacyObligations({ rootDir, bridgeSupervisor = null, executeTool = null, confirmGrant = null } = {}) {
  const directory = path.join(rootDir, 'workspace');
  mkdirSync(directory, { recursive: true });
  const plans = new Map(IDS.map(id => {
    const row = legacyPlan(id, directory, id === 'legacy' ? {} : { recorder });
    return [row.planId, row];
  }));
  const store = createWorkCoordinationStore({ rootDir: path.join(rootDir, 'runtime'), workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  const scheduler = createExecutionScheduler({ rootDir: path.join(rootDir, 'runtime') });
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: item => plans.get(item.planId) || item });
  for (const id of IDS) scheduler.protectResources(plans.get(`plan-${id}`), { operationId: `cancel-${id}`, state: 'reconciling' });
  const service = createExecutionObligationService({
    plans: () => [...plans.values()],
    readControl: item => item.delegationOrigin.executionControl,
    scheduler, canManage: () => true, storeFor: () => store,
    identity: () => ({ bootId: 'boot-now', pid: 7, pidStart: 'linux:7', lookup: () => null }),
    writerEpochFor: () => epoch, now: () => '2026-11-07T10:00:00.000Z',
  });
  const raw = {
    inspectExecutionObligations: input => service.inspect(input),
    requestObligationAuthorization: input => service.requestAuthorization(input),
    resolveExecutionObligation: input => service.resolve(input),
    listPendingObligationGrants: (workspaceId, parentConversationId) => ({ ok: true, grants: service.pendingGrants(workspaceId, parentConversationId) }),
    confirmObligationGrant: input => service.confirm(input),
    revokeObligationGrant: input => service.revoke(input),
  };
  const supervisor = typeof bridgeSupervisor === 'function' ? bridgeSupervisor(raw) : raw;
  const provider = createDelegationProvider({ supervisor });
  const context = { mode: 'project_agent', role: 'project_agent', workspaceId: 'workspace', conversationId: 'parent', turnId: 'turn-legacy', toolCallOrdinal: 1 };
  const callTool = async (capabilityId, args, toolCallId) => toolOutput(typeof executeTool === 'function'
    ? await executeTool({ capabilityId, args, toolCallId, raw })
    : await provider.executeCapability({ call: { toolCallId, capabilityId, arguments: args } }, context));
  const callChecked = async (name, capabilityId, args, toolCallId) => {
    const validated = validateDelegationInput(name, args);
    if (!validated.ok) return { ok: false, error: validated.error, message: validated.message };
    return callTool(capabilityId, validated.value, toolCallId);
  };
  const steps = [];
  try {
    const inspected = await callChecked('inspect_execution_obligation', 'local.delegation.inspect_execution_obligation', { sessionIds: IDS }, 'inspect-legacy');
    steps.push({ step: 'inspect', ok: inspected?.ok === true, classes: inspected?.items?.map(item => item.classes), missing: inspected?.items?.map(item => item.missingFields), allowed: inspected?.items?.map(item => item.allowedActions), error: inspected?.error || null });
    if (inspected?.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    const staleArgs = requestFromInspect(inspected, ['dead-1']);
    plans.get('plan-dead-1').delegationOrigin.executionControl.revision += 1;
    const stale = await callChecked('request_obligation_authorization', 'local.delegation.request_obligation_authorization', staleArgs, 'request-stale');
    plans.get('plan-dead-1').delegationOrigin.executionControl.revision -= 1;
    steps.push({ step: 'stale', ok: stale?.error === 'evidence_stale' && stale?.nextTool === 'inspect_execution_obligation', error: stale?.error || null, nextTool: stale?.nextTool || null, reason: stale?.stale?.map(item => item.reason) || null });
    if (steps.at(-1).ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    const oneInspect = await callChecked('inspect_execution_obligation', 'local.delegation.inspect_execution_obligation', { sessionIds: ['legacy'] }, 'inspect-one');
    if (oneInspect?.ok !== true) return { ok: false, steps: [...steps, { step: 'inspect-one', ok: false, error: oneInspect?.error || null }], logPath: obligationLogPath() };
    const one = await callChecked('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFromInspect(oneInspect, ['legacy']), 'request-one');
    steps.push({ step: 'request-one', ok: one?.ok === true, count: one?.items?.length || 0, grantId: one?.grantId || null, error: one?.error || null });
    const threeInspect = await callChecked('inspect_execution_obligation', 'local.delegation.inspect_execution_obligation', { sessionIds: DEAD_IDS }, 'inspect-three');
    if (threeInspect?.ok !== true) return { ok: false, steps: [...steps, { step: 'inspect-three', ok: false, error: threeInspect?.error || null }], logPath: obligationLogPath() };
    const three = await callChecked('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFromInspect(threeInspect, DEAD_IDS), 'request-three');
    steps.push({ step: 'request-three', ok: three?.ok === true, count: three?.items?.length || 0, grantId: three?.grantId || null, error: three?.error || null });
    if (one?.ok !== true || three?.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
    for (const authorization of [one, three]) {
      const confirmed = typeof confirmGrant === 'function'
        ? await confirmGrant({ raw, grantId: authorization.grantId, workspaceId: 'workspace', parentConversationId: 'parent' })
        : service.confirm({ actor: 'user_panel', workspaceId: 'workspace', parentConversationId: 'parent', grantId: authorization.grantId });
      steps.push({ step: 'confirm', ok: confirmed.ok === true, grantId: authorization.grantId, status: confirmed.status || confirmed.grant?.status || null, grants: confirmed.grants || null, resolution: confirmed.resolution || null, error: confirmed.error || null });
      if (confirmed.ok !== true) return { ok: false, steps, logPath: obligationLogPath() };
      const resolved = await callChecked('resolve_execution_obligation', 'local.delegation.resolve_execution_obligation', resolveFromAuthorization(authorization), `resolve-${authorization.grantId}`);
      steps.push({ step: 'resolve', ok: resolved?.ok === true, replayed: resolved?.replayed === true, results: resolved?.items?.map(item => item.result), error: resolved?.error || null });
    }
    const lists = IDS.map(id => {
      const row = plans.get(`plan-${id}`);
      const session = projectWorkSession({ planId: row.planId, status: row.status, title: id, delegated: true, runnerStatus: 'running' }, {
        sessionId: id, workspaceId: 'workspace', spawnedAt: '2026-11-07T08:00:00.000Z', origin: row.delegationOrigin,
        obligationDisposition: service.dispositionFor('workspace', id), executionOwnership: 'unknown',
      });
      return { sessionId: id, planStatus: row.status, inCurrentList: session.followUp?.inCurrentList !== false, inObligations: session.followUp?.reason === 'obligation_indexed', reason: session.followUp?.reason || null };
    });
    const claims = scheduler.resourceSnapshot();
    steps.push({ step: 'lists', rows: lists, claimsReleased: claims.some(claim => claim.state === 'released') });
    const ok = steps.every(step => step.ok !== false) && one.items.length === 1 && three.items.length === 3
      && lists.every(row => row.inCurrentList === false && row.inObligations === true && row.planStatus !== 'cancelled')
      && !claims.some(claim => claim.state === 'released');
    return { ok, steps, logPath: obligationLogPath() };
  } finally {
    scheduler.close();
    store.close();
  }
}
