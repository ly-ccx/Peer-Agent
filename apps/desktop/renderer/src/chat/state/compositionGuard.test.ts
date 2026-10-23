import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompositionGuard, isImeKey } from './compositionGuard.ts';
test('composition owns Enter, Escape, arrows and Backspace before any UI action', () => {
  const guard = createCompositionGuard(), target = new EventTarget(); guard.start(target);
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'Backspace']) assert.equal(guard.keyDown({ key, target }), true);
  guard.end(target); guard.keyUp({ key: 'Enter', target });
  assert.equal(guard.keyDown({ key: 'Enter', target }), false);
});
test('a held composition Enter cannot submit again after compositionend, but the next physical Enter can', () => {
  const guard = createCompositionGuard(), target = new EventTarget(); guard.start(target);
  assert.equal(guard.keyDown({ key: 'Enter', target, isComposing: true }), true); guard.end(target);
  assert.equal(guard.keyDown({ key: 'Enter', target }), true); assert.equal(isImeKey({ key: 'Enter', target }), true);
  guard.keyUp({ key: 'Enter', target }); assert.equal(guard.keyDown({ key: 'Enter', target }), false);
});
test('legacy 229 and Process are IME signals; normal typing and unmount reset have no timed lockout', () => {
  const guard = createCompositionGuard(), target = new EventTarget();
  assert.equal(guard.keyDown({ key: 'Enter', keyCode: 229, target }), true);
  guard.keyUp({ key: 'Enter', target }); assert.equal(guard.keyDown({ key: 'a', target }), false);
  assert.equal(guard.keyDown({ key: 'Enter', target }), false);
  guard.start(target); guard.reset(); assert.equal(isImeKey({ key: 'Escape', target }), false);
  assert.equal(isImeKey({ key: 'Process' }), true);
});
