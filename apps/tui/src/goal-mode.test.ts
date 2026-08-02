import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { createTuiGoalRunner } from './goal-mode.ts';
import { createTuiSharedGoalRunner } from './goal-runner-adapter.ts';

const source = readFileSync(new URL('./goal-mode.ts', import.meta.url), 'utf8');

describe('legacy TUI Goal entrypoint', () => {
  test('aliases the canonical shared GoalPlan runner', () => {
    expect(createTuiGoalRunner).toBe(createTuiSharedGoalRunner);
  });

  test('does not create a second RuntimeGoalController state machine', () => {
    expect(source).toContain("from './goal-runner-adapter.ts'");
    expect(source).not.toContain("from '@peer-agent/runtime-sdk'");
    expect(source).not.toContain('createRuntimeGoalController');
  });
});
