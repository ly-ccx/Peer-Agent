import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coordinateDesktopProviderRequest,
  executeDesktopProviderRequest,
} from './provider-request-coordinator.mjs';
import { createRestoredObservedContextAccountingSnapshot } from '@peer-agent/runtime-core';
import { dispatchProviderRequest } from './provider-request-recovery.mjs';

describe('Desktop provider request coordinator', () => {
  it('rejects a mutated canonical request before another physical retry', async () => {
    let dispatches = 0;
    await assert.rejects(executeDesktopProviderRequest({
      request: { messages: [{ role: 'user', content: 'fixture request' }], systemPrompt: 'fixture',
        contextWindow: 1_000_000, requestRecoveryOptions: { waitImpl: async () => {} } },
      send: request => dispatchProviderRequest(async () => {
        dispatches++;
        request.messages.push({ role: 'assistant', content: 'adapter mutation' });
        return { ok: false, status: 503 };
      }),
    }), error => error.message.startsWith('context_request_fingerprint_mismatch')
      && error.providerRecovery.kind === 'invalid_request' && error.providerRecovery.retryable === false);
    assert.equal(dispatches, 1);
  });

  it('recovers the next canonical request after 19 completed tool pairs without another logical round', async () => {
    const messages = [{ role: 'user', content: 'fixture request' }];
    for (let i = 0; i < 19; i++) messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call-${i}`, content: `completed result ${i}` },
    );
    const before = JSON.stringify(messages);
    const canonicalRequests = [];
    const budget = [];
    let logicalRounds = 0;
    const result = await executeDesktopProviderRequest({
      request: { messages, systemPrompt: 'fixture', contextWindow: 1_000_000,
        requestRecoveryOptions: { waitImpl: async () => {} },
        budgetGuard: { beforeRequest: metadata => budget.push(metadata) },
        onProviderRequest: () => { logicalRounds++; },
      },
      send: request => dispatchProviderRequest(async () => {
        canonicalRequests.push(request);
        if (canonicalRequests.length === 1) throw Object.assign(new Error('ConnectTimeoutError'), { code: 'ConnectTimeoutError' });
        if (canonicalRequests.length === 2) return { ok: false, status: 503 };
        return { ok: true, content: 'completed', streamUsage: { inputTokens: 10, outputTokens: 2 } };
      }),
    });
    assert.equal(result.response.content, 'completed');
    assert.equal(budget.length, 3);
    assert.equal(logicalRounds, 1);
    assert.equal(canonicalRequests.length, 3);
    assert.ok(canonicalRequests.every(request => request === canonicalRequests[0]));
    assert.equal(canonicalRequests[0].messages.filter(message => message.role === 'tool').length, 19);
    assert.equal(JSON.stringify(messages), before);
  });

  it('coordinates compaction without publishing a parallel context projection', async () => {
    const result = await coordinateDesktopProviderRequest({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      systemPrompt: 'system',
      contextWindow: 10_000,
      providerConfig: {},
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read' } }],
    });

    assert.equal(result.compacted, false);
    assert.equal('projection' in result, false);
    assert.equal('contextInfo' in result, false);
    assert.equal('projectedMessages' in result, false);
    assert.equal(result.messages.length, 2);
  });

  it('leaves canonical request shaping to the shared accounting pipeline', async () => {
    const result = await coordinateDesktopProviderRequest({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'working' },
        { role: 'assistant', content: 'done' },
      ],
      systemPrompt: 'system',
      contextWindow: 100_000,
      providerConfig: {},
    });

    assert.equal(result.compacted, false);
    assert.deepEqual(result.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'working' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('uses provider-observed 498K input as compaction authority before sending', async () => {
    let compactCalls = 0;
    let sendCalls = 0;
    const result = await executeDesktopProviderRequest({
      request: {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'short visible history' },
        ],
        systemPrompt: 'system',
        contextWindow: 500_000,
        providerConfig: { model: 'grok-4.5' },
        accountingIdentity: {
          conversationId: 'conversation-observed',
          contentRevision: 1,
          modelKey: 'provider::grok-4.5',
        },
        initialContextAccounting: createRestoredObservedContextAccountingSnapshot({
          identity: {
            conversationId: 'conversation-observed',
            contentRevision: 0,
            modelKey: 'provider::grok-4.5',
          },
          contextWindow: 500_000,
          countCapability: { kind: 'observed_usage_only' },
          usage: { inputTokens: 498_138 },
        }),
      },
      compactRequest: async ({ messages, systemPrompt }) => {
        compactCalls += 1;
        return {
          compacted: true,
          messages: messages.slice(-1),
          systemPrompt,
        };
      },
      send: async () => {
        sendCalls += 1;
        return {
          ok: true,
          streamUsage: { inputTokens: 12_000 },
        };
      },
    });

    assert.equal(compactCalls, 1);
    assert.equal(sendCalls, 1);
    assert.equal(result.compacted, true);
    assert.equal(result.snapshot.authoritativeInputTokens, 12_000);
  });

  it('compacts and retries once when Grok returns maximum prompt length evidence', async () => {
    let compactCalls = 0;
    let sendCalls = 0;
    const result = await executeDesktopProviderRequest({
      request: {
        messages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: 'history' },
          { role: 'user', content: 'latest' },
        ],
        systemPrompt: '',
        contextWindow: 500_000,
        providerConfig: { model: 'grok-4.5' },
      },
      compactRequest: async ({ messages, systemPrompt }) => {
        compactCalls += 1;
        return {
          compacted: true,
          messages: messages.slice(-1),
          systemPrompt,
        };
      },
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          return {
            ok: false,
            status: 400,
            errorText:
              "This model's maximum prompt length is 500000 but the request contains 501244 tokens.",
          };
        }
        return { ok: true, streamUsage: { inputTokens: 2_000 } };
      },
    });

    assert.equal(compactCalls, 1);
    assert.equal(sendCalls, 2);
    assert.equal(result.retriedAfterOverflow, true);
    assert.equal(result.snapshot.lastOverflow.requestedTokens, 501_244);
    assert.equal(result.snapshot.lastOverflow.maximumTokens, 500_000);
  });
});
