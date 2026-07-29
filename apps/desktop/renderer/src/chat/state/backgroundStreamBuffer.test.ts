import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyBackgroundStreamOperations,
  BackgroundStreamBuffer,
} from './backgroundStreamBuffer.ts';
import type { ChatMsg } from './types.ts';

const baseMessages = (): ChatMsg[] => [
  { id: 'u1', role: 'user', content: 'hello' },
  { id: 'a1', role: 'assistant', content: '', segments: [] },
];

describe('background stream buffer', () => {
  it('coalesces many background chunks into one patch per conversation', () => {
    const buffer = new BackgroundStreamBuffer();

    buffer.pushThinking('a', 'step 1');
    buffer.pushThinking('a', ' step 2');
    buffer.pushText('a', 'hello');
    buffer.pushText('a', ' world');
    buffer.pushText('b', 'other');

    const patches = buffer.drain().sort((left, right) => left.conversationId.localeCompare(right.conversationId));
    assert.equal(patches.length, 2);
    assert.equal(patches[0]?.conversationId, 'a');
    assert.equal(patches[0]?.operations.length, 4);
    assert.equal(patches[1]?.conversationId, 'b');
    assert.equal(patches[1]?.operations.length, 1);
    assert.equal(buffer.size, 0);
  });

  it('applies buffered chunks with the same assistant message semantics', () => {
    const buffer = new BackgroundStreamBuffer();
    buffer.pushThinking('a', 'read', 'summary');
    buffer.pushThinking('a', '\nread', 'summary');
    buffer.pushText('a', 'final');
    buffer.pushText('a', ' answer');

    const [patch] = buffer.drain('a');
    assert.ok(patch);
    const messages = applyBackgroundStreamOperations(baseMessages(), patch.operations);
    const assistant = messages.at(-1)!;

    assert.equal(assistant.content, 'final answer');
    assert.deepEqual(assistant.segments, [
      { type: 'thinking', content: 'read\nread', kind: 'summary' },
      { type: 'text', content: 'final answer' },
    ]);
  });
});
