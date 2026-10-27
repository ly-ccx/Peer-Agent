import assert from 'node:assert/strict';
import test from 'node:test';
import { versionedFileDiff } from './versioned-file-diff.mjs';
test('preview describes the actual versions, including empty files and newline-only changes', () => {
  assert.deepEqual(versionedFileDiff('/repo/a', 'same', 'same'), { text: '', truncated: false, additions: 0, deletions: 0 });
  const empty = versionedFileDiff('/repo/a', '', 'first\n'); assert.match(empty.text, /@@ -0,0 \+1,1 @@/); assert.equal(empty.additions, 1);
  const newline = versionedFileDiff('/repo/a', 'a\n', 'a'); assert.match(newline.text, /No newline at end of file/); assert.equal(newline.additions, 1); assert.equal(newline.deletions, 1);
});
test('bounded preview does not pretend omitted long rows are a complete executable patch', () => {
  const value = versionedFileDiff('/repo/a', 'old\n', 'x'.repeat(5000)); assert.equal(value.truncated, true); assert.ok(value.text.length <= 4000); assert.equal(value.additions, 1); assert.equal(value.deletions, 1);
});
