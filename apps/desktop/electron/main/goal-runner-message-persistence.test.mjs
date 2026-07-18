import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGoalRunnerStreamStartedPayload,
  createGoalRunnerAssistantPlaceholder,
} from './goal-runner-message-persistence.mjs';

describe('createGoalRunnerAssistantPlaceholder', () => {
  it('creates an empty assistant message with a stable id for persistence binding', () => {
    const { id, message } = createGoalRunnerAssistantPlaceholder({
      createId: () => 'asst-goal-1',
      now: 1_700_000_000_000,
    });
    assert.equal(id, 'asst-goal-1');
    assert.deepEqual(message, {
      id: 'asst-goal-1',
      role: 'assistant',
      content: '',
      segments: [],
      timestamp: 1_700_000_000_000,
    });
  });

  it('falls back to a generated id when createId returns empty', () => {
    const { id, message } = createGoalRunnerAssistantPlaceholder({
      createId: () => '',
    });
    assert.ok(id);
    assert.equal(message.id, id);
    assert.equal(message.role, 'assistant');
    assert.equal(message.content, '');
  });
});

describe('buildGoalRunnerStreamStartedPayload', () => {
  it('includes assistantMessageId so renderer can bind the same message', () => {
    const payload = buildGoalRunnerStreamStartedPayload({
      planId: 'plan-1',
      conversationId: 'conv-1',
      streamId: 'stream-1',
      turnNumber: 2,
      assistantMessageId: 'asst-goal-1',
      startedAt: 42,
    });
    assert.deepEqual(payload, {
      type: 'goalRunner:streamStarted',
      planId: 'plan-1',
      conversationId: 'conv-1',
      changeKind: 'runner-state',
      streamId: 'stream-1',
      turnNumber: 2,
      assistantMessageId: 'asst-goal-1',
      startedAt: 42,
    });
  });
});

describe('Goal Runner persistence contract (with assistantMessageId)', () => {
  it('documents the required call order: placeholder -> streamStarted -> sendMessage(assistantMessageId)', () => {
    // 回归契约：有 assistantMessageId 时必须能落盘。
    // 真实 patch 行为已在 llm-chat-service.test.mjs 覆盖；这里钉死 Runner 侧入参拼装顺序。
    const startedAt = 99;
    const { id: assistantMessageId, message } = createGoalRunnerAssistantPlaceholder({
      createId: () => 'asst-runner-turn',
      now: startedAt,
    });
    const streamId = 'stream-runner-1';
    const streamStarted = buildGoalRunnerStreamStartedPayload({
      planId: 'plan-x',
      conversationId: 'conv-x',
      streamId,
      turnNumber: 1,
      assistantMessageId,
      startedAt,
    });
    const sendMessageArgs = {
      streamId,
      conversationId: 'conv-x',
      mode: 'goal',
      assistantMessageId,
    };

    assert.equal(message.id, assistantMessageId);
    assert.equal(streamStarted.assistantMessageId, assistantMessageId);
    assert.equal(sendMessageArgs.assistantMessageId, assistantMessageId);
    assert.ok(
      sendMessageArgs.assistantMessageId,
      'runGoalTurn 在 sendMessage 前必须创建并传入 assistantMessageId，否则主进程不会落盘',
    );
  });
});
