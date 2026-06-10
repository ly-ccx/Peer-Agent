import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isPromptTooLongResponse,
  runCompactionCheck,
} from './compaction-coordinator.mjs';

describe('chat compaction coordinator', () => {
  it('detects provider prompt-too-long responses', () => {
    assert.equal(isPromptTooLongResponse(413, ''), true);
    assert.equal(isPromptTooLongResponse(400, 'context_length_exceeded'), true);
    assert.equal(isPromptTooLongResponse(400, 'Maximum context length exceeded'), true);
    assert.equal(isPromptTooLongResponse(500, 'temporary outage'), false);
  });

  it('does not emit compaction events when no context window is configured', async () => {
    const events = [];
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await runCompactionCheck({
      messages,
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false);
    assert.equal(result.messages, messages);
    assert.deepEqual(events, []);
  });
});
