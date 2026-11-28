import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('request-scoped Fast mode flows through main, classicCoreBridge, and ChatGPT/Grok Responses runtimes', async () => {
  const [main, bridge, classicRs, adapter, encoder] = await Promise.all([
    readSource('./main.mjs'),
    readSource('./classic-core-bridge.mjs'),
    readSource('../../../../crates/peer-core-rpc/src/classic.rs'),
    readSource('./provider-adapters/openai-responses-adapter.mjs'),
    readSource('./provider-encoders/responses-encoder.mjs'),
  ]);

  assert.match(main, /handleChatStartTask\([\s\S]*fastMode = false[\s\S]*handleChatSend\(\{[\s\S]*fastMode/);
  assert.match(main, /handleChatSend\([\s\S]*fastMode = false[\s\S]*classicCoreBridge\.send\(\{[\s\S]*fastMode/);
  assert.match(bridge, /fastMode:\s*Boolean\(params\.fastMode\)/);
  assert.match(classicRs, /fast_mode/);
  assert.match(adapter, /encodeOpenAIResponsesRequest\(\{[^\n]*fastMode/);
  assert.match(encoder, /if \(fastMode\) body\.service_tier = 'priority'/);
});
