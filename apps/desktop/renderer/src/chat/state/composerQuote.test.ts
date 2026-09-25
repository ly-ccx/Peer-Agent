import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSelectionQuote, isSelectionQuoteAttachment, quotePreviewText, splitSelectionQuotes } from './composerQuote.ts';
import { toApiMessages } from './apiMessageMapping.ts';
import type { SelectionReference } from '@peer-agent/protocol';
import type { ChatAttachment, ChatMsg } from './types.ts';

const reference: SelectionReference = {
  schemaVersion: 1,
  id: 'quote-1',
  sourceConversationId: 'p',
  sourceMessageId: 'm',
  blockId: 'content',
  sourceRevision: 2,
  sourceRole: 'assistant',
  start: 3,
  end: 13,
  exactText: '还不能。证书在你这边准备好了，但昨天发出的 v0.0.17 仍然是草稿。',
  textHash: 'hash',
  sourceTextHash: 'source',
};

test('quote preview truncates whitespace and keeps the full body for the model', () => {
  assert.equal(quotePreviewText('  a \n b  '), 'a b');
  assert.equal(quotePreviewText('x'.repeat(80)).endsWith('...'), true);
  assert.equal(quotePreviewText('x'.repeat(80)).length, 75);
});

test('selection quotes stay out of the file attachment list', () => {
  const file: ChatAttachment = { id: 'prior', name: 'prior.txt', kind: 'text', mimeType: 'text/plain', size: 5, text: 'prior' };
  const quotes = appendSelectionQuote([file], reference);
  assert.equal(quotes.some((item) => item.name === '引用选区.txt'), false);
  const split = splitSelectionQuotes(quotes);
  assert.equal(split.files.length, 1);
  assert.equal(split.files[0]?.name, 'prior.txt');
  assert.equal(split.quotes.length, 1);
  assert.equal(isSelectionQuoteAttachment(split.quotes[0]!), true);
  assert.equal(isSelectionQuoteAttachment(file), false);
});

for (const existing of [false, true]) {
  test(`embedded quote still sends exact text once (${existing ? 'with file' : 'quote only'})`, () => {
    const previous: ChatAttachment[] = existing
      ? [{ id: 'prior', name: 'prior.txt', kind: 'text', mimeType: 'text/plain', size: 5, text: 'prior' }]
      : [];
    const attachments = appendSelectionQuote(previous, reference);
    const message: ChatMsg = { id: 'new', role: 'user', content: '那是不是可以', attachments };
    const body = JSON.stringify(toApiMessages([message]));
    assert.equal(body.split(reference.exactText).length - 1, 1);
    assert.ok(body.includes('那是不是可以'));
    assert.ok(body.includes('p/m'));
    assert.equal(body.includes('引用选区.txt'), false);
    if (existing) assert.ok(body.includes('prior'));
  });
}
