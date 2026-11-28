import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as windowGeometry from '../state/conversationWindow.ts';
import { createConversationReadingMemory, type ReadingSnapshot } from '../state/conversationReadingMemory.ts';
import { resolveThreadFollowAfterScroll } from '../../chat/state/threadScrollPolicy.ts';
import { createStreamingScrollScheduler } from '../../chat/state/streamingScrollScheduler.ts';
import { isImeKey } from '../../chat/state/compositionGuard.ts';

function mountConversation(rows: unknown[] = [], snapshot?: ReadingSnapshot) {
  const effects: (() => void | (() => void))[] = [];
  const layoutEffects: (() => void | (() => void))[] = [];
  const frames = new Map<number, () => void>();
  let requested = 0, cancelled = 0;
  const browser = {
    requestAnimationFrame(callback: () => void) {
      assert.equal(this, browser, 'native requestAnimationFrame rejects a borrowed receiver');
      frames.set(++requested, callback); return requested;
    },
    cancelAnimationFrame(id: number) {
      assert.equal(this, browser, 'native cancellation also requires Window');
      frames.delete(id); cancelled++;
    },
    addEventListener() {}, removeEventListener() {},
  };
  const memory = createConversationReadingMemory();
  if (snapshot) memory.save('clicked-bot', snapshot);
  const resizeCallbacks = new Set<() => void>();
  let rowHeight = 72, paragraphOffset = 40;
  const states: unknown[] = [];
  const modules: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => ({ current }),
      useState: (value: unknown) => {
        const index = states.length;
        states.push(typeof value === 'function' ? (value as () => unknown)() : value);
        return [states[index], (next: unknown) => {
          states[index] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[index]) : next;
        }];
      },
      useMemo: (read: () => unknown) => read(),
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      useLayoutEffect: (effect: () => void | (() => void)) => layoutEffects.push(effect),
    },
    '../state/botReplyContinuity': { replyRowContains: () => false },
    '../state/conversationWindow': windowGeometry,
    '../state/conversationReadingMemory': { conversationReadingMemory: memory },
    '../../chat/state/threadScrollPolicy': { resolveThreadFollowAfterScroll },
    '../../chat/state/streamingScrollScheduler': { createStreamingScrollScheduler },
    '../../chat/state/compositionGuard': { isImeKey },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./useConversationWindow.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, window: browser, requestAnimationFrame: browser.requestAnimationFrame,
    cancelAnimationFrame: browser.cancelAnimationFrame, setTimeout, clearTimeout,
    ResizeObserver: class {
      readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; resizeCallbacks.add(callback); }
      observe() {}
      disconnect() { resizeCallbacks.delete(this.callback); }
    },
    require(id: string) { if (id in modules) return modules[id]; throw Error('Unexpected dependency: ' + id); },
  });
  const view = exports.useConversationWindow(rows, null, 0, 0,
    { identity: 'clicked-bot', ready: true, hasOlder: false, locateMessage: async () => false });
  let scrollTop = 0;
  const nativeScroll = new Set<() => void>();
  const scroller = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    scrollHeight: rows.length ? rows.length * 72 : 1040, clientHeight: 320, clientWidth: 800,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => rows.map((_row, index) => ({ dataset: { conversationRow: `m${index}` },
      getBoundingClientRect: () => ({ top: index * rowHeight - scrollTop, bottom: (index + 1) * rowHeight - scrollTop, height: rowHeight }),
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: index * rowHeight + paragraphOffset - scrollTop,
        bottom: index * rowHeight + paragraphOffset + 32 - scrollTop, height: 32 }) }] })),
    addEventListener(type: string, listener: () => void, options?: { capture?: boolean }) {
      if (type === 'scroll' && options?.capture) nativeScroll.add(listener);
    },
    removeEventListener(type: string, listener: () => void) { if (type === 'scroll') nativeScroll.delete(listener); },
  };
  view.scrollerRef.current = scroller;
  const cleanups = [...layoutEffects, ...effects].map(effect => effect());
  return { view, scroller, memory, frames, layoutEffects, cleanups, nativeScroll,
    get top() { return states[1] as number; },
    get following() { return states[3] as boolean; },
    resize(width: number, nextRowHeight: number, nextParagraphOffset: number) {
      scroller.clientWidth = width; rowHeight = nextRowHeight; paragraphOffset = nextParagraphOffset;
      scroller.scrollHeight = rows.length * rowHeight;
      resizeCallbacks.forEach(measure => measure());
    },
    hide() {
      scroller.clientWidth = 0; scroller.clientHeight = 0; scroller.scrollHeight = 0; scrollTop = 0;
      resizeCallbacks.forEach(measure => measure());
    },
    reveal(options: { scrollTop?: number; scrollHeight?: number; width?: number; height?: number } = {}) {
      scroller.clientWidth = options.width ?? 800;
      scroller.clientHeight = options.height ?? 320;
      scroller.scrollHeight = options.scrollHeight ?? (rows.length ? rows.length * rowHeight : 1040);
      scrollTop = options.scrollTop ?? 0;
      resizeCallbacks.forEach(measure => measure());
    },
    get requested() { return requested; }, get cancelled() { return cancelled; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame()); },
    dispose() { cleanups.reverse().forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); }); },
  };
}

test('sidebar reflow keeps a visible paragraph at its reading offset, in both directions', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ type: 'message', message: { id: `m${index}`, kind: 'user_input' } }));
  const mounted = mountConversation(rows, { following: false, anchor: { key: 'm20', delta: -24 }, top: 1464,
    heights: rows.map((_, index) => [`m${index}`, 72] as const) });
  assert.equal(mounted.scroller.scrollTop, 1464);
  mounted.resize(600, 104, 70);
  assert.equal(20 * 104 + 70 - mounted.scroller.scrollTop, 16, 'the same paragraph stays in place after wrapping');
  mounted.resize(800, 72, 40);
  assert.equal(mounted.scroller.scrollTop, 1464, 'restoring width restores the reading position without following');
  mounted.dispose();
});

test('sidebar reflow cannot override a current reading gesture', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ type: 'message', message: { id: `m${index}`, kind: 'user_input' } }));
  const mounted = mountConversation(rows, { following: false, anchor: { key: 'm20', delta: -24 }, top: 1464,
    heights: rows.map((_, index) => [`m${index}`, 72] as const) });
  mounted.view.onWheel({ deltaY: -40 });
  mounted.scroller.scrollTop -= 40;
  mounted.nativeScroll.forEach(capture => capture());
  const applied = mounted.scroller.scrollTop;
  mounted.resize(600, 104, 70);
  assert.equal(mounted.scroller.scrollTop, applied, 'pointer/scroll intent wins over automatic compensation');
  mounted.dispose();
});

test('mounting and leaving a conversation invoke frame APIs with their browser receiver', () => {
  const mounted = mountConversation();
  assert.equal(mounted.requested, 2);
  assert.equal(mounted.scroller.scrollTop, 720, 'opening a following conversation still commits its initial position');
  mounted.dispose();
  assert.equal(mounted.cancelled, 2);
  assert.equal(mounted.frames.size, 0, 'leaving the conversation releases the pending native frame');
});

test('a same-frame geometry commit reconciles the final bottom once, then becomes idle', () => {
  const mounted = mountConversation();
  assert.equal(mounted.scroller.scrollTop, 720);
  mounted.scroller.scrollHeight = 1720;
  mounted.layoutEffects[3]!(); // The scheduler already used this frame on the loading geometry.
  assert.equal(mounted.scroller.scrollTop, 720, 'same-frame work stays coalesced');
  assert.equal(mounted.frames.size, 2, 'one reset and one reconciliation stay bounded');
  mounted.flush();
  assert.equal(mounted.scroller.scrollTop, 1400, 'the next frame observes final geometry');
  mounted.flush();
  assert.equal(mounted.frames.size, 0, 'idle conversations do not keep requesting frames');
  mounted.dispose();
});

test('a reading gesture before reconciliation keeps its position and cancels on leave', () => {
  const mounted = mountConversation(Array.from({ length: 50 }, (_, index) => ({
    type: 'message', message: { id: `m${index}`, kind: 'user_input' },
  })));
  const before = mounted.scroller.scrollTop;
  mounted.view.onWheel({ deltaY: -350 });
  mounted.scroller.scrollTop -= 350;
  mounted.nativeScroll.forEach(capture => capture());
  mounted.flush();
  assert.equal(mounted.scroller.scrollTop, before - 350, 'queued follow cannot take back reading intent');
  mounted.dispose();
  assert.equal(mounted.frames.size, 0);
});

// Execute the hook against simulated DOM geometry, without delivering onScroll.
test('native scroll captures the applied gesture position before delayed React delivery', () => {
  const mounted = mountConversation(Array.from({ length: 50 }, (_, index) => ({
    type: 'message', message: { id: `m${index}`, kind: 'user_input' },
  })));
  mounted.flush();
  const before = mounted.scroller.scrollTop;
  mounted.view.onWheel({ deltaY: -350 });
  mounted.flush(); // An animation frame may precede the compositor's default scroll.
  mounted.scroller.scrollTop -= 350;
  mounted.nativeScroll.forEach(capture => capture()); // React's onScroll is still withheld.
  const saved = mounted.memory.read('clicked-bot');
  assert.equal(saved?.following, false);
  assert.equal(saved?.top, before - 350);
  assert.equal(saved?.anchor?.key, 'm40');
  assert.equal(saved?.anchor?.delta, -50);
  mounted.layoutEffects[3]!(); // A subsequent geometry commit must use the new reading anchor.
  assert.equal(mounted.scroller.scrollTop, before - 350);
  mounted.view.onWheel({ deltaY: -80 });
  mounted.dispose();
  assert.equal(mounted.frames.size, 0, 'leaving cancels pending follow frames');
  assert.equal(mounted.nativeScroll.size, 0, 'leaving releases native reading capture');
});

test('hiding a following thread via display:none keeps virtual top intact and reconciles bottom on return', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    type: 'message', message: { id: `m${index}`, kind: 'user_input' },
  }));
  const mounted = mountConversation(rows);
  mounted.flush();
  const initialBottom = mounted.scroller.scrollTop;
  assert.equal(mounted.top, initialBottom);

  // Switch to a subtask (display: none -> 0x0 box, scrollTop reads 0).
  mounted.hide();
  // Background activity updates rows while hidden; must not overwrite top or reading memory with 0.
  mounted.layoutEffects[3]!();
  mounted.flush();
  assert.equal(mounted.top, initialBottom, 'hidden layout commits must not reset virtual top to 0');
  assert.equal(mounted.memory.read('clicked-bot')?.top, initialBottom, 'hidden commits must not persist top=0');

  // Switch back to main bot after scrollHeight grew while hidden (both browser-preserved and 0-reset scrollTop).
  mounted.reveal({ scrollTop: initialBottom, scrollHeight: 85 * 72 });
  assert.equal(mounted.scroller.scrollTop, 85 * 72 - 320, 'returning from hidden jumps to the latest bottom');
  assert.equal(mounted.top, 85 * 72 - 320, 'virtual top stays synchronized with restored scrollTop');
  assert.equal(mounted.following, true);

  // Also cover zero-box collapse where the browser clamps scrollTop to 0 and dispatches scroll while hidden.
  mounted.hide();
  mounted.view.onScroll();
  mounted.reveal({ scrollTop: 0, scrollHeight: 85 * 72 });
  assert.equal(mounted.scroller.scrollTop, 85 * 72 - 320, 'zero-box collapse recovers bottom on reveal');
  assert.equal(mounted.top, 85 * 72 - 320);
  assert.equal(mounted.following, true);
  mounted.dispose();
});

test('hiding while reading history preserves the reading anchor and restores it on return or leave', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    type: 'message', message: { id: `m${index}`, kind: 'user_input' },
  }));
  const mounted = mountConversation(rows, {
    following: false,
    anchor: { key: 'm40', delta: -24 },
    top: 2904,
    heights: rows.map((_, index) => [`m${index}`, 72] as const),
  });
  assert.equal(mounted.scroller.scrollTop, 2904);

  mounted.hide();
  mounted.layoutEffects[3]!();
  mounted.view.onScroll();
  assert.equal(mounted.top, 2904, 'hidden updates must not wipe virtual top');
  assert.equal(mounted.memory.read('clicked-bot')?.anchor?.key, 'm40', 'hidden updates must not corrupt reading anchor');

  // Browser resets scrollTop to 0 while hidden; reveal must restore the exact reading offset without resuming follow.
  mounted.reveal({ scrollTop: 0, scrollHeight: 85 * 72 });
  assert.equal(mounted.scroller.scrollTop, 2904);
  assert.equal(mounted.top, 2904);
  assert.equal(mounted.following, false);

  // Unmounting while hidden (switching directly from subtask to another bot) must still persist last visible top.
  mounted.hide();
  mounted.dispose();
  assert.equal(mounted.memory.read('clicked-bot')?.top, 2904, 'leaving while hidden keeps last visible top');
  assert.equal(mounted.memory.read('clicked-bot')?.anchor?.key, 'm40');
});
