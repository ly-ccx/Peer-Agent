import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('static stream delivery flushes received text in order, cancels frames and cannot replay on resume', () => {
  let enabled = true, update: (() => void) | undefined, next = 0;
  const frames = new Map<number, () => void>(), cleanups: (() => void)[] = [], received: string[] = [];
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./useTypewriterStream.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, performance: { now: () => 0 }, requestAnimationFrame(fn: () => void) { frames.set(++next, fn); return next; },
    cancelAnimationFrame(id: number) { frames.delete(id); }, require(id: string) {
      if (id === 'react') return { useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn,
        useEffect(fn: () => () => void) { cleanups.push(fn()); } };
      if (id.endsWith('motionEnvironment.ts')) return { motionAllowed: () => enabled, subscribeMotionEnvironment(fn: () => void) { update = fn; return () => { update = undefined; }; } };
      if (id.endsWith('streamProfiler.ts')) return { getStreamProfiler: () => ({ bump() {}, setGauge() {} }) };
      throw Error(id);
    },
  });
  const stream = exports.useTypewriterStream((text: string) => received.push(text));
  stream.push('first'); assert.equal(frames.size, 1);
  enabled = false; update?.(); assert.equal(frames.size, 0); assert.deepEqual(received, ['first']);
  stream.push('second'); assert.equal(frames.size, 0); assert.deepEqual(received, ['first', 'second']);
  enabled = true; update?.(); assert.equal(frames.size, 0);
  stream.push('third'); stream.handoff(); stream.reset(); assert.deepEqual(received, ['first', 'second', 'third']);
  cleanups.forEach(cleanup => cleanup()); assert.equal(frames.size, 0); assert.equal(update, undefined);
});
