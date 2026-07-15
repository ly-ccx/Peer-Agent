import { describe, expect, test } from 'bun:test';

import {
  applyTuiCommand,
  composerRows,
  createTuiExperienceState,
  escapeFooter,
  filterTuiCommands,
  openCommandPanel,
  showPermission,
  showPlanApproval,
  shouldOpenCommandPanel,
  syncSlashSuggestions,
  TUI_COMMANDS,
  updateCommandPanelQuery,
} from './tui-experience.ts';

describe('TUI experience model', () => {
  test('uses the conversation composer as the only default surface', () => {
    expect(createTuiExperienceState()).toEqual({
      mode: 'chat',
      surface: { type: 'composer' },
    });
  });

  test('derives commands from the shared registry and keeps Explorer internal', () => {
    expect(filterTuiCommands('').map((command) => command.id)).toEqual([
      'model', 'mode', 'permissions', 'help', 'quit',
    ]);
    expect(TUI_COMMANDS.map((command) => command.id)).not.toContain('mode-explorer');
    expect(filterTuiCommands('provider').map((command) => command.id)).toEqual(['model']);
    expect(filterTuiCommands('hold', { goalStatus: 'running' }).map((command) => command.id)).toEqual(['goal-pause']);
    expect(filterTuiCommands('continue', { goalStatus: 'paused' }).map((command) => command.id)).toEqual(['goal-resume']);
  });

  test('opens the command picker only for slash at the input root', () => {
    expect(shouldOpenCommandPanel('', '/')).toBe(true);
    expect(shouldOpenCommandPanel('/', '/')).toBe(true);
    expect(shouldOpenCommandPanel('hello', '/')).toBe(false);
    expect(shouldOpenCommandPanel('/model')).toBe(false);
  });

  test('sizes multiline composer content within a bounded height', () => {
    expect(composerRows('', 80)).toBe(1);
    expect(composerRows('a'.repeat(150), 80)).toBe(3);
    expect(composerRows(Array.from({ length: 12 }, () => 'x').join('\n'), 80)).toBe(6);
  });

  test('opens and dismisses the command picker without changing mode', () => {
    const state = createTuiExperienceState('goal');
    expect(openCommandPanel(state, 'mod')).toEqual({
      mode: 'goal',
      surface: { type: 'picker', picker: 'command', query: 'mod', selectedIndex: 0 },
    });
    expect(escapeFooter(openCommandPanel(state))).toEqual(state);
  });

  test('tracks slash suggestions from composer text and dismisses them for normal prose', () => {
    const state = createTuiExperienceState();
    const suggestions = syncSlashSuggestions(state, '/mod');
    expect(suggestions.surface).toEqual({ type: 'slash-suggestions', query: 'mod', selectedIndex: 0 });
    expect(syncSlashSuggestions(suggestions, 'hello').surface).toEqual({ type: 'composer' });
    expect(syncSlashSuggestions(state, '/model now').surface).toEqual({ type: 'composer' });
  });

  test('updates command palette search independently from slash suggestions', () => {
    const panel = openCommandPanel(createTuiExperienceState());
    expect(updateCommandPanelQuery(panel, 'perm').surface).toEqual({
      type: 'picker', picker: 'command', query: 'perm', selectedIndex: 0,
    });
    expect(updateCommandPanelQuery(createTuiExperienceState(), 'perm')).toEqual(createTuiExperienceState());
  });

  test('keeps decision surfaces above command pickers', () => {
    const permission = showPermission(openCommandPanel(createTuiExperienceState()));
    expect(permission.surface.type).toBe('tool-approval');
    expect(openCommandPanel(permission).surface.type).toBe('tool-approval');
    expect(showPlanApproval(permission).surface.type).toBe('tool-approval');
  });

  test('routes registry actions to dedicated pickers', () => {
    const state = createTuiExperienceState();
    const model = TUI_COMMANDS.find((item) => item.id === 'model')!;
    const mode = TUI_COMMANDS.find((item) => item.id === 'mode')!;
    expect(applyTuiCommand(state, model).surface).toMatchObject({ type: 'picker', picker: 'model' });
    expect(applyTuiCommand(state, mode).surface).toMatchObject({ type: 'picker', picker: 'mode' });
  });
});
