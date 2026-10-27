import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as bindings from './deliveryBindingState.ts';
const jsx = { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) };
function load(file: string, modules: Record<string, unknown>) {
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require(id: string) { if (id === 'react/jsx-runtime') return jsx; if (id in modules) return modules[id]; throw Error(id); } }); return exports;
}
const find = (node: any, match: (value: any) => boolean): any => Array.isArray(node) ? node.map(n => find(n, match)).find(Boolean)
  : !node || typeof node !== 'object' ? undefined : match(node) ? node : find(node.props?.children, match);
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
const binding = { evidenceRef: 'tool-result://delivery', artifactRef: 'file:///project/a.md' };
const reference = { workspaceId: 'bot', path: '/project/a.md', task: { sessionId: 'session', planId: 'plan' } };
const delivery = { ...binding, reference, kind: 'code-change', label: 'a.md', savedPreview: { kind: 'diff-summary', text: '+saved', truncated: true } };
test('saved summaries remain literal and explicitly incomplete; an empty delivery list creates no artifact area', () => {
  const history = load('./DeliveryHistory.tsx', { './file-preview/RasterImageView': { RasterImageView: 'image' } });
  const tree = history.DeliveryHistory({ delivery, isZh: true }); assert.ok(text(tree).includes('+saved')); assert.ok(text(tree).includes('未保存完整历史正文'));
  const opened: any[] = [];
  const list = load('../project-agent/drawer/EvidenceDeliveries.tsx', { '../../app/components/MotionDetails': { MotionDetails: 'details' }, '../../ui/icons': { PeerIcon: 'icon' },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => ({ ready: true, openDelivery: (value: any) => opened.push(value) }) }, '../../workbench/DeliveryHistory': { DeliveryHistory: 'history' } });
  assert.equal(list.EvidenceDeliveries({ deliveries: [], isZh: true }), null);
  const rendered = list.EvidenceDeliveries({ deliveries: [delivery], isZh: true }); assert.equal(opened.length, 0);
  find(rendered, node => node.type === 'button').props.onClick(); assert.equal(opened[0], delivery); assert.deepEqual(opened[0].reference.task, reference.task);
});
test('document association reads with original task context and fails visibly on stale or foreign metadata', async () => {
  const calls: any[] = [], reads: (() => unknown)[] = [];
  const state: any = { loaded: true, error: false, loading: false, value: { ok: true, evidenceRef: binding.evidenceRef, deliveryStatus: 'available', deliveries: [delivery], summary: 'saved evidence' }, reload() {} };
  const component = load('./DocumentDeliveryTools.tsx', { '../app/components/MotionDetails': { MotionDetails: 'details' }, '../ui/icons': { PeerIcon: 'icon' }, './DeliveryHistory': { DeliveryHistory: 'history' }, './deliveryBindingState': bindings,
    '../clientApi': { clientApi: { projectAgentReadEvidence: async (request: any) => { calls.push(request); return state.value; } } },
    '../ui/resources/useResourceState': { useResourceRead: (_: unknown, read: () => unknown) => { reads.push(read); return state; } } });
  let tree = component.DocumentDeliveryTools({ binding, reference, active: true, isZh: true }); assert.ok(find(tree, n => n.type === 'history'));
  await reads[0](); assert.deepEqual(calls[0].context.task, reference.task); assert.equal(calls[0].context.workspaceId, 'bot');
  state.error = true; tree = component.DocumentDeliveryTools({ binding, reference, active: true, isZh: true }); assert.equal(find(tree, n => n.type === 'history'), undefined); assert.ok(text(tree).includes('关联未确认'));
  state.error = false; state.value = { ok: true }; tree = component.DocumentDeliveryTools({ binding, reference, active: true, isZh: true }); assert.ok(text(tree).includes('关联未确认'));
});
