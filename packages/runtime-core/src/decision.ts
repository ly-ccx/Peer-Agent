import type { RuntimeDecision } from './contracts.ts';

const DECISION_RANK: Readonly<Record<RuntimeDecision, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export function compareRuntimeDecision(a: RuntimeDecision, b: RuntimeDecision): number {
  return DECISION_RANK[a] - DECISION_RANK[b];
}

export function mostRestrictiveDecision(
  decisions: readonly (RuntimeDecision | null | undefined)[],
): RuntimeDecision {
  let finalDecision: RuntimeDecision = 'allow';
  for (const decision of decisions) {
    if (!decision) {
      continue;
    }
    if (DECISION_RANK[decision] > DECISION_RANK[finalDecision]) {
      finalDecision = decision;
    }
  }
  return finalDecision;
}

export function isDecisionAtLeast(
  decision: RuntimeDecision,
  minimum: RuntimeDecision,
): boolean {
  return DECISION_RANK[decision] >= DECISION_RANK[minimum];
}
