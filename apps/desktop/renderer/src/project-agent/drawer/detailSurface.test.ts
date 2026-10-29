import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
function moduleFrom(file: string, modules: Record<string, unknown>) {
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  return exports;
}
const jsx = { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
function find(node: any, type: string): any {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return node.type === type ? node : find(node.props?.children, type);
}

test('explicit embedded task scene keeps the child conversation and has no nested modal or visible Workbench', async () => {
  const effects: (() => any)[] = [], calls: string[] = [];
  const scene = moduleFrom('./ConversationScene.tsx', {
    react: { useState: (value: any) => [value, () => {}], useEffect: (effect: () => any) => effects.push(effect) },
    'react/jsx-runtime': jsx, '../../app/components/Drawer': { Drawer: 'drawer' },
    '../../app/components/deferredPanels': { ChatSurface: 'chat', WorkbenchPanel: 'workbench' }, '../../clientApi': { clientApi: {
      llmListProviders: async () => { calls.push('read-providers'); return []; }, getSettings: async () => { calls.push('read-settings'); return {}; },
    } },  '../../workbench/WorkbenchContext': { WorkbenchProvider: 'workbench-provider' },
    '../conversation/BotDocumentPreview': { BotDocumentPreview: 'document-preview' }, '../../ui/icons': { PeerIcon: 'icon' },
  });
  const task = { sessionId: 'work', planId: 'plan' };
  const tree = scene.ConversationSceneDrawer({ embedded: true, active: false, workspaceId: 'A', workspacePath: '/synthetic/project', conversationId: 'child',
    title: 'Task', i18n: { t: (key: string) => key }, isZh: false, task, onClose() {} });
  assert.equal(find(tree, 'drawer'), undefined); assert.equal(find(tree, 'workbench'), undefined);
  assert.equal(find(tree, 'chat').props.conversationId, 'child');
  assert.equal(find(tree, 'workbench-provider').props.layoutHost, 'local');
  assert.equal(find(tree, 'workbench-provider').props.isPageActive, false);
  assert.equal(find(tree, 'chat').props.isPageActive, false);
  assert.equal(find(tree, 'chat').props.showComposer, false);
  assert.deepEqual(find(tree, 'document-preview').props.task, task);
  const cleanups = effects.map(effect => effect()); await Promise.resolve();
  assert.deepEqual(calls.sort(), ['read-providers', 'read-settings']); cleanups.forEach(fn => fn?.());
});

test('task Evidence stays in the same reading surface and only selects the original EvidenceRef', () => {
  const view = moduleFrom('./EvidencePreview.tsx', {
    react: { useState: () => ['original-evidence', () => {}], useRef: () => ({ current: null }), useLayoutEffect() {} },
    'react/jsx-runtime': jsx, '../../app/components/Drawer': { Drawer: 'drawer' }, '../../ui/icons': { PeerIcon: 'icon' },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => ({}) },
    '../conversation/EvidenceList': { EvidenceList: 'list' }, './EvidenceView': { EvidenceView: 'evidence' },
  });
  const tree = view.EvidencePreview({ refs: ['original-evidence'], i18n: { t: (key: string) => key } });
  assert.equal(find(tree, 'drawer'), undefined);
  assert.equal(find(tree, 'evidence').props.evidence.evidenceRef, 'original-evidence');
});

test('task file navigation carries exact structured provenance and does not turn missing hints into a global search', () => {
  const opened: any[] = [], searched: any[] = [];
  const preview = moduleFrom('../conversation/BotDocumentPreview.tsx', {
    react: { useMemo: (factory: () => any) => factory() }, 'react/jsx-runtime': jsx,
    '../../chat/components/markdown/DocumentPreviewContext': { DocumentPreviewContext: { Provider: 'provider' } },
    '../state/botResourceReference': { resolveBotResourceDisplay: (value: string) => value },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => ({ openReference: (value: any) => opened.push(value), locate: (value: any) => searched.push(value) }) },
  });
  const task = { sessionId: 'work', planId: 'plan' };
  const tree = preview.BotDocumentPreview({ workspaceId: 'A', task, i18n: { locale: 'en' }, children: null });
  tree.props.value.open('guide.md', null); tree.props.value.locate('guide.md');
  assert.equal(opened.length, 2); assert.equal(searched.length, 0);
  assert.deepEqual(opened[0].task, task); assert.equal(opened[1].workspaceId, 'A');
});

test('Bot management never reveals resources; explicit reply inspection reveals once and preserves close intent', () => {
  const slots: (readonly unknown[])[] = []; let index = 0, reveals = 0;
  let pane = { ready: true, owner: { workspaceId: 'A' }, open: false, detailActive: false,
    registerDetail() {}, showDetails() { reveals++; pane.open = true; pane.detailActive = true; } };
  const effects: (() => void)[] = [];
  const hooks = moduleFrom('./useBotDetailWorkspace.ts', {
    react: { useEffect(effect: () => void, deps: readonly unknown[]) {
      const slot = index++, previous = slots[slot];
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) effects.push(effect);
      slots[slot] = deps;
    } },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => pane },
    './botDetailReference': { botDetailReference: (workspaceId: string, _memory: unknown, inspect: unknown) => ({ workspaceId, inspect }) },
    '../../workbench/resourceDetailState': { resourceDetailKey: JSON.stringify },
  });
  const render = (open: boolean, inspect: unknown) => {
    index = 0; const result = hooks.useBotDetailWorkspace('A', { open }, inspect, 'Detail');
    effects.splice(0).forEach(effect => effect());
    return result;
  };
  render(false, null); assert.equal(reveals, 0);
  assert.equal(render(true, null), null); assert.equal(reveals, 0, 'opening settings does not open resources');
  render(true, { replyId: 'r' }); assert.equal(reveals, 1);
  render(true, { replyId: 'r', evidence: 'e' });
  render(true, { replyId: 'r' }); assert.equal(reveals, 1, 'the reply owns its local return focus');
  pane.open = false; render(true, { replyId: 'r' }); assert.equal(reveals, 1, 'closing is not a new navigation intent');
  render(true, { sessionId: 'new-task' }); assert.equal(reveals, 2);
  pane.detailActive = false; render(true, { replyId: 'new-reply' }); assert.equal(reveals, 3);
});
