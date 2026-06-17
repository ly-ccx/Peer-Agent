import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTERACTION_CAPABILITY_ID,
  createLocalInteractionProvider,
} from './local-interaction-provider.mjs';

function createCall(args = {}, toolCallId = 'local.interaction.request_user_input:test') {
  return {
    toolCallId,
    capabilityId: INTERACTION_CAPABILITY_ID,
    arguments: args,
    argumentsPreview: args,
    occurredAt: new Date().toISOString(),
  };
}

describe('local interaction provider', () => {
  const provider = createLocalInteractionProvider();

  it('declares the governed interaction capability id', () => {
    assert.equal(provider.providerId, INTERACTION_CAPABILITY_ID);
    assert.deepEqual(provider.capabilityIds, [INTERACTION_CAPABILITY_ID]);
  });

  it('emits a terminal control signal and self-grants when a question is provided', async () => {
    const execution = await provider.executeCapability(
      { call: createCall({ question: '按 1/2/3 哪种方式提交？', options: ['1', '2', '3'] }) },
      { locale: 'zh-CN' },
    );

    assert.equal(execution.result.status, 'success');
    assert.equal(execution.grant.granted, true);
    assert.equal(execution.grant.scope, INTERACTION_CAPABILITY_ID);

    // 终止控制信号是本能力的核心契约。
    assert.deepEqual(execution.result.outputPreview.control, {
      terminal: true,
      reason: 'request_user_input',
    });

    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, true);
    assert.equal(payload.question, '按 1/2/3 哪种方式提交？');
    assert.deepEqual(payload.options, ['1', '2', '3']);
    assert.equal(execution.result.evidence.dataLevel, 'D0_public');
  });

  it('does not emit a terminal signal when the question is missing', async () => {
    const execution = await provider.executeCapability(
      { call: createCall({ options: ['1', '2'] }) },
      { locale: 'en-US' },
    );

    assert.equal(execution.result.status, 'failed');
    assert.equal(execution.grant.granted, false);
    assert.equal(execution.result.outputPreview.control, null);

    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /question/);
  });

  it('normalizes string-encoded arguments', async () => {
    const execution = await provider.executeCapability(
      { call: createCall(JSON.stringify({ question: 'continue?' })) },
      { locale: 'en-US' },
    );
    assert.equal(execution.result.status, 'success');
    assert.equal(execution.result.outputPreview.control.terminal, true);
  });
});
