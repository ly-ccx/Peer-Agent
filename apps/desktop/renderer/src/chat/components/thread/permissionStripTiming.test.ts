import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('a displayed permission decision dispatches immediately and once, without an animation timer', () => {
  const exports: Record<string, any> = {}, actions: unknown[] = [], head = { toolCallId: 'displayed-operation' };
  const jsx = (type: unknown, props: any) => ({ type, props });
  const source = readFileSync(new URL('./PermissionGateStrip.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, setTimeout() { throw Error('A timer cannot dispatch a decision'); }, require(id: string) {
      if (id === 'react') return { useRef: (current: unknown) => ({ current }) };
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (id.endsWith('permissionGateView')) return { buildPermissionGateView: () => ({ variant: 'tool' }) };
      throw Error(id);
    },
  });
  const view = exports.PermissionGateStrip({ pendingCalls: [head], onApprove: (call: unknown) => actions.push(call),
    onReject() {}, onApproveAlways() {}, i18n: { locale: 'en', t: (key: string) => key } });
  const controls = view.props.children.at(-1).props.children;
  controls[1].props.onClick(); assert.deepEqual(actions, [head]); controls[1].props.onClick(); assert.deepEqual(actions, [head]);
});
