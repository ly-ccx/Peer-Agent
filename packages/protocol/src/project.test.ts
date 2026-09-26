import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  filterBotList,
  generateAvatar,
  projectBotListItem,
  sortBotList,
  type BotListItem,
  type BotProfile,
} from './project.ts';

function profile(workspaceId: string, displayName = workspaceId): BotProfile {
  return {
    workspaceId,
    displayName,
    avatar: generateAvatar(workspaceId),
    updatedAt: '2026-09-26T00:00:00.000Z',
  };
}

function item(workspaceId: string, lastActiveAt: string, needsYou: number, preview = ''): BotListItem {
  return {
    workspaceId,
    profile: { ...profile(workspaceId), displayName: workspaceId },
    preview,
    lastActiveAt,
    state: { needsYou, unread: 0, running: 0 },
  };
}

test('bot list sort is recent activity and keeps ties stable', () => {
  const quietNew = item('quiet', '2026-09-26T03:00:00.000Z', 0);
  const loudOld = item('loud', '2026-09-26T01:00:00.000Z', 4);
  const tieFirst = item('tie-a', '2026-09-26T02:00:00.000Z', 9);
  const tieSecond = item('tie-b', '2026-09-26T02:00:00.000Z', 0);
  const sorted = sortBotList([tieFirst, loudOld, quietNew, tieSecond]);
  assert.deepEqual(sorted.map((entry) => entry.workspaceId), ['quiet', 'tie-a', 'tie-b', 'loud']);
});

test('bot list filter matches needs-you and display name or preview', () => {
  const rows = [
    item('alpha', '2026-09-26T03:00:00.000Z', 0, 'nothing'),
    item('beta', '2026-09-26T02:00:00.000Z', 1, 'Hello World'),
  ];
  assert.deepEqual(filterBotList(rows, { needsYouOnly: true }).map((entry) => entry.workspaceId), ['beta']);
  assert.deepEqual(filterBotList(rows, { query: '  hELLo ' }).map((entry) => entry.workspaceId), ['beta']);
  assert.deepEqual(filterBotList(rows, { query: 'ALPHA' }).map((entry) => entry.workspaceId), ['alpha']);
});

test('bot row counts approvals, waiting sessions, running work, and unread replies', () => {
  const row = projectBotListItem({
    profile: profile('ws', '仓库'),
    lastMessage: { role: 'assistant', text: '做好了', at: '2026-09-26T04:00:00.000Z' },
    readCursor: '2026-09-26T03:00:00.000Z',
    sessions: [
      { status: 'waiting_user', updatedAt: '2026-09-26T02:00:00.000Z' },
      { status: 'result_ready' },
      { status: 'running', updatedAt: '2026-09-26T05:00:00.000Z' },
      { status: 'starting' },
      { status: 'verifying' },
      { status: 'accepted' },
    ],
    approvals: [
      { state: 'open' },
      { state: 'stale' },
      { state: 'denied' },
    ],
  });
  assert.equal(row.state.needsYou, 4);
  assert.equal(row.state.running, 3);
  assert.equal(row.state.unread, 1);
  assert.equal(row.preview, '做好了');
  assert.equal(row.lastActiveAt, '2026-09-26T05:00:00.000Z');

  const read = projectBotListItem({
    profile: profile('ws'),
    lastMessage: { role: 'assistant', text: '旧回复', at: '2026-09-26T01:00:00.000Z' },
    readCursor: '2026-09-26T02:00:00.000Z',
  });
  assert.equal(read.state.unread, 0);
});

test('generated avatars are deterministic and cover shape and color', () => {
  assert.deepEqual(generateAvatar('workspace-1'), generateAvatar('workspace-1'));
  const buckets = new Map<string, number>();
  let seed = 0x12345678;
  const next = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x6d2b79f5) | 0;
    return seed >>> 0;
  };
  for (let index = 0; index < 1000; index += 1) {
    const avatar = generateAvatar(`ws-${next().toString(16)}-${index}`);
    assert.equal(avatar.kind, 'generated');
    if (avatar.kind !== 'generated') continue;
    const key = `${avatar.shape}:${avatar.color}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  assert.equal(BOT_AVATAR_SHAPES.length * BOT_AVATAR_COLORS.length, 64);
  assert.equal(buckets.size, 64);
  for (const count of buckets.values()) {
    assert.ok(count >= 1 && count <= 45, `bucket count ${count}`);
  }
});
