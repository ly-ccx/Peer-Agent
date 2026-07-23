import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import { historyBeforeEditedUserMessage, serializeConversationMessages } from './editHistory.ts';

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

  it('serializes retained messages for conversation replacement', () => {
    const [persisted] = serializeConversationMessages([message('u1', 'user', 'hello')]);
    assert.deepEqual(persisted, {
      id: 'u1', role: 'user', content: 'hello', segments: undefined, usage: undefined,
      durationMs: undefined, timestamp: 1_767_225_600_000, _compaction: undefined,
      attachments: undefined, interrupted: undefined,
    });
  });
});
