import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

const settingsFiles = [
  'LlmSettingsPanel.tsx',
  'ModelCatalogDialog.tsx',
  'ModelSettingsDialog.tsx',
  'McpSettingsPanel.tsx',
] as const;

const remainingFiles = [
  '../../chat/components/thread/ChatFindBar.tsx',
  '../../chat/components/thread/ImagePreviewBar.tsx',
  '../../chat/components/ChatSurface.tsx',
  '../../chat/components/EditProjectDialog.tsx',
  '../../capabilities/components/CapabilityWorkbench.tsx',
  '../../capabilities/components/SkillUploadDialog.tsx',
  '../../capabilities/components/CapabilityDetailPanel.tsx',
  '../../settings/UsageStatsPanel.tsx',
  '../../workbench/views/FilesView.tsx',
  'FallbackComposer.tsx',
  'QuickChatPopover.tsx',
  'QuickChatTaskCard.tsx',
  '../pages/TaskOverviewPage.tsx',
] as const;

const decorativeGlyph = /[＋✕←‹›↑↓]/;

test('LLM settings back / plus / close controls use PeerIcon instead of character glyphs', async () => {
  const panel = await read('LlmSettingsPanel.tsx');

  assert.match(panel, /<PeerIcon name="back"/);
  assert.match(panel, /<PeerIcon name="plus"/);
  assert.match(panel, /<PeerIcon name="close"/);
  assert.match(panel, /<svg/);
  assert.equal(panel.includes('← 返回'), false);
  assert.equal(panel.includes('← Back'), false);
  assert.equal(panel.includes('＋'), false);
  assert.equal(panel.includes('✕'), false);
});

test('settings dialogs and remaining decorative icon buttons do not use character glyphs', async () => {
  const sources = await Promise.all([
    ...settingsFiles.map((path) => read(path)),
    ...remainingFiles.map((path) => read(path)),
  ]);

  for (const [index, source] of sources.entries()) {
    const path = index < settingsFiles.length ? settingsFiles[index] : remainingFiles[index - settingsFiles.length];
    assert.equal(decorativeGlyph.test(source), false, `${path} still contains a decorative character icon`);
    assert.match(source, /<PeerIcon /, `${path} should use PeerIcon`);
  }
});

test('shared PeerIcon is a currentColor stroke SVG', async () => {
  const icon = await readFile(new URL('../../ui/icons/PeerIcon.tsx', import.meta.url), 'utf8');
  assert.match(icon, /<svg/);
  assert.match(icon, /stroke="currentColor"/);
  assert.match(icon, /\| 'back'/);
  assert.match(icon, /\| 'plus'/);
  assert.match(icon, /\| 'close'/);
  assert.match(icon, /back: \(/);
  assert.match(icon, /plus: <path/);
  assert.match(icon, /close: \(/);
});
