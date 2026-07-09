import type { HookDecision } from './contracts.ts';
import { mostRestrictiveDecision } from './decision.ts';

export interface HookDecisionSource {
  readonly decision?: HookDecision | null;
}

export function mostRestrictiveHookDecision(
  records: readonly (HookDecisionSource | null | undefined)[] = [],
): HookDecision {
  return mostRestrictiveDecision(records.map((record) => record?.decision));
}
