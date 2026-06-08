import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULL_CONVERSATION_CAPABILITIES,
  buildConversationView,
  type ChatStreamEvent,
} from '@zeus-atlas/protocol';
import {
  computeMessageActions,
  createAssistantPlaceholder,
  createInitialChatRuntimeState,
  createSseParserState,
  createUserMessage,
  parseSseChunk,
  reduceChatRuntime,
} from './index.ts';

test('parseSseChunk emits named JSON events', () => {
  const result = parseSseChunk(
    createSseParserState(),
    'event: result\ndata: {"content":"hello"}\n\n',
  );

  assert.deepEqual(result.events, [
    {
      event: 'result',
      data: { content: 'hello' },
    },
  ]);
});

test('computeMessageActions respects ConversationView capability gates', () => {
  const view = buildConversationView({
    source: { kind: 'live', conversationId: 1 },
    capabilities: FULL_CONVERSATION_CAPABILITIES,
  });

  assert.deepEqual(
    computeMessageActions({
      role: 'assistant',
      hasContent: true,
      streaming: false,
      origin: 'live',
      view,
    }),
    {
      copy: true,
      regenerate: true,
      delete: false,
      branch: true,
      snapshot: true,
    },
  );
});

test('reduceChatRuntime appends stream result and completes assistant message', () => {
  const user = createUserMessage({ id: 'u1', content: 'hi', timestamp: 1 });
  const assistant = createAssistantPlaceholder({ id: 'a1', timestamp: 2 });
  const base = {
    ...createInitialChatRuntimeState(),
    messages: [user, assistant],
    isStreaming: true,
    currentAssistantMessageId: 'a1',
  };

  const delta: ChatStreamEvent = { event: 'result', data: { content: 'hello' } };
  const completed: ChatStreamEvent = { event: 'complete', data: {} };
  const afterDelta = reduceChatRuntime(base, { type: 'stream_event', event: delta });
  const afterComplete = reduceChatRuntime(afterDelta, { type: 'stream_event', event: completed });

  assert.equal(afterComplete.messages[1]?.content, 'hello');
  assert.equal(afterComplete.messages[1]?.status, 'done');
  assert.equal(afterComplete.isStreaming, false);
});

test('reduceChatRuntime resolves assistant message on run_complete (runId-scoped long stream terminal)', () => {
  // 模拟 client-tool pause-resume 场景：chat round SSE 已关，后端通过
  // /:runId/stream 长流发出 run_complete 表示整个 run 终态。少了这个分支
  // 会让 assistant message 永远停在 streaming，UI 显示「正在思考...」。
  const user = createUserMessage({ id: 'u1', content: 'hi', timestamp: 1 });
  const assistant = createAssistantPlaceholder({ id: 'a1', timestamp: 2 });
  const base = {
    ...createInitialChatRuntimeState(),
    messages: [user, assistant],
    isStreaming: true,
    currentAssistantMessageId: 'a1',
  };

  const delta: ChatStreamEvent = { event: 'result', data: { content: '看完了' } };
  const runComplete: ChatStreamEvent = {
    event: 'run_complete',
    data: { runId: 'user-msg-uuid-1', runStatus: 'completed', conversationId: 99 },
  };
  const afterDelta = reduceChatRuntime(base, { type: 'stream_event', event: delta });
  const afterRunComplete = reduceChatRuntime(afterDelta, {
    type: 'stream_event',
    event: runComplete,
  });

  assert.equal(afterRunComplete.messages[1]?.content, '看完了');
  assert.equal(afterRunComplete.messages[1]?.status, 'done');
  assert.equal(afterRunComplete.isStreaming, false);
  assert.equal(afterRunComplete.currentAssistantMessageId, undefined);
});

test('reduceChatRuntime renders plain content_delta events as assistant content', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });

  const afterDelta = reduceChatRuntime(base, {
    type: 'stream_event',
    event: { event: 'content_delta', data: { content: 'hello' } },
  });

  assert.equal(afterDelta.messages[0]?.content, 'hello');
  assert.equal(afterDelta.messages[0]?.thinkingProcess, undefined);
});

test('reduceChatRuntime promotes ReAct thinking content to final assistant content when no answer delta exists', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });

  const withThinking = reduceChatRuntime(base, {
    type: 'stream_event',
    event: { event: 'react_start', data: { maxIterations: 3, toolCount: 0 } },
  });
  const afterDelta = reduceChatRuntime(withThinking, {
    type: 'stream_event',
    event: { event: 'content_delta', data: { content: '我可以帮你查日程' } },
  });
  const afterComplete = reduceChatRuntime(afterDelta, {
    type: 'stream_event',
    event: { event: 'complete', data: {} },
  });

  assert.equal(afterComplete.messages[0]?.content, '我可以帮你查日程');
  assert.equal(afterComplete.messages[0]?.thinkingProcess?.iterations[0]?.thinkingContent, '我可以帮你查日程');
  assert.equal(afterComplete.messages[0]?.status, 'done');
});

test('reduceChatRuntime keeps ReAct rounds separate when execution iteration index resets (local-tool pause-resume)', () => {
  // 本地工具 pause-resume 时每个 execution 的 iteration 都从 1 重数。轮次必须按
  // 「tool 之后的 thinking = 新一轮」切分，而不是按后端序号 findIndex 合并，否则
  // 两个 execution 的「iteration 1」会塌缩成一个 → 思考全堆上、工具全堆下。
  let state = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const fire = (event: string, data: unknown) => {
    state = reduceChatRuntime(state, {
      type: 'stream_event',
      event: { event, data } as ChatStreamEvent,
    });
  };

  // exec-1
  fire('iteration_start', { iteration: 1, message: '正在思考...' });
  fire('content_delta', { content: '先确认登录态' });
  fire('tool_calling', { toolCallId: 't1', toolId: 'whoami' });
  fire('tool_result', { toolCallId: 't1', content: '槿柏 246944' });
  // exec-2：pause-resume 后 iteration 序号重置回 1
  fire('iteration_start', { iteration: 1, message: '正在基于工具结果继续思考...' });
  fire('content_delta', { content: '登录正常，开始搜索' });
  fire('tool_calling', { toolCallId: 't2', toolId: 'ata-all' });

  const iterations = state.messages[0]?.thinkingProcess?.iterations ?? [];
  assert.equal(iterations.length, 2, '两个 execution 的同序号轮次不应合并');
  assert.equal(iterations[0]?.thinkingContent, '先确认登录态');
  assert.equal(iterations[0]?.toolCards[0]?.toolId, 'whoami');
  assert.equal(iterations[1]?.thinkingContent, '登录正常，开始搜索');
  assert.equal(iterations[1]?.toolCards[0]?.toolId, 'ata-all');
});

test('reduceChatRuntime uses (executionUuid, iteration) composite key — separates execs and is idempotent on forwardByRun replay', () => {
  let state = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const fire = (event: string, data: unknown) => {
    state = reduceChatRuntime(state, {
      type: 'stream_event',
      event: { event, data } as ChatStreamEvent,
    });
  };
  // 治本：后端 sendEvent 给每个事件注入 (executionUuid, iteration)。
  const e1 = (extra: Record<string, unknown>) => ({ executionUuid: 'exec-1', iteration: 1, ...extra });
  const e2 = (extra: Record<string, unknown>) => ({ executionUuid: 'exec-2', iteration: 1, ...extra });

  fire('iteration_start', e1({ message: '正在思考...' }));
  fire('content_delta', e1({ content: '先确认登录态' }));
  fire('tool_calling', e1({ toolCallId: 't1', toolId: 'whoami' }));
  // exec-2 序号重置回 1，但 executionUuid 不同 → 复合 key 区分，不塌缩
  fire('iteration_start', e2({ message: '正在基于工具结果继续思考...' }));
  fire('content_delta', e2({ content: '登录正常，开始搜索' }));
  fire('tool_calling', e2({ toolCallId: 't2', toolId: 'ata-all' }));

  let iters = state.messages[0]?.thinkingProcess?.iterations ?? [];
  assert.equal(iters.length, 2, '不同 execution 的同序号轮次不合并');
  assert.equal(iters[0]?.thinkingContent, '先确认登录态');
  assert.equal(iters[1]?.thinkingContent, '登录正常，开始搜索');

  // forwardByRun 从头重放 exec-1（断流恢复）：复合 key 命中原轮，幂等，不产生重复
  fire('iteration_start', e1({ message: '正在思考...' }));
  fire('content_delta', e1({ content: '先确认登录态' }));
  fire('tool_calling', e1({ toolCallId: 't1', toolId: 'whoami' }));

  iters = state.messages[0]?.thinkingProcess?.iterations ?? [];
  assert.equal(iters.length, 2, '重放同 execution 同序号命中原轮，不新增轮');
  assert.equal(iters[0]?.thinkingContent, '先确认登录态', '重放重建得到相同内容，不重复累加');
  assert.equal(iters[0]?.toolCards.length, 1, '工具按 toolCallId 幂等，不重复');
});

test('reduceChatRuntime tracks pending human confirmation and removes it when resolved', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });

  const withPending = reduceChatRuntime(base, {
    type: 'stream_event',
    event: {
      event: 'human_confirmation_required',
      data: {
        confirmationId: 'c1',
        executionUuid: 'e1',
        title: 'confirm',
      },
    },
  });

  assert.equal(withPending.pendingConfirmations.length, 1);
  assert.equal(withPending.messages[0]?.pendingHumanConfirmation?.confirmationId, 'c1');

  const resolved = reduceChatRuntime(withPending, {
    type: 'confirmation_resolved',
    confirmation: {
      confirmationId: 'c1',
      executionUuid: 'e1',
      decision: 'approve',
      resolvedAt: '2026-05-14T00:00:00.000Z',
      status: 'resolved',
    },
  });

  assert.equal(resolved.pendingConfirmations.length, 0);
  assert.equal(resolved.messages[0]?.pendingHumanConfirmation, undefined);
  assert.equal(resolved.messages[0]?.resolvedHumanConfirmation?.decision, 'approve');
});

test('reduceChatRuntime captures run_started runId without spawning an assistant message', () => {
  const base = createInitialChatRuntimeState();

  const withRun = reduceChatRuntime(base, {
    type: 'stream_event',
    event: { event: 'run_started', data: { runId: 'user-msg-uuid-7754' } },
  });

  assert.equal(withRun.currentRunId, 'user-msg-uuid-7754');
  assert.equal(withRun.messages.length, 0);
  assert.equal(withRun.currentAssistantMessageId, undefined);
});

test('reduceChatRuntime renders a client tool lifecycle from dispatching to completed', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });

  const afterDispatch = reduceChatRuntime(base, {
    type: 'stream_event',
    event: {
      event: 'client_tool_dispatching',
      data: {
        toolCallId: 'tc-1',
        suspensionUuid: 'sus-1',
        capabilityId: 'local.shell.exec',
        toolName: 'local.shell.exec',
        displayName: '本地 Bash 执行',
        argumentsPreview: { command: 'ls' },
        occurredAt: '2026-05-28T00:00:00.000Z',
      },
    },
  });

  const dispatchedCard =
    afterDispatch.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0];
  assert.equal(dispatchedCard?.toolCallId, 'tc-1');
  assert.equal(dispatchedCard?.displayName, '本地 Bash 执行');
  assert.equal(dispatchedCard?.clientToolStatus, 'dispatching');
  assert.equal(dispatchedCard?.status, 'running');
  assert.deepEqual(dispatchedCard?.inputArguments, { command: 'ls' });

  const afterRunning = reduceChatRuntime(afterDispatch, {
    type: 'stream_event',
    event: {
      event: 'client_tool_running',
      data: { toolCallId: 'tc-1' },
    },
  });
  assert.equal(
    afterRunning.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0]?.clientToolStatus,
    'running',
  );

  const afterStdout = reduceChatRuntime(afterRunning, {
    type: 'stream_event',
    event: { event: 'client_tool_stdout_delta', data: { toolCallId: 'tc-1', delta: 'hello\n' } },
  });
  const afterStdout2 = reduceChatRuntime(afterStdout, {
    type: 'stream_event',
    event: { event: 'client_tool_stdout_delta', data: { toolCallId: 'tc-1', delta: 'world\n' } },
  });
  assert.equal(
    afterStdout2.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0]?.stdout,
    'hello\nworld\n',
  );

  const afterStderr = reduceChatRuntime(afterStdout2, {
    type: 'stream_event',
    event: { event: 'client_tool_stderr_delta', data: { toolCallId: 'tc-1', delta: 'warn\n' } },
  });
  assert.equal(
    afterStderr.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0]?.stderr,
    'warn\n',
  );

  const afterResult = reduceChatRuntime(afterStderr, {
    type: 'stream_event',
    event: {
      event: 'client_tool_result_received',
      data: {
        toolCallId: 'tc-1',
        status: 'success',
        outputPreview: 'hello\nworld\n',
        durationMs: 420,
        receivedAt: '2026-05-28T00:00:02.000Z',
      },
    },
  });
  const finalCard = afterResult.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0];
  assert.equal(finalCard?.clientToolStatus, 'completed');
  assert.equal(finalCard?.status, 'completed');
  assert.equal(finalCard?.resultContent, 'hello\nworld\n');
  assert.equal(finalCard?.durationMs, 420);
});

test('reduceChatRuntime maps client_tool_result_received failure to error status', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const dispatched = reduceChatRuntime(base, {
    type: 'stream_event',
    event: {
      event: 'client_tool_dispatching',
      data: {
        toolCallId: 'tc-fail',
        suspensionUuid: 'sus-fail',
        capabilityId: 'local.shell.exec',
        toolName: 'local.shell.exec',
        occurredAt: '2026-05-28T00:00:00.000Z',
      },
    },
  });

  const failed = reduceChatRuntime(dispatched, {
    type: 'stream_event',
    event: {
      event: 'client_tool_result_received',
      data: {
        toolCallId: 'tc-fail',
        status: 'failed',
        errorMessage: 'permission denied',
        receivedAt: '2026-05-28T00:00:01.000Z',
      },
    },
  });

  const card = failed.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0];
  assert.equal(card?.clientToolStatus, 'failed');
  assert.equal(card?.status, 'error');
  assert.equal(card?.resultSummary, 'permission denied');
});

test('reduceChatRuntime toggles thinking process status on agent_run_suspended/resuming', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const started = reduceChatRuntime(base, {
    type: 'stream_event',
    event: { event: 'react_start', data: { maxIterations: 3, toolCount: 0 } },
  });

  const suspended = reduceChatRuntime(started, {
    type: 'stream_event',
    event: {
      event: 'agent_run_suspended',
      data: {
        conversationId: 1,
        messageId: 100,
        suspensionUuid: 'sus-1',
        toolCallId: 'tc-1',
        reason: 'awaiting_client_tool_result',
        suspendedAt: '2026-05-28T00:00:00.000Z',
      },
    },
  });
  assert.equal(suspended.messages[0]?.thinkingProcess?.status, 'waiting_user');

  const resuming = reduceChatRuntime(suspended, {
    type: 'stream_event',
    event: {
      event: 'agent_run_resuming',
      data: {
        conversationId: 1,
        messageId: 100,
        suspensionUuid: 'sus-1',
        toolCallId: 'tc-1',
        reason: 'client_tool_result_received',
        resumedAt: '2026-05-28T00:00:02.000Z',
      },
    },
  });
  assert.equal(resuming.messages[0]?.thinkingProcess?.status, 'running');
});

test('reduceChatRuntime treats stream_paused the same as suspension for thinking status', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const started = reduceChatRuntime(base, {
    type: 'stream_event',
    event: { event: 'react_start', data: { maxIterations: 3, toolCount: 0 } },
  });

  const paused = reduceChatRuntime(started, {
    type: 'stream_event',
    event: {
      event: 'stream_paused',
      data: {
        conversationId: 1,
        messageId: 100,
        reason: 'awaiting_client_tool_result',
        pausedAt: '2026-05-28T00:00:00.000Z',
        resumeHint: 'GET /api/chat/agent-runs/:runId',
      },
    },
  });
  assert.equal(paused.messages[0]?.thinkingProcess?.status, 'waiting_user');
});

test('reduceChatRuntime client_tool_acked / waiting_user_consent stay in running umbrella status', () => {
  const base = reduceChatRuntime(createInitialChatRuntimeState(), {
    type: 'assistant_stream_started',
    messageId: 'a1',
    timestamp: 1,
  });
  const dispatched = reduceChatRuntime(base, {
    type: 'stream_event',
    event: {
      event: 'client_tool_dispatching',
      data: {
        toolCallId: 'tc-a',
        suspensionUuid: 'sus-a',
        capabilityId: 'local.shell.exec',
        toolName: 'local.shell.exec',
        occurredAt: '2026-05-28T00:00:00.000Z',
      },
    },
  });

  const acked = reduceChatRuntime(dispatched, {
    type: 'stream_event',
    event: { event: 'client_tool_acked', data: { toolCallId: 'tc-a' } },
  });
  const card1 = acked.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0];
  assert.equal(card1?.clientToolStatus, 'acked');
  assert.equal(card1?.status, 'running');

  const waiting = reduceChatRuntime(acked, {
    type: 'stream_event',
    event: {
      event: 'client_tool_waiting_user_consent',
      data: { toolCallId: 'tc-a', consentReason: 'high-risk' },
    },
  });
  const card2 = waiting.messages[0]?.thinkingProcess?.iterations[0]?.toolCards[0];
  assert.equal(card2?.clientToolStatus, 'waiting_user_consent');
  assert.equal(card2?.status, 'running');
});
