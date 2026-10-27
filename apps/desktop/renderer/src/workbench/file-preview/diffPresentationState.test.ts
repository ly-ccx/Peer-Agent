import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareDiffPresentation } from './diffPresentationState.ts';
import { hasMalformedUnifiedHunks, parseUnifiedHunk } from './diffHunkState.ts';

const normal = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new';
test('ordinary unified changes use structured rendering with bounded, verified hunk coordinates', () => {
  assert.equal(prepareDiffPresentation(normal).mode, 'unified');
  assert.equal(prepareDiffPresentation('@@ -0,0 +1 @@\n+new').mode, 'unified');
  assert.equal(parseUnifiedHunk('@@ -9007199254740992 +1 @@'), null);
  assert.equal(parseUnifiedHunk('@@ -0 +1 @@'), null);
  assert.equal(hasMalformedUnifiedHunks('@@ -1,2 +1,2 @@\n a'), true);
  assert.equal(hasMalformedUnifiedHunks('@@ -1 +1 @@\n-a\n+b\n+extra'), true);
  assert.equal(hasMalformedUnifiedHunks('@@ -1 +1 @@\n--- text\n+++ text'), false);
});
test('combined, binary, rename/mode-only, mixed metadata and malformed records preserve raw text', () => {
  const cases = [
    ['diff --cc a\n@@@ -1,1 -1,1 +1,1 @@@', 'combined'],
    ['diff --git a/a b/a\nBinary files a/a and b/a differ', 'binary'],
    ['diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b', 'metadata'],
    [normal + '\ndiff --git a/b b/b\nold mode 100644\nnew mode 100755', 'metadata'],
    [normal + '\ndiff --git a/b b/b\nindex abc..def', 'metadata'],
    ['@@ -1,2 +1,2 @@\n a', 'structure'],
    ['@@ broken\n+x', 'structure'],
    ['--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n--- a/c\n+++ b/c\n@@ -1 +1 @@\n-c\n+d', 'structure'],
    ['@@ -9007199254740992 +1 @@\n+x', 'structure'],
    ['x'.repeat(16_001), 'budget'],
    ['\n'.repeat(9_000), 'budget'],
  ];
  for (const [text, reason] of cases) {
    const value = prepareDiffPresentation(text!);
    assert.equal(value.mode, 'raw'); assert.equal(value.reason, reason); assert.ok(text!.startsWith(value.text));
  }
});
