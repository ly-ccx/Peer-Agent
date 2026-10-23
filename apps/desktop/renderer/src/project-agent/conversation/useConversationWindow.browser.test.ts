import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as windowGeometry from '../state/conversationWindow.ts';
import { createConversationReadingMemory } from '../state/conversationReadingMemory.ts';
import { resolveThreadFollowAfterScroll } from '../../chat/state/threadScrollPolicy.ts';
import { createStreamingScrollScheduler } from '../../chat/state/streamingScrollScheduler.ts';
import { isImeKey } from '../../chat/state/compositionGuard.ts';

function mountConversation(rows: unknown[] = []) {
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
  const modules: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => ({ current }),
      useState: (value: unknown) => [typeof value === 'function' ? value() : value, () => {}],
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
    require(id: string) { if (id in modules) return modules[id]; throw Error('Unexpected dependency: ' + id); },
  });
  const view = exports.useConversationWindow(rows, null, 0, 0,
    { identity: 'clicked-bot', ready: true, hasOlder: false, locateMessage: async () => false });
  let scrollTop = 0;
  const nativeScroll = new Set<() => void>();
  const scroller = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    scrollHeight: rows.length ? rows.length * 72 : 1040, clientHeight: 320,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => rows.map((_row, index) => ({ dataset: { conversationRow: `m${index}` },
      getBoundingClientRect: () => ({ top: index * 72 - scrollTop, bottom: (index + 1) * 72 - scrollTop, height: 72 }) })),
    addEventListener(type: string, listener: () => void, options?: { capture?: boolean }) {
      if (type === 'scroll' && options?.capture) nativeScroll.add(listener);
    },
    removeEventListener(type: string, listener: () => void) { if (type === 'scroll') nativeScroll.delete(listener); },
  };
  view.scrollerRef.current = scroller;
  const cleanups = [...layoutEffects, ...effects].map(effect => effect());
  return { view, scroller, memory, frames, layoutEffects, cleanups, nativeScroll,
    get requested() { return requested; }, get cancelled() { return cancelled; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame()); },
    dispose() { cleanups.reverse().forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); }); },
  };
}

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
