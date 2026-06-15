import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canReplayProviderAttempt,
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
});
