import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('shared portal menus own their styles before any model settings page is visited', () => {
  assert.match(read('./Dropdown.tsx'), /import '\.\/dropdown\.css'/);
  const css = read('./dropdown.css');
  assert.match(css, /\.pa-dropdown-menu\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /z-index:\s*var\(--z-dropdown-portal/);
  assert.match(css, /prefers-reduced-transparency/);
  assert.doesNotMatch(read('../../styles/llm-settings.css'), /\.pa-dropdown-menu\s*\{/);
  assert.match(read('./OverflowMenu.tsx'), /import '\.\/overflow-menu\.css'/);
});

test('MCP remains styled when mounted directly inside capabilities', () => {
  assert.match(read('./McpSettingsPanel.tsx'), /import '\.\/mcp-settings\.css'/);
  assert.match(read('./McpSettingsPanel.tsx'), /import '\.\/settings-controls\.css'/);
  assert.match(read('./mcp-settings.css'), /\.mcp-settings-layout/);
  assert.doesNotMatch(read('../../styles/settings-page.css'), /\.mcp-settings-layout/);
  for (const component of ['SettingsPage', 'AppshotsPanel']) assert.match(read(`./${component}.tsx`), /import '\.\/settings-controls\.css'/);
});
