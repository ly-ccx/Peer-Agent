import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeLoadedMessagesWithLiveTail } from './compactionLiveTailMerge.ts';
import type { ChatMsg } from './types.ts';

function assistant(overrides: Partial<ChatMsg>): ChatMsg {
  return {
    id: 'assistant',
    role: 'assistant',
    content: '',
    timestamp: 0,
    ...overrides,
  };
}

describe('mergeLoadedMessagesWithLiveTail', () => {
  it('dedupes an existing assistant snapshot before appending the live tail', () => {
    const liveTail = assistant({
      id: 'live-assistant',
      content: 'partial answer',
      segments: [{ type: 'thinking', content: 'thinking' }],
    });
    const loaded: ChatMsg[] = [
      { id: 'u1', role: 'user', content: 'continue', timestamp: 1 },
      { ...liveTail },
    ];

    const merged = mergeLoadedMessagesWithLiveTail(loaded, liveTail, { streamMatches: true });

    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], loaded[0]);
    assert.equal(merged[1], liveTail);
  });

  it('appends the live tail when loaded has no matching snapshot', () => {
    const liveTail = assistant({ id: 'live-assistant', content: 'partial answer' });
    const loaded: ChatMsg[] = [
      { id: 'u1', role: 'user', content: 'continue', timestamp: 1 },
      assistant({ id: 'older-assistant', content: 'older answer' }),
    ];

    const merged = mergeLoadedMessagesWithLiveTail(loaded, liveTail, { streamMatches: true });

    assert.equal(merged.length, 3);
    assert.deepEqual(merged.slice(0, 2), loaded);
    assert.equal(merged[2], liveTail);
  });

  it('does not merge live tail when the stream no longer matches', () => {
    const liveTail = assistant({ id: 'live-assistant', content: 'partial answer' });
    const loaded: ChatMsg[] = [
      { id: 'u1', role: 'user', content: 'continue', timestamp: 1 },
      { ...liveTail },
    ];

    const merged = mergeLoadedMessagesWithLiveTail(loaded, liveTail, { streamMatches: false });

    assert.deepEqual(merged, loaded);
    assert.notEqual(merged, loaded);
  });

  it('can dedupe by content and segments when ids differ', () => {
    const liveTail = assistant({
      id: 'live-assistant',
      content: 'partial answer',
      segments: [{ type: 'text', content: 'partial answer' }],
    });
    const loadedSnapshot = assistant({
      id: 'persisted-snapshot',
      content: 'partial answer',
      segments: [{ type: 'text', content: 'partial answer' }],
    });

    const merged = mergeLoadedMessagesWithLiveTail([loadedSnapshot], liveTail, { streamMatches: true });

    assert.deepEqual(merged, [liveTail]);
  });
});
