import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = (name: string) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
test('touched project controls use locale keys, custom controls and SVG icons', () => {
  for (const name of ['project-agent/BotList.tsx','project-agent/drawer/BotProfileDrawer.tsx','project-agent/conversation/UserBubble.tsx','app/components/QuickChatWindow.tsx','app/components/GeneralPanel.tsx','workbench/BackgroundRuntimePanel.tsx']) {
    assert.doesNotMatch(source(name), /isZh\s*\?/, name);
  }
  assert.doesNotMatch(source('app/components/QuickChatWindow.tsx'), /<select\b/);
  assert.doesNotMatch(source('app/components/GeneralPanel.tsx'), /type="(?:checkbox|time)"/);
  for (const name of ['project-agent/conversation/QuoteChip.tsx','workbench/BackgroundRuntimePanel.tsx']) {
    assert.doesNotMatch(source(name), /[‹×]/); assert.match(source(name), /PeerIcon/);
  }
});
