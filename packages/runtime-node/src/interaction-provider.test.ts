import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNodeInteractionProvider,
  INTERACTION_CAPABILITY_ID,
  NODE_INTERACTION_CAPABILITY_MANIFESTS,
  REQUEST_USER_INPUT_TOOL_NAME,
} from './interaction-provider.ts';

test('interaction manifests expose request_user_input', () => {
  assert.equal(NODE_INTERACTION_CAPABILITY_MANIFESTS.length, 1);
  assert.equal(
    NODE_INTERACTION_CAPABILITY_MANIFESTS[0]?.capabilityId,
    INTERACTION_CAPABILITY_ID,
  );
  assert.equal(REQUEST_USER_INPUT_TOOL_NAME, 'request_user_input');
});

test('interaction provider returns terminal control signal', async () => {
  const provider = createNodeInteractionProvider({
    now: () => '2026-01-01T00:00:00.000Z',
    idFactory: () => 'grant-1',
  });
  const result = await provider.execute({
    capabilityId: INTERACTION_CAPABILITY_ID,
    toolCall: {
      toolCallId: 'tool-1',
      capabilityId: INTERACTION_CAPABILITY_ID,
    },
    input: {
      question: 'Pick a commit style?',
      options: ['1', '2', '3'],
    },
  }, { locale: 'en' } as never);

  assert.equal(result.status, 'completed');
  const output = result.output as Record<string, unknown>;
  assert.equal(output.ok, true);
  assert.equal(output.question, 'Pick a commit style?');
  assert.deepEqual(output.options, ['1', '2', '3']);
  assert.deepEqual(output.control, {
    terminal: true,
    reason: 'request_user_input',
  });
  assert.deepEqual((result as { control?: unknown }).control, {
    terminal: true,
    reason: 'request_user_input',
  });
  assert.ok(String(result.outputPreview ?? '').includes('1. 1'));
  assert.ok(String(result.outputPreview ?? '').includes('Reply with a number'));
});

test('interaction provider rejects empty question', async () => {
  const provider = createNodeInteractionProvider({
    now: () => '2026-01-01T00:00:00.000Z',
    idFactory: () => 'grant-2',
  });
  const result = await provider.execute({
    capabilityId: INTERACTION_CAPABILITY_ID,
    toolCall: {
      toolCallId: 'tool-2',
      capabilityId: INTERACTION_CAPABILITY_ID,
    },
    input: { question: '   ' },
  }, {} as never);
  assert.equal(result.status, 'failed');
  assert.equal((result as { control?: unknown }).control, null);
});
