import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as comparisons from './resourceComparisonState.ts';
import * as revisions from './documentRevisionState.ts';

function treeFind(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => treeFind(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : treeFind(node.props?.children, predicate);
}
test('selection is shared with the auxiliary index; disappearance does not open a different file or lose task provenance', async () => {
  const state: any[] = []; let cursor = 0; const reads: any[] = [], opened: any[] = [], indices: any[] = [];
  const raw = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`;
  const reading: any = { value: { ok: true, workspaceRoot: '/repo', diffText: raw('one.ts') + '\n' + raw('two.ts') }, loaded: true, loading: false, error: false,
    reload() {}, observe() {}, adopt() {} };
  const modules: Record<string, unknown> = {
    './useComparisonReading': { useComparisonReading: (options: any) => ({ capture: () => ({ top: 120, left: 0, ...(options.selected ? { selected: options.selected } : {}) }) }) },
    './feedback/ResourceSelectionFeedback': { ResourceSelectionFeedback: 'resource-selection-feedback' },
    './OpenResourceWindowButton': { OpenResourceWindowButton: 'open-native-window' },
    react: { useRef: () => ({ current: null }), useLayoutEffect() {}, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
      useState(initial: unknown) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (value: unknown) => { state[index] = value; }]; } },
    'react/jsx-runtime': { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) },
    '../clientApi': { clientApi: { gitDiffRange: async (value: any) => { reads.push(value); return reading.value; } } },
    './ResourceWorkspaceContext': { useResourceWorkspace: () => ({ openReference: (ref: any) => opened.push(ref) }) },
    './WorkbenchContext': { useWorkbench: () => ({}) }, './file-preview/DiffViewer': { DiffViewer: 'diff' },
    './resourceComparisonState': comparisons, './documentRevisionState': revisions,
    './useComparisonRefresh': { useComparisonRefresh: (_: unknown, read: () => unknown) => { reads.push(read); return reading; } },
    './useForegroundRefresh': { useForegroundRefresh: () => ({ enabled: false, toggle() {} }) },
    './ComparisonNavigation': { usePublishComparisonIndex: (index: any, active: boolean) => indices.push({ index, active }) },
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./ComparisonRead.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  const task = { sessionId: 'task', planId: 'plan' };
  const render = (root = '/repo') => { cursor = 0; return exports.ComparisonRead({ workspaceId: 'bot', path: root, root, active: true, isZh: false, comparison: 'working', task, viewId: 'view' }); };
  render(); indices.at(-1).index.select('two.ts'); const selected = render();
  assert.equal(indices.at(-1).index.selected, 'two.ts');
  treeFind(selected, node => node.type === 'button' && node.props.children === 'Open current file').props.onClick();
  assert.equal(opened[0].path, '/repo/two.ts'); assert.equal(opened[0].workspaceId, 'bot'); assert.deepEqual(opened[0].task, task);
  await reads.find(value => typeof value === 'function')();
  const request = reads.find(value => typeof value === 'object'); assert.deepEqual(request.documentReference.task, task); assert.equal(request.documentReference.workspaceId, 'bot');
  reading.value = { ...reading.value, diffText: raw('one.ts') }; const disappeared = render();
  assert.equal(treeFind(disappeared, node => node.type === 'diff'), undefined);
  assert.ok(treeFind(disappeared, node => node.props?.role === 'status' && String(node.props.children).includes('selected file')));
  const nested = render('/repo/docs');
  assert.equal(treeFind(nested, node => node.type === 'open-native-window').props.request().resource.reference.path, '/repo/docs');
});
