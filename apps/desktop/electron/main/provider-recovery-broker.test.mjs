import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canReplayProviderAttempt,
  createProviderAttemptStream,
  isProviderTransportFailure,
  orderProviderCandidates,
} from './chat-runtime/provider-recovery-broker.mjs';

describe('provider recovery broker', () => {
  it('classifies enterprise domain blocking as a transport failure', () => {
    assert.equal(
      isProviderTransportFailure('HTTP 403: 抱歉，您要访问的网站不在安全策略默认允许的范围内。Domain Blocking.'),
      true,
    );
    assert.equal(
      isProviderTransportFailure('fetch failed (ECONNRESET: socket hang up)'),
      true,
    );
    assert.equal(
      isProviderTransportFailure('empty_model_response: 模型没有返回任何文本或工具调用'),
      false,
    );
  });

  it('allows replay only before model output or tool events were observed', () => {
    assert.equal(canReplayProviderAttempt({
      errorText: 'HTTP 403: Domain Blocking',
      observedReplayUnsafeEvent: false,
    }), true);
    assert.equal(canReplayProviderAttempt({
      errorText: 'HTTP 403: Domain Blocking',
      observedReplayUnsafeEvent: true,
    }), false);
  });

  it('orders configured same-model providers with the default provider first', () => {
    const ordered = orderProviderCandidates([
      { id: 'disabled', isDefault: true, enabled: false, apiKeyConfigured: true, model: 'gpt-5.5' },
      { id: 'same-model-fallback', apiKeyConfigured: true, model: 'GPT-5.5' },
      { id: 'different-model', apiKeyConfigured: true, model: 'claude-opus-4-8' },
      { id: 'default', isDefault: true, apiKeyConfigured: true, model: 'gpt-5.5' },
      { id: 'missing-key', apiKeyConfigured: false, model: 'gpt-5.5' },
    ]);
    assert.deepEqual(ordered.map((provider) => provider.id), ['default', 'same-model-fallback']);
  });

  it('buffers a mid-stream transport error and marks it replayable when nothing was emitted', () => {
    const sent = [];
    const attempt = createProviderAttemptStream({
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 's1',
      provider: { id: 'anthropic' },
    });
    // 中途断流：adapter 把 ECONNRESET 经 chat:stream:error 上报。
    attempt.webContents.send('chat:stream:error', { error: 'terminated (ECONNRESET: read ECONNRESET)' });
    const result = attempt.getResult();
    // 终态错误被缓冲、未直接转发给真实 webContents（留待重试决策）。
    assert.equal(sent.length, 0);
    assert.equal(result.terminalSent, false);
    assert.equal(result.observedReplayUnsafeEvent, false);
    assert.equal(result.replayable, true);
    assert.equal(result.errorText, 'terminated (ECONNRESET: read ECONNRESET)');
  });

  it('does not allow replay once a replay-unsafe event (delta) was emitted', () => {
    const sent = [];
    const attempt = createProviderAttemptStream({
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 's2',
      provider: { id: 'anthropic' },
    });
    attempt.webContents.send('chat:stream:delta', { content: 'partial' });
    attempt.webContents.send('chat:stream:error', { error: 'terminated (ECONNRESET: read ECONNRESET)' });
    const result = attempt.getResult();
    // delta 已转发；已产出内容后即便是可恢复传输错误也不再自动重试。
    assert.equal(result.observedReplayUnsafeEvent, true);
    assert.equal(result.replayable, false);
    assert.deepEqual(sent.map((entry) => entry.channel), ['chat:stream:delta']);
  });

  it('flushError forwards the buffered terminal error exactly once', () => {
    const sent = [];
    const attempt = createProviderAttemptStream({
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 's3',
      provider: { id: 'anthropic' },
    });
    attempt.webContents.send('chat:stream:error', { error: 'fetch failed' });
    assert.equal(attempt.flushError(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'chat:stream:error');
    assert.equal(sent[0].payload.error, 'fetch failed');
    assert.equal(sent[0].payload.streamId, 's3');
    assert.equal(attempt.getResult().terminalSent, true);
  });
});
