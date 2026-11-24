import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';

const exports: Record<string, any> = {};
const jsx = {
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
};
const modules: Record<string, unknown> = {
  'react/jsx-runtime': jsx,
  '../BotAvatar': { BotAvatar: 'bot-avatar' },
  '../../ui/icons': { PeerIcon: 'peer-icon' },
  '../state/drawerState': {},
};

runInNewContext(
  ts.transpileModule(readFileSync(new URL('./OverviewTab.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText,
  {
    exports,
    require(id: string) {
      if (id in modules) return modules[id];
      throw new Error(`Unexpected import in OverviewTab test: ${id}`);
    },
  },
);

function find(node: any, predicate: (item: any) => boolean): any {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

function textContent(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node && typeof node === 'object') return textContent(node.props?.children);
  return '';
}

function render(overrides: Record<string, unknown> = {}) {
  const i18n = createI18n('zh-CN');
  return exports.OverviewTab({
    path: '/Users/demo/Develop/Peer-Agent',
    pathExists: true,
    profile: {
      workspaceId: 'ws-1',
      displayName: 'Peer-Agent',
      avatar: { kind: 'generated', shape: 'circle', color: '#6474e5', variant: 1 },
      proactivity: 'inherit',
      acceptancePolicy: 'auto',
    },
    sessionsAvailable: true,
    onOpenTasks() {},
    brief: '',
    running: [],
    modelLabel: 'DeepSeek',
    i18n,
    onReveal() {},
    onRebind() {},
    onOpenSession() {},
    ...overrides,
  });
}

test('missing folder highlights warning, disables Reveal, and promotes primary Rebind CTA', () => {
  const i18n = createI18n('zh-CN');
  const tree = render({ pathExists: false });
  const card = find(tree, (n) => n.props?.className === 'bot-overview-folder');
  assert.equal(card.props['data-missing'], 'true');

  const warning = find(card, (n) => n.props?.className === 'bot-overview-folder-missing');
  assert.equal(warning.props.role, 'status');
  assert.ok(textContent(warning).includes(i18n.t('projectAgent.drawer.folderMissing')));

  const revealBtn = find(card, (n) => n.type === 'button' && textContent(n).includes(i18n.t('projectAgent.drawer.reveal')));
  assert.equal(revealBtn.props.disabled, true);

  const rebindBtn = find(card, (n) => n.type === 'button' && String(n.props?.className || '').includes('bot-overview-folder-rebind'));
  assert.ok(String(rebindBtn.props.className).includes('is-primary'));
  assert.ok(textContent(rebindBtn).includes(i18n.t('projectAgent.drawer.rebindFolder')));
});

test('existing folder enables Reveal and offers Change folder action', () => {
  const i18n = createI18n('zh-CN');
  const tree = render({ pathExists: true });
  const card = find(tree, (n) => n.props?.className === 'bot-overview-folder');
  assert.equal(card.props['data-missing'], undefined);
  assert.equal(find(card, (n) => n.props?.className === 'bot-overview-folder-missing'), undefined);

  const revealBtn = find(card, (n) => n.type === 'button' && textContent(n).includes(i18n.t('projectAgent.drawer.reveal')));
  assert.equal(revealBtn.props.disabled, false);

  const rebindBtn = find(card, (n) => n.type === 'button' && String(n.props?.className || '').includes('bot-overview-folder-rebind'));
  assert.equal(rebindBtn.props.className, 'bot-overview-folder-rebind');
  assert.ok(textContent(rebindBtn).includes(i18n.t('projectAgent.drawer.changeFolder')));
});

test('inline rebind feedback renders alert on error and status on success', () => {
  const errTree = render({
    pathExists: false,
    rebindFeedback: { kind: 'error', message: '这个文件夹已经绑定给另一个机器人了。' },
  });
  const errFeedback = find(errTree, (n) => String(n.props?.className || '').includes('bot-overview-folder-feedback'));
  assert.equal(errFeedback.props.role, 'alert');
  assert.equal(textContent(errFeedback), '这个文件夹已经绑定给另一个机器人了。');

  const okTree = render({
    pathExists: true,
    rebindFeedback: { kind: 'success', message: '已绑定到新文件夹' },
  });
  const okFeedback = find(okTree, (n) => String(n.props?.className || '').includes('bot-overview-folder-feedback'));
  assert.equal(okFeedback.props.role, 'status');
  assert.equal(textContent(okFeedback), '已绑定到新文件夹');
});
