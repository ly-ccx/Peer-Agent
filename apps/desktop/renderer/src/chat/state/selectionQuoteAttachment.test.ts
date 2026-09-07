import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSelectionQuote } from './selectionQuoteAttachment.ts';
import { toApiMessages } from './apiMessageMapping.ts';
import type { SelectionReference } from '@peer-agent/protocol';
import type { ChatAttachment, ChatMsg } from './types.ts';

for (const sourceRole of ['user', 'assistant'] as const) for (const existing of [false, true]) {
  test(`quote send ${sourceRole} × ${existing ? 'existing attachment' : 'empty attachments'}: identity retained, content once as user material`, () => {
    const reference: SelectionReference = { schemaVersion: 1, id: 'quote-1', sourceConversationId: 'p', sourceMessageId: 'm',
      blockId: 'content', sourceRevision: 2, sourceRole, start: 3, end: 13, exactText: '唯一选区😀', textHash: 'hash', sourceTextHash: 'source' };
    const previous: ChatAttachment[] = existing ? [{ id: 'prior', name: 'prior.txt', kind: 'text', mimeType: 'text/plain', size: 5, text: 'prior' }] : [];
    const before = structuredClone(previous);
    const attachments = appendSelectionQuote(previous, reference);
    assert.deepEqual(previous, before);
    assert.equal(appendSelectionQuote(attachments, reference), attachments);
    assert.deepEqual(attachments.at(-1)?.selectionReference, reference);
    const restored = JSON.parse(JSON.stringify(attachments)) as ChatAttachment[];
    const message: ChatMsg = { id: 'new', role: 'user', content: '我的原草稿', attachments: restored };
    const api = toApiMessages([message]);
    assert.equal(api.length, 1);
    assert.equal(api[0].role, 'user');
    const body = JSON.stringify(api);
    assert.equal(body.split(reference.exactText).length - 1, 1);
    assert.ok(body.includes('我的原草稿'));
    assert.ok(body.includes('p/m'));
    assert.deepEqual(restored.at(-1)?.selectionReference, reference);
    if (existing) assert.ok(body.includes('prior'));
  });
}
