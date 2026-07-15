import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import {
  buildMessageRailItems,
  buildMessageRailItemsIncremental,
} from './messageRailItems.ts';

function message(id: string, role: ChatMsg['role'], content: string = id): ChatMsg {
  return { id, role, content };
}

describe('message rail projection', () => {
  it('projects user messages and compaction markers in timeline order', () => {
    const items = buildMessageRailItems([
      message('user-1', 'user', ' first '),
      message('assistant-1', 'assistant'),
      {
        ...message('compact-1', 'assistant'),
        compaction: {
          method: 'rolling',
          originalMessageCount: 2,
          beforeTokens: 100,
          afterTokens: 20,
          summary: 'summary',
        },
      },
      message('user-2', 'user', 'second'),
      {
        ...message('compact-2', 'assistant'),
        compaction: {
          method: 'rolling',
          originalMessageCount: 4,
          beforeTokens: 200,
          afterTokens: 30,
          summary: 'newer summary',
        },
      },
      message('user-3', 'user', 'third'),
    ], 'Compacted');

    assert.deepEqual(items, [
      { kind: 'message', id: 'user-1', text: 'first', messageNumber: 1 },
      { kind: 'compaction', id: 'compact-1', text: 'Compacted' },
      { kind: 'message', id: 'user-2', text: 'second', messageNumber: 2 },
      { kind: 'compaction', id: 'compact-2', text: 'Compacted' },
      { kind: 'message', id: 'user-3', text: 'third', messageNumber: 3 },
    ]);
  });

  it('reuses the projection for a same-length streaming assistant tail update', () => {
    const initial = [message('user', 'user'), message('assistant', 'assistant', 'a')];
    const first = buildMessageRailItemsIncremental(initial, 'Compacted');
    const next = buildMessageRailItemsIncremental(
      [initial[0]!, { ...initial[1]!, content: 'abcd' }],
      'Compacted',
      first,
      true,
    );

    assert.equal(next, first);
  });

  it('rebuilds when the caller does not declare a streaming tail-only update', () => {
    const initial = [message('user', 'user', 'before'), message('assistant', 'assistant')];
    const first = buildMessageRailItemsIncremental(initial, 'Compacted');
    const edited = [message('user', 'user', 'after'), initial[1]!];
    const next = buildMessageRailItemsIncremental(edited, 'Compacted', first, false);

    assert.notEqual(next, first);
    assert.equal(next.items[0]?.text, 'after');
  });
});
