import { describe, expect, test } from 'bun:test';

import {
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
  });

  test('shows goal controls only when they can execute', () => {
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).toContain('goal-pause');
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).not.toContain('goal-resume');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).toContain('goal-resume');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).not.toContain('goal-pause');
  });
});
