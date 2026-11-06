import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('the explicit native-copy action captures reading position at click time and retains its bound task', async () => {
  let top = 10, captures = 0; const requests: any[] = [], state: unknown[] = []; const exports: any = {};
  const modules: Record<string, unknown> = {
    react: { useState: (initial: unknown) => [initial, (value: unknown) => state.push(value)] },
    'react/jsx-runtime': { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) },
    '../ui/icons': { PeerIcon: 'icon' },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./OpenResourceWindowButton.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, window: { peerAgent: { resourceWindowOpen: async (request: any) => { requests.push(request); return { ok: true }; } } },
    require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  const task = { sessionId: 'session', planId: 'plan' };
  const tree = exports.OpenResourceWindowButton({ isZh: false, request: () => { captures++; return { resource: { kind: 'document', mode: 'preview', reference: { workspaceId: 'bot', path: '/repo/a.md', task } }, navigation: { top, left: 0 } }; } });
  assert.equal(captures, 0); top = 345; await tree.props.children[0].props.onClick();
  assert.equal(captures, 1); assert.equal(requests[0].navigation.top, 345); assert.deepEqual(requests[0].resource.reference.task, task);
  assert.deepEqual(state, [true, null, false]);
});
