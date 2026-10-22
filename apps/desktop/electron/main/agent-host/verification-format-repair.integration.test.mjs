import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'peer-format-repair-'));
const oldHome = process.env.PEER_AGENT_HOME;
process.env.PEER_AGENT_HOME = root;
const { runContinuedVerification } = await import('../../../../../packages/runtime-node/src/project-agent/verification-continuation.mjs');
const { createAgentTurnExecutor } = await import('./agent-turn-executor.mjs');
const { agentLoopOpenAI } = await import('../chat-runtime/openai-agent-loop.mjs');
const { createRuntimeToolProjection, buildOpenAIToolsFromModelProjection } = await import('../tools/index.mjs');

test('production format repair cannot execute a requested file read or begin another audit', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (oldHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(path.join(root, 'must-not-be-read.txt'), 'FORMAT_REPAIR_PRIVATE_CONTENT');
  let requests = 0;
  const allEvents = [];
  globalThis.fetch = async () => {
    const frames = ++requests === 1
      ? [{ type: 'response.output_text.delta', delta: 'Invalid report' }]
      : [{ type: 'response.output_item.added', item: { type: 'function_call', id: 'repair-fc', call_id: 'repair-read', name: 'read_file' } },
        { type: 'response.function_call_arguments.done', item_id: 'repair-fc', arguments: JSON.stringify({ path: 'must-not-be-read.txt' }) }];
    frames.push({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 10 } } });
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    const { registry, projection, modelProjection } = createRuntimeToolProjection({ projectionOptions: { mode: 'explorer', readOnlyWorkSession: true } });
    await agentLoopOpenAI({ baseUrl: 'https://fixture.invalid', apiKey: 'controlled', authMethod: 'oauth_chatgpt',
      providerId: 'fixture', model: 'fixture', systemPrompt: 'Readonly verifier.', messages: input.messages,
      tools: buildOpenAIToolsFromModelProjection(modelProjection), streamId: input.streamId,
      signal: input.signal, executionBudget: input.executionBudget, workspacePath: root, conversationId: null,
      runtimeMode: 'explorer', registry, runtimeProjection: projection,
      toolContext: { mode: 'explorer', turnRole: 'verifier', readFiles: new Map(), turnToolCalls: [], turnId: input.streamId },
      permissionGate: { createFilePermissionRequester: () => async () => assert.fail('format repair must never request permission') },
      webContents: input.webContents });
    return { terminalStatus: 'done' };
  } } });
  await assert.rejects(runContinuedVerification({ identity: { planId: 'format-review', sourceRevision: 's', modelKey: 'm' },
    run: async ({ executionBudget, signal, onToolResult }) => {
      const events = [];
      const outcome = await executor.runTurn({ turnProfile: { role: 'verifier' }, executionBudget, signal,
        messages: [{ role: 'user', content: 'Review then return a structured report.' }],
        sink: { send(channel, payload) {
          events.push({ channel, payload }); allEvents.push({ channel, payload });
          if (channel === 'chat:stream:tool-result') onToolResult(payload.result);
        } } });
      return { events, outcome };
    } }), { code: 'verifier_report_invalid' });
  assert.equal(requests, 2);
  assert.doesNotMatch(JSON.stringify(allEvents), /FORMAT_REPAIR_PRIVATE_CONTENT/);
});
