import { describe, expect, test } from 'bun:test';

import { executeTuiCommand } from './command-execution.ts';
import { createTuiExperienceState, syncSlashSuggestions, TUI_COMMANDS } from './tui-experience.ts';

const quit = TUI_COMMANDS.find((command) => command.id === 'quit')!;
const compact = TUI_COMMANDS.find((command) => command.id === 'compact')!;

function harness() {
  let state = createTuiExperienceState('chat');
  let quitCount = 0;
  let compactCount = 0;
  const notices: Array<string | null> = [];
  const handlers = {
    clearChat: () => true,
    compactContext: () => {
      compactCount += 1;
      return 'Compacted model context 20 → 9 messages (summarized 12)';
    },
    controlGoal: () => 'unused',
    quit: () => { quitCount += 1; },
    setNotice: (notice: string | null) => { notices.push(notice); },
    updateExperience: (update: (current: typeof state) => typeof state) => { state = update(state); },
  };
  return {
    handlers,
    get state() { return state; },
    get quitCount() { return quitCount; },
    get compactCount() { return compactCount; },
    get notices() { return notices; },
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

  test('executes /compact through the shared dispatcher and surfaces notice', () => {
    const subject = harness();

    executeTuiCommand(compact, subject.handlers);

    expect(subject.compactCount).toBe(1);
    expect(subject.notices.at(-1)).toContain('Compacted model context');
  });
});
