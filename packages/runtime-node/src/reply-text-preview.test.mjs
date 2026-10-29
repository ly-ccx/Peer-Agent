import assert from 'node:assert/strict';
import test from 'node:test';
import { readReplyTextPreview } from './provider-adapters/reply-text-preview.mjs';

test('only root text is decoded, including every split inside escapes and unicode', () => {
  const value = 'Hello\n"quoted" \\ 😀 end';
  const json = JSON.stringify({ question: { text: 'private' }, text: value, sources: [] });
  for (let i = 0; i <= json.length; i++) {
    const preview = readReplyTextPreview(json.slice(0, i));
    if (preview !== null) assert.ok(value.startsWith(preview), JSON.stringify({ i, preview }));
  }
  assert.equal(readReplyTextPreview(json), value);
  assert.equal(readReplyTextPreview('{"nested":{"text":"secret"}}'), null);
  assert.equal(readReplyTextPreview('{"text":123}'), null);
  assert.equal(readReplyTextPreview('{"text":"a\\uD83D'), 'a');
  assert.equal(readReplyTextPreview('{"text":"a\\'), 'a');
});
