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

test('mounting and leaving a conversation invoke frame APIs with their browser receiver', () => {
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
    '../state/conversationReadingMemory': { conversationReadingMemory: createConversationReadingMemory() },
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
  const view = exports.useConversationWindow([], null, 0, 0,
    { identity: 'clicked-bot', ready: true, hasOlder: false, locateMessage: async () => false });
  const scroller = { scrollTop: 0, scrollHeight: 720, clientHeight: 320,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  view.scrollerRef.current = scroller;
  const cleanups = [...layoutEffects, ...effects].map(effect => effect());
  assert.equal(requested, 1);
  assert.equal(scroller.scrollTop, 720, 'opening a following conversation still commits its initial position');
  cleanups.reverse().forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
  assert.equal(cancelled, 1);
  assert.equal(frames.size, 0, 'leaving the conversation releases the pending native frame');
});
