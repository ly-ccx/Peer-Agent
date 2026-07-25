import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPersistedCompactedMessages,
  persistCompactedConversation,
} from './conversation-compaction-persistence.mjs';

const compactedMessages = [
  { role: 'system', content: 'system prompt' },
  {
    role: 'user',
    content: '[上下文交接 - 共压缩 2 条消息]\nsummary',
    _compaction: {
      method: 'structural',
      originalMessageCount: 2,
      beforeTokens: 100,
      afterTokens: 40,
      summary: 'summary',
    },
  },
  { role: 'user', content: 'kept from api' },
];

describe('conversation compaction persistence', () => {
  it('persists original messages, then handoff, then the last kept source messages', () => {
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      { id: 'm3', role: 'user', content: 'recent 1' },
      { id: 'm4', role: 'assistant', content: 'recent 2', segments: [{ type: 'text', content: 'recent 2' }] },
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 2,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted.slice(0, 2), sourceMessages.slice(0, 2));
    assert.equal(persisted[2].id, 'compaction-id');
    assert.equal(persisted[2].role, 'user');
    assert.equal(persisted[2]._compaction.method, 'structural');
    assert.deepEqual(persisted.slice(3), sourceMessages.slice(-2));
  });

  it('preserves the pending assistant placeholder during automatic compaction', () => {
    const pendingAssistant = { id: 'pending', role: 'assistant', content: '', segments: [], timestamp: 1 };
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      { id: 'm3', role: 'user', content: 'recent 1' },
      pendingAssistant,
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 1,
      preservePendingAssistant: true,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted.slice(0, 2), sourceMessages.slice(0, 2));
    assert.equal(persisted[2].id, 'compaction-id');
    assert.deepEqual(persisted[3], sourceMessages[2]);
    assert.deepEqual(persisted[4], pendingAssistant);
  });

  it('keeps older compaction handoffs at their historical timeline positions', () => {
    const previousCompaction = {
      id: 'previous-compaction',
      role: 'user',
      content: '[上下文交接 - 共压缩 100 条消息]',
      _compaction: {
        method: 'structural',
        originalMessageCount: 100,
        beforeTokens: 1000,
        afterTokens: 300,
        summary: 'previous summary',
      },
    };
    const sourceMessages = [
      previousCompaction,
      { id: 'm1', role: 'user', content: 'recent 1' },
      { id: 'm2', role: 'assistant', content: 'recent 2' },
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 2,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 4);
    assert.equal(persisted[0].id, 'previous-compaction');
    assert.equal(persisted[1].id, 'compaction-id');
    assert.deepEqual(persisted.slice(2), sourceMessages.slice(1));
  });

  it('places all source messages before the handoff when keptCount is 0 (guards against slice(-0) active tail)', () => {
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      { id: 'm3', role: 'user', content: 'old 3' },
      { id: 'm4', role: 'assistant', content: 'old 4' },
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 0,
      idFactory: () => 'compaction-id',
    });

    // keptCount=0 时，所有原文仍留给 UI 回看，但没有任何旧消息位于 compaction 之后的活跃尾部。
    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted.slice(0, 4), sourceMessages);
    assert.equal(persisted[4].id, 'compaction-id');
    assert.equal(persisted[4]._compaction.method, 'structural');
  });

  it('treats negative keptCount as zero active source messages after the handoff', () => {
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: -1,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted.slice(0, 2), sourceMessages);
    assert.equal(persisted[2].id, 'compaction-id');
  });

  it('still preserves the pending assistant when keptCount is 0', () => {
    const pendingAssistant = { id: 'pending', role: 'assistant', content: '', segments: [], timestamp: 1 };
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      pendingAssistant,
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 0,
      preservePendingAssistant: true,
      idFactory: () => 'compaction-id',
    });

    // pendingAssistant 不参与压缩边界切分，仍保留在分界线之后作为工具/续写连续性兜底。
    assert.equal(persisted.length, 4);
    assert.deepEqual(persisted.slice(0, 2), sourceMessages.slice(0, 2));
    assert.equal(persisted[2].id, 'compaction-id');
    assert.deepEqual(persisted[3], pendingAssistant);
  });

  it('preserves a non-empty in-flight assistant after automatic compaction', () => {
    const inFlightAssistant = {
      id: 'streaming-assistant',
      role: 'assistant',
      content: 'partial answer',
      segments: [
        { type: 'tool', name: 'read_file', status: 'running' },
        { type: 'reasoning', content: 'thinking' },
      ],
      timestamp: 2,
    };
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      { id: 'm3', role: 'user', content: 'recent 1' },
      inFlightAssistant,
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 2,
      preservePendingAssistant: true,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted[0], sourceMessages[0]);
    assert.equal(persisted[1].id, 'compaction-id');
    assert.deepEqual(persisted.slice(2, 4), sourceMessages.slice(1, 3));
    assert.deepEqual(persisted[4], inFlightAssistant);
  });

  it('does not move the last completed assistant when preservePendingAssistant is disabled', () => {
    const completedAssistant = {
      id: 'completed-assistant',
      role: 'assistant',
      content: 'completed answer',
      segments: [{ type: 'text', content: 'completed answer' }],
      timestamp: 3,
    };
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'old 1' },
      { id: 'm2', role: 'assistant', content: 'old 2' },
      { id: 'm3', role: 'user', content: 'recent 1' },
      completedAssistant,
    ];

    const persisted = buildPersistedCompactedMessages({
      compactedMessages,
      sourceMessages,
      keptCount: 2,
      preservePendingAssistant: false,
      idFactory: () => 'compaction-id',
    });

    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted.slice(0, 2), sourceMessages.slice(0, 2));
    assert.equal(persisted[2].id, 'compaction-id');
    assert.deepEqual(persisted.slice(3), sourceMessages.slice(-2));
  });

  it('writes the compacted projection only after replaceMessages creates the new revision', () => {
    const calls = [];
    const store = {
      replaceMessages(conversationId, messages) {
        calls.push(['replace', conversationId, messages]);
        return { contentRevision: 8 };
      },
      updateContextSnapshot(conversationId, snapshot) {
        calls.push(['snapshot', conversationId, snapshot]);
        return { contentRevision: 8, contextSnapshot: snapshot };
      },
    };

    const result = persistCompactedConversation({
      store,
      conversationId: 'c1',
      messages: compactedMessages,
      requestProjection: {
        nextRequestInputTokens: 42_500,
        contextWindow: 500_000,
      },
      computedAt: '2026-07-23T00:00:00.000Z',
    });

    assert.deepEqual(calls.map(([kind]) => kind), ['replace', 'snapshot']);
    assert.deepEqual(calls[1], [
      'snapshot',
      'c1',
      {
        nextRequestInputTokens: 42_500,
        contextWindow: 500_000,
        computedAt: '2026-07-23T00:00:00.000Z',
        projectorVersion: 1,
        source: 'desktop',
      },
    ]);
    assert.equal(result.contentRevision, 8);
  });

  it('fails instead of reporting a completed compaction when the shared snapshot is rejected', () => {
    const store = {
      replaceMessages() {
        return { contentRevision: 8 };
      },
      updateContextSnapshot() {
        return null;
      },
    };

    assert.throws(
      () => persistCompactedConversation({
        store,
        conversationId: 'c1',
        messages: compactedMessages,
        requestProjection: {
          nextRequestInputTokens: 42_500,
          contextWindow: 500_000,
        },
      }),
      /Failed to persist compacted context snapshot/,
    );
  });
});
