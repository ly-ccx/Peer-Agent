import { describe, expect, test } from 'bun:test';

import {
  animatedToolStatusGlyph,
  createToolPresentation,
  formatToolResultSummary,
  parseLegacyToolContent,
  resolveToolPresentation,
  runningToolStatusGlyph,
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

  test('thinking status label uses a leading cursor spinner', () => {
    expect(thinkingStatusLabel(0, false)).toBe('⠋ Thinking esc to cancel');
    expect(thinkingStatusLabel(1, false)).toBe('⠙ Thinking esc to cancel');
    expect(thinkingStatusLabel(2, true)).toBe('⠹ Thinking');
    expect(thinkingStatusLabel(3, true)).toBe('⠸ Thinking');
  });

  test('running tool glyph is larger and breathes across frames', () => {
    expect(toolStatusGlyph('running')).toBe('●');
    expect(runningToolStatusGlyph(0)).toBe('●');
    expect(runningToolStatusGlyph(1)).toBe('◉');
    expect(runningToolStatusGlyph(2)).toBe('○');
    expect(animatedToolStatusGlyph('running', 1)).toBe('◉');
    expect(animatedToolStatusGlyph('completed', 1)).toBe(toolStatusGlyph('completed'));
  });
});
