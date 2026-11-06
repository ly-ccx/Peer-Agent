import test from 'node:test';
import assert from 'node:assert/strict';
import { botResourceCandidates, referencesForReplyParagraph, resolveBotResourceDisplay } from './botResourceReference.ts';
const refs = [{ path: '/project/scripts/host-lease.mjs', tool: 'read_file' as const }];

test('R2 shortened file display binds to a unique same-turn source, never a branch or guessed basename', () => {
  assert.equal(resolveBotResourceDisplay('host-lease.mjs', refs), refs[0].path);
  assert.equal(resolveBotResourceDisplay('scripts/host-lease.mjs', refs), refs[0].path);
  assert.equal(resolveBotResourceDisplay('host-lease.mjs', []), null);
  assert.equal(resolveBotResourceDisplay('host-lease.mjs', [...refs, { ...refs[0], path: '/other/host-lease.mjs' }]), null);
  assert.equal(resolveBotResourceDisplay('docs/other.md', refs), 'docs/other.md');
  assert.equal(resolveBotResourceDisplay('/explicit/other.md', refs), '/explicit/other.md');
});

test('ambiguous candidates deduplicate sources and paragraph hints never cross turns', () => {
  const other = { ...refs[0]!, path: '/other/host-lease.mjs' };
  assert.deepEqual(botResourceCandidates('host-lease.mjs', [...refs, other, other]), [refs[0]!.path, other.path]);
  const messages = [{ id: 'no-hints', turnId: 'stored' }, { id: 'm', turnId: 'stored', resourceReferences: refs }];
  const activity = { turnId: 'live', resourceReferences: [other] };
  assert.deepEqual(referencesForReplyParagraph('stored:text-1', messages, activity), refs);
  assert.deepEqual(referencesForReplyParagraph('live:text-1', messages, activity), [other]);
  assert.deepEqual(referencesForReplyParagraph('unrelated:text-1', messages, activity), []);
  assert.deepEqual(referencesForReplyParagraph('stored:other:text-1', messages, activity), []);
});
