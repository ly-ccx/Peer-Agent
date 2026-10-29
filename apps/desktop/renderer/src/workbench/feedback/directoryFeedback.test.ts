import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryFeedbackExcerpt } from './directoryFeedback.ts';
import { browserFeedbackNoticeText, feedbackPreparationFailureText } from './browserFeedbackNotice.ts';
test('directory quote captures only the already-read listing and identifies partial results without reading bodies', () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `entry-${i}`, isDir: i % 2 === 0 }));
  const text = directoryFeedbackExcerpt(entries, '/repo/selected.md', false, false);
  assert.match(text, /file contents were not read/); assert.match(text, /Selected path: \/repo\/selected.md/);
  assert.match(text, /50\/500 listed entries; partial listing/); assert.equal(text.includes('entry-50'), false); assert.ok(text.length <= 8192);
  assert.match(directoryFeedbackExcerpt([], null, true, true), /0\/0.*部分清单/);
  assert.equal(entries.length, 500);
});
test('long entry is omitted with explicit partial count instead of corrupting the selected excerpt budget', () => {
  const text = directoryFeedbackExcerpt([{ name: 'x'.repeat(8192), isDir: false }], null, false, false);
  assert.match(text, /0\/1 listed entries; partial listing/); assert.ok(text.length <= 8192);
});
test('feedback distinguishes persisted intent, unknown save, changed owner and limits; none claims input submission', () => {
  const base = { webContentsId: 1, conversationId: 'task', browserTabId: 'tab' };
  assert.match(browserFeedbackNoticeText({ ...base, phase: 'prepared' }, false), /input draft; not sent/);
  assert.match(browserFeedbackNoticeText({ ...base, phase: 'unconfirmed' }, false), /not confirmed/);
  assert.match(feedbackPreparationFailureText('RESOURCE_FEEDBACK_RECIPIENT_CHANGED', false), /not forwarded/);
  assert.match(feedbackPreparationFailureText('RESOURCE_FEEDBACK_LIMIT', false), /limit/);
});
