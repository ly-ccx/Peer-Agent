import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stripSource = readFileSync(new URL('./AttachmentStrip.tsx', import.meta.url), 'utf8');
const turnSource = readFileSync(new URL('./ChatTurn.tsx', import.meta.url), 'utf8');

test('historical image attachments defer loading and decoding without slowing editable previews', () => {
  assert.match(stripSource, /loading=\{readOnly \? 'lazy' : 'eager'\}/);
  assert.match(stripSource, /decoding="async"/);
  assert.match(
    turnSource,
    /attachments=\{msg\.attachments\}[\s\S]*?readOnly[\s\S]*?onPreviewImage=\{onPreviewImage\}/,
  );
});
