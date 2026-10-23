import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { motionDurationMs, watchVisualMotion } from '../../app/state/visualMotion.ts';

/** Executes production surfaces with simulated React scheduling and DOM APIs. */
function mount(file: string, props: unknown, modules: Record<string, unknown>, supported = true, question = false,
  activate?: (view: any, node: any, document: any) => void, focusTarget?: () => unknown) {
  const effects: (() => void | (() => void))[] = [], states: unknown[] = [];
  let cancelled = 0;
  const animation = { animationName: 'motion-enter-layout', finished: new Promise(() => {}), ready: Promise.resolve(),
    cancel() { cancelled++; }, currentTime: 0, playbackRate: 1, effect: { getComputedTiming: () => ({ endTime: 200 }) } };
  const node = { style: { display: '' }, contains: () => false, getBoundingClientRect: () => ({ height: 100 }), getAnimations: () => [animation] };
  const ref = { current: node };
  const events = new Map<string, (event: unknown) => void>();
  const document = { activeElement: null as unknown, body: {},
    addEventListener(type: string, listener: (event: unknown) => void) { events.set(type, listener); },
    removeEventListener(type: string) { events.delete(type); },
    dispatch(event: { type: string; target: unknown }) { events.get(event.type)?.(event); },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, CSS: { supports: () => supported }, document,
    getComputedStyle: () => ({ marginTop: '7px', paddingTop: '15px', getPropertyValue: (key: string) => key === '--za-motion-medium' ? '200ms' : 'ease' }),
    require(id: string) {
      if (id === 'react') return {
        useRef: (value: unknown) => value === null ? ref : { current: value },
        useState: (initial: unknown) => [question ? true : typeof initial === 'function' ? initial() : initial, (next: unknown) => states.push(next)],
        useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
      };
      if (id === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }) };
      if (id in modules) return modules[id];
      throw Error('Unexpected dependency: ' + id);
    },
  });
  const view = question ? exports.useQuestionDismissal(true, props, focusTarget) : exports.ConversationRow(props);
  activate?.(view, node, document);
  const cleanups = effects.map(effect => effect());
  return { node, view, states, events, cancelled: () => cancelled, close: () => cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); }) };
}

test('an interrupted layout entry settles once and cannot replay when motion returns', () => {
  let allowed = true, update = () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const environment = { allowed: () => allowed, subscribe(fn: () => void) { update = fn; return () => { update = () => {}; }; } };
  const f = mount('./ConversationRow.tsx', { rowKey: 'input-a', entering: true, className: 'bot-thread-row', children: 'same input' }, {
    '../../app/state/motionEnvironment': { motionAllowed: () => allowed },
    '../../app/state/visualMotion': { motionDurationMs, watchVisualMotion: (animations: Animation[], finish: () => void, options: {}) => watchVisualMotion(animations, finish, {
      ...options, environment, schedule: () => { const timer = {} as ReturnType<typeof setTimeout>; timers.add(timer); return timer; }, clear: timer => { timers.delete(timer); },
    }) },
  });
  assert.match(f.view.props.className, /motion-enter-layout/);
  allowed = false; update();
  assert.deepEqual(f.states, [false]); assert.equal(f.cancelled(), 1); assert.equal(timers.size, 0);
  allowed = true; update(); f.close();
  assert.deepEqual(f.states, [false]);
  assert.equal(f.view.props.children, 'same input');
});

test('unsupported intrinsic interpolation keeps the row static and readable', () => {
  const f = mount('./ConversationRow.tsx', { rowKey: 'input-a', entering: true, className: 'bot-thread-row', children: 'same input' }, {
    '../../app/state/motionEnvironment': { motionAllowed: () => true },
    '../../app/state/visualMotion': { motionDurationMs, watchVisualMotion },
  }, false);
  assert.equal(f.view.props.className, 'bot-thread-row'); assert.equal(f.view.props.children, 'same input'); f.close();
});

test('question completion fixes the zero footprint before React commits removal', () => {
  let finish = () => {}, closed = 0;
  const f = mount('./useQuestionDismissal.ts', () => { closed++; }, {
    '../../app/state/visualMotion': { motionDurationMs, animateVisual: (_node: unknown, _frames: unknown, _timing: unknown, done: () => void) => { finish = done; return { cancel() {} }; } },
  }, true, true);
  finish();
  assert.equal(f.node.style.display, 'none'); assert.deepEqual(f.states, [false]); assert.equal(closed, 1);
  finish(); assert.equal(closed, 1); f.close();
});

test('instant question removal returns owned focus; navigation or a hidden document prevents stealing focus', () => {
  for (const [leave, hidden] of [[false, false], [true, false], [false, true]] as const) {
    let focused = 0;
    const destination = { isConnected: true, closest: () => null, focus: () => { focused++; } };
    const f = mount('./useQuestionDismissal.ts', () => {}, {
      '../../app/state/visualMotion': { motionDurationMs, animateVisual: (_node: unknown, _frames: unknown, _timing: unknown, done: () => void) => { done(); return { cancel() {} }; } },
    }, true, true, (view, node, document) => {
      const button = {};
      node.contains = (target: unknown) => target === button;
      document.activeElement = button;
      view.captureFocus();
      document.activeElement = document.body; // Disabling the submitted control releases native focus.
      document.hidden = hidden;
      if (leave) {
        // Explicitly clicking the background is user navigation, even if focus stays on body.
        document.dispatch({ type: 'pointerdown', target: document.body });
      }
    }, () => destination);
    assert.equal(focused, leave || hidden ? 0 : 1);
    assert.equal(f.node.style.display, 'none'); f.close(); assert.equal(f.events.size, 0);
  }
});
