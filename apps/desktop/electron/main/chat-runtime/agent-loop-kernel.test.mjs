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

describe('agent loop kernel', () => {
  it('defaults to an unbounded loop so model terminal responses control completion', () => {
    const loop = createAgentLoopKernel({ webContents: makeWebContents(), streamId: 's0' });

    assert.equal(loop.maxTurns, AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('0'), AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('unlimited'), AGENT_LOOP_UNBOUNDED);
    assert.equal(normalizeAgentLoopMaxTurns('42'), 42);
  });

  it('accumulates usage and emits done events with the shared usage object', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's1' });

    loop.addUsage({ inputTokens: 2, outputTokens: 3, cacheWriteTokens: 5 });
    loop.addUsage({ inputTokens: 7, cacheReadTokens: 11 });
    loop.sendDone();

    assert.deepEqual(loop.usage, {
      inputTokens: 9,
      outputTokens: 3,
      cacheWriteTokens: 5,
      cacheReadTokens: 11,
    });
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:done',
      payload: { streamId: 's1', usage: loop.usage },
    }]);
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

  it('emits done for terminal text responses', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's3' });
    const apiMessages = [];

    const result = handleTerminalTextResponse({
      text: 'finished',
      apiMessages,
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'done' });
    assert.deepEqual(apiMessages, []);
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:done',
      payload: { streamId: 's3', usage: loop.usage },
    }]);
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
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:error',
      payload: { streamId: 's4', error: 'empty response' },
    }]);
  });

  it('emits done (not error) when text is empty but thinking is present', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({ webContents, streamId: 's4b' });

    const result = handleTerminalTextResponse({
      text: '   ',
      thinking: 'deep reasoning happened here',
      apiMessages: [],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, { action: 'done', reason: 'thinking-only' });
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:done',
      payload: { streamId: 's4b', usage: loop.usage },
    }]);
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
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:error',
      payload: { streamId: 's4e', error: 'empty response' },
    }]);
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

  it('silently completes after the unsupported tool retry budget is exhausted', () => {
    const webContents = makeWebContents();
    const loop = createAgentLoopKernel({
      webContents,
      streamId: 's6',
      maxUnsupportedToolRetries: 0,
    });

    const result = handleTerminalTextResponse({
      text: 'fake tool result',
      apiMessages: [],
      loop,
      responseGuard: makeResponseGuard(),
    });

    assert.deepEqual(result, {
      action: 'stop',
      reason: 'unsupported-tool-claim-exhausted',
    });
    // 不再向用户弹出守卫文案：以 done 静默收尾，不发 error。
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:done',
      payload: { streamId: 's6', usage: loop.usage },
    }]);
  });
});

function makeResponseGuard() {
  return {
    emptyModelResponseError: () => 'empty response',
    emptyModelResponseCorrection: () => 'empty retry correction',
    shouldRetryNoToolResponse: (text) => text.includes('fake tool result'),
    unsupportedToolResponseCorrection: () => 'retry correction',
  };
}
