import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeOpenAIResponsesRequest } from './responses-encoder.mjs';

describe('OpenAI Responses request encoder (ADR 28)', () => {
  it('moves system messages into instructions and keeps the rest as input', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
    });
    assert.equal(body.model, 'gpt-5');
    assert.equal(body.instructions, 'be concise');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, 'user');
    assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: 'hello' }]);
  });

  it('encodes assistant tool calls as function_call items', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{"p":1}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    });
    const fnCall = body.input.find((i) => i.type === 'function_call');
    const fnOut = body.input.find((i) => i.type === 'function_call_output');
    assert.ok(fnCall, 'expected a function_call item');
    assert.equal(fnCall.call_id, 'call_1');
    assert.equal(fnCall.name, 'read');
    assert.equal(fnCall.arguments, '{"p":1}');
    assert.ok(fnOut, 'expected a function_call_output item');
    assert.equal(fnOut.call_id, 'call_1');
    assert.equal(fnOut.output, 'ok');
  });

  it('flattens tools to Responses function shape', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: { type: 'object' } } }],
    });
    assert.deepEqual(body.tools, [
      { type: 'function', name: 'ls', description: 'list', parameters: { type: 'object' } },
    ]);
  });

  it('adds reasoning only when supportsReasoning and effort is active', () => {
    const off = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'x' }],
      supportsReasoning: false,
      effort: 'high',
    });
    assert.equal(off.reasoning, undefined);

    const on = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'x' }],
      supportsReasoning: true,
      effort: 'high',
    });
    assert.equal(on.reasoning.effort, 'high');
  });

  it('passes OpenAI extra-high reasoning through as xhigh', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'x' }],
      supportsReasoning: true,
      effort: 'xhigh',
    });
    assert.equal(body.reasoning.effort, 'xhigh');
  });

  it('maps Responses reasoning effort through provider-specific effort map', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'x' }],
      supportsReasoning: true,
      effort: 'xhigh',
      reasoningEffortMap: {
        medium: 'high',
        xhigh: 'max',
      },
    });
    assert.equal(body.reasoning.effort, 'max');
  });
});
