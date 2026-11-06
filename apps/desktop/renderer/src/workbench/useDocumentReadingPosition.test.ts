import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createDocumentReadingMemory } from './useDocumentReadingPosition.ts';

test('reading memory separates modes and ignores invalid geometry', () => {
  const memory = createDocumentReadingMemory();
  memory.remember('preview', 300, 0); memory.remember('source', 80, 20);
  memory.remember('source', NaN, 0);
  assert.deepEqual(memory.read('preview'), { top: 300, left: 0 });
  assert.deepEqual(memory.read('source'), { top: 80, left: 20 });
  const copy = memory.read('source'); copy.top = 0;
  assert.equal(memory.read('source').top, 80);
});

function mount() {
  const slots: any[] = []; let cursor = 0;
  const effects: (() => void)[] = [];
  const memo = (read: () => unknown, deps: unknown[]) => {
    const index = cursor++, old = slots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { value: read(), deps };
    return slots[index].value;
  };
  const react = {
    useMemo: memo, useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useRef(value: unknown) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next: unknown) => { slots[index] = next; }]; },
    useLayoutEffect(effect: () => void, deps: unknown[]) { memo(() => { effects.push(effect); return true; }, deps); },
  };
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useDocumentReadingPosition.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: () => react });
  const node = { scrollTop: 0, scrollLeft: 0, querySelector: () => null as null | { getBoundingClientRect: () => { top: number } }, getBoundingClientRect: () => ({ top: 10 }) };
  return {
    node,
    render(mode: string, active = true, navigation?: { line: number; requestId: string }, identity = 'doc') {
      cursor = 0;
      const view = exports.useDocumentReadingPosition(identity, mode, active, true, navigation);
      view.ref.current = node;
      effects.splice(0).forEach(effect => effect());
      return view;
    },
  };
}

test('mode switches and hidden geometry preserve independent reading points; new document identity resets them', () => {
  const h = mount(); let view = h.render('preview');
  h.node.scrollTop = 300; view.onScroll();
  view = h.render('source'); assert.equal(h.node.scrollTop, 0);
  h.node.scrollTop = 80; h.node.scrollLeft = 20; view.onScroll();
  view = h.render('preview'); assert.equal(h.node.scrollTop, 300);
  view = h.render('preview', false); h.node.scrollTop = 0; view.onScroll();
  h.render('preview'); assert.equal(h.node.scrollTop, 300);
  h.render('source'); assert.equal(h.node.scrollTop, 80); assert.equal(h.node.scrollLeft, 20);
  h.render('source', true, undefined, 'other-doc'); assert.equal(h.node.scrollTop, 0);
});

test('explicit line navigation runs once per intent, while repeated clicks and invalid lines remain recoverable', () => {
  const h = mount(); const navigation = { line: 8, requestId: 'first' };
  h.node.querySelector = () => ({ getBoundingClientRect: () => ({ top: 210 - h.node.scrollTop }) });
  let view = h.render('source', true, navigation); assert.equal(h.node.scrollTop, 200);
  h.node.scrollTop = 450; view.onScroll();
  view = h.render('source', true, navigation); assert.equal(h.node.scrollTop, 450);
  h.render('source', true, { line: 8, requestId: 'second' }); assert.equal(h.node.scrollTop, 200);
  h.node.querySelector = () => null;
  const missing = { line: 999, requestId: 'missing' };
  h.render('source', true, missing); view = h.render('source', true, missing);
  assert.equal(view.missingLine, true); assert.equal(h.node.scrollTop, 200);
});

test('restored reading coordinates remain separate for content versions and modes', () => {
  const a = `sha256:${'a'.repeat(64)}:source`, b = `sha256:${'b'.repeat(64)}:source`;
  const memory = createDocumentReadingMemory({ [a]: { top: 320, left: 18 } });
  assert.deepEqual(memory.read(a), { top: 320, left: 18 });
  assert.deepEqual(memory.read(b), { top: 0, left: 0 });
  memory.remember(b, 80, 0);
  assert.deepEqual(memory.read(a), { top: 320, left: 18 });
});

test('reading memory bounds retained versions and coordinates', () => {
  const memory = createDocumentReadingMemory();
  for (let i = 0; i < 14; i++) memory.remember(`version-${i}`, i + 1, 0);
  assert.deepEqual(memory.read('version-0'), { top: 0, left: 0 });
  assert.equal(memory.read('version-13').top, 14);
  memory.remember('large', 20_000_000, 20_000_000);
  assert.deepEqual(memory.read('large'), { top: 10_000_000, left: 10_000_000 });
});
