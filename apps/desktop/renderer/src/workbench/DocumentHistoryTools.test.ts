import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as revisionState from './documentRevisionState.ts';

function mount(commit: string) {
  const opened: any[] = [], exports: Record<string, any> = {};
  const modules: Record<string, any> = {
    react: { useState: () => [commit, () => {}] },
    'react/jsx-runtime': { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
    '../app/components/MotionDetails': { MotionDetails: 'details' },
    '../ui/icons': { PeerIcon: 'svg' }, '../chat/state/compositionGuard': { isImeKey: () => false },
    './ResourceWorkspaceContext': { useResourceWorkspace: () => ({ openReference: (reference: any) => opened.push(reference) }) },
    './documentRevisionState': revisionState,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./DocumentHistoryTools.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id: string) => modules[id] });
  return { opened, render: exports.DocumentHistoryTools };
}

function find(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

test('opening historical content is explicit, typed and keeps task ownership; invalid commits stay disabled', () => {
  const reference = { workspaceId: 'bot', path: '/repo/doc.md', task: { sessionId: 's', planId: 'p' } };
  const h = mount('a'.repeat(40));
  const tree = h.render({ reference, path: reference.path, isZh: false });
  assert.equal(h.opened.length, 0);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.opened[0].revision.commit, 'a'.repeat(40)); assert.deepEqual(h.opened[0].task, reference.task);
  const invalid = mount('main');
  const invalidTree = invalid.render({ reference, path: reference.path, isZh: false });
  assert.equal(find(invalidTree, node => node.type === 'button').props.disabled, true);
  find(invalidTree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(invalid.opened.length, 0);
});

test('the current-file action is a separate user navigation and never carries the historical revision', () => {
  const h = mount('');
  const reference = { workspaceId: 'bot', path: '/repo/deleted.md', revision: { kind: 'git', commit: 'a'.repeat(40) } };
  const tree = h.render({ reference, path: reference.path, isZh: false });
  assert.equal(h.opened.length, 0);
  find(tree, node => node.type === 'button').props.onClick();
  assert.equal(h.opened[0].path, reference.path); assert.equal('revision' in h.opened[0], false);
});
