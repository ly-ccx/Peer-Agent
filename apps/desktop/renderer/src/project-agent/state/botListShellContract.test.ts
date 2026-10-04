import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';

const appUrl = new URL('../../App.tsx', import.meta.url);
const sidebarUrl = new URL('../../chat/components/Sidebar.tsx', import.meta.url);
const menuUrl = new URL('../AppMenu.tsx', import.meta.url);

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const pieces = text.split('\n');
  return text.endsWith('\n') ? pieces.length - 1 : pieces.length;
}

const LIST_KEYS = [
  'projectAgent.list.brand',
  'projectAgent.list.newBot',
  'projectAgent.list.searchPlaceholder',
  'projectAgent.list.needsYou',
  'projectAgent.list.empty',
  'projectAgent.list.emptyNeedsYou',
  'projectAgent.list.needsYouBadge',
  'projectAgent.list.nameInvalid',
  'projectAgent.list.bindFolder',
  'projectAgent.list.blankBot',
  'projectAgent.list.history',
] as const;

test('开关关闭时 App 仍走原来的主布局，机器人壳只在打开时出现', () => {
  const app = readFileSync(appUrl, 'utf8');
  assert.equal(app.includes('projectAgentMode'), false);
  assert.equal(app.includes('useDeveloperFlag'), false);
  assert.match(app, /botListShell\.active \? \(/);
  assert.match(app, /<BotListShell/);
  assert.match(app, /<Sidebar/);
  assert.match(app, /className="app-layout"/);
  assert.match(app, /<GlobalWorkbenchPage/);
  assert.match(app, /<WorkbenchPanel/);
  const branchAt = app.indexOf('botListShell.active ? (');
  const sidebarAt = app.indexOf('<Sidebar');
  const layoutAt = app.indexOf('className="app-layout"');
  assert.ok(branchAt >= 0 && sidebarAt > branchAt && layoutAt > branchAt);
  assert.ok(app.indexOf('<BotListShell') < sidebarAt);
});

test('Sidebar.tsx 行数保持当前壳层', () => {
  const sidebar = readFileSync(sidebarUrl, 'utf8');
  assert.equal(lineCount(sidebar), 1152);
});

test('应用设置菜单可以打开历史对话', () => {
  const menu = readFileSync(menuUrl, 'utf8');
  assert.match(menu, /projectAgent\.list\.history/);
  assert.match(menu, /onOpenHistory/);
});

test('机器人列表文案在中英文里都有', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');
  for (const key of LIST_KEYS) {
    assert.notEqual(zh.t(key), key, key);
    assert.notEqual(en.t(key), key, key);
  }
  assert.equal(zh.t('projectAgent.list.needsYou', { count: 3 }), '需要你 3');
  assert.equal(zh.t('projectAgent.list.nameInvalid'), '这个名字不能用');
});
