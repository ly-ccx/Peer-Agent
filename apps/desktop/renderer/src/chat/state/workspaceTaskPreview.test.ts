import assert from 'node:assert/strict';
import test from 'node:test';
import { UNASSIGNED_WORKSPACE_KEY } from './workspaceTaskTree.ts';
import {
  mergeConversationLists,
  nextRevealedTaskCount,
  previewWorkspaceTasks,
  shouldFetchWorkspaceTaskPage,
  WORKSPACE_TASK_PREVIEW_SIZE,
  workspaceListPath,
} from './workspaceTaskPreview.ts';

test('unassigned workspace key maps to a null list path', () => {
  assert.equal(workspaceListPath(UNASSIGNED_WORKSPACE_KEY), null);
  assert.equal(workspaceListPath('/repo/peer_agent'), '/repo/peer_agent');
});

test('merge keeps primary items first and skips duplicate ids', () => {
  const merged = mergeConversationLists(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'c' }],
  );
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c']);
});

test('preview shows a short first page and hides the rest', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({ id: String(index) }));
  const preview = previewWorkspaceTasks(tasks, WORKSPACE_TASK_PREVIEW_SIZE);
  assert.equal(preview.visible.length, 12);
  assert.equal(preview.canShowMore, true);
  assert.equal(previewWorkspaceTasks(tasks.slice(0, 3), 12).canShowMore, false);
});

test('revealed count grows by one preview page and never past loaded items', () => {
  assert.equal(nextRevealedTaskCount(12, 40), 24);
  assert.equal(nextRevealedTaskCount(36, 40), 40);
});

test('fetch is skipped while locally hidden items can still be revealed', () => {
  assert.equal(shouldFetchWorkspaceTaskPage({
    revealedCount: 12,
    loadedCount: 30,
    hasMore: true,
    fetched: true,
  }), false);
  assert.equal(shouldFetchWorkspaceTaskPage({
    revealedCount: 12,
    loadedCount: 12,
    hasMore: true,
    fetched: true,
  }), true);
  assert.equal(shouldFetchWorkspaceTaskPage({
    revealedCount: 12,
    loadedCount: 5,
    hasMore: false,
    fetched: false,
  }), true);
});
