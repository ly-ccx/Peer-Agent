import { describe, expect, test } from 'bun:test';

import {
  buildTuiHelpSections,
  filterTuiCommandRegistry,
  TUI_COMMAND_REGISTRY,
  visibleTuiCommands,
} from './command-registry.ts';

const idle = { goalStatus: 'none' } as const;

describe('TUI command registry', () => {
  test('exposes only real P0 actions and keeps Explorer internal', () => {
    expect(visibleTuiCommands(idle).map((command) => command.id)).toEqual([
      'model',
      'mode',
      'permissions',
      'clear',
      'compact',
      'resume',
      'help',
      'quit',
    ]);
    expect(TUI_COMMAND_REGISTRY.some((command) => command.id.includes('explorer'))).toBe(false);
    expect(TUI_COMMAND_REGISTRY.some((command) => command.id === 'new')).toBe(false);
  });

  test('uses the same searchable registry for slash and command palette entry', () => {
    expect(filterTuiCommandRegistry('provider effort', idle).map((command) => command.id)).toEqual(['model']);
    expect(filterTuiCommandRegistry('ask approval', idle).map((command) => command.id)).toEqual(['permissions']);
    expect(filterTuiCommandRegistry('plan', idle).map((command) => command.id)).toEqual(['mode']);
    expect(filterTuiCommandRegistry('compress context', idle).map((command) => command.id)).toEqual(['compact']);
  });

  test('shows goal controls only when they can execute', () => {
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).toContain('goal-pause');
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).not.toContain('goal-resume');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).toContain('goal-resume');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).not.toContain('goal-pause');
  });

  test('builds a non-empty help panel with commands and modes', () => {
    const sections = buildTuiHelpSections(idle);
    expect(sections.map((section) => section.title)).toEqual([
      'Keyboard',
      'Slash commands',
      'Modes',
      'Tips',
    ]);
    const slash = sections.find((section) => section.title === 'Slash commands')!;
    expect(slash.lines.some((line) => line.startsWith('/help'))).toBe(true);
    expect(slash.lines.some((line) => line.startsWith('/mode'))).toBe(true);
    const modes = sections.find((section) => section.title === 'Modes')!;
    expect(modes.lines.some((line) => line.startsWith('Agent'))).toBe(true);
  });
});
