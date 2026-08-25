import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('composer wrap shows a stream-error Resume control above the input', async () => {
  const source = await readFile(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
  const composerWrapIndex = source.indexOf('className={`chat-composer-wrap');
  const resumeIndex = source.indexOf('chat-stream-error-resume');
  const streamErrorIndex = source.indexOf('{streamError ? (');
  assert.ok(composerWrapIndex > 0, 'composer wrap should exist');
  assert.ok(streamErrorIndex > composerWrapIndex, 'stream-error banner should sit in the composer wrap');
  assert.ok(resumeIndex > composerWrapIndex, 'Resume control should sit in the composer wrap');
  assert.match(source, /handleResumeStream/);
  assert.match(source, /\{isZh \? '继续' : 'Resume'\}/);
  assert.match(source, /resolveStreamResumeTarget/);
  assert.match(source, /handleRegenerate\(target\.assistantIndex\)/);
  assert.match(source, /messages\.slice\(0, target\.userIndex\)/);
});
