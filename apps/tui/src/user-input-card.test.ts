import { describe, expect, test } from 'bun:test';

import {
  extractUserInputRequest,
  moveUserInputSelection,
  toUserInputOptions,
  userInputDecisionForKey,
} from './user-input-card.ts';
import type { ToolPresentation } from './tool-result-summary.ts';

function tool(partial: Partial<ToolPresentation> & Pick<ToolPresentation, 'capabilityId'>): ToolPresentation {
  return {
    capabilityId: partial.capabilityId,
    toolName: partial.toolName ?? 'Ask user',
    argumentSummary: partial.argumentSummary ?? '',
    status: partial.status ?? 'completed',
    detail: partial.detail ?? '',
    detailLines: partial.detailLines ?? [],
    toolCallId: partial.toolCallId,
    arguments: partial.arguments,
  };
}

describe('user-input card', () => {
  test('extracts question and options from request_user_input tool arguments', () => {
    const request = extractUserInputRequest(tool({
      capabilityId: 'local.interaction.request_user_input',
      arguments: {
        question: 'Which path?',
        options: ['Ship it', 'Keep drafting', 'Cancel'],
      },
    }));
    expect(request).toEqual({
      question: 'Which path?',
      options: ['Ship it', 'Keep drafting', 'Cancel'],
      note: null,
    });
  });

  test('returns null for non-interaction tools', () => {
    expect(extractUserInputRequest(tool({
      capabilityId: 'local.bash',
      arguments: { question: 'nope', options: ['a'] },
    }))).toBeNull();
  });

  test('supports free-input only requests (no options)', () => {
    const request = extractUserInputRequest(tool({
      capabilityId: 'request_user_input',
      arguments: { question: 'Type anything' },
    }));
    expect(request).toEqual({
      question: 'Type anything',
      options: [],
      note: null,
    });
  });

  test('recovers options from detail lines when arguments are missing', () => {
    const request = extractUserInputRequest(tool({
      capabilityId: 'local.interaction.request_user_input',
      argumentSummary: 'Pick one',
      detailLines: [
        'Pick one',
        'Options:',
        '  1. Alpha',
        '  2. Beta',
        'Reply with a number or free text.',
      ],
    }));
    expect(request?.question).toBe('Pick one');
    expect(request?.options).toEqual(['Alpha', 'Beta']);
  });

  test('maps ↑↓ style selection and digit/enter keys', () => {
    const options = ['A', 'B', 'C'];
    expect(moveUserInputSelection(0, -1, options.length)).toBe(2);
    expect(moveUserInputSelection(2, 1, options.length)).toBe(0);
    expect(userInputDecisionForKey('2', 0, options)).toBe('B');
    expect(userInputDecisionForKey('enter', 2, options)).toBe('C');
    expect(userInputDecisionForKey('return', 0, options)).toBe('A');
    expect(userInputDecisionForKey('x', 0, options)).toBeNull();
    expect(userInputDecisionForKey('enter', 0, [])).toBeNull();
  });

  test('toUserInputOptions assigns 1-based shortcuts', () => {
    expect(toUserInputOptions(['One', 'Two'])).toEqual([
      { label: 'One', shortcut: '1', color: expect.any(String) },
      { label: 'Two', shortcut: '2', color: expect.any(String) },
    ]);
  });
});
