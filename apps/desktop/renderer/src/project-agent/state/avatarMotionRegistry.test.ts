import assert from 'node:assert/strict';
import test from 'node:test';
import { createAvatarMotionRegistry } from './avatarMotionRegistry.ts';
test('200 avatars share observation; only intersecting, visible-window, motion-enabled avatars animate', () => {
  let updates: (id: string, visible: boolean) => void, signal: () => void;
  let allowed = true, created = 0, disconnected = 0, unsubscribed = 0;
  const active = new Map<string, boolean>();
  const registry = createAvatarMotionRegistry<string>({
    observe: update => { created++; updates = update; return { observe() {}, unobserve() {}, disconnect() { disconnected++; } }; },
    allowed: () => allowed, subscribe: update => { signal = update; return () => { unsubscribed++; }; },
  });
  const stops = Array.from({ length: 200 }, (_, i) => registry.observe(String(i), value => active.set(String(i), value)));
  assert.equal(created, 1); assert.equal([...active.values()].filter(Boolean).length, 0);
  for (let i = 0; i < 8; i++) updates!(String(i), true);
  assert.equal([...active.values()].filter(Boolean).length, 8);
  allowed = false; signal!(); assert.equal([...active.values()].filter(Boolean).length, 0);
  allowed = true; signal!(); assert.equal([...active.values()].filter(Boolean).length, 8);
  updates!('0', false); assert.equal(active.get('0'), false);
  stops.forEach(stop => stop()); assert.equal(disconnected, 1); assert.equal(unsubscribed, 1);
  updates!('0', true); assert.equal(active.get('0'), false, 'late observations cannot update an unmounted avatar');
});
