import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import { groupMessagesIntoTurns } from './chatTurns.ts';
import {
  areChatTurnRenderPropsEqual,
  type ChatTurnRenderIdentity,
} from './chatTurnRenderEquality.ts';

const callback = () => undefined;
const runtime = {};

function message(id: string, role: ChatMsg['role']): ChatMsg {
  return { id, role, content: id };
}

function identity(turn: ChatTurnRenderIdentity['turn']): ChatTurnRenderIdentity {
  return {
    conversationId: 'conversation-1',
    turn,
    isLive: false,
    streamStartedAt: null,
    isZh: true,
    i18n: runtime,
    onMessageAction: callback,
    onEditMessage: callback,
    onRegenerate: callback,
    onPreviewImage: callback,
    turnIndex: 0,
    onMeasure: callback,
  };
}

describe('chat turn render equality', () => {
  it('keeps a settled turn isolated when the parent renders with a new wrapper object', () => {
    const [turn] = groupMessagesIntoTurns([
      message('user', 'user'),
      message('assistant', 'assistant'),
    ]);
    assert.ok(turn);

    assert.equal(
      areChatTurnRenderPropsEqual(identity(turn), identity({ ...turn })),
      true,
    );
  });

  it('rerenders the active turn when its streaming message reference changes', () => {
    const [turn] = groupMessagesIntoTurns([
      message('user', 'user'),
      message('assistant', 'assistant'),
    ]);
    assert.ok(turn);
    const changed = {
      ...turn,
      messages: [
        turn.messages[0]!,
        { ...turn.messages[1]!, msg: { ...turn.messages[1]!.msg, content: 'delta' } },
      ],
    };

    assert.equal(areChatTurnRenderPropsEqual(identity(turn), identity(changed)), false);
  });

  it('rerenders when a behavior-bearing callback changes', () => {
    const [turn] = groupMessagesIntoTurns([message('user', 'user')]);
    assert.ok(turn);
    const previous = identity(turn);
    const next = { ...identity(turn), onMessageAction: () => undefined };

    assert.equal(areChatTurnRenderPropsEqual(previous, next), false);
  });
});
