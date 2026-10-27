import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function find(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : find(node.props?.children, predicate);
}
test('reading history is listed without restoring files, and restore/forget require separate explicit actions', async () => {
  const hooks: any[] = [], effects: (() => any)[] = [], calls: any[] = []; let cursor = 0;
  const api = { resourceWindowHistory: async (payload: unknown) => { calls.push(['list', payload]); return { ok: true, entries: [{ id: 'record', owner: { workspaceId: 'bot', conversationId: 'conversation' }, request: { resource: { kind: 'directory', reference: { workspaceId: 'bot', path: '/repo' } } }, savedAt: '2026-10-26T00:00:00Z' }] }; },
    resourceWindowRestore: async (payload: unknown) => { calls.push(['restore', payload]); return { ok: true }; },
    resourceWindowForget: async (payload: unknown) => { calls.push(['forget', payload]); return { ok: true }; } };
  const modules: Record<string, unknown> = {
    react: { useState(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], (value: any) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
      useRef(value: unknown) { const i = cursor++; return hooks[i] ?? (hooks[i] = { current: value }); }, useEffect: (fn: any) => effects.push(fn) },
    'react/jsx-runtime': { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) }, '../ui/icons': { PeerIcon: 'icon' },
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./ResourceWindowHistory.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, window: { peerAgent: api }, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  const render = () => { cursor = 0; return exports.ResourceWindowHistory({ workspaceId: 'bot', isZh: false, active: true }); };
  render(); const cleanup = effects[0](); await Promise.resolve();
  try {
    let tree = render(); assert.equal(calls.filter(call => call[0] === 'restore').length, 0);
    find(tree, node => node.type === 'button' && node.props.className === 'resource-recent').props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call[0] === 'restore')[1])), { workspaceId: 'bot', id: 'record' });
    tree = render(); find(tree, node => node.props?.['aria-label'] === 'Remove reading record').props.onClick(); await new Promise(resolve => setImmediate(resolve));
    tree = render(); assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'resource-recent'), undefined);
  } finally { cleanup(); }
});
