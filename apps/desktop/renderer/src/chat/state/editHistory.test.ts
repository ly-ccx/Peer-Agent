import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import {
  clearInterruptedMarkers,
  historyBeforeEditedUserMessage,
  serializeConversationMessages,
} from './editHistory.ts';

function message(id: string, role: ChatMsg['role'], content = id): ChatMsg {
  return { id, role, content, timestamp: 1_767_225_600_000 };
}

describe('historical message editing', () => {
  it('retains only messages before the edited user input', () => {
    const history = [
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
    ];

    assert.deepEqual(
      historyBeforeEditedUserMessage(history, 'u2')?.map((entry) => entry.id),
      ['u1', 'a1'],
    );
  });

  it('allows editing the first user input and rejects non-user messages', () => {
    const history = [message('u1', 'user'), message('a1', 'assistant')];
    assert.deepEqual(historyBeforeEditedUserMessage(history, 'u1'), []);
    assert.equal(historyBeforeEditedUserMessage(history, 'a1'), null);
    assert.equal(historyBeforeEditedUserMessage(history, 'missing'), null);
  });

  it('clears historical interrupted markers when conversation continues', () => {
    const history: ChatMsg[] = [
      message('u1', 'user', 'first'),
      { ...message('a1', 'assistant', 'partial'), interrupted: true },
      message('u2', 'user', 'continue'),
    ];
    const cleared = clearInterruptedMarkers(history);
    assert.equal(cleared.changed, true);
    assert.equal(cleared.messages[1]?.interrupted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(cleared.messages[1], 'interrupted'), false);
    assert.equal(clearInterruptedMarkers(cleared.messages).changed, false);
  });

  it('serializes retained messages for conversation replacement', () => {
    const [persisted, interrupted] = serializeConversationMessages([
      message('u1', 'user', 'hello'),
      { ...message('a1', 'assistant', 'partial'), interrupted: true },
    ]);
    assert.deepEqual(persisted, {
      id: 'u1', role: 'user', content: 'hello', segments: undefined, usage: undefined,
      durationMs: undefined, timestamp: 1_767_225_600_000, _compaction: undefined,
      attachments: undefined,
    });
    assert.equal(interrupted?.interrupted, true);
  });
});
