import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPersistedCompactedMessages } from './conversation-compaction-persistence.mjs';

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
  it('persists handoff plus the last kept source messages', () => {
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

    assert.equal(persisted.length, 3);
    assert.equal(persisted[0].id, 'compaction-id');
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0]._compaction.method, 'structural');
    assert.deepEqual(persisted.slice(1), sourceMessages.slice(-2));
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

    assert.equal(persisted.length, 3);
    assert.equal(persisted[0].id, 'compaction-id');
    assert.deepEqual(persisted[1], sourceMessages[2]);
    assert.deepEqual(persisted[2], pendingAssistant);
  });

  it('does not keep an older compaction handoff as a recent source message', () => {
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

    assert.equal(persisted.length, 3);
    assert.equal(persisted[0].id, 'compaction-id');
    assert.deepEqual(persisted.slice(1), sourceMessages.slice(1));
    assert.equal(persisted.some((message) => message.id === 'previous-compaction'), false);
  });

  it('keeps zero source messages when keptCount is 0 (guards against slice(-0) keeping all)', () => {
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

    // 只应保留压缩交接消息，0 条旧消息；修复前 slice(-0) 会退化为保留全部 4 条。
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, 'compaction-id');
    assert.equal(persisted[0]._compaction.method, 'structural');
    assert.equal(persisted.some((message) => message.id?.startsWith('m')), false);
  });

  it('treats negative keptCount as zero kept source messages', () => {
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

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, 'compaction-id');
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

    // keptCount=0 不保留旧消息，但 pendingAssistant 仍须保留（工具/续写连续性兜底）。
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].id, 'compaction-id');
    assert.deepEqual(persisted[1], pendingAssistant);
  });
});
