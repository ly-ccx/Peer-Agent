import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('request-scoped Fast mode flows through main and the ChatGPT Responses runtime only', async () => {
  const [main, service, loop, adapter, encoder] = await Promise.all([
    readSource('./main.mjs'),
    readSource('./llm-chat-service.mjs'),
    readSource('./chat-runtime/openai-agent-loop.mjs'),
    readSource('./provider-adapters/openai-responses-adapter.mjs'),
    readSource('./provider-encoders/responses-encoder.mjs'),
  ]);

  assert.match(main, /handleChatStartTask\([\s\S]*fastMode = false[\s\S]*sendMessage\(\{[\s\S]*fastMode/);
  assert.match(main, /handleChatSend\(\{[\s\S]*fastMode = false[\s\S]*sendMessage\(\{[\s\S]*fastMode/);
  assert.match(service, /async function sendMessage\(\{[\s\S]*fastMode = false/);
  assert.match(service, /fastMode: fastMode === true/);
  assert.match(loop, /fastMode: authMethod === 'oauth_chatgpt' && fastMode/);
  assert.match(adapter, /encodeOpenAIResponsesRequest\(\{[^\n]*fastMode/);
  assert.match(encoder, /if \(fastMode\) body\.service_tier = 'priority'/);
});
