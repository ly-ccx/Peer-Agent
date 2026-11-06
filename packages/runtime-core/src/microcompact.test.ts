import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MICROCOMPACTION_CONFIG,
  boundProviderToolResultContent,
  microcompactMessagesForContext,
} from './microcompact.ts';
import { projectConversationHistory } from './conversation-history-projector.ts';

describe('provider tool result cap', () => {
  it('keeps a recent multi-megabyte tool result out of the provider request', () => {
    const huge = 'x'.repeat(2_190_000);
    const messages = [
      { role: 'user' as const, content: 'inspect the log' },
      { role: 'assistant' as const, content: null, toolCalls: [{ id: 'call-1', name: 'bash', arguments: '{}' }] },
      { role: 'tool' as const, toolCallId: 'call-1', content: huge },
    ];
    const bounded = microcompactMessagesForContext(messages);
    const tool = bounded.messages[2];
    assert.equal(tool?.role, 'tool');
    assert.equal(typeof tool?.content, 'string');
    assert.ok(String(tool?.content).length <= MICROCOMPACTION_CONFIG.recentToolResultChars);
    assert.match(String(tool?.content), /2190000|2,190,000|originalChars/);
    assert.equal(bounded.stats.compactedCount, 1);
    const requestBytes = Buffer.byteLength(JSON.stringify(bounded.messages), 'utf8');
    assert.ok(requestBytes < 100_000, `request grew to ${requestBytes} bytes`);
  });

  it('leaves an ordinary recent tool result unchanged', () => {
    const content = JSON.stringify({ ok: true, path: 'README.md' });
    const messages = [{ role: 'tool' as const, toolCallId: 'call-1', content }];
    const bounded = microcompactMessagesForContext(messages);
    assert.equal(bounded.messages[0]?.content, content);
    assert.equal(bounded.stats.compactedCount, 0);
  });

  it('keeps a saved huge tool body for the host to spill before send', () => {
    const huge = 'y'.repeat(MICROCOMPACTION_CONFIG.recentToolResultChars + 50);
    const projected = projectConversationHistory([{
      id: 'assistant',
      role: 'assistant',
      content: '',
      segments: [{
        type: 'tool-call',
        tool: 'bash',
        toolCallId: 'call-huge',
        args: { command: 'cat log' },
        result: huge,
      }],
    }]);
    const tool = projected.messages.find(message => message.role === 'tool');
    assert.equal(tool?.content, huge);
    assert.equal(boundProviderToolResultContent('short'), 'short');
  });
});
