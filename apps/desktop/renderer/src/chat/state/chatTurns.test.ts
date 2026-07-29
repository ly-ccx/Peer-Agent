import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import {
  buildMessageTurnIndex,
  getChatTurnVirtualizationWeight,
  getTurnUserMessage,
  groupMessagesIntoTurns,
  groupMessagesIntoTurnsIncremental,
  isLiveChatTurn,
  shouldVirtualizeChatTurns,
} from './chatTurns.ts';

function message(id: string, role: ChatMsg['role']): ChatMsg {
  return { id, role, content: id };
}

function messageWithSegments(
  id: string,
  role: ChatMsg['role'],
  segmentCount: number,
  toolCallCount = 0,
): ChatMsg {
  return {
    ...message(id, role),
    segments: Array.from({ length: segmentCount }, (_, index) => (
      index < toolCallCount
        ? { type: 'tool-call' as const, tool: 'bash', args: {}, result: 'ok' }
        : { type: 'thinking' as const, content: 'thinking' }
    )),
  };
}

function messageWithImage(id: string, size: number): ChatMsg {
  return {
    ...message(id, 'user'),
    attachments: [{
      id: `attachment-${id}`,
      name: 'image.png',
      mimeType: 'image/png',
      size,
      kind: 'image',
      dataUrl: 'data:image/png;base64,stub',
    }],
  };
}

describe('chat turn virtualization weight', () => {
  it('virtualizes short conversations that contain very heavy tool timelines', () => {
    const turns = groupMessagesIntoTurns([
      message('u1', 'user'),
      messageWithSegments('a1', 'assistant', 31, 21),
      message('u2', 'user'),
      messageWithSegments('a2', 'assistant', 113, 74),
      message('u3', 'user'),
      messageWithSegments('a3', 'assistant', 19, 9),
    ]);

    assert.deepEqual(getChatTurnVirtualizationWeight(turns), {
      turnCount: 3,
      segmentCount: 163,
      maxTurnSegmentCount: 113,
      toolCallCount: 104,
      attachmentBytes: 0,
      maxTurnAttachmentBytes: 0,
    });
    assert.equal(shouldVirtualizeChatTurns(turns, false), true);
  });

  it('virtualizes short conversations whose historical attachments are collectively heavy', () => {
    const turns = groupMessagesIntoTurns([
      messageWithImage('u1', 169_052),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
      message('u3', 'user'),
      message('a3', 'assistant'),
      messageWithImage('u4', 778_462),
      message('a4', 'assistant'),
      message('u5', 'user'),
      message('a5', 'assistant'),
      message('u6', 'user'),
      message('a6', 'assistant'),
      message('u7', 'user'),
      message('a7', 'assistant'),
    ]);

    assert.deepEqual(getChatTurnVirtualizationWeight(turns), {
      turnCount: 7,
      segmentCount: 0,
      maxTurnSegmentCount: 0,
      toolCallCount: 0,
      attachmentBytes: 947_514,
      maxTurnAttachmentBytes: 778_462,
    });
    assert.equal(shouldVirtualizeChatTurns(turns, false), true);
  });

  it('does not virtualize one or two turn image exchanges solely because one image is large', () => {
    const turns = groupMessagesIntoTurns([
      messageWithImage('u1', 2 * 1024 * 1024),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
    ]);

    assert.equal(shouldVirtualizeChatTurns(turns, false), false);
  });

  it('keeps small conversations unvirtualized and disables virtualization while find is open', () => {
    const small = groupMessagesIntoTurns([
      message('u1', 'user'),
      messageWithSegments('a1', 'assistant', 4, 1),
      message('u2', 'user'),
      messageWithSegments('a2', 'assistant', 5, 2),
    ]);
    const long = groupMessagesIntoTurns(
      Array.from({ length: 22 }, (_, index) => message(`u${index}`, 'user')),
    );

    assert.equal(shouldVirtualizeChatTurns(small, false), false);
    assert.equal(shouldVirtualizeChatTurns(long, false), true);
    assert.equal(shouldVirtualizeChatTurns(long, true), false);
  });
});

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
