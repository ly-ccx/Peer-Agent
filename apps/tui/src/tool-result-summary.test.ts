import { describe, expect, test } from 'bun:test';

import {
  animatedToolStatusGlyph,
  composerRunningStatusLine,
  createToolPresentation,
  formatRunningElapsed,
  formatToolDuration,
  runningActivityField,
  scrambleStatusLabel,
  formatToolResultSummary,
  formatInteractionToolDetail,
  isGoalStatusToolPresentation,
  toolActivitySummary,
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
    expect(toolDisplayName('bash')).toBe('Bash');
    expect(toolDisplayName('read_file')).toBe('Read');
    expect(toolHeadline(presentation.toolName, presentation.argumentSummary))
      .toBe('Bash(git status --short)');
    expect(toolStatusGlyph(presentation.status)).toBe('✓');
    expect(presentation.detailLines[0]).toContain('M apps/tui/src/app.tsx');

    const failed = createToolPresentation({
      capabilityId: 'local.file.read',
      arguments: { path: '/tmp/missing.txt' },
      status: 'failed',
      errorMessage: 'ENOENT: no such file',
    });
    expect(toolHeadline(failed.toolName, failed.argumentSummary))
      .toBe('Read(/tmp/missing.txt)');
    expect(toolStatusGlyph(failed.status)).toBe('✗');
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

  test('keeps Bash collapsed activity to one command line even for multiline JSON output', () => {
    const command = 'for i in {1..20}; do\n  echo "poll $i"\ndone';
    const presentation = resolveToolPresentation({
      content: '',
      tool: {
        capabilityId: 'local.shell.exec',
        toolName: 'Bash',
        argumentSummary: '',
        arguments: { command },
        status: 'completed',
        detail: JSON.stringify({ command, stdout: 'poll 1\npoll 2', exitCode: 0 }, null, 2),
        detailLines: [],
        startedAt: 1_000,
        completedAt: 1_250,
      },
    });

    const summary = toolActivitySummary(presentation);
    expect(summary).toBe('for i in {1..20}; do echo "poll $i" done');
    expect(summary).not.toContain('\n');
    expect(summary).not.toStartWith('{');
    expect(presentation.durationMs).toBe(250);
  });

  test('recovers the command from legacy Bash result JSON when arguments are missing', () => {
    const command = 'printf "one\\ntwo"';
    const presentation = resolveToolPresentation({
      content: '',
      tool: {
        capabilityId: 'local.shell.exec',
        toolName: 'Bash',
        argumentSummary: '',
        status: 'completed',
        detail: JSON.stringify({ command, stdout: 'one\ntwo', exitCode: 0 }, null, 2),
        detailLines: [],
      },
    });

    expect(toolActivitySummary(presentation)).toBe('printf "one\\ntwo"');
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

  test('composer running status uses a continuous character field and elapsed time', () => {
    expect(runningActivityField(0, 80)).toHaveLength(12);
    expect(runningActivityField(1, 80)).not.toBe(runningActivityField(0, 80));
    expect(formatRunningElapsed(999)).toBe('0s');
    expect(formatRunningElapsed(65_000)).toBe('1:05');
    // Generic running: activity field + timer only (no static "Working…" label).
    expect(composerRunningStatusLine({
      frame: 0,
      statusLabel: '',
      elapsedMs: 8_000,
      width: 80,
    })).toMatch(/^.{12} · 8s$/);
    // Exceptional states keep a stable semantic label.
    expect(composerRunningStatusLine({
      frame: 0,
      statusLabel: 'Cancelling…',
      elapsedMs: 8_000,
      width: 80,
    })).toMatch(/^.{12}  Cancelling… · 8s$/);
  });

  test('composer running status degrades cleanly at compact and narrow widths', () => {
    expect(runningActivityField(0, 40)).toHaveLength(8);
    expect(runningActivityField(0, 20)).toHaveLength(4);
    expect(composerRunningStatusLine({
      frame: 2,
      statusLabel: 'Cancelling…',
      elapsedMs: 12_000,
      width: 20,
    })).toMatch(/^.{4} · 12s$/);
  });

  test('uses Crush glyphs: ✓ completed and animated ◇ running', () => {
    expect(toolStatusGlyph('completed')).toBe('✓');
    expect(toolStatusGlyph('running')).toBe('◇');
    expect(runningToolStatusGlyph(0)).toBe('◇');
    expect(runningToolStatusGlyph(1)).toBe('◆');
    expect(runningToolStatusGlyph(2)).toBe('◇');
    expect(animatedToolStatusGlyph('running', 1)).toBe('◆');
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

  test('records and formats real tool timing', () => {
    const completed = createToolPresentation({
      capabilityId: 'local.file.read',
      status: 'completed',
      outputPreview: 'ok',
      startedAt: 1_000,
      completedAt: 1_145,
    });
    expect(completed.durationMs).toBe(145);
    expect(formatToolDuration(completed)).toBe('0.1s');
    expect(formatToolDuration({ status: 'running' })).toBe('now');
  });

  test('scrambles briefly and then settles on the running label', () => {
    expect(scrambleStatusLabel('Running…', 0)).not.toBe('Running…');
    expect(scrambleStatusLabel('Running…', 6)).toBe('Running…');
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
