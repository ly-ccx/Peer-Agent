import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLoopOpenAI } from './openai-agent-loop.mjs';
import { agentLoopAnthropic } from './anthropic-agent-loop.mjs';
import { agentLoopGemini } from './gemini-agent-loop.mjs';
import { agentLoopQoder } from './qoder-agent-loop.mjs';

const adapters = [['openai', agentLoopOpenAI], ['anthropic', agentLoopAnthropic],
  ['gemini', agentLoopGemini], ['qoder', agentLoopQoder]];

for (const [provider, run] of adapters) for (const changed of ['provider', 'providerId', 'model']) {
  test(`${provider} refuses a recovered checkpoint with a different ${changed} before dispatch`, async () => {
    const checkpoint = { provider, providerId: 'connection', model: 'model',
      messages: [{ role: 'assistant', tool_calls: [{ id: 'done-read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'done-read', content: 'confirmed result' }] };
    checkpoint[changed] = 'different';
    let dispatches = 0;
    const events = [];
    await assert.rejects(run({ providerId: 'connection', model: 'model', messages: [], tools: [],
      systemPrompt: 'fixture', streamId: 'fixture',
      webContents: { send: (...event) => events.push(event) },
      executionBudget: { providerCheckpoint: checkpoint,
        guard: { beforeRequest() { dispatches++; }, beforeTool() { dispatches++; } } },
    }), /continuity_model_changed/);
    assert.equal(dispatches, 0);
    assert.equal(events.length, 0);
  });
}
