import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function source(relativePath: string): string {
  return readFileSync(path.join(rendererSrc, relativePath), 'utf8');
}

function lineCount(relativePath: string): number {
  const text = source(relativePath);
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

test('关闭抽屉时把焦点还给触发按钮', () => {
  const drawer = source('project-agent/drawer/BotProfileDrawer.tsx');
  assert.match(drawer, /triggerRef\.current\?\.focus\(/);
  assert.match(drawer, /Escape/);
  assert.match(drawer, /from '\.\.\/\.\.\/app\/components\/Drawer'/);
});

test('记忆页动作和回复芯片都经记忆 IPC', () => {
  const page = source('project-agent/drawer/MemoryTab.tsx');
  const calls = [...page.matchAll(/clientApi\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(calls)].sort(), [
    'projectMemoryEdit',
    'projectMemoryExport',
    'projectMemoryForget',
    'projectMemoryList',
    'projectMemoryPin',
    'projectMemoryRestore',
    'projectMemorySetSwitches',
  ]);
  assert.equal(page.includes('localStorage'), false);
  assert.equal(page.includes('child_process'), false);
  const bubble = source('project-agent/conversation/ReplyBubble.tsx');
  assert.match(bubble, /projectMemoryList/);
  assert.match(bubble, /aria-expanded/);
  assert.equal(bubble.includes('<span>{i18n.t(\'projectAgent.chat.memoryUsed\''), false);
});

test('设置项只经 IPC 写入', () => {
  const settings = source('project-agent/drawer/BotSettingsTab.tsx');
  const calls = [...settings.matchAll(/clientApi\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['projectAgentDelete', 'projectAgentUpdateProfile']);
  assert.equal(settings.includes('localStorage'), false);
  assert.equal(settings.includes('child_process'), false);
  assert.equal(settings.includes('modelRoutingUpdate'), false);
});

test('ChatSurface 行数不变', () => {
  assert.equal(lineCount('chat/components/ChatSurface.tsx'), 3306);
});
