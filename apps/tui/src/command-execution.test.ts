import { describe, expect, test } from 'bun:test';

import { executeTuiCommand } from './command-execution.ts';
import { createTuiExperienceState, syncSlashSuggestions, TUI_COMMANDS } from './tui-experience.ts';

const quit = TUI_COMMANDS.find((command) => command.id === 'quit')!;
const compact = TUI_COMMANDS.find((command) => command.id === 'compact')!;
const history = TUI_COMMANDS.find((command) => command.id === 'history')!;
const skill = TUI_COMMANDS.find((command) => command.id === 'skill')!;
const mcp = TUI_COMMANDS.find((command) => command.id === 'mcp')!;
const newSession = TUI_COMMANDS.find((command) => command.id === 'new')!;
const version = TUI_COMMANDS.find((command) => command.id === 'version')!;

function harness() {
  let state = createTuiExperienceState('chat');
  let quitCount = 0;
  let compactCount = 0;
  const historyDirections: string[] = [];
  const notices: Array<string | null> = [];
  let clearCount = 0;
  let newSessionCount = 0;
  const handlers = {
    clearChat: () => {
      clearCount += 1;
      return true;
    },
    startNewSession: () => {
      newSessionCount += 1;
      return true;
    },
    compactContext: () => {
      compactCount += 1;
      return 'Compacted model context 20 → 9 messages (summarized 12)';
    },
    navigateHistory: (direction: 'earlier' | 'later' | 'latest') => {
      historyDirections.push(direction);
      return `History: ${direction}`;
    },
    controlGoal: () => 'unused',
    quit: () => { quitCount += 1; },
    showVersion: () => 'peer 0.0.2-test',
    setNotice: (notice: string | null) => { notices.push(notice); },
    updateExperience: (update: (current: typeof state) => typeof state) => { state = update(state); },
  };
  return {
    handlers,
    get state() { return state; },
    get quitCount() { return quitCount; },
    get compactCount() { return compactCount; },
    get clearCount() { return clearCount; },
    get newSessionCount() { return newSessionCount; },
    get historyDirections() { return historyDirections; },
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

  test('opens Skill and MCP management pickers through the shared dispatcher', () => {
    const subject = harness();
    executeTuiCommand(skill, subject.handlers);
    expect(subject.state.surface).toMatchObject({ type: 'picker', picker: 'skill' });
    executeTuiCommand(mcp, subject.handlers);
    expect(subject.state.surface).toMatchObject({ type: 'picker', picker: 'mcp' });
  });

  test('executes /compact through the shared dispatcher and surfaces notice', () => {
    const subject = harness();

    executeTuiCommand(compact, subject.handlers);

    expect(subject.compactCount).toBe(1);
    expect(subject.notices.at(-1)).toContain('Compacted model context');
  });

  test('executes history navigation through the shared dispatcher', () => {
    const subject = harness();

    executeTuiCommand(history, subject.handlers);

    expect(subject.historyDirections).toEqual(['earlier']);
    expect(subject.notices.at(-1)).toBe('History: earlier');
  });

  test('executes /new through the shared dispatcher and surfaces notice', () => {
    const subject = harness();

    executeTuiCommand(newSession, subject.handlers);

    expect(subject.newSessionCount).toBe(1);
    expect(subject.notices.at(-1)).toBe('New task');
    expect(subject.state.surface).toEqual({ type: 'composer' });
  });

  test('executes /version through the shared dispatcher and surfaces the version notice', () => {
    const subject = harness();

    executeTuiCommand(version, subject.handlers);

    expect(subject.notices.at(-1)).toBe('peer 0.0.2-test');
    expect(subject.state.surface).toEqual({ type: 'composer' });
  });
});
