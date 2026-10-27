import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as state from './directorySessionState.ts';

function harness() {
  const refs: any[] = [], layout: (() => any)[] = [], passive: (() => any)[] = [], saves: any[] = [];
  const timers = new Map<number, () => void>(); let index = 0, sequence = 0;
  const initial = { root: '/project', expanded: ['src'], selected: null, filter: '', top: 240, left: 9 };
  const exports: any = {};
  const modules: Record<string, any> = {
    react: { useRef: (value: any) => refs[index++] ?? (refs[index - 1] = { current: value }), useCallback: (fn: any) => fn,
      useLayoutEffect: (fn: any) => layout.push(fn), useEffect: (fn: any) => passive.push(fn) },
    './directorySessionState': state,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useDirectoryReadingPosition.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => modules[id],
    setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; }, clearTimeout: (id: number) => timers.delete(id) });
  const node = { scrollTop: 0, scrollLeft: 0 };
  let cleanup: () => void = () => {};
  return { node, saves, render(ready: boolean, active = true) {
    index = 0; layout.length = 0; passive.length = 0;
    const value = exports.useDirectoryReadingPosition(ready, active, initial, {
      root: '/project', expanded: new Set(['/project', '/project/src']), selected: null, filter: '', remember: (value: any) => saves.push(value) });
    value.ref.current = node;
    for (const effect of layout) { const result = effect(); if (result) cleanup = result; }
    for (const effect of passive) effect();
    return value;
  }, flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); }, cleanup: () => cleanup() };
}

test('tree position restores once after branches load and never follows background refresh', () => {
  const h = harness(); h.render(false); assert.equal(h.node.scrollTop, 0);
  const tree = h.render(true); assert.equal(h.node.scrollTop, 240); assert.equal(h.node.scrollLeft, 9);
  h.node.scrollTop = 530; tree.onScroll(); h.flush(); assert.equal(h.saves.at(-1).top, 530);
  h.render(true); assert.equal(h.node.scrollTop, 530);
  assert.deepEqual(Array.from(h.saves.at(-1).expanded), ['.', 'src']);
  h.cleanup();
});

test('early user scrolling wins and a hidden tree never overwrites the reading position', () => {
  const h = harness(); const waiting = h.render(false); waiting.interrupt(); h.node.scrollTop = 41;
  const tree = h.render(true); assert.equal(h.node.scrollTop, 41);
  tree.onScroll(); h.flush(); assert.equal(h.saves.at(-1).top, 41);
  const hidden = h.render(true, false); h.node.scrollTop = 0; hidden.onScroll(); h.flush();
  assert.equal(h.saves.at(-1).top, 41); h.cleanup();
});
