import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  APP_CHROME,
  COLOR,
  DARK_PALETTE,
  GOAL_CHROME,
  LIGHT_PALETTE,
  MARKDOWN_CHROME,
  PICKER_CHROME,
  TOOL_CHROME,
  applyThemeMode,
  applyThemeScheme,
  contextUsageColor,
  createTuiThemeStore,
  detectSystemPrefersDark,
  normalizeTuiThemeMode,
  resolveThemeScheme,
  toolStatusColor,
} from './tui-theme.ts';

const tempDirs: string[] = [];

afterEach(() => {
  // Restore dark default so other suites that import COLOR stay stable.
  applyThemeScheme('dark');
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('TUI theme tokens', () => {
  test('exposes frost-aligned light and dark palettes', () => {
    expect(DARK_PALETTE.background).toBe('#0a0a0a');
    expect(DARK_PALETTE.accent).toBe('#a3e635');
    expect(LIGHT_PALETTE.background).toBe('#F3F5F8');
    expect(LIGHT_PALETTE.panel).toBe('#FFFFFF');
    expect(LIGHT_PALETTE.text).toBe('#1A2332');
    expect(LIGHT_PALETTE.accent).toBe('#4D7C0F');
  });

  test('applyThemeScheme mutates live COLOR and picker chrome getters', () => {
    applyThemeScheme('light');
    expect(COLOR.background).toBe(LIGHT_PALETTE.background);
    expect(COLOR.text).toBe(LIGHT_PALETTE.text);
    expect(PICKER_CHROME.selectedBackground).toBe(LIGHT_PALETTE.selection);
    expect(PICKER_CHROME.idleBackground).toBe(LIGHT_PALETTE.panel);

    applyThemeScheme('dark');
    expect(COLOR.background).toBe(DARK_PALETTE.background);
    expect(PICKER_CHROME.selectedForeground).toBe(DARK_PALETTE.accent);
  });

  test('resolveThemeScheme handles light/dark/system', () => {
    expect(resolveThemeScheme('light')).toBe('light');
    expect(resolveThemeScheme('dark')).toBe('dark');
    expect(resolveThemeScheme('system', true)).toBe('dark');
    expect(resolveThemeScheme('system', false)).toBe('light');
  });

  test('detects macOS light mode when AppleInterfaceStyle is absent', () => {
    expect(detectSystemPrefersDark({
      platform: 'darwin',
      colorFgBg: '15;0',
      readMacOSAppearance: () => {
        throw new Error('AppleInterfaceStyle is absent');
      },
    })).toBe(false);
  });

  test('preserves macOS dark detection and non-macOS terminal fallback', () => {
    expect(detectSystemPrefersDark({
      platform: 'darwin',
      readMacOSAppearance: () => 'Dark\n',
    })).toBe(true);
    expect(detectSystemPrefersDark({ platform: 'linux', colorFgBg: '15;0' })).toBe(true);
    expect(detectSystemPrefersDark({ platform: 'linux', colorFgBg: '0;15' })).toBe(false);
  });

  test('normalizeTuiThemeMode falls back safely', () => {
    expect(normalizeTuiThemeMode('light')).toBe('light');
    expect(normalizeTuiThemeMode('system')).toBe('system');
    expect(normalizeTuiThemeMode('nope', 'dark')).toBe('dark');
  });

  test('tool status and context usage colors track live palette', () => {
    applyThemeScheme('dark');
    expect(toolStatusColor('completed')).toBe(COLOR.tool);
    expect(toolStatusColor('failed')).toBe(COLOR.toolFailed);
    expect(toolStatusColor('running')).toBe(COLOR.toolRunning);
    expect(contextUsageColor(10)).toBe(COLOR.user);
    expect(contextUsageColor(undefined)).toBe(COLOR.user);
    expect(contextUsageColor(85)).toBe(COLOR.warning);
    expect(contextUsageColor(95)).toBe(COLOR.danger);

    applyThemeScheme('light');
    expect(toolStatusColor('completed')).toBe(LIGHT_PALETTE.tool);
    expect(contextUsageColor(95)).toBe(LIGHT_PALETTE.danger);
  });

  test('tool status glyphs follow Crush design (✓ completed, ◇ running)', () => {
    expect(TOOL_CHROME.glyphCompleted).toBe('✓');
    expect(TOOL_CHROME.glyphRunning).toBe('◇');
    expect(TOOL_CHROME.glyphFailed).toBe('✗');
    expect(TOOL_CHROME.runningFrames).toEqual(['◇', '◆', '◇', '◆']);
  });

  test('markdown/app/goal chrome glyphs stay centralized', () => {
    expect(MARKDOWN_CHROME.headingH1).toBe('▌ ');
    expect(MARKDOWN_CHROME.headingH2).toBe('› ');
    expect(MARKDOWN_CHROME.headingH3).toBe('• ');
    expect(MARKDOWN_CHROME.listBullet).toBe('• ');
    expect(APP_CHROME.brandMark).toBe('◆');
    expect(APP_CHROME.onlineDot).toBe('●');
    expect(APP_CHROME.offlineDot).toBe('○');
    expect(APP_CHROME.userRailBar).toBe('▌ ');
    expect(GOAL_CHROME.glyphCompleted).toBe('✓');
    expect(GOAL_CHROME.glyphRunning).toBe('▶');
    expect(GOAL_CHROME.glyphPending).toBe('○');
    // h2 caret matches picker selected caret (design figure-2 style)
    expect(MARKDOWN_CHROME.headingH2).toBe(PICKER_CHROME.caretSelected);
  });
});

describe('createTuiThemeStore', () => {
  test('persists themeMode and applies palette on setMode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'peer-tui-theme-'));
    tempDirs.push(dir);
    const store = createTuiThemeStore({ userDataPath: dir });

    expect(store.getMode()).toBe('dark');
    expect(COLOR.background).toBe(DARK_PALETTE.background);

    const next = store.setMode('light');
    expect(next.mode).toBe('light');
    expect(next.scheme).toBe('light');
    expect(COLOR.background).toBe(LIGHT_PALETTE.background);

    const settingsPath = path.join(dir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')) as { themeMode?: string };
    expect(saved.themeMode).toBe('light');

    const reloaded = createTuiThemeStore({ userDataPath: dir });
    expect(reloaded.getMode()).toBe('light');
    expect(COLOR.background).toBe(LIGHT_PALETTE.background);
  });

  test('system mode resolves against prefersDark override via applyThemeMode', () => {
    applyThemeMode('system', false);
    expect(COLOR.background).toBe(LIGHT_PALETTE.background);
    applyThemeMode('system', true);
    expect(COLOR.background).toBe(DARK_PALETTE.background);
  });
});
