import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_LOOP_UNBOUNDED,
  createAgentLoopKernel,
  handleTerminalTextResponse,
  normalizeAgentLoopMaxTurns,
} from './agent-loop-kernel.mjs';

function makeWebContents() {
  const events = [];
  return {
    events,
    send(channel, payload) {
      events.push({ channel, payload });
    },
  };
}

function accountingSnapshot(input = {}) {
  return {
    version: 1,
    conversationId: 'conversation-1',
    contentRevision: 2,
    modelKey: 'model-1',
    revision: 3,
    phase: 'turn_complete',
    compactionEpoch: 0,
    contextWindow: 100_000,
    inputBudget: 100_000,
    compactionThresholdTokens: 80_000,
    authoritativeInputTokens: 84_000,
    percent: 84,
    pressureSource: 'provider_usage',
    pendingUncountedChanges: false,
    pendingContentChars: 0,
    countCapability: { kind: 'observed_usage_only' },
    counterStatus: 'active',
    updatedAt: 1,
    ...input,
  };
}

describe('agent loop kernel', () => {
  it('defaults to an unbounded loop so model terminal responses control completion', () => {
    const loop = createAgentLoopKernel({ webContents: makeWebContents(), streamId: 's0' });

    assert.equal(loop.maxTurns, AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('0'), AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('unlimited'), AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('42'), 42);
  });

  it('accumulates runtime-turn usage and emits its explicit scope', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's1' });

    loop.addUsage({ inputTokens: 2, outputTokens: 3, cacheWriteTokens: 5 });
    loop.addUsage({ inputTokens: 7, cacheReadTokens: 11 });
    loop.sendDone();

    assert.deepEqual(loop.usage, {
      usageScope: 'runtime_turn',
      providerRequestCount: 2,
      inputTokens: 9,
      outputTokens: 3,
      cacheWriteTokens: 5,
      cacheReadTokens: 11,
      totalTokens: 28,
    });
    assert.equal(webContents.events.length, 1);
    assert.equal(webContents.events[0].channel, 'chat:stream:done');
    assert.deepEqual(webContents.events[0].payload.usage, loop.usage);
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
    assert.equal(webContents.events[0].payload.contextAccounting.pressureSource, 'unknown');
  });

  it('keeps provider-request evidence separate from the runtime-turn total', () => {
    const loop = createAgentLoopKernel({ webContents: makeWebContents(), streamId: 's1u' });

    assert.equal(loop.usageAccounting.snapshot().lastRequest, null);
    loop.addUsage({ inputTokens: 100, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 50 });
    assert.deepEqual(loop.usageAccounting.snapshot().lastRequest, {
      usageScope: 'provider_request',
      requestIndex: 1,
      requestPurpose: 'agent',
      inputTokens: 100,
      outputTokens: 5,
      cacheWriteTokens: 0,
      cacheReadTokens: 50,
      totalTokens: 155,
    });

    // 下一轮覆盖，不累加。
    loop.addUsage({ inputTokens: 20, cacheReadTokens: 3 });
    assert.deepEqual(loop.usageAccounting.snapshot().lastRequest, {
      usageScope: 'provider_request',
      requestIndex: 2,
      requestPurpose: 'agent',
      inputTokens: 20,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 3,
      totalTokens: 23,
    });

    assert.equal(loop.usage.inputTokens, 120);
  });

  it('attaches the accepted shared accounting snapshot onto the done payload', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's1ctx',
      accountingIdentity: {
        conversationId: 'conversation-1',
        contentRevision: 2,
        modelKey: 'model-1',
      },
    });
    loop.acceptContextAccounting(accountingSnapshot());

    loop.sendDone();

    const done = webContents.events[0];
    assert.equal(done.channel, 'chat:stream:done');
    assert.equal(done.payload.streamId, 's1ctx');
    assert.equal(done.payload.contextAccounting.authoritativeInputTokens, 84_000);
    assert.equal(done.payload.contextAccounting.percent, 84);
    assert.equal(done.payload.contextAccounting.modelKey, 'model-1');
  });

  it('emits an explicit unknown snapshot when provider authority is unavailable', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's1noctx' });

    loop.sendDone();

    const snapshot = webContents.events[0].payload.contextAccounting;
    assert.equal(snapshot.authoritativeInputTokens, null);
    assert.equal(snapshot.percent, null);
    assert.equal(snapshot.pendingUncountedChanges, true);
  });

  it('marks provider stream deltas pending through the shared lifecycle', () => {
    const webContents = makeWebContents();
    const runtimeEvents = [];
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's1stream',
      emitRuntimeEvent: (event) => runtimeEvents.push(event),
    });

    loop.providerWebContents.send('chat:stream:delta', {
      streamId: 's1stream',
      content: 'streamed text',
    });

    assert.equal(webContents.events[0].channel, 'chat:stream:delta');
    assert.equal(loop.getContextAccounting().phase, 'stream_preview');
    assert.equal(loop.getContextAccounting().pendingContentChars, 13);
    assert.equal(runtimeEvents.at(-1).type, 'context.accounting');
  });

  it('invokes onRound exactly once per addUsage, including when usage is null', () => {
    let rounds = 0;
    const loop = createAgentLoopKernel({
      webContents: makeWebContents(),
      streamId: 's1r',
      onRound: () => {
        rounds += 1;
      },
    });

    loop.addUsage({ inputTokens: 2, outputTokens: 3 });
    loop.addUsage(null); // 无计费 usage 的轮次也应计入。
    loop.addUsage({ inputTokens: 1 });

    assert.equal(rounds, 3);
  });

  it('does not let an onRound callback failure break the loop', () => {
    const loop = createAgentLoopKernel({
      webContents: makeWebContents(),
      streamId: 's1rf',
      onRound: () => {
        throw new Error('sink boom');
      },
    });

    assert.doesNotThrow(() => loop.addUsage({ inputTokens: 5 }));
    assert.equal(loop.usage.inputTokens, 5);
  });

  it('preserves prior billing and context evidence when a later request fails', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's1-error' });
    loop.addUsage(
      { inputTokens: 35, outputTokens: 2 },
      { requestFingerprint: 'request-1' },
    );
    loop.addUsage(null, { requestFingerprint: 'request-2' });
    loop.sendError('provider failed');

    const payload = webContents.events[0].payload;
    assert.equal(payload.usage.usageScope, 'runtime_turn');
    assert.equal(payload.usage.providerRequestCount, 2);
    assert.equal(payload.usage.totalTokens, 37);
    assert.equal(
      loop.usageAccounting.snapshot().lastRequest.requestFingerprint,
      'request-1',
    );
    assert.equal(payload.contextAccounting.version, 1);
  });

  it('caps unsupported tool retries and formats stream errors', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's2',
      maxUnsupportedToolRetries: 1,
    });

    assert.equal(loop.claimUnsupportedToolRetry(), true);
    assert.equal(loop.claimUnsupportedToolRetry(), false);
    loop.sendHttpError(400, 'x'.repeat(500));

    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.equal(webContents.events[0].payload.streamId, 's2');
    assert.equal(webContents.events[0].payload.error.length, 'HTTP 400: '.length + 300);
  });

  it('emits an explicit exhausted error for configured loop budgets', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's2b', maxTurns: 2 });

    loop.addUsage({ inputTokens: 13, outputTokens: 21 });
    loop.sendLoopExhausted();

    assert.equal(webContents.events.length, 1);
    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.match(webContents.events[0].payload.error, /agent_loop_exhausted/);
    assert.match(webContents.events[0].payload.error, /task is not complete/);
    assert.deepEqual(webContents.events[0].payload.usage, loop.usage);
  });

  it('appends the terminal assistant reply before emitting the done snapshot', () => {
    const webContents = makeWebContents();
    const apiMessages = [{ role: 'user', content: 'question' }];
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's3',
    });

    const result = handleTerminalTextResponse({
      text: 'finished',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'done' });
    assert.deepEqual(apiMessages, [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'finished' },
    ]);
    assert.equal(webContents.events[0].channel, 'chat:stream:done');
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
    assert.equal(webContents.events[0].payload.contextAccounting.percent, null);
  });

  it('emits an error for empty terminal text responses', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's4' });

    const result = handleTerminalTextResponse({
      text: '   ',
      apiMessages: [],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'stop', reason: 'empty-response' });
    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.equal(webContents.events[0].payload.streamId, 's4');
    assert.equal(webContents.events[0].payload.error, 'empty response');
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
  });

  it('retries once when text is empty but thinking is present', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's4b' });
    const apiMessages = [];

    const result = handleTerminalTextResponse({
      text: '   ',
      thinking: 'deep reasoning happened here',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'retry', reason: 'thinking-only-response' });
    assert.deepEqual(apiMessages, [{ role: 'user', content: 'thinking-only retry correction' }]);
    assert.deepEqual(webContents.events, []);
  });

  it('reports an error when the thinking-only retry budget is exhausted', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's4b2',
      maxThinkingOnlyRetries: 0,
    });

    const result = handleTerminalTextResponse({
      text: '',
      thinking: 'deep reasoning happened here',
      providerTracePath: '/tmp/thinking-only.jsonl',
      apiMessages: [],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'stop', reason: 'thinking-only-response-exhausted' });
    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.equal(webContents.events[0].payload.streamId, 's4b2');
    assert.equal(
      webContents.events[0].payload.error,
      'thinking-only response /tmp/thinking-only.jsonl',
    );
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
  });

  it('retries once when an empty terminal response follows OpenAI tool results', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's4c' });
    const apiMessages = [
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"status":"success"}' },
    ];

    const result = handleTerminalTextResponse({
      text: '',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'retry', reason: 'empty-response-after-tool-result' });
    assert.deepEqual(apiMessages[2], { role: 'user', content: 'empty retry correction' });
    assert.deepEqual(webContents.events, []);
  });

  it('retries once by appending correction text to Anthropic tool results', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's4d' });
    const apiMessages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"kind":"local_file_ref"}' }],
      },
    ];

    const result = handleTerminalTextResponse({
      text: '',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'retry', reason: 'empty-response-after-tool-result' });
    assert.deepEqual(apiMessages[1].content[1], { type: 'text', text: 'empty retry correction' });
    assert.deepEqual(webContents.events, []);
  });

  it('emits an error when the empty response retry budget is exhausted', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's4e',
      maxEmptyResponseRetries: 0,
    });

    const result = handleTerminalTextResponse({
      text: '',
      apiMessages: [{ role: 'tool', tool_call_id: 't1', content: '{}' }],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'stop', reason: 'empty-response' });
    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.equal(webContents.events[0].payload.streamId, 's4e');
    assert.equal(webContents.events[0].payload.error, 'empty response');
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
  });

  it('adds one retry instruction for unsupported tool claims', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's5' });
    const apiMessages = [];

    const result = handleTerminalTextResponse({
      text: 'fake tool result',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'retry', reason: 'unsupported-tool-claim' });
    assert.deepEqual(apiMessages, [{ role: 'user', content: 'retry correction' }]);
    assert.deepEqual(webContents.events, []);
  });

  it('reports an error after the unsupported tool retry budget is exhausted', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's6',
      maxUnsupportedToolRetries: 0,
    });

    const result = handleTerminalTextResponse({
      text: 'fake tool result',
      providerTracePath: '/tmp/provider-trace.jsonl',
      apiMessages: [],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, {
      action: 'stop',
      reason: 'unsupported-tool-claim-exhausted',
    });
    // 重试耗尽不能伪装成正常 done，否则 UI 会表现为“思考完直接没了”。
    assert.equal(webContents.events[0].channel, 'chat:stream:error');
    assert.equal(webContents.events[0].payload.streamId, 's6');
    assert.equal(
      webContents.events[0].payload.error,
      'unsupported response /tmp/provider-trace.jsonl',
    );
    assert.equal(webContents.events[0].payload.contextAccounting.version, 1);
  });
});

function makeResponseGuard() {
  return {
    emptyModelResponseError: () => 'empty response',
    emptyModelResponseCorrection: () => 'empty retry correction',
    thinkingOnlyResponseError: ({ providerTracePath }) => `thinking-only response ${providerTracePath}`,
    thinkingOnlyResponseCorrection: () => 'thinking-only retry correction',
    shouldRetryNoToolResponse: (text) => text.includes('fake tool result'),
    unsupportedToolResponseCorrection: () => 'retry correction',
    unsupportedToolResponseError: ({ providerTracePath }) => `unsupported response ${providerTracePath}`,
  };
}
