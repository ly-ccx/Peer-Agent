import type { EffortLevel } from '../../state/preferences';

const EFFORT_ORDER: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh', 'max'];

/**
 * Locate a persisted effort in the model's current level list.
 * Capability data can change while a conversation still holds xhigh/max; in that case use the
 * semantically nearest level (preferring the stronger level on a tie) instead of falling back to off.
 */
export function effortIndexForLevel(effort: EffortLevel, levels: readonly EffortLevel[]): number {
  const exactIndex = levels.indexOf(effort);
  if (exactIndex >= 0 || levels.length <= 1) return Math.max(0, exactIndex);

  const effortRank = EFFORT_ORDER.indexOf(effort);
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  levels.forEach((level, index) => {
    const distance = Math.abs(EFFORT_ORDER.indexOf(level) - effortRank);
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export function snapEffortValue(value: number, levelCount: number): number {
  if (levelCount <= 1) return 0;
  const step = 100 / (levelCount - 1);
  return Math.round(value / step) * step;
}

export function effortIndexFromValue(value: number, levelCount: number): number {
  if (levelCount <= 1) return 0;
  return Math.min(levelCount - 1, Math.round((value / 100) * (levelCount - 1)));
}

/** Keep the persisted effort authoritative except while the user is actively previewing a drag. */
export function effortLevelForDisplay(
  effort: EffortLevel,
  levels: readonly EffortLevel[],
  sliderValue: number,
  previewing: boolean,
): EffortLevel {
  if (!previewing) return effort;
  return levels[effortIndexFromValue(sliderValue, levels.length)] ?? effort;
}
