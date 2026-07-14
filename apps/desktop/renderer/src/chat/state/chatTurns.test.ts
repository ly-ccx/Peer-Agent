import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import {
  buildMessageTurnIndex,
  getTurnUserMessage,
  groupMessagesIntoTurns,
  groupMessagesIntoTurnsIncremental,
  isLiveChatTurn,
} from './chatTurns.ts';

function message(id: string, role: ChatMsg['role']): ChatMsg {
  return { id, role, content: id };
}

describe('chat turn grouping', () => {
  it('groups assistant and system messages under the preceding user message', () => {
    const messages = [
      message('system-1', 'system'),
      message('assistant-1', 'assistant'),
      message('user-1', 'user'),
      message('assistant-2', 'assistant'),
      message('user-2', 'user'),
    ];

    const turns = groupMessagesIntoTurns(messages);

    assert.deepEqual(turns.map((turn) => turn.id), ['system-1', 'user-1', 'user-2']);
    assert.deepEqual(turns.map((turn) => turn.messages.map(({ msg }) => msg.id)), [
      ['system-1', 'assistant-1'],
      ['user-1', 'assistant-2'],
      ['user-2'],
    ]);
    assert.equal(getTurnUserMessage(turns[0]!), null);
    assert.equal(getTurnUserMessage(turns[1]!), messages[2]);
  });

  it('preserves message references and original indexes for memoized rendering', () => {
    const messages = [message('user-1', 'user'), message('assistant-1', 'assistant')];
    const [turn] = groupMessagesIntoTurns(messages);

    assert.equal(turn?.messages[0]?.msg, messages[0]);
    assert.equal(turn?.messages[1]?.msg, messages[1]);
    assert.deepEqual(turn?.messages.map(({ index }) => index), [0, 1]);
    assert.equal(turn?.messages[1]?.answeredText, null);
  });

  it('captures the adjacent user reply for an interaction card', () => {
    const turns = groupMessagesIntoTurns([
      message('user-1', 'user'),
      message('assistant-1', 'assistant'),
      { ...message('user-2', 'user'), content: '  option A  ' },
    ]);

    assert.equal(turns[0]?.messages[1]?.answeredText, 'option A');
  });

  it('indexes every message by its containing turn', () => {
    const turns = groupMessagesIntoTurns([
      message('user-1', 'user'),
      message('assistant-1', 'assistant'),
      message('user-2', 'user'),
    ]);

    assert.deepEqual([...buildMessageTurnIndex(turns)], [
      ['user-1', 0],
      ['assistant-1', 0],
      ['user-2', 1],
    ]);
  });

  it('patches only the live tail turn and reuses stable history plus navigation index', () => {
    const initialMessages = [
      message('user-1', 'user'),
      message('assistant-1', 'assistant'),
      message('user-2', 'user'),
      message('assistant-2', 'assistant'),
    ];
    const first = groupMessagesIntoTurnsIncremental(initialMessages);
    const nextTail = { ...initialMessages[3]!, content: 'streamed content' };
    const next = groupMessagesIntoTurnsIncremental(
      [...initialMessages.slice(0, -1), nextTail],
      first,
      true,
    );

    assert.equal(next.turns, first.turns);
    assert.equal(next.messageTurnIndex, first.messageTurnIndex);
    assert.equal(next.liveTurn?.messages.at(-1)?.msg, nextTail);
    assert.equal(next.turns.at(-1)?.messages.at(-1)?.msg, initialMessages[3]);
  });

  it('rebuilds when a same-length tail has a different message id', () => {
    const initial = [message('user', 'user'), message('assistant-1', 'assistant')];
    const first = groupMessagesIntoTurnsIncremental(initial);
    const next = groupMessagesIntoTurnsIncremental(
      [initial[0]!, message('assistant-2', 'assistant')],
      first,
      true,
    );

    assert.notEqual(next.turns, first.turns);
    assert.equal(next.liveTurn, null);
    assert.equal(next.turns[0]?.messages.at(-1)?.msg.id, 'assistant-2');
  });

  it('marks only the turn containing the latest message as live', () => {
    const messages = [
      message('user-1', 'user'),
      message('assistant-1', 'assistant'),
      message('user-2', 'user'),
      message('assistant-2', 'assistant'),
    ];
    const turns = groupMessagesIntoTurns(messages);

    assert.equal(isLiveChatTurn(turns[0]!, messages.at(-1), true), false);
    assert.equal(isLiveChatTurn(turns[1]!, messages.at(-1), true), true);
    assert.equal(isLiveChatTurn(turns[1]!, messages.at(-1), false), false);
  });
});
