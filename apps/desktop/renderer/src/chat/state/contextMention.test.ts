import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceFileAttachment,
  fileMentionSubtitle,
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

test('empty query in all scope only shows Files and Chats', () => {
  const hits = mergeContextMentionHits({
    query: '',
    mentionScope: 'all',
    files: [{ relPath: 'README.md', name: 'README.md' }],
    sessions: [{ id: 'c1', title: 'Demo' }],
  });
  assert.deepEqual(hits, [
    { type: 'category', id: 'files' },
    { type: 'category', id: 'chats' },
  ]);
});

test('files scope lists a back row then files only', () => {
  const hits = mergeContextMentionHits({
    query: '',
    mentionScope: 'files',
    files: [{ relPath: 'src/index.ts', name: 'index.ts' }],
    sessions: [{ id: 'c1', title: 'Demo' }],
  });
  assert.deepEqual(hits[0], { type: 'back', to: 'all', from: 'files' });
  assert.equal(hits.some((hit) => hit.type === 'session'), false);
  assert.equal(hits.some((hit) => hit.type === 'file'), true);
});

test('fileMentionSubtitle always shows a path, including the workspace root', () => {
  assert.equal(fileMentionSubtitle('AGENTS.md'), '.');
  assert.equal(
    fileMentionSubtitle('apps/desktop/renderer/src/chat/state/types.ts'),
    'apps/desktop/renderer/src/chat/state',
  );
});

test('workspace directory attachment is a path pin', () => {
  const attachment = buildWorkspaceFileAttachment({
    relPath: 'apps/desktop',
    name: 'desktop',
    kind: 'directory',
  });
  assert.equal(attachment.sourceKind, 'workspace_dir');
  assert.equal(attachment.workspaceRelPath, 'apps/desktop');
  assert.equal(attachment.text, undefined);
});

test('chat scope keeps the session id for the subtitle', () => {
  const hits = mergeContextMentionHits({
    query: '',
    mentionScope: 'chats',
    sessions: [{ id: 'sess-123', title: 'Demo session' }],
  });
  const session = hits.find((hit) => hit.type === 'session');
  assert.equal(session?.type === 'session' && session.id, 'sess-123');
});
