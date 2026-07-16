import { describe, expect, test } from 'bun:test';

import { executeTuiCommand } from './command-execution.ts';
import { createTuiExperienceState, syncSlashSuggestions, TUI_COMMANDS } from './tui-experience.ts';

const quit = TUI_COMMANDS.find((command) => command.id === 'quit')!;

function harness() {
  let state = createTuiExperienceState('chat');
  let quitCount = 0;
  const handlers = {
    clearChat: () => true,
    controlGoal: () => 'unused',
    quit: () => { quitCount += 1; },
    setNotice: () => {},
    updateExperience: (update: (current: typeof state) => typeof state) => { state = update(state); },
  };
  return {
    handlers,
    get state() { return state; },
    get quitCount() { return quitCount; },
    setState(next: typeof state) { state = next; },
  };
}

describe('TUI command execution', () => {
  test('executes /quit selected from slash suggestions', () => {
    const subject = harness();
    subject.setState(syncSlashSuggestions(subject.state, '/quit'));

    executeTuiCommand(quit, subject.handlers);

    expect(subject.quitCount).toBe(1);
  });

  test('executes quit selected from the Commands panel through the same dispatcher', () => {
    const subject = harness();

    executeTuiCommand(quit, subject.handlers);

    expect(subject.quitCount).toBe(1);
  });
});
