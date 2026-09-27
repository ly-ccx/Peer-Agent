import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateAvatar } from '@peer-agent/protocol';

import { cleanDisplayName, createBotProfileStore } from './bot-profile-store.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-12-profile-'));
}

test('名字去掉控制字符和路径分隔符，并且不超过 40 个字', () => {
  assert.equal(cleanDisplayName('a/b\\c\u0000d'), 'abcd');
  assert.equal(cleanDisplayName('  笔记. '), '笔记');
  assert.equal(cleanDisplayName(''), '');
  const long = '项'.repeat(50);
  assert.equal(Array.from(cleanDisplayName(long)).length, 40);
});

test('头像由工作区 id 决定，换一个会带盐重新生成', () => {
  const root = tempRoot();
  try {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const store = createBotProfileStore({
      rootDir: root,
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    });
    const created = store.create({
      workspaceId,
      displayName: '演示',
      agentConversationId: 'conv-1',
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.profile.avatar, generateAvatar(workspaceId));
    const again = store.create({
      workspaceId,
      displayName: '另一个名字',
      agentConversationId: 'conv-2',
    });
    assert.equal(again.created, false);
    assert.equal(again.profile.displayName, '演示');
    assert.equal(again.profile.agentConversationId, 'conv-1');
    const rotated = store.regenerateAvatar(workspaceId);
    assert.equal(rotated.profile.avatarSalt, '1');
    assert.deepEqual(rotated.profile.avatar, generateAvatar(`${workspaceId}:1`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('上传只接受 png、jpg、webp，并且不超过 1 MB', () => {
  const root = tempRoot();
  try {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const store = createBotProfileStore({ rootDir: root });
    store.create({
      workspaceId,
      displayName: '演示',
      agentConversationId: 'conv-1',
    });
    const png = path.join(root, 'avatar-src.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const installed = store.installAvatar(workspaceId, png);
    assert.equal(installed.ok, true);
    assert.deepEqual(installed.profile.avatar, { kind: 'image', ref: 'avatar.png' });
    assert.equal(statSync(path.join(root, 'projects', workspaceId, 'avatar.png')).isFile(), true);
    const gif = path.join(root, 'avatar.gif');
    writeFileSync(gif, Buffer.from('GIF89a'));
    assert.equal(store.installAvatar(workspaceId, gif).code, 'INVALID_IMAGE');
    const huge = path.join(root, 'huge.png');
    writeFileSync(huge, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024 * 1024),
    ]));
    assert.equal(store.installAvatar(workspaceId, huge).code, 'INVALID_IMAGE');
    assert.equal(store.read(workspaceId).avatar.ref, 'avatar.png');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
