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

  it('normalizes legacy capability ids before replaying historical function calls', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', function: { name: 'local.file.read', arguments: '{"path":"a.ts"}' } },
            { id: 'call_2', function: { name: 'MCP 服务: list_nodes', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        { role: 'tool', tool_call_id: 'call_2', content: 'node list' },
      ],
    });

    const calls = body.input.filter((item) => item.type === 'function_call');
    assert.deepEqual(calls.map((item) => ({
      callId: item.call_id,
      name: item.name,
    })), [
      { callId: 'call_1', name: 'local_file_read' },
      { callId: 'call_2', name: 'MCP_____list_nodes' },
    ]);
    assert.ok(calls.every((item) => /^[a-zA-Z0-9_-]+$/.test(item.name)));
    assert.deepEqual(
      body.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
      ['call_1', 'call_2'],
      'normalizing names must preserve call_id pairing with tool outputs',
    );
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
    // Default: request effort only. Do not subscribe to reasoning.summary
    // (OpenAI docs: summary is optional and off unless explicitly set).
    assert.equal(on.reasoning.summary, undefined);
    assert.deepEqual(Object.keys(on.reasoning).sort(), ['effort']);
  });

  it('does not request reasoning.summary for GPT subscription Responses by default', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'plan' }],
      supportsReasoning: true,
      effort: 'medium',
      reasoningParamStyle: 'openai-effort',
    });
    assert.ok(body.reasoning);
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal('summary' in body.reasoning, false);
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

  it('passes GPT-5.6 max reasoning through as max', () => {
    const body = encodeOpenAIResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hard problem' }],
      effort: 'max',
      supportsReasoning: true,
    });
    assert.equal(body.reasoning.effort, 'max');
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

  it('adds the priority service tier only when Fast mode is enabled', () => {
    const standard = encodeOpenAIResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const fast = encodeOpenAIResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      fastMode: true,
    });
    const grokFast = encodeOpenAIResponsesRequest({
      model: 'grok-4.5',
      messages: [{ role: 'user', content: 'hello' }],
      fastMode: true,
    });

    assert.equal(standard.service_tier, undefined);
    assert.equal(fast.service_tier, 'priority');
    assert.equal(grokFast.service_tier, 'priority');
  });

  it('passes Grok low/medium/high and maps default/off to high via effort map', () => {
    const make = (effort, reasoningEffortMap) => encodeOpenAIResponsesRequest({
      model: 'grok-4.5',
      messages: [{ role: 'user', content: 'debug' }],
      supportsReasoning: true,
      reasoningParamStyle: 'openai-effort',
      effort,
      reasoningEffortMap,
    });

    assert.equal(make('low').reasoning.effort, 'low');
    assert.equal(make('medium').reasoning.effort, 'medium');
    assert.equal(make('high').reasoning.effort, 'high');

    const grokMap = {
      off: 'high',
      low: 'low',
      medium: 'medium',
      default: 'high',
      high: 'high',
    };
    assert.equal(make('default', grokMap).reasoning.effort, 'high');
    assert.equal(make('off', grokMap).reasoning, undefined);
  });
});
