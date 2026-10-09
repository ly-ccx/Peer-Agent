import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoopOpenAI } from './openai-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';

const frames = values => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
const usage = { input_tokens: 100, output_tokens: 7 };
const emptyCompleted = () => [
  { type: 'response.output_item.added', item: { type: 'reasoning', encrypted_content: 'opaque', summary: [] } },
  { type: 'response.output_text.done', text: '' },
  { type: 'response.completed', response: { status: 'completed', usage, output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '' }] },
  ] } },
];
const answer = () => [
  { type: 'response.output_text.delta', delta: 'The task is still running.' },
  { type: 'response.completed', response: { status: 'completed', usage } },
];

async function runFixture(responses, options = {}, expectAbort = false) {
  const previousFetch = globalThis.fetch;
  const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
  const requests = [], events = [], rounds = [];
  process.env.PEER_AGENT_PROVIDER_TRACE = '0';
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/responses'));
    requests.push(JSON.parse(init.body));
    assert.ok(requests.length <= responses.length, 'unexpected extra provider request');
    return frames(responses[requests.length - 1]());
  };
  try {
    const execution = agentLoopOpenAI({
      baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'test-responses',
      systemPrompt: 'Use structured tools.', messages: [{ role: 'user', content: 'Report the task status.' }],
      tools: [], contextWindow: 100_000, supportsReasoning: true, effort: 'max',
      authMethod: 'oauth_chatgpt', accountId: 'fixture', streamId: 'empty-response-recovery',
      webContents: { send: (channel, payload) => events.push({ channel, payload }) },
      agentProgress: { onRound: () => rounds.push(true) },
      ...options,
    });
    if (expectAbort) await assert.rejects(execution, { name: 'AbortError' });
    else await execution;
    return { requests, events, rounds };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
    else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
  }
}

for (const effort of ['max', 'high']) {
  test(`an empty completed Responses request recovers once with the selected ${effort} effort and bills both requests`, async () => {
    const { requests, events, rounds } = await runFixture([emptyCompleted, answer], { effort });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests[1].reasoning.effort, effort);
    assert.equal(rounds.length, 2);
    assert.equal(events.some(event => event.channel === 'chat:stream:error'), false);
    assert.equal(events.filter(event => event.channel === 'chat:stream:delta').map(event => event.payload.content).join(''), 'The task is still running.');
    const done = events.find(event => event.channel === 'chat:stream:done');
    assert.equal(done.payload.usage.providerRequestCount, 2);
    assert.equal(done.payload.usage.inputTokens, 200);
    assert.equal(done.payload.usage.outputTokens, 14);
    assert.equal(done.payload.contextAccounting.authoritativeInputTokens, 100);
  });

  test(`consecutive empty Responses replies stop after one recovery at ${effort} effort`, async () => {
    const { requests, events } = await runFixture([emptyCompleted, emptyCompleted], { effort });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.reasoning.effort === effort));
    const errors = events.filter(event => event.channel === 'chat:stream:error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].payload.error, /empty_model_response/);
    assert.equal(errors[0].payload.usage.providerRequestCount, 2);
    assert.equal(events.some(event => event.channel === 'chat:stream:done'), false);
  });
}

test('empty Responses recovery keeps completed tool results in the request without re-executing them', async () => {
  const messages = [
    { role: 'user', content: 'Report the task status.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-completed', type: 'function', function: { name: 'get_session', arguments: '{"sessionId":"fixture"}' } }] },
    { role: 'tool', tool_call_id: 'call-completed', content: '{"status":"running"}' },
  ];
  const { requests, events } = await runFixture([emptyCompleted, answer], { messages });
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[1].input.at(-1), { type: 'function_call_output', call_id: 'call-completed', output: '{"status":"running"}' });
  assert.equal(events.some(event => event.channel === 'chat:stream:tool-call'), false);
});

test('an empty response after a real tool continuation does not replay the tool call', async () => {
  const call = () => [
    { type: 'response.output_item.added', item: { id: 'item-1', type: 'function_call', call_id: 'call-1', name: 'unknown_fixture_tool' } },
    { type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '{}' },
    { type: 'response.completed', response: { status: 'completed', usage } },
  ];
  const { requests, events } = await runFixture([call, emptyCompleted, answer], {
    toolContext: createToolContext({ conversationId: 'fixture-recovery', mode: 'chat' }),
    tools: [{ type: 'function', function: { name: 'unknown_fixture_tool', parameters: { type: 'object', properties: {} } } }],
    permissionGate: {
      createFilePermissionRequester: () => async () => ({ granted: true }),
      createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
      createShellApprovalDecider: () => async () => ({ approved: true }),
    },
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], requests[1]);
  assert.equal(requests[2].input.at(-1).type, 'function_call_output');
  assert.equal(requests[2].input.at(-1).call_id, 'call-1');
  assert.equal(events.filter(event => event.channel === 'chat:stream:tool-call').length, 1);
  assert.equal(events.some(event => event.channel === 'chat:stream:error'), false);
});

test('the existing turn budget still stops empty Responses recovery', async () => {
  const { requests, events } = await runFixture([emptyCompleted], { executionBudget: { maxTurns: 1 } });
  assert.equal(requests.length, 1);
  assert.equal(events.some(event => event.channel === 'chat:stream:done'), false);
  assert.match(events.find(event => event.channel === 'chat:stream:error').payload.error, /agent_loop_exhausted/);
});

test('abort after an empty response prevents a recovery request', async () => {
  const controller = new AbortController();
  const { requests, events } = await runFixture([emptyCompleted], {
    signal: controller.signal,
    agentProgress: { onRound: () => controller.abort() },
  }, true);
  assert.equal(requests.length, 1);
  assert.equal(events.some(event => event.channel === 'chat:stream:done'), false);
});
