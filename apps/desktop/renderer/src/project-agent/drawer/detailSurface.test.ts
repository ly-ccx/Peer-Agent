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
    '../../chat/components/ChatSurface': { ChatSurface: 'chat' }, '../../clientApi': { clientApi: {
      llmListProviders: async () => { calls.push('read-providers'); return []; }, getSettings: async () => { calls.push('read-settings'); return {}; },
    } }, '../../workbench/WorkbenchPanel': { WorkbenchPanel: 'workbench' }, '../../workbench/WorkbenchContext': { WorkbenchProvider: 'workbench-provider' },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => ({ detailsVisible: true }) },
    '../conversation/BotDocumentPreview': { BotDocumentPreview: 'document-preview' }, '../../ui/icons': { PeerIcon: 'icon' },
  });
  const task = { sessionId: 'work', planId: 'plan' };
  const tree = scene.ConversationSceneDrawer({ embedded: true, workspaceId: 'A', workspacePath: '/synthetic/project', conversationId: 'child',
    title: 'Task', i18n: { t: (key: string) => key }, isZh: false, task, onClose() {} });
  assert.equal(find(tree, 'drawer'), undefined); assert.equal(find(tree, 'workbench'), undefined);
  assert.equal(find(tree, 'chat').props.conversationId, 'child');
  assert.equal(find(tree, 'workbench-provider').props.layoutHost, 'local');
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
