import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness() {
  const slots: any[] = [], layout: (() => any)[] = [], effects: (() => any)[] = [], timers = new Map<number, () => void>(), handlers = new Map<string, () => void>(), saved: any[] = [];
  let cursor = 0, sequence = 0, cleanup = () => {};
  const react = { useRef(value: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: value }); }, useCallback: (fn: any) => fn,
    useMemo(fn: () => unknown, deps: unknown[]) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, i) => value !== old.deps[i])) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: (fn: any) => effects.push(fn), useLayoutEffect: (fn: any) => layout.push(fn) };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useComparisonReading.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: () => react, setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; }, clearTimeout: (id: number) => timers.delete(id) });
  const scroll = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 10 }), addEventListener: (key: string, fn: () => void) => handlers.set(key, fn), removeEventListener: (key: string) => handlers.delete(key) };
  const surface = { current: { closest: () => scroll } }, body = { current: { getBoundingClientRect: () => ({ top: 10 + 180 - scroll.scrollTop }) } };
  return { scroll, saved, render(ready: boolean) {
    cleanup(); cursor = 0; layout.length = 0; effects.length = 0;
    const result = exports.useComparisonReading({ identity: 'scope', selected: 'a.ts', ready, active: true, surface, body, initial: { top: 70, left: 4, selected: 'a.ts' }, onRemember: (value: unknown) => saved.push(value) });
    layout.forEach(fn => fn()); effects.forEach(fn => { const dispose = fn(); if (dispose) cleanup = dispose; }); return result;
  }, event: (key: string) => handlers.get(key)?.(), flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); }, cleanup: () => cleanup() };
}
test('comparison anchors are relative to selected diff content and do not replay on background rerenders', () => {
  const f = harness(); try {
    const reading = f.render(true); assert.equal(f.scroll.scrollTop, 250); assert.equal(reading.capture().top, 70);
    f.scroll.scrollTop = 550; f.event('scroll'); f.flush(); assert.equal(f.saved.at(-1).top, 370);
    f.render(true); assert.equal(f.scroll.scrollTop, 550);
  } finally { f.cleanup(); }
});
test('user interaction during loading interrupts pending anchor restoration', () => {
  const f = harness(); try { f.render(false); f.scroll.scrollTop = 30; f.event('wheel'); f.render(true); assert.equal(f.scroll.scrollTop, 30); }
  finally { f.cleanup(); }
});
