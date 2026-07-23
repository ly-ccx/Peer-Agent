import { describe, expect, test } from 'bun:test';

import {
  displayableGoalPlans,
  selectPreferredGoalPlanId,
} from './goal-plan-history.ts';

function plan(overrides: Record<string, unknown>) {
  return {
    planId: String(overrides.planId),
    title: String(overrides.title ?? overrides.planId),
    status: 'completed',
    updatedAt: '2026-07-23T00:00:00.000Z',
    tasks: [],
    ...overrides,
  };
}

describe('TUI Goal plan history', () => {
  test('matches Desktop display rules after plans have been hydrated', () => {
    const details = new Map([
      ['intake', plan({
        planId: 'intake',
        title: '1+2',
        activation: { kind: 'intake' },
        updatedAt: '2026-07-23T03:00:00.000Z',
      })],
      ['cancelled', plan({
        planId: 'cancelled',
        status: 'cancelled',
        updatedAt: '2026-07-23T04:00:00.000Z',
      })],
      ['older', plan({
        planId: 'older',
        title: 'Older formal goal',
        updatedAt: '2026-07-23T01:00:00.000Z',
      })],
      ['latest', plan({
        planId: 'latest',
        title: 'Latest formal goal',
        updatedAt: '2026-07-23T02:00:00.000Z',
      })],
    ]);
    expect(
      displayableGoalPlans([...details.values()]).map((item) => item.planId),
    ).toEqual(['latest', 'older']);
  });

  test('prefers active work, preserves an explicit history selection, then falls back to newest', () => {
    const plans = [
      plan({ planId: 'latest-completed', updatedAt: '2026-07-23T03:00:00.000Z' }),
      plan({ planId: 'accepted', status: 'accepted', updatedAt: '2026-07-23T02:00:00.000Z' }),
      plan({ planId: 'executing', status: 'executing', updatedAt: '2026-07-23T01:00:00.000Z' }),
    ];

    expect(selectPreferredGoalPlanId(plans, null)).toBe('executing');
    expect(selectPreferredGoalPlanId(plans, 'latest-completed')).toBe('latest-completed');
    expect(selectPreferredGoalPlanId([plans[0]], 'missing')).toBe('latest-completed');
    expect(selectPreferredGoalPlanId([], 'missing')).toBeNull();
  });

  test('does not revive terminal history from a stale runner overlay', () => {
    const plans = [
      plan({
        planId: 'latest-completed',
        status: 'completed',
        runner: { status: 'running' },
        updatedAt: '2026-07-23T03:00:00.000Z',
      }),
      plan({
        planId: 'older-completed',
        status: 'completed',
        updatedAt: '2026-07-23T02:00:00.000Z',
      }),
    ];

    expect(selectPreferredGoalPlanId(plans, null)).toBe('latest-completed');
  });
});
