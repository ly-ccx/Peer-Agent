import { describe, expect, test } from 'bun:test';

import {
  animatedToolStatusGlyph,
  composerRunningStatusLine,
  createToolPresentation,
  formatToolResultSummary,
  formatInteractionToolDetail,
  isGoalStatusToolPresentation,
  toolArgumentSummary,
  parseLegacyToolContent,
  resolveToolPresentation,
  runningToolStatusGlyph,
  thinkingSpinnerGlyph,
  thinkingStatusLabel,
  toggleToolDetails,
  toolDisplayName,
  toolHeadline,
  toolResultInlineSummary,
  toolStatusGlyph,
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

  test('presents tools with Qoder-like hierarchy: name, args, status glyph, nested detail', () => {
    const presentation = createToolPresentation({
      capabilityId: 'local.shell.exec',
      arguments: { command: 'git status --short' },
      status: 'completed',
      outputPreview: ' M apps/tui/src/app.tsx\n?? apps/tui/src/tool-result-summary.ts\n',
    });

    expect(toolDisplayName('local.shell.exec')).toBe('Bash');
    expect(toolHeadline(presentation.toolName, presentation.argumentSummary))
      .toBe('Bash(git status --short)');
    expect(toolStatusGlyph(presentation.status)).toBe('●');
    expect(presentation.detailLines[0]).toContain('M apps/tui/src/app.tsx');

    const failed = createToolPresentation({
      capabilityId: 'local.file.read',
      arguments: { path: '/tmp/missing.txt' },
      status: 'failed',
      errorMessage: 'ENOENT: no such file',
    });
    expect(toolHeadline(failed.toolName, failed.argumentSummary))
      .toBe('Read(/tmp/missing.txt)');
    expect(toolStatusGlyph(failed.status)).toBe('●');
    expect(failed.detail).toContain('ENOENT');
  });

  test('recovers hierarchical presentation from legacy flat tool content', () => {
    const legacy = parseLegacyToolContent(
      'local.file.read: {"path":"apps/tui/src/app.tsx","bytes":120}',
    );
    expect(legacy.toolName).toBe('Read');
    expect(legacy.capabilityId).toBe('local.file.read');

    const resolved = resolveToolPresentation({
      content: 'local.shell.exec: exit 0',
      tool: null,
    });
    expect(resolved.toolName).toBe('Bash');
  });

  test('thinking status label uses a trailing three-dot animation without a leading spinner', () => {
    expect(thinkingSpinnerGlyph(0)).toBe('|');
    expect(thinkingSpinnerGlyph(1)).toBe('/');
    expect(thinkingSpinnerGlyph(2)).toBe('-');
    expect(thinkingSpinnerGlyph(3)).toBe('\\');
    expect(thinkingSpinnerGlyph(4)).toBe('|');
    // Braille spinners sit high vs CJK/Latin text; keep composer spinner non-Braille.
    expect(thinkingSpinnerGlyph(0)).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(thinkingStatusLabel(0, false)).toBe('Thinking.');
    expect(thinkingStatusLabel(1, false)).toBe('Thinking..');
    expect(thinkingStatusLabel(2, true)).toBe('Thinking...');
    expect(thinkingStatusLabel(3, true)).toBe('Thinking.');
    expect(thinkingStatusLabel(0, false)).not.toMatch(/^[|/\-\\]/);
  });

  test('composer running status line pairs spinner with status label', () => {
    expect(composerRunningStatusLine({
      frame: 0,
      statusLabel: 'Working…',
    })).toBe('| Working…');
    expect(composerRunningStatusLine({
      frame: 1,
      statusLabel: '运行中…',
    })).toBe('/ 运行中…');
    expect(composerRunningStatusLine({
      frame: 2,
      statusLabel: 'Cancelling…',
    })).toBe('- Cancelling…');
  });

  test('running tool glyph is larger and breathes across frames', () => {
    expect(toolStatusGlyph('running')).toBe('●');
    expect(runningToolStatusGlyph(0)).toBe('●');
    expect(runningToolStatusGlyph(1)).toBe('◉');
    expect(runningToolStatusGlyph(2)).toBe('○');
    expect(animatedToolStatusGlyph('running', 1)).toBe('◉');
    expect(animatedToolStatusGlyph('completed', 1)).toBe(toolStatusGlyph('completed'));
  });

  test('formats request_user_input as selectable prompt', () => {
    const detail = formatInteractionToolDetail({
      ok: true,
      acknowledged: true,
      question: 'Pick a plan?',
      options: ['A', 'B'],
      note: 'Waiting for you.',
    });
    expect(detail).toContain('Pick a plan?');
    expect(detail).toContain('1. A');
    expect(detail).toContain('2. B');
    expect(detail).toContain('Reply with a number');
    expect(formatToolResultSummary({
      ok: true,
      acknowledged: true,
      question: 'Pick a plan?',
      options: ['A', 'B'],
    })).toContain('1. A');
  });

  test('formats request_user_input free-input when options empty', () => {
    const detail = formatInteractionToolDetail({
      ok: true,
      acknowledged: true,
      question: 'What is the target?',
      options: [],
    });
    expect(detail).toContain('What is the target?');
    expect(detail).toContain('Type your answer');
  });

  test('toolArgumentSummary uses question for request_user_input', () => {
    expect(toolArgumentSummary('local.interaction.request_user_input', {
      question: 'Choose branch strategy?',
      options: ['1', '2'],
    })).toContain('Choose branch strategy?');
  });

  test('identifies ordinary Goal tools for chat noise reduction', () => {
    expect(isGoalStatusToolPresentation(createToolPresentation({
      capabilityId: 'local.goal.update',
      status: 'completed',
      outputPreview: { ok: true, taskId: 'internal-task-id' },
    }))).toBe(true);
    expect(isGoalStatusToolPresentation(createToolPresentation({
      capabilityId: 'local.interaction.request_user_input',
      status: 'completed',
      outputPreview: { question: 'Continue?' },
    }))).toBe(false);
  });

});
