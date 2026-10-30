import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ReactElement } from 'react';
import ts from 'typescript';

test('conversation siblings keep distinct identities while loading, recovering and changing bots', () => {
  const conversation = {
    status: 'loading', viewRows: [], rows: [], messages: [],
    recovery: { state: { ready: true, pending: [], received: [], sending: [] }, session: { edit() {} } },
  };
  const components = new Map<string, () => null>();
  const component = (name: string) => {
    if (!components.has(name)) components.set(name, () => null);
    return components.get(name)!;
  };
  const dependencies: Record<string, unknown> = {
    react: {
      useEffect() {}, useMemo: (read: () => unknown) => read(),
      useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, () => {}],
    },
    'react/jsx-runtime': jsxRuntime,
    '../state/useBotConversation': { useBotConversation: () => conversation },
    '../state/botActivityState': { replyDetailsRow: () => null },
    '../state/useReplyDetailsRow': { useReplyDetailsRow: () => ({ row: null, loading: false }) },
    '../state/taskConversationState': { taskConversationContext: () => null },
    '../state/botWorkState': { backgroundWork: () => ({ count: 0, rows: [] }) },
    '../BotAvatar': { botAvatarDisplayColor: () => '#609ba6' },
    './BotInputContext': { BotInputContext: { Provider: component('Provider') } },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./BotConversation.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    exports,
    require(id: string) {
      if (id in dependencies) return dependencies[id];
      return new Proxy({}, { get: (_target, name) => component(String(name)) });
    },
  });

  const render = (workspaceId: string) => {
    const tree = exports.BotConversation({ workspaceId, profile: {}, modelControls: { views: {} },
      avatar: { kind: 'generated', color: 'lake' }, i18n: { t: (key: string) => key } });
    const children = tree.props.children.props.children.filter((child: unknown) =>
      child !== null && typeof child === 'object') as ReactElement[];
    const keys = children.flatMap(child => child.key === null ? [] : [child.key]);
    assert.equal(new Set(keys).size, keys.length, 'React cannot reconcile siblings with duplicate keys');
    return {
      thread: children.find(child => child.type === component('BotMessageList'))?.key,
      composer: children.find(child => child.type === component('BotConversationComposer'))?.key,
    };
  };

  const loading = render('first-bot');
  assert.ok(loading.thread); assert.ok(loading.composer);
  conversation.status = 'ready';
  assert.deepEqual(render('first-bot'), loading, 'loading completion preserves both surfaces');
  conversation.status = 'error';
  assert.equal(render('first-bot').composer, loading.composer, 'read failure preserves the draft surface');
  conversation.status = 'ready';
  assert.deepEqual(render('first-bot'), loading, 'retry restores one thread with its original identity');
  const next = render('second-bot');
  assert.notEqual(next.thread, loading.thread);
  assert.notEqual(next.composer, loading.composer, 'draft identity remains scoped to its bot');
});
