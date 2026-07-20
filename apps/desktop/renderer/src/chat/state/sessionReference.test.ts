import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionReferenceAttachment,
  detectAtQuery,
  formatConversationTranscript,
  insertSessionMention,
} from './sessionReference.ts';
import type { ChatMsg } from './types.ts';

test('detectAtQuery finds trailing @ token', () => {
  assert.deepEqual(detectAtQuery('hello @foo'), { start: 6, query: 'foo' });
  assert.deepEqual(detectAtQuery('@'), { start: 0, query: '' });
  assert.equal(detectAtQuery('email@x.com'), null);
  assert.equal(detectAtQuery('hello world'), null);
});

test('insertSessionMention replaces query and adds trailing space', () => {
  assert.equal(insertSessionMention('see @fo', 4, 'fo', 'Plan A'), 'see @Plan A ');
  assert.equal(insertSessionMention('@', 0, '', 'Demo'), '@Demo ');
});

test('formatConversationTranscript keeps recent messages and roles', () => {
  const messages: ChatMsg[] = [
    { id: '1', role: 'user', content: 'hi' },
    { id: '2', role: 'assistant', content: 'hello' },
  ];
  const text = formatConversationTranscript(messages);
  assert.match(text, /user: hi/);
  assert.match(text, /assistant: hello/);
});

test('buildSessionReferenceAttachment produces text attachment', () => {
  const attachment = buildSessionReferenceAttachment({
    conversationId: 'c1',
    title: 'Demo Session',
    messages: [{ id: '1', role: 'user', content: 'context' }],
  });
  assert.equal(attachment.kind, 'text');
  assert.equal(attachment.mimeType, 'text/plain');
  assert.match(attachment.name, /^session:Demo Session\.txt$/);
  assert.match(attachment.text || '', /Referenced conversation: Demo Session/);
  assert.match(attachment.text || '', /user: context/);
});
