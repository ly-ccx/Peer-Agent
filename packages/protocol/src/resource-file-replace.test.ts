import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResourceFileReplaceInput } from './resource-file-replace.ts';
const version = 'sha256:' + 'a'.repeat(64);
const input = { requestId: 'request', target: { recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: { workspaceId: 'bot', path: '/repo/a.md' }, base: { resourceId: version, contentVersion: version } }, content: '中文😀\r\n', proposedVersion: version };
test('conditional file input is finite, retains exact text, and carries no renderer grant/root/receipt', () => {
  const normalized = normalizeResourceFileReplaceInput(input); assert.ok(normalized); assert.equal(normalized.content, input.content);
  for (const patch of [{ grant: { granted: true } }, { root: '/' }, { evidenceRef: 'forged' }, { requestId: '../request' }, { content: 'bad\u0000text' }, { content: '字'.repeat(400_000) }, { proposedVersion: 'latest' }]) assert.equal(normalizeResourceFileReplaceInput({ ...input, ...patch }), undefined);
});
test('current exact targets only; guessed relative paths, mismatched owners and history cannot become writes', () => {
  for (const reference of [{ ...input.target.reference, path: 'a.md' }, { ...input.target.reference, relativeTo: '/other' }, { ...input.target.reference, kind: 'directory' }, { ...input.target.reference, revision: { ref: 'HEAD' } }, { ...input.target.reference, workspaceId: 'another' }]) {
    assert.equal(normalizeResourceFileReplaceInput({ ...input, target: { ...input.target, reference } }), undefined);
  }
});

test('Provider preview cannot describe a partial or unobserved write as applied or cancelled-with-no-effect', async () => {
  const { normalizeResourceFileReplacePreview } = await import('./resource-file-replace.ts');
  const preview = { kind: 'resource_file_replace_result', requestId: 'request', path: '/repo/a.md', resourceId: version, expectedVersion: version, proposedVersion: version,
    observedVersion: version, status: 'success', outcome: 'applied', effectStarted: true };
  assert.ok(normalizeResourceFileReplacePreview(preview));
  assert.equal(normalizeResourceFileReplacePreview({ ...preview, observedVersion: 'sha256:' + 'b'.repeat(64) }), undefined);
  assert.equal(normalizeResourceFileReplacePreview({ ...preview, effectStarted: false }), undefined);
  assert.ok(normalizeResourceFileReplacePreview({ ...preview, effectStarted: false, reason: 'no_change' }));
  assert.equal(normalizeResourceFileReplacePreview({ ...preview, outcome: 'cancelled', status: 'cancelled' }), undefined);
  assert.equal(normalizeResourceFileReplacePreview({ ...preview, grant: { granted: true } }), undefined);
});
