import { describe, expect, test } from 'bun:test';

import {
  createComposerSurface,
  dismissTuiSurface,
  moveTuiSurfaceSelection,
  requestTuiSurface,
} from './surface-state.ts';

describe('TUI surface state', () => {
  test('keeps exactly one surface and enforces decision priority', () => {
    const picker = requestTuiSurface(createComposerSurface(), {
      type: 'picker', picker: 'model', query: '', selectedIndex: 0,
    });
    const plan = requestTuiSurface(picker, { type: 'plan-approval', selectedIndex: 0 });
    const userInput = requestTuiSurface(picker, { type: 'user-input', selectedIndex: 0 });
    const ignoredPicker = requestTuiSurface(plan, {
      type: 'picker', picker: 'mode', query: '', selectedIndex: 0,
    });
    const tool = requestTuiSurface(plan, { type: 'tool-approval', selectedIndex: 0 });
    const toolBlocksUserInput = requestTuiSurface(tool, { type: 'user-input', selectedIndex: 0 });

    expect(picker.type).toBe('picker');
    expect(userInput.type).toBe('user-input');
    expect(ignoredPicker.type).toBe('plan-approval');
    expect(tool.type).toBe('tool-approval');
    expect(toolBlocksUserInput.type).toBe('tool-approval');
  });

  test('does not dismiss approval or destructive decisions with a generic escape', () => {
    expect(dismissTuiSurface({ type: 'picker', picker: 'command', query: '', selectedIndex: 0 })).toEqual({ type: 'composer' });
    expect(dismissTuiSurface({ type: 'tool-approval', selectedIndex: 1 })).toEqual({ type: 'tool-approval', selectedIndex: 1 });
    expect(dismissTuiSurface({ type: 'destructive-confirmation', actionId: 'goal-cancel', selectedIndex: 0 })).toEqual({ type: 'destructive-confirmation', actionId: 'goal-cancel', selectedIndex: 0 });
    expect(dismissTuiSurface({ type: 'user-input', selectedIndex: 0 })).toEqual({ type: 'composer' });
  });

  test('wraps selection only on selectable surfaces', () => {
    expect(moveTuiSurfaceSelection({ type: 'picker', picker: 'model', query: '', selectedIndex: 0 }, -1, 3)).toMatchObject({ selectedIndex: 2 });
    expect(moveTuiSurfaceSelection({ type: 'user-input', selectedIndex: 0 }, 1, 3)).toMatchObject({ selectedIndex: 1 });
    expect(moveTuiSurfaceSelection(createComposerSurface(), 1, 3)).toEqual({ type: 'composer' });
  });
});
