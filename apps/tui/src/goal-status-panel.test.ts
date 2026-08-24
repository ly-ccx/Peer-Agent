import { describe, expect, test } from 'bun:test';

import {
  goalCompactSummaryView,
  goalStatusFromSharedPlan,
  goalStatusLayout,
  goalTaskGlyph,
} from './goal-status-panel.ts';

describe('Goal status panel interface', () => {
  test('selects a side-by-side right status area on wide terminals', () => {
    expect(goalStatusLayout(120)).toEqual({ mode: 'side-panel', panelWidth: 36 });
    expect(goalStatusLayout(119)).toEqual({ mode: 'compact-summary', panelWidth: 0 });
  });

  test('projects plan state into user-facing progress and current work', () => {
    const view = goalStatusFromSharedPlan({
      title: 'Ship Goal UI',
      status: 'executing',
      tasks: [
        { taskId: 'one', title: 'Map flow', status: 'completed' },
        { taskId: 'two', title: 'Render status', status: 'running' },
      ],
    });
    expect(view?.title).toBe('Ship Goal UI');
    expect(view?.completed).toBe(1);
    expect(view?.currentTask?.title).toBe('Render status');
    expect(goalTaskGlyph('running')).toBe('▶');
    expect(goalCompactSummaryView(view!)).toMatchObject({
      glyph: '▶',
      tone: 'accent',
      title: 'Render status',
      progressCount: '1/2',
      missionLabel: undefined,
    });
  });
});
