import { describe, expect, test } from 'bun:test';

import {
  COLOR,
  PICKER_CHROME,
  TOOL_CHROME,
  contextUsageColor,
  toolStatusColor,
} from './tui-theme.ts';

describe('TUI theme tokens', () => {
  test('exposes a stable professional palette', () => {
    expect(COLOR.background).toBe('#0a0a0a');
    expect(COLOR.accent).toBe('#a3e635');
    expect(COLOR.tool).toBe('#86efac');
    expect(COLOR.danger).toBe('#fb7185');
  });

  test('picker chrome reuses theme colors for selection', () => {
    expect(PICKER_CHROME.selectedBackground).toBe(COLOR.selection);
    expect(PICKER_CHROME.selectedForeground).toBe(COLOR.accent);
    expect(PICKER_CHROME.caretSelected).toBe('› ');
    expect(PICKER_CHROME.checkCurrent).toBe(' ✓');
  });

  test('tool chrome maps status to layered glyphs and colors', () => {
    expect(TOOL_CHROME.branchFirst).toBe('  ╰ ');
    expect(TOOL_CHROME.glyphCompleted).toBe('●');
    expect(TOOL_CHROME.glyphFailed).toBe('●');
    expect(TOOL_CHROME.glyphRunning).toBe('●');
    expect(toolStatusColor('completed')).toBe(COLOR.tool);
    expect(toolStatusColor('failed')).toBe(COLOR.toolFailed);
    expect(toolStatusColor('running')).toBe(COLOR.toolRunning);
  });

  test('context usage escalates color near capacity', () => {
    expect(contextUsageColor(10)).toBe(COLOR.muted);
    expect(contextUsageColor(85)).toBe(COLOR.warning);
    expect(contextUsageColor(95)).toBe(COLOR.danger);
    expect(contextUsageColor(undefined, COLOR.textSoft)).toBe(COLOR.textSoft);
  });
});

  test('running tool glyph is enlarged', () => {
    expect(TOOL_CHROME.glyphRunning).toBe('●');
  });
