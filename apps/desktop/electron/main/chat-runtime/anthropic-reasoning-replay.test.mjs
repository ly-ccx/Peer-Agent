import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoopAnthropic } from './anthropic-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';

test('an unsigned compatible thinking block survives the real tool continuation request', async () => {
  const previousFetch = globalThis.fetch;
  const attempts = [], events = [];
  const frames = values => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { status: 200 });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
    const body = JSON.parse(init.body); attempts.push(body);
    if (attempts.length === 1) return frames([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'inspect the requested file' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'unknown_fixture_tool' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    assert.deepEqual(body.messages.find(message => message.role === 'assistant').content[0], {
      type: 'thinking', thinking: 'inspect the requested file',
    });
    assert.equal(body.messages.at(-1).content[0].tool_use_id, 'call-1');
    return frames([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'The tool is unavailable.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]);
  };
  try {
    await agentLoopAnthropic({ baseUrl: 'https://fixture.invalid/anthropic', apiKey: 'fixture', model: 'deepseek-flash',
      systemPrompt: 'Use structured tools.', messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'unknown_fixture_tool', input_schema: { type: 'object', properties: {} } }],
      webContents: { send: (channel, payload) => events.push({ channel, payload }) }, streamId: 'unsigned-thinking-replay',
      contextWindow: 100_000, supportsReasoning: true, effort: 'high',
      resolvedChannel: { supportsReasoning: true, reasoningParamStyle: 'anthropic-enabled-output-effort' },
      toolContext: createToolContext({ conversationId: 'fixture-replay', mode: 'chat' }),
      permissionGate: { createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }) },
    });
    assert.equal(attempts.length, 2);
    assert.equal(events.some(event => event.channel === 'chat:stream:error'), false);
    assert.ok(events.some(event => event.channel === 'chat:stream:done'));
  } finally { globalThis.fetch = previousFetch; }
});
