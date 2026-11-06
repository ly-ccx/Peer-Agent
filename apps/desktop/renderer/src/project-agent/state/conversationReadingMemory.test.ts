import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationReadingMemory, type ReadingSnapshot } from './conversationReadingMemory.ts';
const snapshot: ReadingSnapshot = { following: false, top: 900, anchor: { key: 'message-a', delta: -10, messageId: 'a' }, heights: [['message-a', 100]] };
test('navigation returns to the same identity and bounds session geometry without holding message facts', () => {
  const memory = createConversationReadingMemory(2); memory.save('bot-a', snapshot);
  memory.save('bot-b', { ...snapshot, following: true, anchor: null });
  assert.equal(memory.read('bot-a')?.anchor?.messageId, 'a'); assert.equal(memory.read('bot-b')?.following, true);
  memory.save('bot-a', { ...snapshot, top: 901 }); memory.save('bot-c', snapshot);
  assert.equal(memory.read('bot-a')?.top, 901); assert.equal(memory.read('bot-b'), undefined);
  memory.save('large', { ...snapshot, heights: Array.from({ length: 500 }, (_, index) => [`message-${index}`, index] as const) });
  assert.equal(memory.read('large')?.heights.length, 160);
});
