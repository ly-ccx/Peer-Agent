import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
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

  it('emits the unsupported tool fallback after retry budget is exhausted', () => {
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
    assert.deepEqual(webContents.events, [{
      channel: 'chat:stream:error',
      payload: { streamId: 's6', error: 'unsupported fallback' },
    }]);
  });
});

function makeResponseGuard() {
  return {
    emptyModelResponseError: () => 'empty response',
    shouldRetryNoToolResponse: (text) => text.includes('fake tool result'),
    unsupportedToolResponseCorrection: () => 'retry correction',
    unsupportedToolResponseFallback: () => 'unsupported fallback',
  };
}
