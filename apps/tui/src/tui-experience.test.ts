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
  TUI_COMMANDS,
} from './tui-experience.ts';

describe('TUI experience model', () => {
  test('uses the conversation composer as the only default surface', () => {
    expect(createTuiExperienceState()).toEqual({
      mode: 'chat',
      footer: { type: 'composer' },
    });
  });

  test('puts modes and common actions behind one discoverable command list', () => {
    expect(TUI_COMMANDS.map((command) => command.id)).toEqual([
      'model',
      'mode-chat',
      'mode-plan',
      'mode-goal',
      'mode-explorer',
      'new',
      'goal-pause',
      'goal-resume',
      'goal-cancel',
      'help',
      'quit',
    ]);
    expect(filterTuiCommands('read only').map((command) => command.id)).toEqual([
      'mode-plan',
      'mode-explorer',
    ]);
    expect(filterTuiCommands('provider').map((command) => command.id)).toEqual(['model']);
    expect(filterTuiCommands('hold').map((command) => command.id)).toEqual(['goal-pause']);
    expect(filterTuiCommands('continue').map((command) => command.id)).toEqual(['goal-resume']);
    expect(filterTuiCommands('abort').map((command) => command.id)).toEqual(['goal-cancel']);
  });

  test('keeps the composer compact and grows it only up to six rows', () => {
    expect(composerRows('', 80)).toBe(1);
    expect(composerRows('hello', 80)).toBe(1);
    expect(composerRows('a'.repeat(200), 40)).toBe(6);
    expect(composerRows('one\ntwo\nthree', 80)).toBe(3);
  });

  test('opens commands immediately only for slash at the start of an empty composer', () => {
    expect(shouldOpenCommandPanel('/')).toBe(true);
    expect(shouldOpenCommandPanel('', '/')).toBe(true);
    expect(shouldOpenCommandPanel('/', '/')).toBe(true);
    expect(shouldOpenCommandPanel('hello', '/')).toBe(false);
    expect(shouldOpenCommandPanel('hello/')).toBe(false);
    expect(shouldOpenCommandPanel('//')).toBe(false);
  });

  test('opens and escapes the command panel without changing the active mode', () => {
    const state = createTuiExperienceState('goal');
    const opened = openCommandPanel(state, 'mod');
    expect(opened).toEqual({
      mode: 'goal',
      footer: { type: 'command', query: 'mod', selectedIndex: 0 },
    });
    expect(escapeFooter(opened)).toEqual(state);
  });

  test('gives permission the highest footer priority', () => {
    const permission = showPermission(openCommandPanel(createTuiExperienceState()));
    expect(permission.footer.type).toBe('permission');
    expect(openCommandPanel(permission).footer.type).toBe('permission');
    expect(showPlanApproval(permission).footer.type).toBe('permission');
  });

  test('applies mode commands and returns to the composer', () => {
    const command = TUI_COMMANDS.find((item) => item.id === 'mode-explorer')!;
    const state = showPlanApproval(createTuiExperienceState('plan'));
    expect(applyTuiCommand(state, command)).toEqual({
      mode: 'explorer',
      footer: { type: 'composer' },
    });
  });
});
