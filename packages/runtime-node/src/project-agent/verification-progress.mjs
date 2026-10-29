import { progressFacts } from './continuation-policy.mjs';

export const VERIFICATION_IDLE_MS = 10 * 60_000;

/** Counts factual observations, never dispatches, Evidence identities or heartbeats. */
export function observeVerification(state, result, at) {
  const seen = new Set(state.observationFacts || []);
  const facts = progressFacts([{ toolCalls: [{ name: 'verification_observation', result }] }]);
  const fresh = facts.filter(fact => !seen.has(fact));
  if (!fresh.length) return null;
  return { observationFacts: [...seen, ...fresh], observationCount: (state.observationCount || 0) + fresh.length,
    lastProgressAt: at };
}

export function verificationProgressFromPlan(plan) {
  const value = plan?.runner?.verificationContinuation;
  if (!value?.continuationId || !Number.isFinite(Date.parse(value.startedAt))
    || !Number.isFinite(Date.parse(value.lastProgressAt))) return null;
  return { continuationId: value.continuationId, startedAt: value.startedAt,
    lastProgressAt: value.lastProgressAt, observationCount: value.observationCount || 0, phase: value.phase };
}
