import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGoalRunnerStreamStartedPayload,
  createGoalRunnerAssistantPlaceholder,
  mapGoalTurnOutcome,
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

describe('mapGoalTurnOutcome', () => {
  // Independent outcome fields must survive together, not just in isolation.
  // Matrix: interrupted absent/true × recoverable unknown/true/false.
  for (const interrupted of [undefined, true]) {
    for (const recoverable of [undefined, true, false]) {
      it(`preserves interrupted=${interrupted ?? 'absent'} × recoverable=${recoverable ?? 'unknown'}`, () => {
        const mapped = mapGoalTurnOutcome({
          terminalStatus: 'error',
          failureReason: '  provider response dropped after tool completion  ',
          toolCallCount: 2,
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(recoverable === undefined ? {} : { recoverable }),
        });
        assert.equal(mapped.failureReason, 'provider response dropped after tool completion');
        assert.equal(mapped.failed, true);
        assert.equal(mapped.terminalStatus, 'error');
        assert.equal(mapped.toolCallCount, 2);
        assert.equal(mapped.interrupted, interrupted);
        assert.equal(Object.hasOwn(mapped, 'interrupted'), interrupted === true);
        assert.equal(mapped.recoverable, recoverable);
        assert.equal(Object.hasOwn(mapped, 'recoverable'), recoverable !== undefined);
      });
    }
  }

  it('keeps a mid-turn stream drop recoverable instead of rewriting it as a permanent failure', () => {
    const mapped = mapGoalTurnOutcome({
      terminalStatus: 'error',
      failureReason: 'empty_model_response: the model returned no text and no tool call',
      interrupted: true,
      toolCallCount: 2,
    });
    assert.equal(mapped.failed, true);
    assert.match(mapped.failureReason, /empty_model_response/);
    assert.equal(mapped.interrupted, true);
    assert.equal(Object.hasOwn(mapped, 'recoverable'), false);
    assert.equal(mapped.toolCallCount, 2);
    assert.notEqual(mapped.failureReason, 'Goal Runner turn stream failed');
  });

  it('preserves an explicit unrecoverable decision', () => {
    const mapped = mapGoalTurnOutcome({
      terminalStatus: 'error',
      failureReason: 'Host visual review failed',
      recoverable: false,
      toolCallCount: 1,
    });
    assert.equal(mapped.failed, true);
    assert.equal(mapped.recoverable, false);
    assert.equal(mapped.failureReason, 'Host visual review failed');
    assert.equal(Object.hasOwn(mapped, 'interrupted'), false);
  });

  it('maps requested user input and aborted turns without marking them failed', () => {
    assert.deepEqual(mapGoalTurnOutcome({
      requestedUserInput: true,
      terminalStatus: 'done',
      toolCallCount: 1,
    }), {
      requestedUserInput: true,
      blockedReason: 'requested_user_input',
      terminalStatus: 'done',
      toolCallCount: 1,
    });
    assert.deepEqual(mapGoalTurnOutcome({
      terminalStatus: 'aborted',
      toolCallCount: 0,
    }), {
      blocked: true,
      blockedReason: 'Goal Runner turn aborted',
      terminalStatus: 'aborted',
      toolCallCount: 0,
    });
  });
});
