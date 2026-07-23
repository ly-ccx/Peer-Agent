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
  showUserInput,
  selectionWindow,
  slashCommandWindow,
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
      'model', 'mode', 'permissions', 'language', 'theme', 'skill', 'mcp', 'new', 'clear', 'compact',
      'history-earlier', 'history-later', 'history-latest', 'resume', 'goals', 'help', 'quit',
    ]);
    expect(TUI_COMMANDS.map((command) => command.id)).not.toContain('mode-explorer');
    expect(filterTuiCommands('provider').map((command) => command.id)).toEqual(['model']);
    expect(filterTuiCommands('hold', { goalStatus: 'running' }).map((command) => command.id)).toEqual(['goal-pause']);
    expect(filterTuiCommands('continue', { goalStatus: 'paused' }).map((command) => command.id)).toEqual(['resume', 'goal-resume']);
  });

  test('keeps slash command windows bounded around the selected item', () => {
    const commands = filterTuiCommands('');
    expect(slashCommandWindow(commands, 0, 3).map(({ command }) => command.id)).toEqual([
      'model', 'mode', 'permissions',
    ]);
    expect(slashCommandWindow(commands, 3, 3).map(({ command, index }) => [command.id, index])).toEqual([
      ['permissions', 2], ['language', 3], ['theme', 4],
    ]);
    expect(slashCommandWindow(commands, commands.length - 1, 2).map(({ command }) => command.id)).toEqual([
      'help', 'quit',
    ]);
  });

  test('keeps generic selection windows centered on the selected item', () => {
    const rows = Array.from({ length: 12 }, (_, index) => `row-${index}`);
    expect(selectionWindow(rows, 0, 4).map(({ item, index }) => [item, index])).toEqual([
      ['row-0', 0], ['row-1', 1], ['row-2', 2], ['row-3', 3],
    ]);
    expect(selectionWindow(rows, 8, 4).map(({ item, index }) => [item, index])).toEqual([
      ['row-6', 6], ['row-7', 7], ['row-8', 8], ['row-9', 9],
    ]);
    expect(selectionWindow(rows, 11, 4).map(({ item }) => item)).toEqual([
      'row-8', 'row-9', 'row-10', 'row-11',
    ]);
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

  test('does not open slash suggestions for dragged absolute file paths', () => {
    const state = createTuiExperienceState();
    expect(syncSlashSuggestions(state, '/Users/liangyin/Downloads/Peer-Agent-产品定义与自我进化机制-PRD-v0.2.md').surface)
      .toEqual({ type: 'composer' });
    expect(syncSlashSuggestions(state, '/var/folders/24/otty-paste/image.png').surface)
      .toEqual({ type: 'composer' });
    expect(syncSlashSuggestions(state, '/tmp/a.md').surface)
      .toEqual({ type: 'composer' });

    const suggestions = syncSlashSuggestions(state, '/mod');
    expect(syncSlashSuggestions(suggestions, '/Users/liangyin/Downloads/spec.md').surface)
      .toEqual({ type: 'composer' });
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
    expect(showUserInput(permission).surface.type).toBe('tool-approval');
  });

  test('opens user-input surface for Ask user option selection', () => {
    const next = showUserInput(createTuiExperienceState());
    expect(next.surface).toEqual({ type: 'user-input', selectedIndex: 0 });
  });

  test('routes registry actions to dedicated pickers', () => {
    const state = createTuiExperienceState();
    const model = TUI_COMMANDS.find((item) => item.id === 'model')!;
    const mode = TUI_COMMANDS.find((item) => item.id === 'mode')!;
    expect(applyTuiCommand(state, model).surface).toMatchObject({ type: 'picker', picker: 'model' });
    expect(applyTuiCommand(state, mode).surface).toMatchObject({ type: 'picker', picker: 'mode' });
    const resume = TUI_COMMANDS.find((item) => item.id === 'resume')!;
    expect(applyTuiCommand(state, resume).surface).toMatchObject({ type: 'picker', picker: 'resume' });
    const goals = TUI_COMMANDS.find((item) => item.id === 'goals')!;
    expect(applyTuiCommand(state, goals).surface).toMatchObject({ type: 'picker', picker: 'goal' });
    const help = TUI_COMMANDS.find((item) => item.id === 'help')!;
    expect(applyTuiCommand(state, help).surface).toMatchObject({ type: 'picker', picker: 'help' });
    const language = TUI_COMMANDS.find((item) => item.id === 'language')!;
    expect(applyTuiCommand(state, language).surface).toMatchObject({ type: 'picker', picker: 'language' });
  });
});
