import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupSearchConversationsByWorkspace,
  type SearchConversationHit,
} from './conversationSearchGrouping.ts';

function hit(id: string, workspacePath?: string | null): SearchConversationHit {
  return { id, title: id, workspacePath };
}

test('groups search results by workspace and puts the active workspace first', () => {
  const groups = groupSearchConversationsByWorkspace([
    hit('other-1', '/work/other'),
    hit('active-1', '/work/current'),
    hit('other-2', '/work/other'),
    hit('active-2', '/work/current/'),
    hit('unassigned'),
  ], '/work/current');

  assert.deepEqual(
    groups.map((group) => ({
      workspaceName: group.workspaceName,
      isActiveWorkspace: group.isActiveWorkspace,
      ids: group.conversations.map((conversation) => conversation.id),
    })),
    [
      { workspaceName: 'current', isActiveWorkspace: true, ids: ['active-1', 'active-2'] },
      { workspaceName: 'other', isActiveWorkspace: false, ids: ['other-1', 'other-2'] },
      { workspaceName: '', isActiveWorkspace: false, ids: ['unassigned'] },
    ],
  );
});

test('keeps first-seen workspace order and result order inside every group', () => {
  const groups = groupSearchConversationsByWorkspace([
    hit('z-first', '/work/zeta'),
    hit('a-first', '/work/alpha'),
    hit('z-second', '/work/zeta'),
    hit('a-second', '/work/alpha'),
  ]);

  assert.deepEqual(groups.map((group) => group.workspaceName), ['zeta', 'alpha']);
  assert.deepEqual(groups.flatMap((group) => group.conversations.map((item) => item.id)), [
    'z-first',
    'z-second',
    'a-first',
    'a-second',
  ]);
});
