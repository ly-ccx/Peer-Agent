import type { GoalSuccessCriterion } from '@peer-agent/protocol';

export function cloneSuccessCriteria(
  criteria: readonly GoalSuccessCriterion[] | null | undefined,
): GoalSuccessCriterion[] {
  return (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
}

export function replaceCriterionDescription(
  criteria: readonly GoalSuccessCriterion[],
  id: string,
  description: string,
): GoalSuccessCriterion[] {
  return criteria.map((criterion) => (
    criterion.id === id ? { ...criterion, description } : criterion
  ));
}

export function addManualCriterion(criteria: readonly GoalSuccessCriterion[]): GoalSuccessCriterion[] {
  const id = `criterion-${globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${criteria.length}`}`;
  return [...criteria, { id, kind: 'manual', description: '' }];
}

export function removeCriterion(
  criteria: readonly GoalSuccessCriterion[],
  id: string,
): GoalSuccessCriterion[] {
  return criteria.filter((criterion) => criterion.id !== id);
}

export function sanitizeSuccessCriteriaDraft(
  criteria: readonly GoalSuccessCriterion[],
): GoalSuccessCriterion[] {
  return criteria
    .map((criterion) => ({
      ...criterion,
      description: criterion.description.trim(),
    }))
    .filter((criterion) => criterion.description.length > 0);
}

export function successCriteriaDraftEquals(
  left: readonly GoalSuccessCriterion[],
  right: readonly GoalSuccessCriterion[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((criterion, index) => {
    const other = right[index];
    return Boolean(
      other
      && criterion.id === other.id
      && criterion.kind === other.kind
      && criterion.description === other.description
      && (criterion.command ?? '') === (other.command ?? '')
      && (criterion.path ?? '') === (other.path ?? '')
      && (criterion.expect ?? '') === (other.expect ?? ''),
    );
  });
}
