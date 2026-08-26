import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('composer wrap shows a stream-error Resume control above the input', async () => {
  const source = await readFile(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../styles/chat-surface.css', import.meta.url), 'utf8');
  const composerWrapIndex = source.indexOf('className={`chat-composer-wrap');
  const resumeIndex = source.indexOf('chat-stream-error-resume');
  const streamErrorIndex = source.indexOf('{streamError ? (');
  const streamErrorRule = styles.slice(
    styles.indexOf('.chat-stream-error {'),
    styles.indexOf('.chat-stream-error-icon'),
  );
  assert.ok(composerWrapIndex > 0, 'composer wrap should exist');
  assert.ok(streamErrorIndex > composerWrapIndex, 'stream-error banner should sit in the composer wrap');
  assert.ok(resumeIndex > composerWrapIndex, 'Resume control should sit in the composer wrap');
  assert.match(source, /handleResumeStream/);
  assert.match(source, /\{isZh \? '继续' : 'Resume'\}/);
  assert.match(source, /resolveStreamResumeTarget/);
  assert.match(source, /handleRegenerate\(target\.assistantIndex\)/);
  assert.match(source, /messages\.slice\(0, target\.userIndex\)/);
  assert.doesNotMatch(source, /⚠/);
  assert.doesNotMatch(source, />\s*×\s*</);
  assert.match(source, /chat-stream-error-icon/);
  assert.match(source, /<PeerIcon name="close" size=\{14\} \/>/);
  assert.match(streamErrorRule, /--za-control-fill/);
  assert.doesNotMatch(streamErrorRule, /--za-danger-soft/);
  assert.doesNotMatch(streamErrorRule, /--azure-seal/);
  assert.match(source, /restoreStreamErrorFromInterrupted/);
  assert.match(source, /streamError 按会话桶隔离/);
  assert.doesNotMatch(source, /切换会话时清掉上一会话的流式错误横幅/);
});
