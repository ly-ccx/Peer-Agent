import { describe, expect, test } from 'bun:test';

import {
  formatToolResultSummary,
  toggleToolDetails,
  toolResultInlineSummary,
} from './tool-result-summary.ts';

describe('tool result summary', () => {
  test('renders object results as stable readable JSON', () => {
    expect(formatToolResultSummary({ z: 2, result: { ok: true }, a: 1 })).toBe(
      '{\n  "a": 1,\n  "result": {\n    "ok": true\n  },\n  "z": 2\n}',
    );
    expect(formatToolResultSummary({ ok: true })).not.toContain('[object Object]');
  });

  test('preserves strings and bounds long output', () => {
    expect(formatToolResultSummary('done')).toBe('done');
    expect(formatToolResultSummary('abcdef', 'completed', 4)).toBe('abc…');
    expect(formatToolResultSummary(undefined, 'completed')).toBe('completed');
  });

  test('handles circular values without throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(formatToolResultSummary(value)).toContain('[Circular]');
  });

  test('collapses tool details to one short line by default', () => {
    expect(toolResultInlineSummary('{\n  "ok": true,\n  "value": 1\n}')).toBe(
      '{ "ok": true, "value": 1 }',
    );
    expect(toolResultInlineSummary('abcdef', 5)).toBe('abcd…');
    expect(toolResultInlineSummary('   ')).toBe('completed');
  });

  test('toggles detail expansion explicitly', () => {
    expect(toggleToolDetails(false)).toBe(true);
    expect(toggleToolDetails(true)).toBe(false);
  });
});
