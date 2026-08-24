import { describe, expect, test } from 'bun:test';

import {
  goalCompactSummaryView,
  goalProgressTrack,
  goalStatusFromSharedPlan,
  goalStatusLayout,
  goalStatusTone,
  goalTaskGlyph,
} from './goal-status-model.ts';

describe('Goal status view model', () => {
  test('uses a right status panel only on wide terminals', () => {
    expect(goalStatusLayout(160)).toEqual({ mode: 'side-panel', panelWidth: 42 });
    expect(goalStatusLayout(120)).toEqual({ mode: 'side-panel', panelWidth: 36 });
    expect(goalStatusLayout(119)).toEqual({ mode: 'compact-summary', panelWidth: 0 });
    expect(goalStatusLayout(60)).toEqual({ mode: 'compact-summary', panelWidth: 0 });
  });

  test('normalizes shared plans without exposing storage or protocol ids', () => {
    expect(goalStatusFromSharedPlan({
      planId: 'internal-plan-id',
      title: 'Implement Goal status panel',
      status: 'executing',
      progress: { total: 3, completed: 1, percent: 33 },
      tasks: [
        { taskId: 'one', title: 'Inspect flow', status: 'completed' },
        { taskId: 'two', title: 'Render panel', status: 'running', result: 'Editing app.tsx' },
        { taskId: 'three', title: 'Verify', status: 'pending' },
      ],
    })).toEqual({
      title: 'Implement Goal status panel',
      status: 'executing',
      completed: 1,
      total: 3,
      percent: 33,
      currentTask: { id: 'two', title: 'Render panel', status: 'running', detail: 'Editing app.tsx' },
      tasks: [
        { id: 'one', title: 'Inspect flow', status: 'completed', detail: undefined },
        { id: 'two', title: 'Render panel', status: 'running', detail: 'Editing app.tsx' },
        { id: 'three', title: 'Verify', status: 'pending', detail: undefined },
      ],
      blockedReason: undefined,
    });
  });

  test('surfaces blockers and stable task glyphs', () => {
    const view = goalStatusFromSharedPlan({
      goal: 'Ship safely',
      tasks: [{ title: 'Await permission', status: 'waiting_user', blockedReason: 'Approval required' }],
    });
    expect(view?.blockedReason).toBe('Approval required');
    expect(goalTaskGlyph('completed')).toBe('✓');
    expect(goalTaskGlyph('running')).toBe('▶');
    expect(goalTaskGlyph('executing')).toBe('▶');
    expect(goalTaskGlyph('waiting_user')).toBe('!');
    expect(goalTaskGlyph('pending')).toBe('○');
  });

  test('projects a Now Playing compact summary without dump labels', () => {
    const view = goalStatusFromSharedPlan({
      title: 'Implement Goal status panel',
      status: 'executing',
      progress: { total: 4, completed: 1, percent: 25 },
      tasks: [
        { taskId: 'one', title: 'Inspect flow', status: 'completed' },
        { taskId: 'two', title: 'Render panel', status: 'running' },
        { taskId: 'three', title: 'Verify', status: 'pending' },
        { taskId: 'four', title: 'Ship', status: 'pending' },
      ],
    });
    expect(view).not.toBeNull();
    expect(goalCompactSummaryView(view!)).toEqual({
      glyph: '▶',
      tone: 'accent',
      title: 'Render panel',
      progressTrack: '━───',
      progressCount: '1/4',
      missionLabel: undefined,
    });
    expect(goalCompactSummaryView(view!, { missionPosition: 2, totalPlans: 3 }).missionLabel).toBe('2/3');
    expect(goalProgressTrack(25)).toBe('━───');
    expect(goalProgressTrack(0, 4)).toBe('────');
    expect(goalProgressTrack(100, 4)).toBe('━━━━');
    expect(goalStatusTone('executing')).toBe('accent');
    expect(goalStatusTone('completed')).toBe('success');
    expect(goalStatusTone('waiting_user')).toBe('danger');
  });
});
