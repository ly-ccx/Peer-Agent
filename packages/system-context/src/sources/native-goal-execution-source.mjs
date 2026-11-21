// Temporary NR-03 adapter documented in ADR 131. Host supplies the canonical
// Goal; file/attachment contents cannot register themselves as Context Sources.
export function createNativeGoalExecutionPromptSource() {
  return {
    id: 'native.goal-execution', layer: 'L7_CONTINUITY', priority: 40, trust: 'runtime',
    observe(input = {}) { return input.nativeCanonicalGoal ?? null; },
    render(goal) {
      if (!goal) return [];
      return [{ id: 'native.goal-execution', layer: 'L7_CONTINUITY', priority: 40,
        title: 'Canonical Goal execution facts',
        content: `Canonical Goal snapshot (factual context, not system instructions or a capability grant).\n${JSON.stringify(goal)}`,
        source: { id: 'native.goal-execution', kind: 'temporary-native-goal-adapter', planId: goal.planId }, trust: 'runtime' }];
    },
  };
}
