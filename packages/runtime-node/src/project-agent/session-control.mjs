import { legacyCancellationStopped, legacyTakeoverIdle } from './legacy-stop-proof.mjs';
import { stopExecutionHandles } from './execution-handles.mjs';
import { randomUUID } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';
import { sessionFactsFromPlan } from './session-facts.mjs';
import { unsettledExecution } from './execution-resources.mjs';
import { isCanonicalUserInput } from './user-priority.mjs';
import { controlDigest, executionIdentity, sameExecution, reduceSessionControl } from './session-control-kernel.mjs';
import { fencedResumeStop } from './takeover-stop-recovery.mjs';

/** One stop barrier shared by cancellation, takeover and reversible suspension. */
export function createSessionControl({ goalPlanStore, goalRunner, executionScheduler, canManageWorkspace, abortStream,
  readMessages = () => [], onStopReceipt = () => {}, stopTimeoutMs = 30_000, now = () => new Date().toISOString() }) {
  const drains = new Map();
  const readPlan = id => goalPlanStore.getPlan(id);
  // ESRCH is the same recorder-death proof the resource editor uses. A missing pid, a live pid,
  // an empty token map, a provider status, or a timeout does not prove the old execution ended.
  function recordedHostPid(operation) {
    if (Number.isSafeInteger(operation?.hostPid) && operation.hostPid > 0) return operation.hostPid;
    const match = /^legacy-host:(\d+)$/.exec(typeof operation?.hostEpoch === 'string' ? operation.hostEpoch : '');
    if (!match) return 0;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  }
  function hostProcessDead(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  }
  function observedUnknown(plan) {
    const claims = (executionScheduler.resourceSnapshot?.() || []).filter(row => sameExecution(row.execution, executionIdentity(plan)));
    const ids = [...unsettledExecution(plan), ...claims.flatMap(claim => [
      ...(claim.evidenceCalls || []),
      ...Object.values(claim.handles || {}).filter(handle => handle.state !== 'ended').map(handle => handle.toolCallId),
    ])].filter(id => typeof id === 'string' && id);
    return [...new Set(ids)].sort();
  }
  function deadRecordingHost(operation, plan) {
    return hostProcessDead(recordedHostPid(operation)) && sessionFactsFromPlan(plan).executionOwnership !== 'live';
  }
  const journal = plan => workBudgetBinding(plan.delegationOrigin.workspaceId)?.store;
  function read(plan) { return journal(plan)?.readSessionControl?.(plan.delegationOrigin.sessionId) || plan.delegationOrigin.executionControl; }
  function withdrawalValid(plan) {
    const origin = plan.delegationOrigin, withdrawal = origin.cancellation?.withdrawal;
    return Boolean(withdrawal && Object.entries({ workspaceId: origin.workspaceId, parentConversationId: origin.parentConversationId,
      sessionId: origin.sessionId, planId: plan.planId }).every(([key, value]) => withdrawal[key] === value)
      && readMessages(origin.parentConversationId).some(row => isCanonicalUserInput(row) && row.id === withdrawal.anchorMessageId
        && (row.inputId || row.id) === withdrawal.inputId));
  }
  function recoveryFacts(plan) {
    return controlDigest([unsettledExecution(plan), sessionFactsFromPlan(plan).executionOwnership, plan.runner?.status,
      executionScheduler.resourceClaimsFor?.(plan), read(plan)?.stopReceipt?.receiptId, legacyCancellationStopped(plan), legacyTakeoverIdle(plan)]);
  }
  function persist(plan, operation) {
    if (!canManageWorkspace(plan.delegationOrigin.workspaceId)) throw new Error('lease_unavailable');
    const currentPlan = readPlan(plan.planId);
    const store = journal(currentPlan), previous = read(currentPlan);
    if (typeof store?.writeSessionControl === 'function') {
      store.writeSessionControl(operation, previous?.operationId === operation.operationId ? previous.revision : 0, previous?.operationId || null);
    } else {
      // Legacy hosts without a coordination journal already persist controls in GoalPlan.
      // This adapter cannot issue a mandate or clear an unknown dispatch.
      const state = { sessionControls: previous ? { [previous.operationId]: previous } : {},
        sessionControlHeads: previous ? { [previous.sessionId]: { operationId: previous.operationId } } : {} };
      reduceSessionControl(state, { operation, expectedRevision: previous?.operationId === operation.operationId ? previous.revision : 0,
        expectedCurrentOperationId: previous?.operationId || null });
    }
    const fresh = readPlan(plan.planId);
    goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...fresh.delegationOrigin, executionControl: operation } },
      { reason: 'execution control receipt', changedBy: 'session-control' });
    return operation;
  }
  function change(plan, operation, patch) {
    const current = read(readPlan(plan.planId));
    if (!current || current.operationId !== operation.operationId || current.phase === 'settled') throw new Error('session_control_superseded');
    return persist(plan, { ...current, ...patch, revision: current.revision + 1, updatedAt: now() });
  }
  function begin(plan, { kind, operationId = `${kind}-${randomUUID()}`, authorityRef, reason = kind, priorStopReceiptId }) {
    if (!canManageWorkspace(plan.delegationOrigin.workspaceId)) throw new Error('lease_unavailable');
    const current = read(plan), execution = executionIdentity(plan);
    const legacyStop = plan.delegationOrigin.cancellation?.phase === 'completed'
      && Number.isFinite(Date.parse(plan.delegationOrigin.cancellation.completedAt)) && (withdrawalValid(plan) || legacyCancellationStopped(plan));
    const mayHaveDispatched = plan.delegationOrigin.phase === 'running' || plan.delegationOrigin.takeover || plan.delegationOrigin.cancellation;
    const unproven = Boolean(mayHaveDispatched && sessionFactsFromPlan(plan).executionOwnership === 'unknown'
      && !legacyStop && !legacyTakeoverIdle(plan) && !(current?.stopReceipt && sameExecution(current.expectedExecution, execution)) && !executionScheduler.currentExecutionKnown?.(plan));
    const hostEpoch = journal(plan)?.writerEpoch?.() || `legacy-host:${process.pid}`;
    const identity = { kind, operationId, authorityRef, execution };
    if (current?.operationId === operationId) {
      if (current.requestDigest !== controlDigest(identity)) throw new Error('operation_identity_conflict');
      return current;
    }
    if (current?.kind === 'cancel' && kind !== 'cancel' || plan.delegationOrigin.cancellation && kind !== 'cancel') throw new Error('work_execution_stopped');
    if (kind !== 'resume') goalRunner?.pause?.(plan.planId, reason);
    executionScheduler.cancelPlan(plan.planId);
    executionScheduler.prepareResources?.();
    const operation = persist(plan, { ...identity, reason, requestDigest: controlDigest(identity), revision: 1,
      workspaceId: plan.delegationOrigin.workspaceId, parentConversationId: plan.delegationOrigin.parentConversationId,
      sessionId: execution.sessionId, planId: execution.planId, expectedExecution: execution, hostEpoch, hostPid: process.pid, unproven, priorStopReceiptId, phase: 'recorded', updatedAt: now() });
    if (kind !== 'resume') executionScheduler.protectResources?.(plan, { operationId, state: 'draining' });
    return change(plan, operation, { phase: 'draining' });
  }
  async function drain(plan, operation) {
    plan = readPlan(plan.planId);
    if (read(plan)?.operationId !== operation.operationId) throw new Error('session_control_superseded');
    if (!sameExecution(executionIdentity(plan), operation.expectedExecution)) throw new Error('execution_revision_stale');
    if (operation.stopReceipt && JSON.stringify(operation.stopReceipt.unknownCalls) === JSON.stringify(unsettledExecution(plan))
      && sessionFactsFromPlan(plan).executionOwnership !== 'live' && !executionScheduler.hasUnsettledHandles?.(plan)
      && (operation.phase === 'settled' || (executionScheduler.resourceClaimsFor?.(plan) || []).every(ref => operation.stopReceipt.resourceClaims.some(old => old.claimId === ref.claimId && old.revision === ref.revision)))) return operation.stopReceipt;
    if (operation.stopReceipt && deadRecordingHost(operation, plan)
      && JSON.stringify([...operation.stopReceipt.unknownCalls].sort()) === JSON.stringify(observedUnknown(plan))) return operation.stopReceipt;
    const factsDigest = recoveryFacts(plan);
    if (operation.nextAction && operation.recoveryFactsDigest === factsDigest) throw new Error(operation.nextAction);
    const hostEpoch = journal(plan)?.writerEpoch?.() || `legacy-host:${process.pid}`;
    const key = `${operation.operationId}:${operation.expectedExecution.executionEpoch}`;
    if (drains.has(key)) return drains.get(key);
    let timedOut = false, timeout;
    const work = (async () => {
      const ended = sessionFactsFromPlan(readPlan(plan.planId)).executionOwnership === 'ended';
      const retainedFence = operation.kind === 'pause' && operation.authorityRef?.startsWith('coordination-recovery:')
        && fencedResumeProof(readPlan(plan.planId))?.operationId === operation.operationId;
      const recordingHostDead = deadRecordingHost(operation, readPlan(plan.planId));
      if ((operation.hostEpoch && operation.hostEpoch !== hostEpoch && !operation.stopReceipt || operation.unproven) && !ended && !recordingHostDead
        && !legacyCancellationStopped(readPlan(plan.planId)) && !legacyTakeoverIdle(readPlan(plan.planId)) && !retainedFence)
        throw new Error('execution_stop_unconfirmed');
      const registration = { sessionId: operation.sessionId, planId: plan.planId, workspaceId: operation.workspaceId, conversationId: plan.conversationId };
      await abortStream?.({ ...registration, reason: operation.reason || operation.kind });
      await stopExecutionHandles(plan.conversationId);
      await goalRunner?.waitForIdle?.(plan.planId);
      await executionScheduler.waitForPlanIdle(plan.planId);
      await stopExecutionHandles(plan.conversationId);
      const fresh = readPlan(plan.planId);
      if (!canManageWorkspace(operation.workspaceId)) throw new Error('lease_unavailable');
      if (!sameExecution(executionIdentity(fresh), operation.expectedExecution)) throw new Error('execution_revision_stale');
      if (sessionFactsFromPlan(fresh).executionOwnership === 'live') throw new Error('execution_still_running');
      const binding = workBudgetBinding(operation.workspaceId), workId = fresh.delegationOrigin.workId;
      const work = typeof workId === 'string' && workId ? binding?.store.readWork?.(workId) : undefined;
      const activeUnknown = work?.budget?.uncertainDispatches?.some(row => (!row.planId || row.planId === plan.planId) && binding.activeAttempts?.has(row.attemptId));
      if (activeUnknown) throw new Error('execution_still_running');
      const hostDead = deadRecordingHost(operation, fresh);
      if (!hostDead && executionScheduler.hasUnsettledHandles?.(fresh)) throw new Error('execution_stop_unconfirmed');
      const unknownCalls = hostDead ? observedUnknown(fresh) : unsettledExecution(fresh);
      const resourceClaims = executionScheduler.resourceClaimsFor?.(fresh) || [];
      const receipt = { receiptId: `stop:${operation.operationId}:${controlDigest([unknownCalls, resourceClaims])}`, operationId: operation.operationId,
        execution: operation.expectedExecution, admissionClosed: true, runnerIdle: true, schedulerIdle: true,
        resourceClaims, unknownCalls, scope: 'managed_execution', completedAt: now() };
      const current = read(fresh);
      if (current?.operationId !== operation.operationId) throw new Error('session_control_superseded');
      change(fresh, current, { stopReceipt: receipt, nextAction: undefined, recoveryFactsDigest: undefined });
      // The deadline reports a pending stop; it must not discard a later real idle receipt.
      if (timedOut) void Promise.resolve().then(() => onStopReceipt(fresh.delegationOrigin.workspaceId)).catch(() => {});
      return receipt;
    })();
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => {
      timedOut = true; reject(new Error('execution_stop_unconfirmed'));
    }, stopTimeoutMs); });
    const result = Promise.race([work, deadline]).catch(error => {
      const fresh = readPlan(plan.planId), current = read(fresh);
      if (canManageWorkspace(operation.workspaceId) && current?.operationId === operation.operationId && current.phase !== 'settled')
        change(fresh, current, { phase: 'reconciling', nextAction: error.message, recoveryFactsDigest: recoveryFacts(fresh) });
      throw error;
    }).finally(() => { clearTimeout(timeout); drains.delete(key); });
    drains.set(key, result); return result;
  }
  function settle(plan, operation, receipt, { withdrawal = false, outcome = 'applied' } = {}) {
    const current = read(readPlan(plan.planId));
    if (current?.operationId !== operation.operationId) throw new Error('session_control_superseded');
    if (current.phase === 'settled') return current;
    if (!sameExecution(receipt?.execution, operation.expectedExecution)) throw new Error('session_control_receipt_invalid');
    if (receipt.unknownCalls.length && current.phase === 'reconciling' && current.stopReceipt?.receiptId === receipt.receiptId
      && JSON.stringify(current.stopReceipt.unknownCalls) === JSON.stringify(receipt.unknownCalls)) return current;
    executionScheduler.settleResources?.(plan, receipt);
    if (receipt.unknownCalls.length && !withdrawal && current.phase === 'reconciling' && current.stopReceipt?.receiptId === receipt.receiptId) return current;
    if (receipt.unknownCalls.length && !withdrawal) return change(plan, current, { phase: 'reconciling', stopReceipt: receipt, nextAction: 'reconcile_execution_outcome' });
    return change(plan, current, { phase: 'settled', outcome, stopReceipt: receipt, nextAction: undefined });
  }
  function retireTakeover(plan, operationId) {
    const origin = readPlan(plan.planId).delegationOrigin, takeover = origin.takeover;
    if (!takeover || takeover.phase !== 'stopping') return;
    const store = journal(plan), transition = store?.readLifecycleFacts?.().transitions?.[takeover.operationId];
    if (transition && transition.phase !== 'completed') store.advanceTransition(takeover.operationId, transition.phase,
      { phase: 'completed', error: 'control_superseded', controlOperationRef: operationId,
        ...(['applied', 'unknown'].includes(transition.executionEffect) ? {} : { executionEffect: 'rejected' }) });
    goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...origin,
      takeover: { ...takeover, phase: 'superseded', supersededBy: operationId, completedAt: now() } } },
    { reason: 'takeover superseded by settled control', changedBy: 'session-control' });
  }
  async function settleEnded(plan) {
    if (!['completed', 'failed', 'cancelled', 'stopped'].includes(plan.runner?.status)) return false;
    if (plan.delegationOrigin.cancellation) return false;
    const resourceClaims = executionScheduler.resourceClaimsFor?.(plan) || [];
    const operationId = `terminal:${plan.planId}:${executionIdentity(plan).executionEpoch}:${controlDigest(resourceClaims)}`, existing = read(plan);
    if (existing && existing.phase !== 'settled' && !existing.authorityRef.startsWith('runner-terminal:')) return false;
    if (existing?.operationId === operationId && existing.phase === 'settled') return true;
    executionScheduler.prepareResources?.();
    const execution = executionIdentity(plan), identity = { kind: 'pause', operationId, authorityRef: `runner-terminal:${plan.planId}`, execution };
    const operation = existing?.phase !== 'settled' && existing?.authorityRef.startsWith('runner-terminal:') ? existing : persist(plan, { ...identity, requestDigest: controlDigest(identity), revision: 1,
      workspaceId: plan.delegationOrigin.workspaceId, parentConversationId: plan.delegationOrigin.parentConversationId,
      sessionId: execution.sessionId, planId: execution.planId, expectedExecution: execution, phase: 'recorded', updatedAt: now() });
    if (operation.phase === 'recorded') executionScheduler.protectResources?.(plan, { operationId: operation.operationId, state: 'draining' });
    const draining = operation.phase === 'recorded' ? change(plan, operation, { phase: 'draining' }) : operation;
    try {
      const receipt = await drain(readPlan(plan.planId), draining);
      return settle(readPlan(plan.planId), draining, receipt).phase === 'settled';
    } catch { return false; }
  }
  async function settleQueued(plan) {
    const origin = plan.delegationOrigin, execution = executionIdentity(plan);
    if (origin.phase !== 'queued' || plan.runner || origin.cancellation || origin.takeover
      || sessionFactsFromPlan(plan).executionOwnership === 'live' || unsettledExecution(plan).length
      || executionScheduler.hasUnsettledHandles?.(plan)) return false;
    const work = journal(plan)?.readWork?.(origin.workId);
    if (!work || work.stopScope === 'work' && ['paused', 'cancelled', 'coalesced', 'budget_limited'].includes(work.state)) return false;
    const proofs = work.budget?.settledDispatches?.filter(row => row.sessionId === origin.sessionId
      && row.executionEpoch === execution.executionEpoch && row.goalRevision === execution.goalRevision) || [];
    const proof = proofs[0];
    if (!proof) return false;
    const unsettled = executionScheduler.resourceSnapshot?.().filter(claim => sameExecution(claim.execution, execution));
    if (!unsettled || unsettled.some(claim => (claim.evidenceCalls || []).some(id => !proofs.some(row => row.toolCallId === id)))) return false;
    const claims = executionScheduler.resourceClaimsFor?.(plan) || [];
    if (!claims.length) return false;
    const existing = read(plan), authorityRef = `queued-dispatch:${proof.evidenceRef}`;
    if (existing?.kind === 'cancel' || existing && existing.phase !== 'settled' && existing.authorityRef !== authorityRef) return false;
    const operationId = `queued:${plan.planId}:${proof.operationId}:${controlDigest(claims)}`;
    const identity = { kind: 'pause', operationId, authorityRef, execution };
    const operation = existing?.phase !== 'settled' && existing?.authorityRef === authorityRef ? existing : persist(plan, {
      ...identity, requestDigest: controlDigest(identity), revision: 1, workspaceId: origin.workspaceId,
      parentConversationId: origin.parentConversationId, sessionId: origin.sessionId, planId: plan.planId,
      expectedExecution: execution, hostEpoch: journal(plan)?.writerEpoch?.(), phase: 'recorded', updatedAt: now() });
    if (operation.phase === 'recorded') executionScheduler.protectResources?.(plan, { operationId: operation.operationId, state: 'draining' });
    const draining = operation.phase === 'recorded' ? change(plan, operation, { phase: 'draining' }) : operation;
    try {
      const receipt = await drain(readPlan(plan.planId), draining);
      return settle(readPlan(plan.planId), draining, receipt).phase === 'settled';
    } catch { return false; }
  }
  function fencedResumeProof(plan) {
    if (plan.delegationOrigin.takeover?.phase !== 'stopping' || !plan.delegationOrigin.executionGeneration) return null;
    const store = journal(plan), state = store?.readSnapshot?.() ?? store?.read();
    if (!state) return null;
    return fencedResumeStop(plan, state, readMessages(plan.delegationOrigin.parentConversationId), {
      live: sessionFactsFromPlan(plan).executionOwnership === 'live',
      handles: typeof executionScheduler.hasUnsettledHandles !== 'function' || executionScheduler.hasUnsettledHandles(plan),
      unknownCalls: unsettledExecution(plan),
      claims: executionScheduler.resourceSnapshot?.().filter(row => sameExecution(row.execution, executionIdentity(plan))),
    });
  }
  async function settleFencedResume(plan) {
    const spec = fencedResumeProof(plan);
    if (!spec) return false;
    const store = journal(plan);
    const existing = read(plan);
    const operation = existing?.operationId === spec.operationId ? existing : persist(plan, { ...spec,
      requestDigest: controlDigest({ kind: spec.kind, operationId: spec.operationId, authorityRef: spec.authorityRef, execution: spec.execution }),
      revision: 1, workspaceId: plan.delegationOrigin.workspaceId, parentConversationId: plan.delegationOrigin.parentConversationId,
      sessionId: spec.execution.sessionId, planId: plan.planId, expectedExecution: spec.execution,
      hostEpoch: store.writerEpoch(), phase: 'recorded', updatedAt: now() });
    if (operation.phase === 'settled') return true;
    if (operation.phase === 'recorded') executionScheduler.protectResources?.(plan, { operationId: operation.operationId, state: 'draining' });
    const draining = operation.phase === 'recorded' ? change(plan, operation, { phase: 'draining' }) : operation;
    const receipt = await drain(readPlan(plan.planId), draining);
    return settle(readPlan(plan.planId), draining, receipt).phase === 'settled';
  }
  return { begin, drain, settle, read, retireTakeover, settleEnded,
    async prepareResume(plan, authorityRef, exclusive) {
      const barrier = await exclusive(() => {
        const fresh = readPlan(plan.planId), current = read(fresh);
        if (current?.kind === 'cancel' || fresh.delegationOrigin.cancellation) throw new Error('work_execution_stopped');
        if (current?.operationId === `resume:${authorityRef}` && current.phase === 'settled'
          || current?.phase === 'settled' && current.stopReceipt && sameExecution(current.expectedExecution, executionIdentity(fresh))) return null;
        if (current && current.phase !== 'settled') {
          if (current.kind !== 'pause') throw new Error('execution_stop_unconfirmed');
          return current;
        }
        return begin(fresh, { kind: 'pause', operationId: `before:resume:${authorityRef}`, authorityRef, reason: 'resume barrier' });
      });
      if (!barrier) return;
      // Result/handle commits may need the supervisor writer while this wait is pending.
      const receipt = await drain(readPlan(plan.planId), barrier);
      await exclusive(() => {
        if (settle(readPlan(plan.planId), barrier, receipt).phase !== 'settled') throw new Error('execution_outcome_unknown');
      });
    },
    resume(plan, authorityRef) {
      const current = read(plan), operationId = `resume:${authorityRef}`;
      if (current?.operationId === operationId && current.phase === 'settled') return current;
      if (!current?.stopReceipt || !sameExecution(current.expectedExecution, executionIdentity(plan))) throw new Error('execution_stop_unconfirmed');
      if (current && current.operationId !== operationId && current.phase !== 'settled') throw new Error(current.stopReceipt?.unknownCalls.length ? 'execution_outcome_unknown' : 'execution_stop_unconfirmed');
      const operation = begin(plan, { kind: 'resume', operationId, authorityRef, priorStopReceiptId: current?.stopReceipt?.receiptId || current?.priorStopReceiptId });
      const resumed = operation.phase === 'settled' ? operation : change(plan, operation, { phase: 'settled', outcome: 'applied' });
      const fresh = readPlan(plan.planId);
      goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...fresh.delegationOrigin, executionGeneration: operation.operationId } },
        { reason: 'resume execution generation', changedBy: 'session-control' });
      executionScheduler.rebindResourceRequirements?.(operation.expectedExecution, executionIdentity(readPlan(plan.planId)), operation.priorStopReceiptId);
      return resumed;
    },
    isCurrent(plan, operation) { return read(plan)?.operationId === operation.operationId; },
    async reconcile(plans) {
      const failures = [];
      for (const plan of plans) {
        const origin = plan.delegationOrigin;
        if (!canManageWorkspace(origin.workspaceId)) continue;
        let current = read(plan);
        if (origin.cancellation?.phase !== 'completed') {
          try { await settleFencedResume(plan); }
          catch (error) { failures.push({ planId: plan.planId, sessionId: origin.sessionId, error: error.message }); }
          current = read(readPlan(plan.planId));
          await settleQueued(plan);
          // Old hosts could persist takeover.stopping after both the worker and verifier
          // had returned. Import those structured end receipts, then run today's barrier.
          if (!current && legacyTakeoverIdle(plan)) {
            try {
              const operation = begin(plan, { kind: 'pause', operationId: `legacy-takeover-stop:${origin.takeover.operationId}`,
                authorityRef: `legacy-takeover:${origin.takeover.operationId}`, reason: 'legacy idle takeover settlement' });
              const receipt = await drain(readPlan(plan.planId), operation);
              if (settle(readPlan(plan.planId), operation, receipt).phase === 'settled') retireTakeover(readPlan(plan.planId), operation.operationId);
            } catch (error) { failures.push({ planId: plan.planId, sessionId: origin.sessionId, error: error.message }); }
          }
          if (current?.kind === 'pause' && current.phase !== 'settled') {
            try {
              const receipt = await drain(plan, current);
              const settled = settle(readPlan(plan.planId), current, receipt);
              if (settled.phase === 'settled' && current.authorityRef.startsWith('legacy-takeover:')) retireTakeover(readPlan(plan.planId), current.operationId);
            }
            catch (error) { failures.push({ planId: plan.planId, sessionId: origin.sessionId, error: error.message }); }
          }
          continue;
        }
        // A completed legacy cancellation is the host's existing abort/idle receipt. Re-enter
        // the barrier to confirm this process and import its identity; never infer tool success.
        const factsDigest = recoveryFacts(plan);
        if (current?.phase === 'reconciling' && current.recoveryFactsDigest === factsDigest) continue;
        if (origin.takeover?.phase !== 'stopping' && (!current && sessionFactsFromPlan(plan).executionOwnership !== 'unknown' || current?.phase === 'settled'
          && JSON.stringify(current.stopReceipt?.unknownCalls || []) === JSON.stringify(unsettledExecution(plan)))) continue;
        try {
          const operation = begin(plan, { kind: 'cancel', operationId: `recover:${origin.cancellation.operationId}:${controlDigest(unsettledExecution(plan))}`,
            authorityRef: origin.cancellation.withdrawal?.anchorMessageId || `cancellation:${origin.cancellation.operationId}`, reason: 'cancellation settlement recovery' });
          const receipt = await drain(plan, operation);
          settle(readPlan(plan.planId), operation, receipt, { withdrawal: withdrawalValid(plan) });
          goalPlanStore.setPlanStatus(plan.planId, 'cancelled');
          retireTakeover(readPlan(plan.planId), operation.operationId);
        } catch (error) {
          const pending = read(readPlan(plan.planId));
          if (pending?.kind === 'cancel' && pending.phase !== 'settled' && pending.recoveryFactsDigest !== factsDigest)
            change(readPlan(plan.planId), pending, { phase: 'reconciling', nextAction: error.message, recoveryFactsDigest: factsDigest });
          failures.push({ planId: plan.planId, sessionId: origin.sessionId, error: error.message });
        }
      }
      return failures;
    },
  };
}
