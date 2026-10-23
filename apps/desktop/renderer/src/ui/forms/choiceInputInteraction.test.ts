import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { selectionNavigation } from '../../app/components/selectionNavigation.ts';
import { createCompositionGuard, isImeKey } from '../../chat/state/compositionGuard.ts';

type El = { type: unknown; props: Record<string, any> };
function component(path: string, modules: Record<string, unknown>) {
  const jsx = (type: unknown, props: Record<string, any>): El => ({ type, props });
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, getComputedStyle: () => ({ direction: 'ltr' }), require(id: string) {
    if (id === 'react') return { useState: (value: unknown) => [value, () => {}], useId: () => 'field' };
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id in modules) return modules[id];
    throw Error('Unexpected dependency: ' + id);
  } });
  return exports;
}
const event = (key: string, target: object = {}, extra: object = {}) => ({ key, nativeEvent: { key, target, ...extra },
  target, currentTarget: target, preventDefault() {}, stopPropagation() {}, ...extra });

test('tabs move focus without activating an expensive page; radio arrows update only the local controlled choice', () => {
  const { ChoiceStrip } = component('./ChoiceStrip.tsx', {
    '../../app/components/selectionNavigation': { selectionNavigation }, '../../chat/state/compositionGuard': { isImeKey },
  });
  let focused = -1; const changes: string[] = [];
  const options = [{ value: 'a', label: 'A' }, { value: 'disabled', label: 'Disabled', disabled: true }, { value: 'b', label: 'B' }];
  const nodes = options.map((_, i) => ({ focus() { focused = i; } }));
  const target = { parentElement: { querySelectorAll: () => nodes } };
  const tabs: El = ChoiceStrip({ value: 'a', options, label: 'Pages', onChange: (value: string) => changes.push(value) });
  tabs.props.children[0].props.onKeyDown(event('ArrowRight', target));
  assert.equal(focused, 2); assert.deepEqual(changes, []);
  tabs.props.children[2].props.onClick(); assert.deepEqual(changes, ['b']);
  const radio: El = ChoiceStrip({ value: 'a', options, label: 'Local mode', kind: 'radio', onChange: (value: string) => changes.push(value) });
  radio.props.children[0].props.onKeyDown(event('ArrowRight', target)); assert.deepEqual(changes, ['b', 'b']);
  radio.props.children[0].props.onKeyDown(event('ArrowLeft', target, { isComposing: true })); assert.deepEqual(changes, ['b', 'b']);
});
test('filename composition and blur preserve the draft; an explicit second Enter creates once, Escape cancels', () => {
  const { FileEntryInput } = component('../../workbench/views/FileEntryInput.tsx', {
    '../../app/hooks/useCompositionGuard': { useCompositionGuard: () => createCompositionGuard() },
    '../../ui/icons': { PeerIcon: () => null },
  });
  let created = 0, cancelled = 0;
  const tree: El = FileEntryInput({ value: '文件', busy: false, error: '名称重复', kind: 'file', isZh: true,
    onChange() {}, onCommit() { created++; }, onCancel() { cancelled++; } });
  const input: El = tree.props.children[0], target = {};
  input.props.onCompositionStart({ currentTarget: target }); input.props.onKeyDown(event('Enter', target, { isComposing: true }));
  input.props.onCompositionEnd({ currentTarget: target }); input.props.onKeyDown(event('Enter', target));
  input.props.onBlur?.({ currentTarget: target }); assert.equal(created, 0);
  input.props.onKeyUp(event('Enter', target)); input.props.onKeyDown(event('Enter', target)); assert.equal(created, 1);
  input.props.onKeyDown(event('Enter', target, { repeat: true })); assert.equal(created, 1);
  input.props.onKeyDown(event('Escape', target)); assert.equal(cancelled, 1);
  assert.equal(input.props['aria-invalid'], true); assert.equal(input.props['aria-describedby'], tree.props.children.at(-1).props.id);
});
