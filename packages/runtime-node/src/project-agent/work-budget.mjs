import { randomUUID } from 'node:crypto';
import { executionBindingCurrent } from './coordination-kernel.mjs';

// Host registry contains local ports, never model supplied policy. Desktop and TUI share this seam.
const stores = new Map();
export const DEFAULT_WORK_BUDGET = Object.freeze({ maxModelRequests: 256, maxToolCalls: 2048, source: 'system:execution-continuity-v1' });
export function registerWorkBudget(workspaceId, store, policy = {}) {
  const limits = { ...DEFAULT_WORK_BUDGET };
  for (const key of ['maxModelRequests', 'maxToolCalls', 'maxTokens', 'maxCostUsd']) {
    if (Number.isFinite(policy[key]) && policy[key] >= 0) limits[key] = policy[key];
  }
  const binding = { store, limits, activeAttempts: new Set() };
  stores.set(workspaceId, binding);
  return () => { if (stores.get(workspaceId) === binding) stores.delete(workspaceId); };
}
export function workBudgetBinding(workspaceId) { return stores.get(workspaceId); }

/** A fresh manual recovery period never creates a fresh allowance. */
export function workBudgetCanResume(work, limits) {
  const budget = work?.budget, previous = budget?.limits;
  if (!budget || !previous || !limits) return false;
  const caps = [['maxModelRequests', 'modelRequests'], ['maxToolCalls', 'toolCalls'], ['maxTokens', 'tokens'], ['maxCostUsd', 'costUsd']];
  const increased = caps.some(([cap]) => Number.isFinite(previous[cap]) && Number.isFinite(limits[cap]) && limits[cap] > previous[cap]);
  return increased && caps.every(([cap, count]) => limits[cap] === undefined
    || Number.isFinite(budget[count]) && budget[count] >= 0 && budget[count] < limits[cap])
    && !(limits.maxTokens !== undefined && budget.unknownUsage)
    && !(limits.maxCostUsd !== undefined && budget.unknownCost);
}
export function createWorkBudgetGuard(profile) {
  if (!profile?.workId) return null;
  const binding = stores.get(profile.workspaceId);
  if (!binding) throw new Error('work_budget_host_unavailable');
  const { store, limits } = binding;
  const attemptId = randomUUID();
  binding.activeAttempts.add(attemptId);
  let requests = 0, finished = false, observed = 0, physicalDispatchAccounting = false;
  function change(update, requireActive = true) {
    store.assertOwner();
    const work = store.read().works[profile.workId];
    const stopped = work && ['paused', 'cancelled', 'budget_limited', 'blocked_system'].includes(work.state);
    const stopsExecutor = profile.role === 'project_agent' || work?.stopScope !== 'reply' || work?.state === 'budget_limited';
    if (!work || requireActive && stopped && stopsExecutor) throw new Error('work_execution_stopped');
    if (requireActive && profile.coordinationBinding) {
      const state = store.read(), mandate = state.mandates?.[profile.coordinationBinding.workId];
      const transition = Object.values(state.transitions || {}).find(row => row.executionEpoch === profile.coordinationBinding.executionEpoch);
      if (!executionBindingCurrent(mandate, transition, profile.coordinationBinding)) throw new Error('execution_revision_stale');
    }
    const budget = { modelRequests: 0, toolCalls: 0, tokens: 0, costUsd: 0, unknownUsage: false, unknownCost: false, attempts: {}, ...work.budget, limits };
    const patch = update(budget);
    store.saveWork({ ...work, ...patch, budget });
    return budget;
  }
  const relevantOutcome = row => !row.planId || row.planId === profile.planId;
  function limited() { throw new Error('work_budget_limited'); }
  return {
    beforeRequest(metadata) {
      change(budget => {
        if (budget.uncertainDispatches?.some(relevantOutcome) || Object.entries(budget.attempts).some(([id, row]) => relevantOutcome(row) && row.pendingTools?.length && (id === attemptId || !binding.activeAttempts.has(id)))) throw new Error('execution_outcome_unknown');
        if (budget.modelRequests >= limits.maxModelRequests) limited();
        if (limits.maxTokens !== undefined && (budget.unknownUsage || budget.tokens >= limits.maxTokens)) limited();
        if (limits.maxCostUsd !== undefined && (budget.unknownCost || budget.costUsd >= limits.maxCostUsd)) limited();
        // A token/cost cap reserves the remaining measurable allowance for one attempt.
        // Other roles cannot concurrently read and spend that same allowance.
        if ((limits.maxTokens !== undefined || limits.maxCostUsd !== undefined)
          && Object.keys(budget.attempts).some(id => id !== attemptId)) limited();
        budget.modelRequests++;
        if (metadata?.accounting === 'physical_dispatch') physicalDispatchAccounting = true;
        budget.attempts[attemptId] = { ...budget.attempts[attemptId], role: profile.role, planId: profile.planId, sessionId: profile.sessionId,
          modelProviderId: profile.modelSelection?.modelProviderId, requests: ++requests };
      });
    },
    beforeTool(call = {}) { change(budget => {
      if (budget.toolCalls >= limits.maxToolCalls) limited();
      budget.toolCalls++;
      const attempt = budget.attempts[attemptId] || { role: profile.role, planId: profile.planId, sessionId: profile.sessionId };
      budget.attempts[attemptId] = { ...attempt, pendingTools: [...(attempt.pendingTools || []),
        { toolCallId: call.toolCallId || call.id || null, capabilityId: call.capabilityId || call.name || call.tool || null }] };
    }); },
    observeUsage(usage, fingerprint) {
      change(budget => {
        budget.observations ||= {};
        const observationKey = `${attemptId}:${usage?.requestIndex}:${usage?.requestPurpose}:${fingerprint}`;
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
        const work = store.read().works[profile.workId];
        const ref = store.checkpoint(`${profile.workId}:${attemptId}`, native);
        // A paired unknown result records the interruption, not the side effect's
        // outcome. Successful persistence cannot erase that uncertainty.
        const settled = new Set((executions || []).filter(execution => execution?.result
          && ![execution.terminalReason, execution.result.error].some(reason => /outcome_unknown$/.test(reason || '')))
          .map(execution => execution.call?.toolCallId).filter(Boolean));
        const pendingTools = (budget.attempts[attemptId]?.pendingTools || []).filter(call => !settled.has(call.toolCallId));
        budget.attempts[attemptId] = { ...budget.attempts[attemptId], role: profile.role, checkpointRef: ref, pendingTools };
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
      const work = store.read().works[profile.workId];
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
      delete budget.attempts[attemptId];
      store.saveWork({ ...work, budget });
    },
  };
}
