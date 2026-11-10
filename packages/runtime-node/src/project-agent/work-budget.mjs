import { verificationDispatchTarget } from './verification-dispatch-recovery.mjs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { runtimeWorkHeld } from './runtime-disposition.ts';
import { executionBindingCurrent } from './coordination-kernel.mjs';
import { resolveWorkBudgetPolicy, effectiveWorkLimits, budgetBoundary, budgetReservationBoundary, legacyBudgetMigration } from './work-budget-policy.mjs';
export { DEFAULT_WORK_BUDGET } from './work-budget-policy.mjs';

// Host registry contains local ports, never model supplied policy. Desktop and TUI share this seam.
const stores = new Map();
export function registerWorkBudget(workspaceId, store, policy = {}, clock = () => new Date().toISOString()) {
  const limits = resolveWorkBudgetPolicy(policy);
  const binding = { store, limits, activeAttempts: new Set(), now: clock };
  stores.set(workspaceId, binding);
  return () => { if (stores.get(workspaceId) === binding) stores.delete(workspaceId); };
}
export function workBudgetBinding(workspaceId) { return stores.get(workspaceId); }

/** Configuration can reopen a boundary; retries never reset actual usage. */
export function workBudgetCanResume(work, limits) {
  const budget = work?.budget, previous = budget?.limits;
  if (!budget || !previous || !limits) return false;
  const caps = [['maxModelRequests', 'modelRequests'], ['maxToolCalls', 'toolCalls'], ['maxTokens', 'tokens'], ['maxCostUsd', 'costUsd']];
  const current = effectiveWorkLimits(budget, limits);
  const increased = Boolean(legacyBudgetMigration(work, limits)) || caps.some(([cap]) =>
    Number.isFinite(previous[cap]) && Number.isFinite(current[cap]) && current[cap] > previous[cap]);
  const reservationReleased = budget.lastBoundary?.reason === 'reservation_pending' && !Object.keys(budget.attempts || {}).length;
  return (increased || reservationReleased) && !budgetBoundary(budget, current);
}
export function createWorkBudgetGuard(profile) {
  if (!profile?.workId) return null;
  const binding = stores.get(profile.workspaceId);
  if (!binding) throw new Error('work_budget_host_unavailable');
  const { store } = binding;
  const readWork = () => typeof store.readWork === 'function' ? store.readWork(profile.workId) : store.read().works[profile.workId];
  const attemptId = randomUUID();
  binding.activeAttempts.add(attemptId);
  let requests = 0, finished = false, observed = 0, physicalDispatchAccounting = false;
  function change(update, requireActive = true) {
    store.assertOwner();
    const work = readWork();
    const stopped = work && (runtimeWorkHeld(work) || ['paused', 'cancelled', 'budget_limited', 'blocked_system', 'coalesced'].includes(work.state));
    const stopsExecutor = profile.role === 'project_agent' || work?.stopScope !== 'reply' || ['budget_limited', 'coalesced'].includes(work?.state);
    if (!work || requireActive && stopped && stopsExecutor) throw new Error('work_execution_stopped');
    if (requireActive && profile.coordinationBinding) {
      const state = typeof store.readLifecycleFacts === 'function' ? store.readLifecycleFacts() : store.read();
      const mandate = state.mandates?.[profile.coordinationBinding.workId];
      const transition = Object.values(state.transitions || {}).find(row => row.executionEpoch === profile.coordinationBinding.executionEpoch);
      if (!executionBindingCurrent(mandate, transition, profile.coordinationBinding)) throw new Error('execution_revision_stale');
    }
    if (requireActive && profile.sessionId) {
      const control = store.readSessionControl?.(profile.sessionId);
      if (control && (control.phase !== 'settled' || control.kind === 'cancel')) throw new Error('work_execution_stopped');
    }
    const limits = effectiveWorkLimits(work.budget, binding.limits);
    const budget = { modelRequests: 0, toolCalls: 0, tokens: 0, costUsd: 0, unknownUsage: false, unknownCost: false, attempts: {},
      ...(legacyBudgetMigration(work, binding.limits) || work.budget), limits };
    let patch;
    try { patch = update(budget); } catch (error) {
      if (error?.message === 'work_budget_limited') store.saveWork({ ...work, budget: { ...budget,
        lastBoundary: error.boundary || budgetBoundary(budget, limits) || undefined } }, { returnState: false });
      throw error;
    }
    store.saveWork({ ...work, ...patch, budget }, { returnState: false });
    return budget;
  }
  const relevantOutcome = row => !row.planId || row.planId === profile.planId;
  function limited(boundary) { throw Object.assign(new Error('work_budget_limited'), { boundary }); }
  // ADR 127 §5.1: the dispatch id is deterministic so a retried or replayed registration of the
  // same call on the same attempt names the same dispatch instead of manufacturing a second unknown.
  const dispatchIdFor = toolCallId => `dispatch-${createHash('sha256')
    .update(JSON.stringify([profile.workId, attemptId, toolCallId])).digest('hex').slice(0, 32)}`;
  function receiptStatus(result) {
    if (typeof result?.status === 'string') return result.status;
    if (typeof result?.output === 'string' && result.output.trim().startsWith('{')) {
      try { const parsed = JSON.parse(result.output); if (typeof parsed?.status === 'string') return parsed.status; } catch { /* a preview is not a receipt */ }
    }
    return null;
  }
  function receiptEvidenceRefs(result) {
    if (Array.isArray(result?.evidenceRefs)) return result.evidenceRefs.filter(ref => typeof ref === 'string');
    if (typeof result?.output === 'string' && result.output.trim().startsWith('{')) {
      try { const parsed = JSON.parse(result.output); if (Array.isArray(parsed?.evidenceRefs)) return parsed.evidenceRefs.filter(ref => typeof ref === 'string'); } catch { /* a preview is not a receipt */ }
    }
    return [];
  }
  /** Receipt classification, not a success claim: a terminated process is answered for, never "successful". */
  function dispatchOutcome(execution) {
    const result = execution?.result, status = receiptStatus(result);
    if (status === 'denied' || status === 'not_executed') return 'not_dispatched';
    if (status === 'cancelled' || status === 'terminated' || result?.interrupted === true || typeof result?.stopReason === 'string') {
      return status === 'cancelled' && result?.taskId == null && result?.interrupted !== true && !result?.stopReason ? 'not_dispatched' : 'terminated';
    }
    return 'resulted';
  }
  /** ADR 127 §5.1: dispatch-declared scopes are host-derived facts. Unresolvable targets stay undeclared. */
  function declaredScopes(context) {
    const scopes = context?.scopes;
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 16
      || scopes.some(scope => !scope || typeof scope !== 'object' || !['file', 'git_ref', 'remote_object'].includes(scope.kind)
        || (scope.kind === 'file' ? typeof scope.path !== 'string' || !path.isAbsolute(scope.path)
          : typeof scope.ref !== 'string' || !scope.ref))) return {};
    return { declaredScopes: scopes.map(scope => ({ ...scope })) };
  }
  return {
    beforeRequest(metadata) {
      change(budget => {
        const limits = budget.limits;
        if (budget.uncertainDispatches?.some(relevantOutcome) || Object.entries(budget.attempts).some(([id, row]) => relevantOutcome(row) && row.pendingTools?.length && (id === attemptId || !binding.activeAttempts.has(id)))) throw new Error('execution_outcome_unknown');
        const boundary = budgetBoundary(budget, limits, ['maxModelRequests', 'maxTokens', 'maxCostUsd']);
        if (boundary) limited(boundary);
        // A token/cost cap reserves the remaining measurable allowance for one attempt.
        // Other roles cannot concurrently read and spend that same allowance.
        if ((limits.maxTokens !== undefined || limits.maxCostUsd !== undefined)
          && Object.keys(budget.attempts).some(id => id !== attemptId)) limited(budgetReservationBoundary(budget));
        budget.modelRequests++;
        if (metadata?.accounting === 'physical_dispatch') physicalDispatchAccounting = true;
        budget.attempts[attemptId] = { ...budget.attempts[attemptId], role: profile.role, planId: profile.planId, sessionId: profile.sessionId,
          modelProviderId: profile.modelSelection?.modelProviderId, requests: ++requests };
      });
    },
    beforeTool(call = {}, context = null) { change(budget => {
      const boundary = budgetBoundary(budget, budget.limits, ['maxToolCalls']);
      if (boundary) limited(boundary);
      budget.toolCalls++;
      const toolCallId = call.toolCallId || call.id || null;
      const attempt = budget.attempts[attemptId] || { role: profile.role, planId: profile.planId, sessionId: profile.sessionId };
      const row = {
        toolCallId,
        capabilityId: call.capabilityId || call.name || call.tool || null,
        dispatchId: dispatchIdFor(toolCallId),
        registeredAt: binding.now(),
        ...(typeof context?.streamId === 'string' && context.streamId ? { streamId: context.streamId } : {}),
        ...(typeof context?.conversationId === 'string' && context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(verificationDispatchTarget(call) ? { verificationSessionId: verificationDispatchTarget(call) } : {}),
        ...declaredScopes(context),
      };
      budget.attempts[attemptId] = { ...attempt, pendingTools: [...(attempt.pendingTools || []), row] };
    }); },
    observeUsage(usage, fingerprint) {
      const observationKey = `${attemptId}:${usage?.requestIndex}:${usage?.requestPurpose}:${fingerprint}`;
      if (typeof store.observeUsage === 'function') {
        const added = store.observeUsage(profile.workId, observationKey, usage);
        if (added && Number.isFinite(usage?.totalTokens) && usage.totalTokens >= 0) observed++;
        return;
      }
      change(budget => {
        budget.observations ||= {};
        if (budget.observations[observationKey]) return;
        budget.observations[observationKey] = true;
        const tokens = usage?.totalTokens;
        if (Number.isFinite(tokens) && tokens >= 0) { budget.tokens += tokens; observed++; }
        else budget.unknownUsage = true;
        if (Number.isFinite(usage?.estimatedCostUsd)) budget.costUsd += usage.estimatedCostUsd;
        else budget.unknownCost = true;
      }, false);
    },
    checkpoint(native, executions) {
      change(budget => {
        const ref = store.checkpoint(`${profile.workId}:${attemptId}`, native);
        // A paired unknown result records the interruption, not the side effect's
        // outcome. Successful persistence cannot erase that uncertainty.
        const settled = new Map((executions || []).filter(execution => execution?.result
          && ![execution.terminalReason, execution.result.error].some(reason => /outcome_unknown$/.test(reason || '')))
          .map(execution => [execution?.call?.toolCallId, execution]).filter(([id]) => Boolean(id)));
        const prior = budget.attempts[attemptId] || {};
        const pendingTools = (prior.pendingTools || []).filter(call => !settled.has(call.toolCallId));
        // ADR 127 §5.1: the terminal state, its classification and the evidence refs are committed
        // in the same saveWork transaction as the pairing itself. A call this attempt never
        // registered has no receipt here; its own executor owns its record.
        const receipts = [...settled.entries()].flatMap(([toolCallId, execution]) => {
          const row = (prior.pendingTools || []).find(call => call.toolCallId === toolCallId);
          if (!row) return [];
          return [{ dispatchId: row.dispatchId, toolCallId, outcome: dispatchOutcome(execution),
            evidenceRefs: receiptEvidenceRefs(execution.result), settledAt: binding.now() }];
        });
        const settledTools = new Map([...(prior.settledTools || []), ...receipts].map(row => [row.dispatchId, row]));
        budget.attempts[attemptId] = { ...prior, role: profile.role, checkpointRef: ref, pendingTools, settledTools: [...settledTools.values()] };
        // Keep the parent checkpoint separate from every child's protected history.
        if (profile.role === 'project_agent') {
          return { nativeCheckpointRef: ref };
        }
      }, false);
    },
    finish(usage) {
      if (finished) return;
      finished = true; binding.activeAttempts.delete(attemptId);
      if (!requests) return;
      store.assertOwner();
      const work = readWork();
      if (!work) return;
      const budget = structuredClone(work.budget);
      // Unknown billable usage is retained explicitly, including after cancellation/failure.
      const tokens = usage?.totalTokens;
      if (!observed && Number.isFinite(tokens) && tokens >= 0) budget.tokens += tokens;
      else if (!observed) budget.unknownUsage = true;
      const cost = usage?.estimatedCostUsd;
      if (!observed && Number.isFinite(cost) && cost >= 0) budget.costUsd += cost;
      else if (!observed) budget.unknownCost = true;
      if (!physicalDispatchAccounting && Number.isFinite(usage?.providerRequestCount)) budget.modelRequests += Math.max(0, usage.providerRequestCount - requests);
      budget.lastUsage = { attemptId, role: profile.role, usage: usage || null };
      if (budget.attempts[attemptId]?.pendingTools?.length) budget.uncertainDispatches = [...(budget.uncertainDispatches || []),
        ...budget.attempts[attemptId].pendingTools.map(row => ({ ...row, attemptId, role: profile.role, planId: profile.planId, sessionId: profile.sessionId }))];
      // ADR 127 §5.1: settled receipts outlive the attempt so later reconciliation can tell an
      // answered dispatch from a lost one without replaying the call.
      const settledTools = budget.attempts[attemptId]?.settledTools;
      if (settledTools?.length) {
        const receipts = { ...(budget.dispatchReceipts || {}) };
        for (const row of settledTools) receipts[row.dispatchId] = row;
        budget.dispatchReceipts = receipts;
      }
      delete budget.attempts[attemptId];
      store.saveWork({ ...work, budget }, { returnState: false });
    },
  };
}
