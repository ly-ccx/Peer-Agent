import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceFileAttachment,
  insertFileMention,
  mergeContextMentionHits,
} from './contextMention.ts';
import { buildAttachmentContext } from './contextSources.ts';

test('insertFileMention writes a relative path token', () => {
  assert.equal(
    insertFileMention('see @Com', 4, 'Com', 'apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx'),
    'see @apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx ',
  );
});

test('workspace file attachment is a path pin, not inlined text', () => {
  const attachment = buildWorkspaceFileAttachment({
    relPath: 'apps/desktop/renderer/src/chat/state/types.ts',
    name: 'types.ts',
  });
  assert.equal(attachment.sourceKind, 'workspace_file');
  assert.equal(attachment.kind, 'unsupported');
  assert.equal(attachment.text, undefined);
  assert.equal(attachment.workspaceRelPath, 'apps/desktop/renderer/src/chat/state/types.ts');

  const [item] = buildAttachmentContext([attachment]);
  assert.equal(item.sourceKind, 'workspace_file');
  assert.equal(item.contentIncluded, false);
  assert.equal(item.transport, 'metadata_only');
  assert.equal(item.contentRef, 'apps/desktop/renderer/src/chat/state/types.ts');
});

test('empty query starts with Files and Chats categories', () => {
  const hits = mergeContextMentionHits({
    query: '',
    files: [{ relPath: 'README.md', name: 'README.md' }],
    sessions: [{ id: 'c1', title: 'Demo' }],
  });
  assert.deepEqual(hits.slice(0, 2), [
    { type: 'category', id: 'files' },
    { type: 'category', id: 'chats' },
  ]);
  assert.equal(hits.some((hit) => hit.type === 'file'), true);
  assert.equal(hits.some((hit) => hit.type === 'session'), true);
});
