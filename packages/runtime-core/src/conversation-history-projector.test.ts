import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_HISTORY_PROJECTOR_VERSION,
  projectConversationHistory,
} from './conversation-history-projector.ts';

describe('projectConversationHistory', () => {
  it('uses the last compaction boundary and returns its continuity summary', () => {
    const result = projectConversationHistory([
      { id: 'old-user', role: 'user', content: 'old question' },
      {
        id: 'compact-1',
        role: 'system',
        content: 'first handoff',
        _compaction: { summary: 'first summary' },
      },
      { id: 'middle-user', role: 'user', content: 'middle question' },
      {
        id: 'compact-2',
        role: 'system',
        content: 'second handoff',
        _compaction: { summary: 'second summary' },
      },
      { id: 'new-user', role: 'user', content: 'new question' },
    ]);

    assert.equal(result.projectorVersion, CANONICAL_HISTORY_PROJECTOR_VERSION);
    assert.equal(result.compactionBoundaryIndex, 3);
    assert.equal(result.continuityContext, 'second summary');
    assert.deepEqual(result.continuity, {
      summary: 'second summary',
      sourceMessageId: 'compact-2',
      method: 'unknown',
      originalMessageCount: null,
      beforeTokens: null,
      afterTokens: null,
    });
    assert.deepEqual(result.messages, [{ role: 'user', content: 'new question' }]);
  });

  it('preserves ordered text and completed tool call/result pairs', () => {
    const result = projectConversationHistory([{
      id: 'assistant:one',
      role: 'assistant',
      content: 'display fallback',
      segments: [
        { type: 'thinking', content: 'hidden reasoning' },
        { type: 'text', content: 'Inspecting.' },
        {
          type: 'tool-call',
          tool: 'local.file.read',
          args: { path: 'a.ts' },
          result: 'file contents',
        },
        { type: 'text', content: 'Done.' },
      ],
    }]);

    assert.deepEqual(result.messages, [
      { role: 'assistant', content: 'Inspecting.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'tool_call_assistant_one_2',
          name: 'local.file.read',
          arguments: '{"path":"a.ts"}',
        }],
      },
      {
        role: 'tool',
        content: 'file contents',
        toolCallId: 'tool_call_assistant_one_2',
        name: 'local.file.read',
      },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('degrades incomplete tool segments to read-only history instead of orphan calls', () => {
    const result = projectConversationHistory([{
      id: 'assistant-pending',
      role: 'assistant',
      content: '',
      segments: [{
        type: 'tool-call',
        tool: 'local.shell.exec',
        args: { command: 'pwd' },
      }],
    }]);

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.role, 'assistant');
    assert.match(String(result.messages[0]?.content), /read-only context/);
    assert.match(String(result.messages[0]?.content), /local\.shell\.exec/);
    assert.equal(result.messages[0]?.toolCalls, undefined);
  });

  it('projects text, unsupported and image attachments into one user message', () => {
    const result = projectConversationHistory([{
      id: 'user-1',
      role: 'user',
      content: 'Review these.',
      attachments: [
        {
          kind: 'text',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          text: 'hello',
        },
        {
          kind: 'unsupported',
          name: 'archive.zip',
          mimeType: 'application/zip',
          size: 2048,
        },
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 10,
          dataUrl: 'data:image/png;base64,abc',
        },
      ],
    }]);

    assert.equal(result.messages.length, 1);
    const content = result.messages[0]?.content;
    assert.ok(Array.isArray(content));
    assert.match(String(content[0]?.type === 'text' ? content[0].text : ''), /notes\.txt/);
    assert.match(String(content[0]?.type === 'text' ? content[0].text : ''), /archive\.zip/);
    assert.deepEqual(content[1], {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });

  it('filters UI-only system rows and sanitizes legacy assistant markers', () => {
    const result = projectConversationHistory([
      { id: 'status', role: 'system', content: 'Compacting 90%' },
      {
        id: 'assistant',
        role: 'assistant',
        content: '[Tool call: bash]\n[Tool result]\nok',
      },
    ]);

    assert.deepEqual(result.messages, [{
      role: 'assistant',
      content: '[Legacy assistant local action marker: bash]\n[Legacy assistant local observation marker]\nok',
    }]);
  });

  it('folds legacy TUI tool rows into a paired canonical call/result', () => {
    const result = projectConversationHistory([
      {
        id: 'assistant-old',
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [{
          id: 'call-old',
          name: 'lookup',
          arguments: '{"key":"value"}',
        }],
      },
      {
        id: 'tool-old',
        role: 'tool',
        content: 'fallback result',
        tool: {
          capabilityId: 'lookup',
          arguments: { key: 'value' },
          detail: 'found it',
          toolCallId: 'call-old',
        },
      },
    ]);

    assert.deepEqual(result.messages, [
      { role: 'assistant', content: 'Checking.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'call-old',
          name: 'lookup',
          arguments: '{"key":"value"}',
        }],
      },
      {
        role: 'tool',
        content: 'found it',
        toolCallId: 'call-old',
        name: 'lookup',
      },
    ]);
  });

  it('normalizes serialized legacy tool records and legacy images', () => {
    const result = projectConversationHistory([
      {
        id: 'legacy-user',
        role: 'user',
        content: 'see image',
        images: [{ url: 'data:image/png;base64,legacy' }],
      },
      {
        id: 'legacy-assistant',
        role: 'assistant',
        content: [
          'Before.',
          '[Tool call: shell {"command":"pwd"}]',
          '[Tool result]',
          '/workspace',
          'After.',
        ].join('\n'),
      },
    ]);

    assert.deepEqual(result.messages[0], {
      role: 'user',
      content: [
        { type: 'text', text: 'see image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,legacy' } },
      ],
    });
    assert.equal(result.messages[1]?.content, 'Before.');
    assert.equal(result.messages[2]?.toolCalls?.[0]?.name, 'shell');
    assert.equal(result.messages[3]?.content, '/workspace\nAfter.');
  });

  it('produces a deterministic fingerprint that changes with canonical history', () => {
    const first = projectConversationHistory([
      { id: 'user', role: 'user', content: 'one' },
    ]);
    const same = projectConversationHistory([
      { id: 'user', role: 'user', content: 'one' },
    ]);
    const changed = projectConversationHistory([
      { id: 'user', role: 'user', content: 'two' },
    ]);
    const boundaryChanged = projectConversationHistory([
      {
        id: 'boundary',
        role: 'system',
        content: 'handoff',
        _compaction: { summary: 'handoff' },
      },
      { id: 'user', role: 'user', content: 'one' },
    ]);

    assert.equal(first.historyFingerprint, same.historyFingerprint);
    assert.notEqual(first.historyFingerprint, changed.historyFingerprint);
    assert.notEqual(first.historyFingerprint, boundaryChanged.historyFingerprint);
    assert.match(first.historyFingerprint, /^history-v1-[0-9a-f]{8}$/);
  });
});
